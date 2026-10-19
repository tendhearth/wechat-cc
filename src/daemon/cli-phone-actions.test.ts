import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import { openDb, type Db } from '../lib/db'
import { makeCliEventHub, type CliEventHub } from '../core/cli-events'
import { makeCliSessionStore } from '../core/cli-session-store'
import { makeCliPermissionRelay, type CliPermissionRelay } from '../core/cli-permission-relay'
import { makeCliReplyCore, type RunResult } from './cli-reply-handler'
import { makeCliPhoneActions, PHONE_CLI_SAY_MAX } from './cli-phone-actions'
import { mobileReadsRoute } from './mobile-reads'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

let windows: Map<string, string>
let relayed: { name: string; text: string }[]
beforeEach(() => { windows = new Map(); relayed = [] })

function actions() {
  const core = makeCliReplyCore({
    hub, log: () => {}, dangerously: false,
    run: (_cmd, args) => new Promise(done => { runs.push({ args, done }) }),
    liveWindow: {
      find: (s) => windows.has(s.session_id) ? { pid: 1, name: windows.get(s.session_id)!, kind: 'interactive' } : null,
      relay: async (w, text) => { relayed.push({ name: w.name, text }); return { ok: true } },
    },
    startCwd: () => '/w/start',
  })
  return makeCliPhoneActions({
    hub, relay, core, localMachine: 'mac', log: () => {}, liveIds: () => new Set(windows.keys()),
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
  it('主人在场 ⇒ 终端自己问,没有码,也不挂「等你批准」(主人在终端前答完不会再有事件,评审 10-15 #1)', async () => {
    hub.ingest({ source: 'claude', kind: 'prompt', session_id: 'S2', cwd: '/w/proj', machine: 'mac' })
    presence = 'present'
    await ask('S2')
    const a = actions()
    expect(status('S2')).toBe('running')
    expect(a.pendingHash('S2')).toBeNull()
    expect(a.permission({ session_id: 'S2' }, 'allow')).toEqual({ ok: false, error: 'not_found' })
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
  it('30 分钟没动静被折算成 idle(stale)⇒ 仍算 busy:可能只是一步长构建还在跑(评审 10-15 #2)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-15T00:00:00Z'))
      hub.ingest({ source: 'claude', kind: 'prompt', session_id: 'T9', cwd: '/w/proj', machine: 'mac' })
      vi.setSystemTime(new Date('2026-10-15T00:31:00Z'))
      expect(hub.list().find(v => v.session_id === 'T9')).toMatchObject({ status: 'idle', stale: true })
      expect(actions().say('T9', 'x')).toEqual({ ok: false, error: 'cli_session_busy' })
      expect(runs).toHaveLength(0)
    } finally { vi.useRealTimers() }
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

describe('开在电脑窗口里的 Claude 会话(2026-10-18):话送进窗口,不起 resume 副本', () => {
  it('在跑也能说;送进窗口;不改登记处状态(窗口自己的 hooks 报)', async () => {
    hub.ingest({ source: 'claude', kind: 'prompt', session_id: 'W1', cwd: '/w/proj/.claude/worktrees/x', machine: 'mac' })
    windows.set('W1', 'proj-fd')
    const a = actions()
    expect(a.say('W1', '手机上的一句')).toEqual({ ok: true })
    await vi.waitFor(() => expect(relayed).toEqual([{ name: 'proj-fd', text: '手机上的一句' }]))
    expect(runs).toHaveLength(0)
    expect(status('W1')).toBe('running')
    expect(a.say('W1', '又一句')).toEqual({ ok: true })   // 不排他:窗口按顺序读
  })
  it('窗口关了 ⇒ 照旧 resume,而且在会话起点的文件夹里起', async () => {
    hub.ingest({ source: 'claude', kind: 'stop', session_id: 'W2', cwd: '/w/proj/.claude/worktrees/x', machine: 'mac', text: '上一轮' })
    const a = actions()
    expect(a.say('W2', '接着')).toEqual({ ok: true })
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(relayed).toHaveLength(0)
    runs[0]!.done({ code: 0, stdout: 'ok', stderr: '', timedOut: false })
  })
  it('列表里带 live_window(只给 Claude 会话),过 schema', async () => {
    hub.ingest({ source: 'claude', kind: 'stop', session_id: 'W3', cwd: '/w/proj' })
    hub.ingest({ source: 'codex', kind: 'stop', session_id: 'W4', cwd: '/w/proj' })
    windows.set('W3', 'a'); windows.set('W4', 'b')
    const r = await mobileReadsRoute({ cliSessions: () => hub.list(), cliActions: actions() }, new URL('http://x/m/api/cli/sessions'), new Request('http://x/m/api/cli/sessions'))
    const body = await r!.json()
    PHONE_API_SCHEMAS['GET /m/api/cli/sessions']!.parse(body)
    const by = (id: string) => body.sessions.find((s: { session_id: string }) => s.session_id === id)
    expect(by('W3').live_window).toBe(true)
    expect(by('W4').live_window).toBeUndefined()
  })
})

describe('POST /m/api/cli/permission、/m/api/cli/say 与列表里的码', () => {
  const post = async (cliActions: ReturnType<typeof actions> | undefined, path: string, body: unknown, method = 'POST') => {
    const url = 'http://x' + path
    const r = await mobileReadsRoute({ ...(cliActions ? { cliActions } : {}), cliSessions: () => hub.list({ limit: 50 }) }, new URL(url), new Request(url, { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }))
    return { status: r!.status, body: await r!.json() as any }
  }
  it('列表:开了码 ⇒ pending.hash + actionable;在场 ⇒ 不挂 pending;过 schema', async () => {
    await ask('L1')
    hub.ingest({ source: 'claude', kind: 'prompt', session_id: 'L2', cwd: '/w/proj', machine: 'mac' })
    presence = 'present'
    await ask('L2')
    const a = actions()
    const r = await post(a, '/m/api/cli/sessions', null, 'GET')
    PHONE_API_SCHEMAS['GET /m/api/cli/sessions']!.parse(r.body)
    const by = (id: string) => r.body.sessions.find((s: any) => s.session_id === id)
    expect(by('L1').pending).toMatchObject({ tool: 'Bash', hash: a.pendingHash('L1'), actionable: true })
    expect(by('L2')).toMatchObject({ status: 'running', pending: null })
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

describe('看着它跑(GET /m/api/cli/activity)', () => {
  it('读本机记录尾巴 ⇒ 最近几步;过 schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-activity-'))
    try {
      const path = join(dir, 's.jsonl')
      writeFileSync(path, [
        JSON.stringify({ type: 'user', message: { content: '跑测试' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }] } }),
      ].join('\n'))
      hub.ingest({ source: 'claude', kind: 'prompt', session_id: 'A1', cwd: '/w/proj', machine: 'mac', transcript_path: path })
      const r = await mobileReadsRoute({ cliActions: actions() }, new URL('http://x/m/api/cli/activity?session_id=A1'), new Request('http://x/m/api/cli/activity?session_id=A1'))
      const body = await r!.json()
      expect(r!.status).toBe(200)
      PHONE_API_SCHEMAS['GET /m/api/cli/activity']!.parse(body)
      expect(body.items.map((i: { text: string }) => i.text)).toEqual(['跑测试', '运行 bun test'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('不认识 ⇒ 404;别的机器 ⇒ remote;没有记录 ⇒ no_transcript;参数坏 ⇒ 400', async () => {
    const a = actions()
    expect(a.activity('nope')).toEqual({ ok: false, error: 'not_found' })
    hub.ingest({ source: 'claude', kind: 'prompt', session_id: 'R1', cwd: '/w/proj', machine: 'pc', transcript_path: '/x.jsonl' })
    expect(a.activity('R1')).toEqual({ ok: false, error: 'cli_session_remote' })
    hub.ingest({ source: 'claude', kind: 'prompt', session_id: 'N1', cwd: '/w/proj', machine: 'mac' })
    expect(a.activity('N1')).toEqual({ ok: false, error: 'no_transcript' })
    hub.ingest({ source: 'claude', kind: 'prompt', session_id: 'G1', cwd: '/w/proj', machine: 'mac', transcript_path: '/definitely/not/here.jsonl' })
    expect(a.activity('G1')).toEqual({ ok: false, error: 'no_transcript' })
    const get = async (q: string) => (await mobileReadsRoute({ cliActions: a }, new URL('http://x/m/api/cli/activity' + q), new Request('http://x/m/api/cli/activity' + q)))!
    expect((await get('')).status).toBe(400)
    expect((await get('?session_id=nope')).status).toBe(404)
    expect((await get('?session_id=R1')).status).toBe(409)
    expect((await mobileReadsRoute({}, new URL('http://x/m/api/cli/activity?session_id=A'), new Request('http://x/m/api/cli/activity?session_id=A')))!.status).toBe(503)
  })
})

describe('列表一眼:在跑的会话带此刻那一步', () => {
  it('currentStep 取最后一步(不带 detail);主人刚说完 ⇒ null;列表只给在跑的带 now', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-now-'))
    try {
      const path = join(dir, 's.jsonl')
      const tool = (id: string, name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
      writeFileSync(path, [JSON.stringify({ type: 'user', message: { content: '跑' } }), tool('a', 'Edit', { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' }), tool('b', 'Bash', { command: 'npm test' })].join('\n'))
      hub.ingest({ source: 'claude', kind: 'prompt', session_id: 'N1', cwd: '/w/proj', machine: 'mac', transcript_path: path })
      const a = actions()
      expect(a.currentStep('N1')).toMatchObject({ kind: 'step', text: '运行 npm test', verb: 'run', target: 'npm test' })
      expect(a.currentStep('N1')!.detail).toBeUndefined()
      const r = await mobileReadsRoute({ cliActions: a, cliSessions: () => hub.list() }, new URL('http://x/m/api/cli/sessions'), new Request('http://x/m/api/cli/sessions'))
      const body = await r!.json()
      PHONE_API_SCHEMAS['GET /m/api/cli/sessions']!.parse(body)
      expect(body.sessions.find((x: { session_id: string }) => x.session_id === 'N1').now.text).toBe('运行 npm test')
      writeFileSync(path, JSON.stringify({ type: 'user', message: { content: '再来' } }))
      expect(a.currentStep('N1')).toBeNull()
      hub.ingest({ source: 'claude', kind: 'stop', session_id: 'N1', cwd: '/w/proj', machine: 'mac', text: '好了' })
      writeFileSync(path, tool('c', 'Bash', { command: 'ls' }))
      const idle = await (await mobileReadsRoute({ cliActions: a, cliSessions: () => hub.list() }, new URL('http://x/m/api/cli/sessions'), new Request('http://x/m/api/cli/sessions')))!.json()
      expect(idle.sessions.find((x: { session_id: string }) => x.session_id === 'N1').now).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
