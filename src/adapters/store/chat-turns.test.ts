import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../../lib/db'
import { makeMatterStore } from './matters-store'
import { makeMatterLog } from './matter-log'
import { makeChatTurnLog } from './chat-turns'
import type { MatterLog, MatterStore } from '../../ports/matters'
import type { ChatTurnLog } from '../../ports/chat-turns'

/** 对话的一轮 → 这件对话的轮与步(M3a)。 */
let db: Db, matters: MatterStore, log: MatterLog, turns: ChatTurnLog, chatMatter: string
beforeEach(() => {
  db = openDb({ path: ':memory:' })
  matters = makeMatterStore(db); log = makeMatterLog(db)
  chatMatter = matters.ensureChat('owner@im.wechat').id
  turns = makeChatTurnLog({ db, log, matters })
})
afterEach(() => db.close())
const begin = () => turns.begin({ chatId: 'owner@im.wechat', provider: 'claude', alias: '_default', startedAt: 1 })!
const items = () => log.items(chatMatter).map(i => ({ kind: i.kind, status: i.status, payload: i.payload }))

describe('chat-turns', () => {
  it('找不到这件对话 ⇒ 不记(null)', () => {
    expect(turns.begin({ chatId: 'stranger@im.wechat', provider: 'claude', alias: '_default', startedAt: 1 })).toBeNull()
  })
  it('开一轮 ⇒ 这件对话在做;工具调用按 activity id 合成一步,没有 activity 的只记名字', () => {
    const h = begin()
    expect(log.state(chatMatter)?.state).toBe('working')
    h.event({ kind: 'tool_call', tool: 'Bash', activity: { id: 'a1', type: 'command', status: 'running', label: '跑测试', detail: 'bun test' } })
    h.event({ kind: 'tool_call', tool: 'Bash', activity: { id: 'a1', type: 'command', status: 'completed', label: '跑测试', detail: 'bun test' } })
    h.event({ kind: 'tool_call', server: 'wechat', tool: 'reply' })
    h.event({ kind: 'tool_call', server: 'wechat', tool: 'reply' })
    expect(items()).toEqual([
      { kind: 'tool_call', status: 'completed', payload: { tool: 'Bash', activity: { id: 'a1', type: 'command', status: 'completed', label: '跑测试', detail: 'bun test' } } },
      { kind: 'tool_call', status: 'completed', payload: { tool: 'wechat/reply' } },
      { kind: 'tool_call', status: 'completed', payload: { tool: 'wechat/reply' } },
    ])
  })
  it('做完:记送达、用量、原生会话、模式;这件对话回到 open;再收一次不动', () => {
    const h = begin()
    h.event({ kind: 'init', sessionId: 'native-1' })
    h.event({ kind: 'result', sessionId: 'native-1', numTurns: 1, durationMs: 5, usage: { input: 10, output: 3 } })
    h.end({ mode: 'solo', outcome: 'completed', report: { delivery: 'daemon', bubbles: 2, attachmentsSent: 0, msgIds: [] } as never })
    h.end({ mode: 'solo', outcome: 'error', error: 'late' })
    expect(log.turns(chatMatter)).toMatchObject([{ executor: 'claude', status: 'completed', errorCode: null, usage: { input: 10, output: 3 }, nativeSessionId: 'native-1', policy: { alias: '_default', mode: 'solo' } }])
    expect(items()).toEqual([{ kind: 'delivery', status: 'completed', payload: { delivery: 'daemon', bubbles: 2, attachments: 0 } }])
    expect(log.state(chatMatter)?.state).toBe('open')
  })
  it('这一轮的起止用协调器给的时刻(和 turn_records 那行一样),不是写库那一刻(Codex 评审 P2)', () => {
    const h = turns.begin({ chatId: 'owner@im.wechat', provider: 'claude', alias: '_default', startedAt: 1_000 })!
    h.end({ mode: 'solo', outcome: 'error', error: 'spawn failed', endedAt: 4_500 })
    expect(log.turns(chatMatter)).toMatchObject([{ startedAt: 1_000, endedAt: 4_500 }])
  })
  it('首字延迟:从开始跑到第一句话 / 第一个工具调用,记在这一轮的 policy;一个字都没来 ⇒ 不记', () => {
    let clock = 10_000
    const t2 = makeChatTurnLog({ db, log, matters, now: () => clock })
    const h = t2.begin({ chatId: 'owner@im.wechat', provider: 'openai', alias: '_default', startedAt: 9_000 })!
    clock = 10_500; h.event({ kind: 'init', sessionId: 's' })
    clock = 12_300; h.event({ kind: 'text', text: '好' })
    clock = 13_000; h.event({ kind: 'text', text: '的' })
    h.end({ mode: 'solo', outcome: 'completed' })
    const quiet = t2.begin({ chatId: 'owner@im.wechat', provider: 'openai', alias: '_default', startedAt: 20_000 })!
    quiet.end({ mode: 'solo', outcome: 'error', error: 'timeout' })
    expect(log.turns(chatMatter).map(t => t.policy?.ttftMs ?? null)).toEqual([2_300, null])
  })
  it('超时 / 出错 ⇒ 这一轮 failed,错误码给不出就用结局;写一步错误', () => {
    const h = begin()
    h.end({ mode: 'parallel', outcome: 'timeout', error: 'turn timed out' })
    expect(log.turns(chatMatter)).toMatchObject([{ status: 'failed', errorCode: 'timeout', policy: { mode: 'parallel' } }])
    expect(items()).toEqual([{ kind: 'error', status: 'completed', payload: { text: 'turn timed out', outcome: 'timeout' } }])
  })
  it('开机 interruptAll:没收的对话轮记中断;一起做的轮不碰', () => {
    begin()
    const task = matters.create({ kind: 'task', title: 't' })
    log.startTurn({ matterId: task.id, executor: 'codex' })
    turns.interruptAll()
    expect(log.turns(chatMatter)).toMatchObject([{ status: 'interrupted', errorCode: 'daemon_restarted' }])
    expect(log.turns(task.id)).toMatchObject([{ status: 'running' }])
  })
})
