/**
 * 管理员命令一条一行(第三批 3d):行两两互斥、推导出来的识别面和以前手写的一字不差、后台那几行立刻回、注册表里的行各管各的。
 */
import { describe, it, expect, vi } from 'vitest'
import { ADMIN_ROW_IDS, adminRowsMatching, makeAdminCommands, type AdminCommandsDeps } from './admin-commands'
import type { InboundMsg } from '../core/prompt-format'

const HANDS = ['家里', 'win', 'mac-mini']

// 每一行至少几句会认的说法,加上一批不该被任何一行认的日常话。
const CORPUS = [
  'WCCP1abcDEF123', '/hand WCCP1abcDEF123', '/配对 WCCP1 abc DEF 123',
  '/hands', '有哪些手', '手列表?', '看看有哪些手',
  '/bag', '/背包', '背包', '打猎背包', '猎物', '战利品', '打到了什么?',
  '/health', '/health ai',
  '/reset', '/重置', '/update', '/updata',
  '自改 状态', '自改 列表', '自改 把设置页的标题改成中文', '自改 状态栏太挤了',
  '/overview', '你对我的理解', '你眼中的我', '查看记忆', '看记忆?',
  '/synthesize', '/整理记忆', '整理记忆', '重新整理记忆', '更新你对我的理解', '更新记忆',
  '让家里 执行 打扫一下', '让 win 跑 测试', '派mac-mini 看看日志', '让我看看这个', '让张三跑一趟',
  '清理 all-expired', '清理 所有过期', '清理 bot1-im-bot',
  '/hearth', '/hearth help', '/hearth list', '/hearth show abc_1', '/hearth apply abc_1', '/hearth ingest 一段内容',
  '/botname', '/botname 小助手', '/botname 跳过',
  '放行规则关掉', '放行规则打开。', '放行规则关闭', '放行规则开启',
  // 日常话 / 别的命令
  '今天天气怎么样', '你好', '放行规则是什么', '把放行规则关掉吧', '放行规则关掉了吗', '/cc', '/codex', '/help', '/set visit', '任务 3 停', '同意 07', '记忆', '整理一下房间', '我的背包丢了',
]

describe('admin rows', () => {
  it('every row id is distinct and the table keeps today\'s order', () => {
    expect(new Set(ADMIN_ROW_IDS).size).toBe(ADMIN_ROW_IDS.length)
    expect(ADMIN_ROW_IDS).toEqual(['hand.join', 'hands.list', 'bag', 'health', 'health.ai', 'reset', 'update', 'selfchange.status', 'selfchange.start', 'memory.show', 'memory.synthesize', 'delegate', 'cleanup', 'hearth.ingest', 'hearth.list', 'hearth.show', 'hearth.apply', 'hearth.help', 'rules.toggle', 'botname'])
  })

  // 整合者审稿:「最多一行认领」和「顺序就是优先级」不能同时成立 —— 选互斥。以前「自改 状态」要排在「自改 <需求>」前面才不被当成需求,
  // 现在 selfchange.start 自己把它排除掉;以后谁调了表的先后也不会悄悄改行为。
  it('rows are mutually exclusive: no sentence is claimed by two rows', () => {
    const overlaps = CORPUS.map(t => [t, adminRowsMatching(t, HANDS)] as const).filter(([, ids]) => ids.length > 1)
    expect(overlaps).toEqual([])
    expect(adminRowsMatching('自改 状态', HANDS)).toEqual(['selfchange.status'])
    expect(adminRowsMatching('自改 状态栏太挤了', HANDS)).toEqual(['selfchange.start'])
  })

  it('放行规则开关只认整句;问句 / 闲聊不认(交给模型)', () => {
    for (const t of ['放行规则关掉', '放行规则打开。', ' 放行规则关闭 ', '放行规则开启!']) expect(adminRowsMatching(t, HANDS), t).toEqual(['rules.toggle'])
    for (const t of ['放行规则是什么', '把放行规则关掉吧', '放行规则关掉了吗', '放行规则']) expect(adminRowsMatching(t, HANDS), t).toEqual([])
  })

})

describe('admin commands() in the registry', () => {
  const msg = (text: string, chatId = 'owner'): InboundMsg => ({ chatId, userId: chatId, text, msgType: 'text', createTimeMs: 0, accountId: 'a' })
  function make(over: Partial<AdminCommandsDeps> = {}) {
    const sent: Array<[string, string]> = []
    const deps = {
      isAdmin: (c: string) => c === 'owner',
      sendMessage: vi.fn(async (c: string, t: string) => { sent.push([c, t]); return {} }),
      log: () => {},
      knownHandNames: () => HANDS,
      getBotName: () => '小助手', setBotName: async () => {}, botNameFallback: () => 'CC',
      ...over,
    } as unknown as AdminCommandsDeps
    return { cmds: makeAdminCommands(deps).commands(), sent }
  }
  const claimers = (cmds: ReturnType<typeof make>['cmds'], m: InboundMsg) => cmds.filter(c => c.probe(m)).map(c => c.id)

  it('one admin.<id> row per command plus admin.owner-only; every id is prefixed and grouped as admin', () => {
    const { cmds } = make()
    expect(cmds.map(c => c.id)).toEqual(['admin.owner-only', ...ADMIN_ROW_IDS.map(id => `admin.${id}`)])
    expect(new Set(cmds.map(c => c.group))).toEqual(new Set(['admin']))
  })
  it('owner: exactly its own row claims; non-owner explicit command: only owner-only claims and says so; non-owner everyday words: nobody', async () => {
    const { cmds, sent } = make()
    expect(claimers(cmds, msg('/botname'))).toEqual(['admin.botname'])
    expect(claimers(cmds, msg('看看有哪些手'))).toEqual(['admin.hands.list'])
    expect(claimers(cmds, msg('/botname', 'guest'))).toEqual(['admin.owner-only'])
    expect(claimers(cmds, msg('背包', 'guest'))).toEqual([])
    expect(claimers(cmds, msg('今天天气怎么样'))).toEqual([])
    await cmds.find(c => c.id === 'admin.owner-only')!.handle(msg('/reset', 'guest'))
    expect(sent).toEqual([['guest', '这条只有主人能用。']])
  })
  // 整合者审稿:后台那两行 handle 要立刻回,活在后台跑(合成、派活都是慢的模型 / agent 调用)
  it('background rows return before the slow work finishes', async () => {
    let finish!: () => void
    const synthesizeMemory = vi.fn(() => new Promise<never>(resolve => { finish = resolve as () => void }))
    const { cmds } = make({ synthesizeMemory } as Partial<AdminCommandsDeps>)
    const row = cmds.find(c => c.id === 'admin.memory.synthesize')!
    const handled = await Promise.race([row.handle(msg('整理记忆')), new Promise(r => setTimeout(() => r('timed-out'), 500))])
    expect(handled).toBe(true)
    // 而且活真的开跑了(不是因为没调到才回得快),此刻还没跑完
    await vi.waitFor(() => expect(synthesizeMemory).toHaveBeenCalledTimes(1))
    finish?.()
  })
})
