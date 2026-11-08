import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../../lib/db'
import { makeCliEventHub, type CliEvent } from '../../app/cli-events'
import { makeCliSessionStore, CLI_SESSION_ENDED_RETAIN_MS, CLI_SESSION_ABANDONED_RETAIN_MS, CLI_SESSION_MAX_ROWS } from './cli-session-store'
import { makeMatterLog } from './matter-log'
import { makeMatterStore } from './matters-store'
import { makeTerminalTurnLog } from './terminal-turns'
import { effectiveStatus, sortCliSessionViews, toCliSessionView, CLI_SESSION_STALE_MS } from '../../domain/cli-session-view'

let db: Db
let clock: number
beforeEach(() => { db = openDb({ path: ':memory:' }); clock = 1_000_000 })
afterEach(() => { db.close() })

const SID = 'a1b2c3d4-0000-1111'
const ev = (over: Partial<CliEvent> = {}): CliEvent => ({ source: 'claude', kind: 'prompt', session_id: SID, cwd: '/home/u/work/wechat-cc', ...over })

/** 真登记处 + 真那件事(M4d 第 2 步起状态只从这件事推,登记处不再记状态)。 */
const terminalTurns = () => makeTerminalTurnLog({ db, log: makeMatterLog(db, () => clock), matters: makeMatterStore(db, () => clock) })
function hub() {
  return makeCliEventHub({
    send: async () => 'sent', projectName: (c) => c, log: () => {},
    now: () => clock, store: makeCliSessionStore(db, () => clock), turns: terminalTurns(),
  })
}

describe('终端会话登记处:状态从已有 hook 事件推导(v76;M4d 起经那件事)', () => {
  it('prompt → running;权限 → waiting(带待批摘要);allow → running;stop → idle(带一句);session_end → ended', () => {
    const h = hub()
    h.ingest(ev({ transcript_path: '/t/a.jsonl', machine: 'mac' }))
    let [v] = h.list()
    expect(v).toMatchObject({ session_id: SID, code: 'a1b2c3', status: 'running', project: 'wechat-cc', cwd: '/home/u/work/wechat-cc', machine: 'mac', last_prompt_at: clock, pending: null, stale: false })

    clock += 1000
    h.permissionAsked({ source: 'claude', session_id: SID, cwd: '/home/u/work/wechat-cc', tool_name: 'Bash', summary: 'rm -rf ./tmp' })
    ;[v] = h.list()
    expect(v!.status).toBe('waiting')
    expect(v!.pending).toEqual({ tool: 'Bash', summary: 'rm -rf ./tmp', since: clock })

    clock += 1000
    h.permissionSettled(SID, 'timeout')
    ;[v] = h.list()   // 过期 ⇒ 终端自己问,主人在终端前答不会再有事件 —— 不挂「等你批准」(评审 10-15 #1)
    expect(v!.status).toBe('running')
    expect(v!.pending).toBeNull()

    clock += 1000
    h.ingest(ev({ kind: 'stop', text: '## 搞定\n\n**测试**全过了' }))
    ;[v] = h.list()
    expect(v!.status).toBe('idle')
    expect(v!.last_summary).toBe('搞定 测试全过了')

    clock += 1000
    h.ingest(ev({ kind: 'session_end' }))
    expect(h.list()).toEqual([])
    expect(h.list({ includeEnded: true })[0]!.status).toBe('ended')
    expect(h.lookup('a1b2c3')).toBeNull()   // 同改造前:结束了就不认
    h.dispose()
  })

  it('自动 prompt 也是 running,但不刷 last_prompt_at;已 Stop 的会话迟到的 allow 不倒回 running', () => {
    const h = hub()
    h.ingest(ev())
    const first = clock
    clock += 5000
    h.ingest(ev({ automated: true }))
    expect(h.list()[0]).toMatchObject({ status: 'running', last_prompt_at: first, last_event_at: clock })
    h.permissionAsked({ source: 'claude', session_id: SID, cwd: '/w', tool_name: 'Edit' })
    h.ingest(ev({ kind: 'stop' }))
    h.permissionSettled(SID, 'deny')
    expect(h.list()[0]!.status).toBe('idle')
    expect(h.list()[0]!.last_summary).toBeNull()
    h.dispose()
  })

  it('running / waiting 超过 30 分钟没事件 ⇒ 读成 idle + stale(不跑定时器);idle / ended 不受影响', () => {
    const base = { last_event_at: 0 }
    expect(effectiveStatus({ ...base, status: 'running' }, CLI_SESSION_STALE_MS)).toEqual({ status: 'running', stale: false })
    expect(effectiveStatus({ ...base, status: 'running' }, CLI_SESSION_STALE_MS + 1)).toEqual({ status: 'idle', stale: true })
    expect(effectiveStatus({ ...base, status: 'waiting' }, CLI_SESSION_STALE_MS + 1)).toEqual({ status: 'idle', stale: true })
    expect(effectiveStatus({ ...base, status: 'ended' }, CLI_SESSION_STALE_MS * 10)).toEqual({ status: 'ended', stale: false })

    const h = hub()
    h.permissionAsked({ source: 'codex', session_id: SID, cwd: '/w/p', tool_name: 'shell' })
    clock += CLI_SESSION_STALE_MS + 1
    const [v] = h.list()
    expect(v).toMatchObject({ status: 'idle', stale: true, pending: null })
    h.dispose()
  })

  it('排序:等你批准的在最前,其余按最近事件倒序', () => {
    const h = hub()
    h.ingest(ev({ session_id: 'old-waiting' }))
    clock += 10
    h.permissionAsked({ source: 'claude', session_id: 'old-waiting', cwd: '/w/a', tool_name: 'Bash' })
    clock += 10
    h.ingest(ev({ session_id: 'idle-newer', kind: 'stop' }))
    clock += 10
    h.ingest(ev({ session_id: 'running-newest' }))
    expect(h.list().map(v => v.session_id)).toEqual(['old-waiting', 'running-newest', 'idle-newer'])
    h.dispose()
  })

  it('daemon 重启(hub 重建)后,「看 码」「@码」照样按短码认得,transcript / 机器 / 来源都在', () => {
    const h1 = hub()
    h1.ingest(ev({ transcript_path: '/t/a.jsonl', machine: 'mac', origin_agent: 'hand-1' }))
    h1.ingest(ev({ kind: 'stop', text: 'ok' }))
    h1.dispose()

    const h2 = hub()
    const s = h2.lookup('A1B2C3')
    expect(s).toMatchObject({ session_id: SID, source: 'claude', cwd: '/home/u/work/wechat-cc', transcript_path: '/t/a.jsonl', machine: 'mac', origin_agent: 'hand-1' })
    expect(h2.sessions().map(x => x.session_id)).toEqual([SID])
    expect(h2.list()[0]).toMatchObject({ status: 'idle', last_summary: 'ok' })
    expect(h2.lookup('zzz')).toBeNull()
    expect(h2.lookup('%')).toBeNull()   // LIKE 通配符被转义
    h2.dispose()
  })

  it('observe 只登记不推(手侧转给脑时本机也记一笔)', async () => {
    const sent: string[] = []
    const h = makeCliEventHub({ send: async (t) => { sent.push(t); return 'sent' }, projectName: (c) => c, log: () => {}, now: () => clock, store: makeCliSessionStore(db, () => clock), turns: terminalTurns(), holds: { stop: 0 } })
    h.observe(ev({ kind: 'stop', text: '完了' }))
    expect(h.pending()).toEqual([])
    expect(h.list()[0]).toMatchObject({ status: 'idle', last_summary: '完了' })
    expect(h.lookup('a1b2')?.session_id).toBe(SID)
    await h.flush()
    expect(sent).toEqual([])
    h.dispose()
  })

  it('touch 不会用空 cwd / 缺省字段盖掉已知值', () => {
    const store = makeCliSessionStore(db, () => clock)
    store.touch({ session_id: SID, source: 'claude', cwd: '/w/p', machine: 'mac', transcript_path: '/t' }, 1)
    store.touch({ session_id: SID, source: 'claude', cwd: '' }, 2)
    expect(store.get(SID)).toMatchObject({ cwd: '/w/p', machine: 'mac', transcript_path: '/t', last_event_at: 2, created_at: 1 })
  })

  it('修剪:结束超过 7 天的、30 天没动静的、超过 500 行的最旧部分', () => {
    const store = makeCliSessionStore(db, () => clock)
    const turns = terminalTurns()
    const now = 100 * 24 * 3600_000
    const seen = (session_id: string, kind: 'stop' | 'session_end', at: number) => {
      store.touch({ session_id, source: 'claude', cwd: '/w' }, at)
      turns.event({ source: 'claude', kind, session_id, cwd: '/w' }, at)
    }
    seen('ended-old', 'session_end', now - CLI_SESSION_ENDED_RETAIN_MS - 1)
    seen('ended-recent', 'session_end', now - 1000)
    store.touch({ session_id: 'abandoned', source: 'codex', cwd: '/w' }, now - CLI_SESSION_ABANDONED_RETAIN_MS - 1)
    seen('idle-week', 'stop', now - CLI_SESSION_ENDED_RETAIN_MS - 1)
    // 没有那件事的读成歇着 ⇒ 不按「结束超过 7 天」修,只按 30 天没动静
    store.touch({ session_id: 'no-matter-week', source: 'codex', cwd: '/w' }, now - CLI_SESSION_ENDED_RETAIN_MS - 1)
    store.prune(now)
    expect(store.list({ includeEnded: true }).map(r => r.session_id).sort()).toEqual(['ended-recent', 'idle-week', 'no-matter-week'])

    for (let i = 0; i < CLI_SESSION_MAX_ROWS + 5; i++) store.touch({ session_id: `s${i}`, source: 'claude', cwd: '/w' }, now + i)
    store.prune(now + CLI_SESSION_MAX_ROWS + 5)
    const rows = store.list({ includeEnded: true })
    expect(rows.length).toBe(CLI_SESSION_MAX_ROWS)
    expect(rows[0]!.session_id).toBe(`s${CLI_SESSION_MAX_ROWS + 4}`)
    expect(store.get('s0')).toBeNull()
  })

  it('没接 store 的 hub(老路径)list 退回内存表,状态一律 idle', () => {
    const h = makeCliEventHub({ send: async () => 'sent', projectName: (c) => c, log: () => {}, now: () => clock })
    h.ingest(ev())
    expect(h.list()).toMatchObject([{ session_id: SID, status: 'idle', stale: false }])
    h.dispose()
  })

  it('toCliSessionView / sortCliSessionViews 是纯函数', () => {
    const row = { session_id: 'abcdef123', source: 'codex' as const, cwd: 'C:\\w\\proj', machine: null, transcript_path: null, origin_agent: null, status: 'waiting' as const, last_event_at: 5, last_prompt_at: null, last_summary: null, pending_tool: 'shell', pending_summary: 'ls', pending_at: 4, created_at: 1 }
    const v = toCliSessionView(row, 10)
    expect(v).toMatchObject({ code: 'abcdef', project: 'proj', pending: { tool: 'shell', summary: 'ls', since: 4 } })
    const a = { ...v, session_id: 'a', status: 'idle' as const, last_event_at: 100 }
    expect(sortCliSessionViews([a, v]).map(x => x.session_id)).toEqual(['abcdef123', 'a'])
  })
})

describe('M4d:状态 / 最近一句 / 等你那一项从那件 terminal 的事推(第 2 步起登记处没有这几列)', () => {
  const live = () => {
    const log = makeMatterLog(db), matters = makeMatterStore(db)
    const turns = makeTerminalTurnLog({ db, log, matters })
    const h = makeCliEventHub({ send: async () => 'sent', projectName: (c) => c, log: () => {}, now: () => clock, store: makeCliSessionStore(db, () => clock), turns })
    return { h, turns, log, matters }
  }
  it('一串事件走下来:状态、等你那一项、最近一句都对;最近一句读时去 markdown、压成一行', () => {
    const { h } = live()
    h.ingest(ev())
    expect(h.list()[0]).toMatchObject({ status: 'running', last_prompt_at: clock, pending: null })
    clock += 1000
    h.permissionAsked({ source: 'claude', session_id: SID, cwd: '/home/u/work/wechat-cc', tool_name: 'Bash', summary: 'ls  *.ts\n| head' })
    expect(h.list()[0]).toMatchObject({ status: 'waiting', pending: { tool: 'Bash', summary: 'ls *.ts | head', since: expect.any(Number) } })
    h.permissionSettled(SID, 'allow')
    expect(h.list()[0]).toMatchObject({ status: 'running', pending: null })
    clock += 1000
    clock += 500
    h.ingest(ev())
    h.ingest(ev({ kind: 'stop', text: '**改好了**\n\n三处 `a.ts`' }))
    expect(h.list()[0]).toMatchObject({ status: 'idle', last_summary: '改好了 三处 a.ts' })
    const asked = clock
    clock += 1000
    h.ingest(ev({ automated: true }))
    expect(h.list()[0]).toMatchObject({ status: 'running', last_prompt_at: asked })
    clock += 1000
    h.ingest(ev({ kind: 'session_end' }))
    expect(h.list()).toEqual([])
    expect(h.list({ includeEnded: true })[0]).toMatchObject({ status: 'ended' })
    expect(h.lookup('a1b2')).toBeNull()
  })
  it('daemon 重启:还有动静的轮照旧在做;开着的卡作废了 ⇒ 不再显示等你', () => {
    const first = live()
    first.h.ingest(ev())
    first.h.permissionAsked({ source: 'claude', session_id: SID, cwd: '/home/u/work/wechat-cc', tool_name: 'Bash', summary: 'ls' })
    expect(first.h.list()[0]).toMatchObject({ status: 'waiting' })
    const again = live()
    again.turns.interruptAll(Date.now())
    expect(again.h.list()[0]).toMatchObject({ status: 'running', pending: null })
  })
  it('登记处只留指针和事实:表里没有 status / last_summary / pending_* 这几列(v100)', () => {
    const cols = db.query<{ name: string }, []>('PRAGMA table_info(cli_sessions)').all().map(c => c.name)
    expect(cols).toEqual(['session_id', 'source', 'cwd', 'machine', 'transcript_path', 'origin_agent', 'last_event_at', 'last_prompt_at', 'created_at'])
  })
  it('没有那件事(写轮失败的那几条;老会话 v100 都补建了)⇒ 当歇着:照样列出来、「@码」认得;没有最近一句 / 等你那一项;下一个钩子事件就建上', () => {
    const store = makeCliSessionStore(db, () => clock)
    store.touch({ session_id: SID, source: 'claude', cwd: '/w/p', transcript_path: '/t.jsonl' }, clock)
    store.seen(SID, clock, { promptAt: clock })
    expect(db.query('SELECT count(*) n FROM matter_bindings').get()).toEqual({ n: 0 })
    expect(store.list().map(r => r.session_id)).toEqual([SID])
    expect(store.findByPrefix('a1b2')?.session_id).toBe(SID)
    expect(store.get(SID)).toMatchObject({ status: 'idle', last_summary: null, pending_tool: null, pending_summary: null, pending_at: null, last_prompt_at: clock, transcript_path: '/t.jsonl' })
    live().h.ingest(ev())
    expect(store.get(SID)).toMatchObject({ status: 'running' })
  })
})
