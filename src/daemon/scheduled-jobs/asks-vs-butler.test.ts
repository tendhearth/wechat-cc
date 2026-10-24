/**
 * 整合者评审 #659 的那个场景:早报 8 点问了 1–3,管家 10 点问「你说的是哪一件?1 还是 2」,主人回「2」。
 * 数字得归管家(任务那一问不能丢),不能被记成早报那条的批准。命令表排在管家前面(INTENT_ORDER),
 * 所以靠 yieldNumbersToOpenChoice + 管家的 noteChoice 让开。临时状态目录,不碰真机。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeOwnerAsksStore, OWNER_ASKS_FILE } from '../../core/owner-asks-store'
import { makeAsksReply } from './asks-reply'
import { fromReplyHandler, makeCommandRegistry, yieldNumbersToOpenChoice } from '../commands/registry'
import { makeMwTaskReference } from '../inbound/mw-task-reference'
import type { TaskCandidate } from '../../core/workbench/task-reference'
import type { InboundMsg } from '../../core/prompt-format'

const OWNER = 'owner@im.wechat'
const H = 3600_000
const AT_8 = Date.parse('2026-10-25T00:00:00.000Z') // 上海 8 点
const cand = (id: string, title: string): TaskCandidate => ({ id, title, project: 'project-b', path: '/s/project-b', providerId: 'claude', phase: 'replied', updatedAt: AT_8 })

describe('早报的「回 2」× 管家的「1 还是 2」', () => {
  it('butler asked after the brief ⇒ the bare 2 goes to the butler, the brief ask stays open; once the choice is settled the brief number works again', async () => {
    let now = AT_8
    const store = makeOwnerAsksStore(join(mkdtempSync(join(tmpdir(), 'asks-butler-')), OWNER_ASKS_FILE))
    for (const k of ['a', 'b', 'c']) store.enqueueVisibleCandidate({ key: k, question: `问题 ${k}?`, recommend: '改。', source: 'manual' })
    const iso = () => new Date(now).toISOString()
    store.commitAsked(store.pickForBrief(0, iso()), iso()) // 早报问了 1–3

    const butlerChoice = new Map<string, number>()
    const said: string[] = [], taskCommands: string[] = []
    const asks = makeAsksReply({ store, isOwner: c => c === OWNER, say: async (_c, t) => { said.push(t) }, now: () => now, log: () => {} })
    const registry = makeCommandRegistry(yieldNumbersToOpenChoice([fromReplyHandler('jobs', asks)], c => (butlerChoice.get(c) ?? 0) > now))
    const butler = makeMwTaskReference({
      ownerChatId: () => OWNER,
      candidates: () => [cand('f3c7234a', '读 DATA.md,哪三个模型在 1 秒以内'), cand('5c12e75a', '检查 · 读 DATA.md')],
      handleWechat: async (_c, text) => { taskCommands.push(text); return '好的。' },
      sendMessage: async (_c, t) => { said.push(t); return {} },
      now: () => now, log: () => {},
      noteChoice: (c, e) => { if (e === null) butlerChoice.delete(c); else butlerChoice.set(c, e) },
    })
    // 入站的顺序:命令表先认;没人认才轮到管家。
    const inbound = async (text: string) => {
      const msg = { chatId: OWNER, userId: 'u', text, msgType: 'text', createTimeMs: now, accountId: 'acct' } as InboundMsg
      if (await registry.handle(msg)) return 'command'
      let fell = false
      await butler({ msg, receivedAtMs: now, requestId: 'r' } as never, async () => { fell = true })
      return fell ? 'chat' : 'butler'
    }

    now = AT_8 + 2 * H // 10 点
    expect(await inbound('project-b 那个继续')).toBe('butler')
    expect(said.at(-1)).toMatch(/你说的是哪一件/)
    expect(await inbound('2')).toBe('butler')
    expect(taskCommands).toEqual(['任务 5c12e75a 补充 project-b 那个继续'])
    expect(store.read().items.every(i => i.status === 'asked')).toBe(true) // 早报那几条一条都没被记成批准

    // 管家那一问落定了 ⇒ 早报的 2 又归早报(还在 12 小时窗口里)
    expect(await inbound('2')).toBe('command')
    expect(said.at(-1)).toBe('记下了,2 要:问题 b?')
  })
})
