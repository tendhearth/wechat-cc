import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../../lib/db'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeTerminalStepStore } from '../../adapters/store/terminal-steps'
import type { MatterLog, MatterStore } from '../../ports/matters'
import { parseActivity } from './cli-activity'
import { makeTerminalSteps, STEPS_FIRST_READ, STOP_SETTLE_MS, withTranscriptSteps, type TerminalSteps } from './terminal-steps'
import { makeTerminalTurnLog } from '../../adapters/store/terminal-turns'

/** 终端会话记录增量读进这件事的步(M4b):不管分几次读、从哪儿断开,读出来的和整段解析一遍逐字段一样。 */
const L = (o: object) => JSON.stringify(o)
const T = '2026-11-04T10:00:00.000Z'
let db: Db, matters: MatterStore, log: MatterLog
let file: Buffer
const makeSteps = (): TerminalSteps => makeTerminalSteps({
  store: makeTerminalStepStore({ db, log, matters }),
  size: () => file.length,
  read: (_p, from, to) => file.subarray(from, to),
})
beforeEach(() => {
  db = openDb({ path: ':memory:' })
  matters = makeMatterStore(db); log = makeMatterLog(db)
  const m = matters.create({ kind: 'terminal', title: 'blog', origin: 'cli' })
  matters.bind(m.id, 'cli', 'S1')
  file = Buffer.alloc(0)
})
afterEach(() => db.close())
const matterId = () => matters.findBySurface('cli', 'S1')!.id
const session = { session_id: 'S1', transcript_path: '/t/S1.jsonl', source: 'claude' }

const CLAUDE = [
  L({ type: 'user', timestamp: T, message: { content: '把测试修好' } }),
  L({ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text: '先看看' }, { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/p/a.ts' } }] } }),
  L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/p/a.ts' } }] } }),
  L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'x' }, { type: 'tool_result', tool_use_id: 'r2', content: 'y' }] } }),
  L({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'const b = 2', new_string: 'const b = 3' } },
    { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } },
  ] } }),
  L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } }),
  L({ type: 'user', timestamp: T, message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: '1 failed\nTOKEN=abcd1234zz', is_error: true }] } }),
  L({ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text: '有一个没过,我再改' }, { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'npm test' } }] } }),
  L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b2', content: 'Tests 3 passed' }] } }),
].join('\n') + '\n'

describe('terminal-steps', () => {
  it('一次读完 ⇒ 和 parseActivity 整段解析逐字段一样(合并「一串读 x」、结果挂回调用、报错、打码)', () => {
    file = Buffer.from(CLAUDE)
    expect(makeSteps().view(session, 40)).toEqual(parseActivity(CLAUDE, 'claude'))
  })

  it('从每一个字节位置断开分两次读(包括断在一行中间、断在中文字中间)⇒ 结果都一样;第二次读换一个实例(重启后接得上)', () => {
    const whole = Buffer.from(CLAUDE)
    const want = parseActivity(CLAUDE, 'claude')
    for (let cut = 1; cut < whole.length; cut += 7) {
      db.close(); db = openDb({ path: ':memory:' }); matters = makeMatterStore(db); log = makeMatterLog(db)
      matters.bind(matters.create({ kind: 'terminal', title: 'blog', origin: 'cli' }).id, 'cli', 'S1')
      file = whole.subarray(0, cut)
      makeSteps().ingest('S1', session.transcript_path, 'claude')
      file = whole
      expect(makeSteps().view(session, 40)).toEqual(want)
    }
  })

  it('一行一行地读(每次只多一行)⇒ 结果一样;读到一半的那一行留给下一次', () => {
    const lines = CLAUDE.split('\n').filter(Boolean)
    const steps = makeSteps()
    let acc = ''
    for (const line of lines) {
      file = Buffer.from(acc + line)            // 先只有半截(没换行)
      steps.ingest('S1', session.transcript_path, 'claude')
      acc += line + '\n'
      file = Buffer.from(acc)
      steps.ingest('S1', session.transcript_path, 'claude')
    }
    expect(steps.view(session, 40)).toEqual(parseActivity(CLAUDE, 'claude'))
  })

  it('最后一行没换行但已经完整 ⇒ 也读进来;之后接着写(先补换行)不重复', () => {
    const lines = CLAUDE.split('\n').filter(Boolean)
    const steps = makeSteps()
    file = Buffer.from(lines.slice(0, 2).join('\n'))
    expect(steps.view(session, 40)!.map(i => i.text)).toEqual(['把测试修好', '先看看', '读 a.ts'])
    file = Buffer.from(CLAUDE)
    expect(steps.view(session, 40)).toEqual(parseActivity(CLAUDE, 'claude'))
  })

  it('步的种类:你说的 = user_message、它说的 = agent_message、动作 = tool_call(报错 ⇒ failed);挂在跑着的那一轮上', () => {
    const turn = log.startTurn({ matterId: matterId(), executor: 'claude' })
    file = Buffer.from(CLAUDE)
    makeSteps().ingest('S1', session.transcript_path, 'claude')
    const items = log.items(matterId())
    expect(items.map(i => `${i.kind}:${i.status}`)).toEqual([
      'user_message:completed', 'agent_message:completed', 'tool_call:completed', 'tool_call:completed', 'tool_call:failed', 'agent_message:completed', 'tool_call:completed',
    ])
    expect(items.every(i => i.turnId === turn.id)).toBe(true)
  })

  it('第一次读一个很大的记录:只从尾巴 256KB 起、丢掉被截断的第一行(同以前「看着它跑」读的那一截)', () => {
    const filler = L({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } }) + '\n'
    const big = filler.repeat(Math.ceil(STEPS_FIRST_READ / filler.length) + 5) + CLAUDE
    file = Buffer.from(big)
    const tail = big.slice(big.length - STEPS_FIRST_READ)
    expect(makeSteps().view(session, 40)).toEqual(parseActivity(tail.slice(tail.indexOf('\n') + 1), 'claude'))
  })

  it('记录被截短了(比读到的位置还短)⇒ 从头重读;还没有那件事 ⇒ view 给 null(调用方退回直接解析)', () => {
    file = Buffer.from(CLAUDE)
    const steps = makeSteps()
    steps.ingest('S1', session.transcript_path, 'claude')
    const n = log.items(matterId()).length
    file = Buffer.from(L({ type: 'user', timestamp: T, message: { content: '重新来' } }) + '\n')
    expect(steps.view(session, 40)!.at(-1)).toMatchObject({ kind: 'you', text: '重新来' })
    expect(log.items(matterId()).length).toBe(n + 1)
    expect(steps.view({ ...session, session_id: 'nobody' }, 40)).toBeNull()
    expect(steps.view({ ...session, transcript_path: null }, 40)).toBeNull()
  })

  it('没有新内容 ⇒ 不写库(游标不动)', () => {
    file = Buffer.from(CLAUDE)
    const steps = makeSteps()
    steps.ingest('S1', session.transcript_path, 'claude')
    const before = db.query<{ value: number }, []>('SELECT value FROM matter_log_cursor').get()!.value
    steps.view(session, 40)
    expect(db.query<{ value: number }, []>('SELECT value FROM matter_log_cursor').get()!.value).toBe(before)
  })
})

describe('钩子事件 + 读记录(withTranscriptSteps)', () => {
  const hooked = (lookup: Record<string, string> = {}) => {
    const turns = makeTerminalTurnLog({ db, log, matters })
    const logs: string[] = [], timers: { fn: () => void; ms: number }[] = []
    return { logs, timers, turns: withTranscriptSteps({ turns, steps: makeSteps(), localMachine: 'mac', lookup: id => (lookup[id] ? { session_id: id, transcript_path: lookup[id] } : null), log: l => logs.push(l), later: (fn, ms) => timers.push({ fn, ms }) }) }
  }
  const kinds = (sid: string) => log.items(matters.findBySurface('cli', sid)!.id).map(i => `${i.kind}:${String(i.payload.text ?? '')}`)
  const ev = (kind: 'prompt' | 'stop' | 'session_end', sid: string, over: Record<string, unknown> = {}) => ({ source: 'claude', kind, session_id: sid, cwd: '/w/blog', machine: 'mac', ...over })

  it('第一个钩子就是 stop(部署前就开着的会话)⇒ 先建这件事再读;最后一句只有记录里那一份,不重(Codex 评审)', () => {
    file = Buffer.from(L({ type: 'user', timestamp: T, message: { content: '修一下' } }) + '\n' + L({ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text: '修好了' }] } }) + '\n')
    const { turns } = hooked()
    turns.event(ev('stop', 'S9', { text: '修好了', transcript_path: '/t/S9.jsonl' }), 1_000)
    expect(kinds('S9')).toEqual(['user_message:修一下', 'agent_message:修好了'])
    makeSteps().view({ session_id: 'S9', transcript_path: '/t/S9.jsonl', source: 'claude' }, 40)
    expect(kinds('S9')).toEqual(['user_message:修一下', 'agent_message:修好了'])
  })

  it('答完那一刻最后一句还没写进记录(真机:和钩子同一秒)⇒ 过一会儿补读一次,最后一句进步;只补一次、不重(M4d)', () => {
    file = Buffer.from(L({ type: 'user', timestamp: T, message: { content: '修一下' } }) + '\n')
    const { turns, timers } = hooked()
    turns.event(ev('prompt', 'S4', { transcript_path: '/t/S4.jsonl' }), 1_000)
    expect(timers).toEqual([])
    turns.event(ev('stop', 'S4', { text: '修好了', transcript_path: '/t/S4.jsonl' }), 2_000)
    expect(kinds('S4')).toEqual(['user_message:修一下'])
    expect(timers).toMatchObject([{ ms: STOP_SETTLE_MS }])
    file = Buffer.concat([file, Buffer.from(L({ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text: '修好了' }] } }) + '\n')])
    timers[0]!.fn()
    timers[0]!.fn()
    expect(kinds('S4')).toEqual(['user_message:修一下', 'agent_message:修好了'])
  })

  it('读不了记录 ⇒ 钩子照旧写发问那一步和最后一句(Codex 评审:别丢);记一行日志', () => {
    const turns0 = makeTerminalTurnLog({ db, log, matters })
    const logs: string[] = []
    const turns = withTranscriptSteps({ turns: turns0, steps: { ingest: () => { throw new Error('ENOENT') } }, localMachine: 'mac', lookup: () => null, log: l => logs.push(l) })
    turns.event(ev('prompt', 'S8', { transcript_path: '/gone.jsonl' }), 1_000)
    turns.event(ev('stop', 'S8', { text: '好了', transcript_path: '/gone.jsonl' }), 2_000)
    expect(kinds('S8')).toEqual(['user_message:', 'agent_message:好了'])
    expect(logs.length).toBe(2)
  })

  it('发问 → 答完:这一轮的步从记录来(发问原文、动作、最后一句),都挂在这一轮上;路径从登记处补', () => {
    const { turns } = hooked({ S7: '/t/S7.jsonl' })
    turns.event(ev('prompt', 'S7'), 1_000)
    file = Buffer.from(CLAUDE)
    turns.event(ev('stop', 'S7', { text: '有一个没过,我再改' }), 2_000)
    const id = matters.findBySurface('cli', 'S7')!.id
    const [turn] = log.turns(id)
    expect(turn).toMatchObject({ status: 'completed', endedAt: 2_000 })
    expect(log.items(id).map(i => i.turnId)).toEqual(log.items(id).map(() => turn!.id))
    expect(kinds('S7')[0]).toBe('user_message:把测试修好')
    expect(kinds('S7').filter(k => k.startsWith('agent_message'))).toEqual(['agent_message:先看看', 'agent_message:有一个没过,我再改'])
  })

  it('那边的会话(别的机器 / 经 A2A)⇒ 不读,钩子照旧写', () => {
    const { turns } = hooked()
    file = Buffer.from(CLAUDE)
    turns.event(ev('stop', 'S6', { text: '那边的', machine: 'pc', transcript_path: '/t/x.jsonl' }), 1_000)
    turns.event(ev('stop', 'S5', { text: '转来的', origin_agent: 'hand', transcript_path: '/t/x.jsonl' }), 1_000)
    expect(kinds('S6')).toEqual(['agent_message:那边的'])
    expect(kinds('S5')).toEqual(['agent_message:转来的'])
  })
})
