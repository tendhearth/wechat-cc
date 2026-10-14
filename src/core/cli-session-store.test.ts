import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../lib/db'
import { makeCliEventHub, type CliEvent } from './cli-events'
import {
  makeCliSessionStore, effectiveStatus, sortCliSessionViews, toCliSessionView,
  CLI_SESSION_STALE_MS, CLI_SESSION_ENDED_RETAIN_MS, CLI_SESSION_ABANDONED_RETAIN_MS, CLI_SESSION_MAX_ROWS,
} from './cli-session-store'

let db: Db
let clock: number
beforeEach(() => { db = openDb({ path: ':memory:' }); clock = 1_000_000 })
afterEach(() => { db.close() })

const SID = 'a1b2c3d4-0000-1111'
const ev = (over: Partial<CliEvent> = {}): CliEvent => ({ source: 'claude', kind: 'prompt', session_id: SID, cwd: '/home/u/work/wechat-cc', ...over })

function hub() {
  return makeCliEventHub({
    send: async () => 'sent', projectName: (c) => c, log: () => {},
    now: () => clock, store: makeCliSessionStore(db, () => clock),
  })
}

describe('终端会话登记处:状态从已有 hook 事件推导(v76)', () => {
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
    expect(h.list()[0]!.status).toBe('waiting')   // 过期 ⇒ 终端自己问,仍在等
    h.permissionSettled(SID, 'allow')
    ;[v] = h.list()
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
    const h = makeCliEventHub({ send: async (t) => { sent.push(t); return 'sent' }, projectName: (c) => c, log: () => {}, now: () => clock, store: makeCliSessionStore(db, () => clock), holds: { stop: 0 } })
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
    const now = 100 * 24 * 3600_000
    store.touch({ session_id: 'ended-old', source: 'claude', cwd: '/w' }, now - CLI_SESSION_ENDED_RETAIN_MS - 1)
    store.setStatus('ended-old', 'ended', now - CLI_SESSION_ENDED_RETAIN_MS - 1)
    store.touch({ session_id: 'ended-recent', source: 'claude', cwd: '/w' }, now - 1000)
    store.setStatus('ended-recent', 'ended', now - 1000)
    store.touch({ session_id: 'abandoned', source: 'codex', cwd: '/w' }, now - CLI_SESSION_ABANDONED_RETAIN_MS - 1)
    store.touch({ session_id: 'idle-week', source: 'codex', cwd: '/w' }, now - CLI_SESSION_ENDED_RETAIN_MS - 1)
    store.prune(now)
    expect(store.list({ includeEnded: true }).map(r => r.session_id).sort()).toEqual(['ended-recent', 'idle-week'])

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
