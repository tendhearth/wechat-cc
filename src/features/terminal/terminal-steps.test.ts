import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../../lib/db'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeTerminalStepStore } from '../../adapters/store/terminal-steps'
import type { MatterLog, MatterStore } from '../../ports/matters'
import { parseActivity } from './cli-activity'
import { makeTerminalSteps, STEPS_FIRST_READ, type TerminalSteps } from './terminal-steps'

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
