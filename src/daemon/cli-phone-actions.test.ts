import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import { openDb, type Db } from '../lib/db'
import { makeCliEventHub, type CliEventHub } from '../core/cli-events'
import { makeCliSessionStore } from '../core/cli-session-store'
import { makeCliPermissionRelay, type CliPermissionRelay } from '../core/cli-permission-relay'
import { makeCliReplyCore, type RunResult } from './cli-reply-handler'
import { makeCliPhoneActions, PHONE_CLI_SAY_MAX } from './cli-phone-actions'
import { mobileReadsRoute } from './mobile-reads'

/**
 * 手机拍板 / 说一句,拿真的 hub + 登记处 + 中继 + core 拼起来:只把「微信」(askUser 与它的
 * PendingPermissions)和「起进程」换成假的。拍板走的就是微信 y/n 那一份 consume。
 */
let db: Db
let hub: CliEventHub
let relay: CliPermissionRelay
let presence: 'present' | 'away'
let waiting: Map<string, (d: 'allow' | 'deny' | 'timeout' | 'undelivered') => void>
let runs: { args: string[]; done: (r: RunResult) => void }[]
let other: Map<string, boolean>

beforeEach(() => {
  db = openDb({ path: ':memory:' })
  hub = makeCliEventHub({ send: async () => 'sent', projectName: (c) => c.split('/').pop()!, log: () => {}, store: makeCliSessionStore(db) })
  presence = 'away'
  waiting = new Map()
  other = new Map([['selfx', true]])   // 别的待批(比如自改流水线)—— 手机这口不许碰
  runs = []
  relay = makeCliPermissionRelay({
    ask: (_p, hash) => new Promise(r => { waiting.set(hash, r) }),
    presence: async () => presence,
    projectName: (c) => c, onRelayed: () => {}, log: () => {},
    onAsked: (req) => hub.permissionAsked(req),
    onSettled: (s, st) => hub.permissionSettled(s, st),
  })
})
afterEach(() => { relay.dispose(); hub.dispose(); db.close() })

function actions() {
  const core = makeCliReplyCore({
    hub, log: () => {}, dangerously: false,
    run: (_cmd, args) => new Promise(done => { runs.push({ args, done }) }),
  })
  return makeCliPhoneActions({
    hub, relay, core, localMachine: 'mac', log: () => {},
    // = ilink.resolvePermission:consume 一条待批(哪一种都行),回 true/false
    resolve: (h, d) => {
      const w = waiting.get(h)
      if (w) { waiting.delete(h); w(d); return true }
      return other.delete(h)
    },
  })
}

const ask = (session_id: string) => relay.open({ source: 'claude', session_id, cwd: '/w/proj', tool_name: 'Bash', summary: 'rm -rf ./tmp' })
const status = (id: string) => hub.list({ includeEnded: true }).find(v => v.session_id === id)?.status
const flush = () => new Promise(r => setTimeout(r, 0))

describe('手机拍板终端会话的待批(同微信 y/n)', () => {
  it('主人不在 ⇒ 中继开了码:按会话 id 拍 ⇒ 回 running;再拍 ⇒ stale', async () => {
    hub.ingest({ source: 'claude', kind: 'prompt', session_id: 'S1', cwd: '/w/proj' })
    await ask('S1')
    expect(status('S1')).toBe('waiting')
    const a = actions()
    const hash = a.pendingHash('S1')
    expect(hash).toMatch(/^[a-z0-9]{5}$/)
    expect(a.permission({ session_id: 'S1' }, 'allow')).toEqual({ ok: true })
    await flush()
    expect(status('S1')).toBe('running')
    expect(a.permission({ hash: hash! }, 'deny')).toEqual({ ok: false, error: 'cli_permission_stale' })
  })
  it('主人在场 ⇒ 终端自己问,没有码:waiting 但 not_actionable', async () => {
    presence = 'present'
    await ask('S2')
    const a = actions()
    expect(status('S2')).toBe('waiting')
    expect(a.pendingHash('S2')).toBeNull()
    expect(a.permission({ session_id: 'S2' }, 'allow')).toEqual({ ok: false, error: 'cli_not_actionable' })
    expect(a.permission({ session_id: 'nope' }, 'allow')).toEqual({ ok: false, error: 'not_found' })
  })
  it('只认终端中继开的码:别的待批(自改)手机这口批不了;码与会话对不上也不行', async () => {
    await ask('S3')
    const a = actions()
    expect(a.permission({ hash: 'selfx' }, 'allow')).toEqual({ ok: false, error: 'cli_permission_stale' })
    expect(other.has('selfx')).toBe(true)
    await ask('S4')
    expect(a.permission({ hash: a.pendingHash('S3')!, session_id: 'S4' }, 'allow')).toEqual({ ok: false, error: 'cli_permission_stale' })
  })
})

describe('手机对终端会话说一句(同微信 @码)', () => {
  it('歇着 ⇒ 收下;开跑即 running(再说 ⇒ busy);跑完结果成为下一句 last_summary', async () => {
    hub.ingest({ source: 'claude', kind: 'prompt', session_id: 'T1', cwd: '/w/proj', machine: 'mac' })
    hub.ingest({ source: 'claude', kind: 'stop', session_id: 'T1', cwd: '/w/proj', machine: 'mac', text: '上一轮' })
    const a = actions()
    expect(a.say('T1', '再跑一次测试')).toEqual({ ok: true })
    expect(status('T1')).toBe('running')
    expect(a.say('T1', '又一句')).toEqual({ ok: false, error: 'cli_session_busy' })
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0]!.args).toContain('再跑一次测试')
    runs[0]!.done({ code: 0, stdout: '**全绿** 了', stderr: '', timedOut: false })
    await vi.waitFor(() => expect(status('T1')).toBe('idle'))
    expect(hub.list().find(v => v.session_id === 'T1')!.last_summary).toBe('全绿 了')
  })
  it('在等批准 ⇒ busy;结束 ⇒ ended;没见过 ⇒ not_found;那边的会话 ⇒ remote_session', async () => {
    await ask('T2')
    const a = actions()
    expect(a.say('T2', 'x')).toEqual({ ok: false, error: 'cli_session_busy' })
    hub.ingest({ source: 'codex', kind: 'session_end', session_id: 'T3', cwd: '/w/proj' })
    expect(a.say('T3', 'x')).toEqual({ ok: false, error: 'cli_session_ended' })
    expect(a.say('nope', 'x')).toEqual({ ok: false, error: 'not_found' })
    hub.ingest({ source: 'claude', kind: 'stop', session_id: 'T4', cwd: '/w/proj', machine: 'win-test' })
    expect(a.say('T4', 'x')).toEqual({ ok: false, error: 'cli_session_remote' })
    expect(runs).toHaveLength(0)
  })
})

describe('POST /m/api/cli/permission、/m/api/cli/say 与列表里的码', () => {
  const post = async (cliActions: ReturnType<typeof actions> | undefined, path: string, body: unknown, method = 'POST') => {
    const url = 'http://x' + path
    const r = await mobileReadsRoute({ ...(cliActions ? { cliActions } : {}), cliSessions: () => hub.list({ limit: 50 }) }, new URL(url), new Request(url, { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }))
    return { status: r!.status, body: await r!.json() as any }
  }
  it('列表:开了码 ⇒ pending.hash + actionable;在场 ⇒ actionable:false;过 schema', async () => {
    await ask('L1')
    presence = 'present'
    await ask('L2')
    const a = actions()
    const r = await post(a, '/m/api/cli/sessions', null, 'GET')
    PHONE_API_SCHEMAS['GET /m/api/cli/sessions']!.parse(r.body)
    const by = (id: string) => r.body.sessions.find((s: any) => s.session_id === id)
    expect(by('L1').pending).toMatchObject({ tool: 'Bash', hash: a.pendingHash('L1'), actionable: true })
    expect(by('L2').pending).toMatchObject({ hash: null, actionable: false })
  })
  it('拍板:200 / 409 / 404 / 400 / 405 / 503,过 schema', async () => {
    await ask('P1')
    const a = actions()
    const s = PHONE_API_SCHEMAS['POST /m/api/cli/permission']!
    const ok = await post(a, '/m/api/cli/permission', { session_id: 'P1', decision: 'allow' })
    expect(ok).toEqual({ status: 200, body: { ok: true } }); s.parse(ok.body)
    const stale = await post(a, '/m/api/cli/permission', { hash: 'abcde', decision: 'allow' })
    expect(stale.status).toBe(409); s.parse(stale.body)
    expect((await post(a, '/m/api/cli/permission', { session_id: 'nope', decision: 'deny' })).status).toBe(404)
    expect((await post(a, '/m/api/cli/permission', { session_id: 'P1', decision: 'maybe' })).status).toBe(400)
    expect((await post(a, '/m/api/cli/permission', { decision: 'allow' })).status).toBe(400)
    expect((await post(a, '/m/api/cli/permission', { hash: 'NOT-A-HASH', decision: 'allow' })).status).toBe(400)
    expect((await post(a, '/m/api/cli/permission', null, 'GET')).status).toBe(405)
    expect((await post(undefined, '/m/api/cli/permission', { session_id: 'P1', decision: 'allow' })).status).toBe(503)
  })
  it('说一句:收下 200 accepted;busy 409;空 / 太长 400;过 schema', async () => {
    hub.ingest({ source: 'claude', kind: 'stop', session_id: 'Y1', cwd: '/w/proj' })
    const a = actions()
    const s = PHONE_API_SCHEMAS['POST /m/api/cli/say']!
    const ok = await post(a, '/m/api/cli/say', { session_id: 'Y1', text: '  接着做  ' })
    expect(ok).toEqual({ status: 200, body: { ok: true, accepted: true } }); s.parse(ok.body)
    const busy = await post(a, '/m/api/cli/say', { session_id: 'Y1', text: '再一句' })
    expect(busy).toEqual({ status: 409, body: { ok: false, error: 'cli_session_busy' } }); s.parse(busy.body)
    expect((await post(a, '/m/api/cli/say', { session_id: 'Y1', text: '   ' })).status).toBe(400)
    expect((await post(a, '/m/api/cli/say', { session_id: 'Y1', text: 'x'.repeat(PHONE_CLI_SAY_MAX + 1) })).status).toBe(400)
    expect((await post(a, '/m/api/cli/say', { text: 'x' })).status).toBe(400)
    expect((await post(a, '/m/api/cli/say', { session_id: 'nope', text: 'x' })).status).toBe(404)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0]!.args).toContain('接着做')
    runs[0]!.done({ code: 0, stdout: 'ok', stderr: '', timedOut: false })
  })
})
