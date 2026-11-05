/**
 * P3e 一件事上的动作收进 `/v1/matter/*`(设计稿 docs/superpowers/specs/2026-11-05-p3-one-route-family-design.md「P3e」):
 * 一个动作一个处理器(routes-matter-actions.ts,MattersService 那一层),两种调用方两份参数。这里盯三件事:
 *   1. 桌面装着的 .app 还在调的 `/v1/workbench/*` 双胞胎(wire-compat.ts 里读的人 = desktop):旧键和新键是同一个处理器,
 *      operator 从 127.0.0.1 打两条,状态码与正文字节一样(成功、参数不对、服务里抛的);
 *   2. 手机令牌从面板那一口走新键:语义同并之前的 `/m/api/matter/*`(runId 过期判断、按块读成果、交办记手机表面),错误码是
 *      桌面那一列(别名才换回 phone 那一列);桌面那一份的参数(expectedRunId、整份成果)手机令牌用不了;
 *   3. 链接令牌只够得着停下(同别名行冻结的 write),别的 403。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTempDir } from '../../lib/test-temp'
import { createInternalApi, type InternalApi } from './index'
import { makeSettingsPanel, type SettingsPanel } from '../../features/phone/settings-panel'
import { makeMattersService } from '../../app/matters/service'
import { WIRE_ROUTE_ALIASES } from '@wechat-cc/protocol'

const OWNER = 'owner@im.wechat'
const ID = 'deadbeef'
const RUN = '33333333-3333-4333-8333-333333333333'
const REQ = '22222222-2222-4222-8222-222222222222'
const ART = '44444444-4444-4444-8444-444444444444'
const SHA = 'ab'.repeat(32)
const TASK = { id: ID, title: '修登录', status: 'running', providerId: 'claude', path: '/w/app', error: null, updatedAt: 1 }
const CONTENT = Buffer.from('# 报告\n全过。\n')

let stateDir: string, api: InternalApi, panel: SettingsPanel, localBase: string, operator: string, device: string, link: string
type WbFn = 'detail' | 'cancel' | 'resolvePermission' | 'resolveAnswer' | 'artifact' | 'handOff' | 'worktreeAction' | 'scriptAction' | 'createEntry' | 'entryReceipt'
let wb: Record<WbFn, ReturnType<typeof vi.fn>>

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'panel-v1-matter-actions-'))
  wb = {
    detail: vi.fn(() => ({ task: TASK, events: [], runId: RUN, permissions: [{ id: REQ, taskId: ID, tool: 'Bash', description: 'rm', createdAt: 1 }], questions: [{ id: REQ, taskId: ID }], artifacts: [{ id: ART, taskId: ID, name: 'r.md', mime: 'text/markdown', size: CONTENT.length, sha256: SHA }], inputs: [] })),
    cancel: vi.fn(async () => ({ ...TASK, status: 'cancelling' })),
    resolvePermission: vi.fn(), resolveAnswer: vi.fn(),
    artifact: vi.fn(() => ({ name: 'r.md', mime: 'text/markdown', size: CONTENT.length, sha256: SHA, contentBase64: CONTENT.toString('base64') })),
    handOff: vi.fn(() => ({ taskId: 'cafebabe', created: true })),
    worktreeAction: vi.fn(() => ({ branch: 'cc/deadbeef', committed: true, sha: 'abc1234', mergeHint: 'git merge cc/deadbeef' })),
    scriptAction: vi.fn(async () => ({ branch: 'cc/deadbeef', scripts: null, port: null })),
    createEntry: vi.fn((input: { requestId: string }) => ({ receipt: { requestId: input.requestId, taskId: ID, matterId: ID, runId: RUN, acceptedAt: 1 }, task: TASK })),
    entryReceipt: vi.fn((requestId: string) => requestId === REQ ? { receipt: { requestId, taskId: ID, matterId: ID, runId: RUN, acceptedAt: 1 }, task: TASK } : null),
  }
  const store = { get: (id: string) => id === ID ? { id, kind: 'task', ownerChatId: OWNER } : null, bind: vi.fn() }
  const matters = makeMattersService({ store: store as never, ownerChatId: () => OWNER, workbench: wb as never })
  api = createInternalApi({ stateDir, daemonPid: 1, matters, resolveAdminChatId: () => OWNER })
  const s = await api.start()
  localBase = `http://127.0.0.1:${s.port}`
  operator = readFileSync(s.operatorTokenFilePath, 'utf8').trim()
  panel = makeSettingsPanel({
    stateDir, ownerChatId: () => OWNER, chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {},
    log: () => {}, tokens: api.panelTokens, v1: api.panelDispatch,
  })
  device = ((await (await panel.handleRequest(new Request(`http://127.0.0.1:1/set/api/pair?t=${panel.issueToken()}`, { method: 'POST' }))).json()) as { device_token: string }).device_token
  link = panel.issueToken()
})
afterEach(async () => {
  await panel.stop()
  await api.stop()
  removeTempDir(stateDir)
})

const viaPanel = (path: string, tok: { d: string } | { t: string }, init: RequestInit = {}) =>
  panel.handleRequest(new Request(`http://127.0.0.1:1${path}${path.includes('?') ? '&' : '?'}${'d' in tok ? `d=${tok.d}` : `t=${tok.t}`}`, init))
const viaLocal = (path: string, init: RequestInit = {}) =>
  fetch(`${localBase}${path}`, { ...init, headers: { 'content-type': 'application/json', Authorization: `Bearer ${operator}` } })
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const raw = async (r: Response) => ({ status: r.status, body: await r.text() })

/** 桌面那半的别名行(旧键 /v1/workbench/* → 新键 /v1/matter/*)。 */
const DESKTOP = WIRE_ROUTE_ALIASES.filter(r => r.from.includes(' /v1/'))
const pathOf = (k: string) => k.slice(k.indexOf(' ') + 1)
/** 每条桌面双胞胎:一份成功的、一份参数不对的、一份服务里抛的(桌面那一份的参数)。 */
const DESKTOP_CASES: Record<string, { ok: string | object; bad: string | object; boom: [WbFn, string | object] }> = {
  '/v1/matter/stop': { ok: { id: ID, expectedRunId: 'run-1' }, bad: { id: ID, expectedRunId: 'bad run!' }, boom: ['cancel', { id: ID }] },
  '/v1/matter/permission': { ok: { id: ID, requestId: REQ, decision: 'allow' }, bad: { id: ID, requestId: REQ, decision: 'maybe' }, boom: ['resolvePermission', { id: ID, requestId: REQ, decision: 'deny' }] },
  '/v1/matter/answer': { ok: { id: ID, requestId: REQ, answers: { q: ['a'] } }, bad: { id: ID, requestId: 'x', answers: null }, boom: ['resolveAnswer', { id: ID, requestId: REQ, answers: null }] },
  '/v1/matter/artifact': { ok: `?id=${ID}&artifactId=${ART}`, bad: `?id=${ID}&artifactId=NOPE`, boom: ['artifact', `?id=${ID}&artifactId=${ART}`] },
  '/v1/matter/handoff': { ok: { id: ID, requestId: REQ, providerId: 'codex' }, bad: { id: ID, requestId: REQ, providerId: 'codex', extra: 1 }, boom: ['handOff', { id: ID, requestId: REQ, providerId: 'codex' }] },
  '/v1/matter/worktree': { ok: { id: ID, action: 'commit' }, bad: { id: ID, action: 'rebase' }, boom: ['scriptAction', { id: ID, action: 'run' }] },
  '/v1/matter/create': { ok: { requestId: REQ, text: '把说明改一下', target: { kind: 'managed' } }, bad: { requestId: REQ, text: '', target: { kind: 'managed' } }, boom: ['createEntry', { requestId: REQ, text: '把说明改一下', target: { kind: 'managed' } }] },
  '/v1/matter/create-receipt': { ok: `?requestId=${REQ}`, bad: `?requestId=${REQ}&extra=1`, boom: ['entryReceipt', `?requestId=${REQ}`] },
}
const BOOM: Partial<Record<WbFn, string>> = { cancel: 'not_found', resolvePermission: 'permission_stale', resolveAnswer: 'question_stale', artifact: 'artifact_changed', handOff: 'quota_handoff_changed', scriptAction: 'script_approval_required', createEntry: 'unattended_ack_required', entryReceipt: 'invalid_entry_owner' }

describe('桌面的 /v1/workbench/* 双胞胎:旧键与新键同一个处理器,operator 打两条一字不差', () => {
  it('每一行别名都有用例', () => {
    expect(DESKTOP.map(r => pathOf(r.to)).sort()).toEqual(Object.keys(DESKTOP_CASES).sort())
  })
  it.each(DESKTOP.map(r => [r.from, r.to] as const))('%s ≡ %s', async (from, to) => {
    const method = from.split(' ')[0]!, c = DESKTOP_CASES[pathOf(to)]!
    const call = async (path: string, arg: string | object) => raw(method === 'GET' ? await viaLocal(path + (arg as string)) : await viaLocal(path, post(arg)))
    const pair = async (arg: string | object) => {
      const old = await call(pathOf(from), arg), now = await call(pathOf(to), arg)
      expect(now, `${to} ${JSON.stringify(arg)}`).toEqual(old)
      return old
    }
    expect((await pair(c.ok)).status).toBeLessThan(300)
    expect((await pair(c.bad)).status).toBe(400)
    const [fn, arg] = c.boom
    const code = BOOM[fn]!
    wb[fn].mockImplementation(() => { throw new Error(code) })
    const failed = await pair(arg)
    expect(failed.status).toBeGreaterThanOrEqual(400)
    expect(JSON.parse(failed.body).error).toBeTruthy()
  })
  it('桌面那一份的参数照旧:停下透传 expectedRunId、交办记 desktop 出生地与主人', async () => {
    expect((await viaLocal('/v1/matter/stop', post({ id: ID, expectedRunId: 'run-1' }))).status).toBe(202)
    expect(wb.cancel).toHaveBeenLastCalledWith(ID, 'run-1')
    expect((await viaLocal('/v1/matter/create', post({ requestId: REQ, text: 'x', target: { kind: 'managed' } }))).status).toBe(202)
    expect(wb.createEntry.mock.calls.at(-1)![1]).toEqual({ ownerKey: OWNER, surface: 'desktop', origin: 'desktop' })
  })
})

describe('手机令牌走新键:语义同并之前的 /m/api/matter/*,错误码是桌面那一列', () => {
  it('停下:runId 必须是手机看到的那一轮(大小写不论);换了一轮 ⇒ 409 input_stale,不停;expectedRunId 那一份手机用不了', async () => {
    const r = await viaPanel('/v1/matter/stop', { d: device }, post({ id: ID, runId: RUN.toUpperCase() }))
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true })
    expect(wb.cancel).toHaveBeenLastCalledWith(ID, RUN)
    wb.cancel.mockClear()
    const stale = await viaPanel('/v1/matter/stop', { d: device }, post({ id: ID, runId: '55555555-5555-4555-8555-555555555555' }))
    expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: 'input_stale' })
    const desk = await viaPanel('/v1/matter/stop', { d: device }, post({ id: ID, expectedRunId: 'run-1' }))
    expect(desk.status).toBe(400); expect(await desk.json()).toEqual({ error: 'invalid_request' })
    expect(wb.cancel).not.toHaveBeenCalled()
  })
  it('批准 / 回答:不是这一轮的、这一项不在了 ⇒ 409 permission_stale / question_stale,不批', async () => {
    expect((await viaPanel('/v1/matter/permission', { d: device }, post({ id: ID, runId: RUN, requestId: REQ, decision: 'allow' }))).status).toBe(200)
    expect(wb.resolvePermission).toHaveBeenCalledWith(ID, REQ, 'allow')
    const stale = await viaPanel('/v1/matter/permission', { d: device }, post({ id: ID, runId: RUN, requestId: '66666666-6666-4666-8666-666666666666', decision: 'allow' }))
    expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: 'permission_stale' })
    const bad = await viaPanel('/v1/matter/permission', { d: device }, post({ id: ID, runId: RUN, requestId: REQ, decision: 'maybe' }))
    expect(bad.status).toBe(400); expect(await bad.json()).toEqual({ error: 'invalid_decision' })
    expect((await viaPanel('/v1/matter/answer', { d: device }, post({ id: ID, runId: RUN, requestId: REQ, answers: null }))).status).toBe(200)
    expect(wb.resolveAnswer).toHaveBeenCalledWith(ID, REQ, null)
    // 桌面那一份(没有 runId)手机令牌用不了
    expect((await viaPanel('/v1/matter/answer', { d: device }, post({ id: ID, requestId: REQ, answers: null }))).status).toBe(400)
  })
  it('成果:手机只按块读(sha256 对得上才给);桌面那一份的整份读法手机令牌用不了', async () => {
    const r = await viaPanel(`/v1/matter/artifact?id=${ID}&artifactId=${ART}&sha256=${SHA}&offset=0`, { d: device })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, taskId: ID, artifactId: ART, name: 'r.md', mime: 'text/markdown', size: CONTENT.length, sha256: SHA, offset: 0, nextOffset: CONTENT.length, contentBase64: CONTENT.toString('base64') })
    expect((await viaPanel(`/v1/matter/artifact?id=${ID}&artifactId=${ART}`, { d: device })).status).toBe(400)
    const changed = await viaPanel(`/v1/matter/artifact?id=${ID}&artifactId=${ART}&sha256=${'cd'.repeat(32)}&offset=0`, { d: device })
    expect(changed.status).toBe(409); expect(await changed.json()).toEqual({ error: 'artifact_changed' })
  })
  it('工作区:手机只回分支和结果(不给合并命令);没批的脚本 ⇒ 新键是桌面那一列 428 script_approval_required,别名才是 script_needs_computer', async () => {
    const r = await viaPanel('/v1/matter/worktree', { d: device }, post({ id: ID, action: 'commit' }))
    expect(await r.json()).toEqual({ ok: true, branch: 'cc/deadbeef', committed: true })
    wb.scriptAction.mockImplementation(() => { throw new Error('script_approval_required') })
    const fresh = await viaPanel('/v1/matter/worktree', { d: device }, post({ id: ID, action: 'run' }))
    expect(fresh.status).toBe(428); expect(await fresh.json()).toEqual({ error: 'script_approval_required' })
    const old = await viaPanel('/m/api/matter/worktree', { d: device }, post({ id: ID, action: 'run' }))
    expect(old.status).toBe(428); expect(await old.json()).toEqual({ ok: false, error: 'script_needs_computer' })
  })
  it('交给另一位:新那件记手机露面,回 {ok, matterId, created};执行者 id 按手机那条的写法', async () => {
    const r = await viaPanel('/v1/matter/handoff', { d: device }, post({ id: ID, requestId: REQ, providerId: 'codex' }))
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true, matterId: 'cafebabe', created: true })
    expect(wb.handOff).toHaveBeenCalledWith(ID, { requestId: REQ, providerId: 'codex' })
  })
  it('交办与回执:手机表面、主人取 MattersService 的、出生地按传输(局域网直连 = web);202', async () => {
    const r = await viaPanel('/v1/matter/create', { d: device }, post({ requestId: REQ, text: '把说明改一下', target: { kind: 'managed' } }))
    expect(r.status).toBe(202); expect((await r.json()).ok).toBe(true)
    expect(wb.createEntry.mock.calls.at(-1)![1]).toEqual({ ownerKey: OWNER, surface: 'phone', origin: 'web' })
    const got = await viaPanel(`/v1/matter/create-receipt?requestId=${REQ}`, { d: device })
    expect(got.status).toBe(200); expect(wb.entryReceipt).toHaveBeenLastCalledWith(REQ, { ownerKey: OWNER, surface: 'phone' })
    const none = await viaPanel(`/v1/matter/create-receipt?requestId=${RUN}`, { d: device })
    expect(none.status).toBe(404); expect(await none.json()).toEqual({ error: 'not_found' })
  })
})

describe('链接令牌:只够得着停下(同别名行冻结的 write)', () => {
  it('停下放、别的一律 403 route_not_allowed,处理器不跑', async () => {
    expect((await viaPanel('/v1/matter/stop', { t: link }, post({ id: ID, runId: RUN }))).status).toBe(200)
    for (const [path, init] of [['/v1/matter/permission', post({ id: ID, runId: RUN, requestId: REQ, decision: 'allow' })], ['/v1/matter/worktree', post({ id: ID, action: 'commit' })], [`/v1/matter/create-receipt?requestId=${REQ}`, {}]] as const) {
      const r = await viaPanel(path, { t: link }, init)
      expect(r.status, path).toBe(403); expect(await r.json()).toEqual({ error: 'route_not_allowed' })
    }
    expect(wb.resolvePermission).not.toHaveBeenCalled(); expect(wb.worktreeAction).not.toHaveBeenCalled()
  })
})
