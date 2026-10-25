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
import { choiceTakes, makeMwTaskReference, type OpenChoice } from '../inbound/mw-task-reference'
import type { TaskCandidate } from '../../core/workbench/task-reference'
import type { InboundMsg } from '../../core/prompt-format'

const OWNER = 'owner@im.wechat'
const H = 3600_000
const AT_8 = Date.parse('2026-10-25T00:00:00.000Z') // 上海 8 点
const cand = (id: string, title: string): TaskCandidate => ({ id, title, project: 'project-b', path: '/s/project-b', providerId: 'claude', phase: 'replied', updatedAt: AT_8 })

function setup() {
  const clock = { now: AT_8 }
  const store = makeOwnerAsksStore(join(mkdtempSync(join(tmpdir(), 'asks-butler-')), OWNER_ASKS_FILE))
  for (const k of ['a', 'b', 'c']) store.enqueueVisibleCandidate({ key: k, question: `问题 ${k}?`, recommend: '改。', source: 'manual' })
  const iso = () => new Date(clock.now).toISOString()
  store.commitAsked(store.pickForBrief(0, iso()), iso()) // 早报问了 1–3

  const butlerChoice = new Map<string, OpenChoice>()
  const said: string[] = [], taskCommands: string[] = []
  let candidates = [cand('f3c7234a', '读 DATA.md,哪三个模型在 1 秒以内'), cand('5c12e75a', '检查 · 读 DATA.md')]
  const asks = makeAsksReply({ store, isOwner: c => c === OWNER, say: async (_c, t) => { said.push(t) }, now: () => clock.now, log: () => {} })
  // 与 pipeline-deps 同一种接法
  const registry = makeCommandRegistry(yieldNumbersToOpenChoice([fromReplyHandler('jobs', asks)], (c, text) => choiceTakes(text, butlerChoice.get(c), clock.now)))
  const butler = makeMwTaskReference({
    ownerChatId: () => OWNER,
    candidates: () => candidates,
    handleWechat: async (_c, text) => { taskCommands.push(text); return '好的。' },
    sendMessage: async (_c, t) => { said.push(t); return {} },
    now: () => clock.now, log: () => {},
    noteChoice: (c, e) => { if (e === null) butlerChoice.delete(c); else butlerChoice.set(c, e) },
  })
  // 入站的顺序:命令表先认;没人认才轮到管家;管家放行 ⇒ 聊天。
  const inbound = async (text: string) => {
    const msg = { chatId: OWNER, userId: 'u', text, msgType: 'text', createTimeMs: clock.now, accountId: 'acct' } as InboundMsg
    if (await registry.handle(msg)) return 'command'
    if (!(await butler.probe({ msg, receivedAtMs: clock.now, requestId: 'r' } as never))) return 'chat'
    let fell = false
    await butler({ msg, receivedAtMs: clock.now, requestId: 'r' } as never, async () => { fell = true })
    return fell ? 'chat' : 'butler'
  }
  const status = (k: string) => store.read().items.find(i => i.key === k)!.status
  return { clock, store, said, taskCommands, inbound, status, butlerChoice, dropCandidates: () => { candidates = [] } }
}

describe('早报的「回 2」× 管家的「1 还是 2」', () => {
  it('butler asked after the brief ⇒ the bare 2 goes to the butler, the brief ask stays open; once the choice is settled the brief number works again', async () => {
    const { clock, said, taskCommands, inbound, store } = setup()
    clock.now = AT_8 + 2 * H // 10 点
    expect(await inbound('project-b 那个继续')).toBe('butler')
    expect(said.at(-1)).toMatch(/你说的是哪一件/)
    expect(await inbound('2')).toBe('butler')
    expect(taskCommands).toEqual(['任务 5c12e75a 补充 project-b 那个继续'])
    expect(store.read().items.every(i => i.status === 'asked')).toBe(true) // 早报那几条一条都没被记成批准
    // 管家那一问落定了 ⇒ 早报的 2 又归早报(还在 12 小时窗口里)
    expect(await inbound('2')).toBe('command')
    expect(said.at(-1)).toBe('记下了,2 要:问题 b?')
  })
  it('out of the butler’s range: butler offered 2, brief asked 3 ⇒ 「3」 is a brief answer, not lost to chat (第二轮评审)', async () => {
    const { clock, said, taskCommands, inbound, status } = setup()
    clock.now = AT_8 + 2 * H
    expect(await inbound('project-b 那个继续')).toBe('butler')
    expect(await inbound('3')).toBe('command')
    expect(said.at(-1)).toBe('记下了,3 要:问题 c?')
    expect(status('c')).toBe('approved')
    expect(taskCommands).toEqual([])
    // 管家那一问还开着:之后的「1」照样归它
    expect(await inbound('1')).toBe('butler')
    expect(taskCommands).toEqual(['任务 f3c7234a 补充 project-b 那个继续'])
  })
  it('「2 不要」 while the butler’s choice is open ⇒ recorded as the brief answer (the butler only eats bare numbers)', async () => {
    const { clock, said, inbound, status } = setup()
    clock.now = AT_8 + 2 * H
    expect(await inbound('project-b 那个继续')).toBe('butler')
    expect(await inbound('2 不要')).toBe('command')
    expect(said.at(-1)).toBe('记下了,2 不要:问题 b?\n以后不再提。')
    expect(status('b')).toBe('declined')
  })
  it('candidates gone ⇒ the open choice is forgotten, digits are not held back for 30 minutes', async () => {
    const { clock, inbound, butlerChoice, dropCandidates, status } = setup()
    clock.now = AT_8 + 2 * H
    expect(await inbound('project-b 那个继续')).toBe('butler')
    expect(butlerChoice.has(OWNER)).toBe(true)
    dropCandidates()
    expect(await inbound('今天怎么样')).toBe('chat')
    expect(butlerChoice.has(OWNER)).toBe(false)
    expect(await inbound('1')).toBe('command')
    expect(status('a')).toBe('approved')
  })
})
