import { markAppRequest } from '../../features/phone/phone-client'
import { readRouteUsage } from '../../lib/route-usage'
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
/** 两轮改动:新的那轮能撤(手机只撤它),旧的那轮桌面能回到。 */
const ROUND = '77777777-7777-4777-8777-777777777777', OLD_ROUND = '88888888-8888-4888-8888-888888888888'
const COMMENT = '99999999-9999-4999-8999-999999999999'

let stateDir: string, api: InternalApi, panel: SettingsPanel, localBase: string, operator: string, device: string, link: string
type WbFn = 'detail' | 'cancel' | 'resolvePermission' | 'resolveAnswer' | 'artifact' | 'handOff' | 'worktreeAction' | 'scriptAction' | 'createEntry' | 'entryReceipt'
  | 'reviewList' | 'markReviewFile' | 'returnReviewFiles' | 'reviewComment' | 'sendReviewComments' | 'rewindPreview' | 'rewind' | 'undoRewind'
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
    // 下面几样的形状照 desktop-api.ts 的响应契约(测试里每个 2xx 回包都对着契约核一遍)
    reviewList: vi.fn(() => [
      { artifactId: OLD_ROUND, sha256: SHA, name: 'r1', createdAt: 1, status: 'complete', headBefore: null, headAfter: null, preexistingPaths: [], notes: [], files: [], rewindable: { start: true, end: true } },
      { artifactId: ROUND, sha256: SHA, name: 'r2', createdAt: 2, status: 'complete', headBefore: null, headAfter: null, preexistingPaths: [], notes: [], rewindable: { start: true, end: true },
        files: [{ path: 'README.md', preexisting: false, kind: 'modified', diff: '@@ -1 +1 @@\n-a\n+b\n', hunks: [{ index: 0, sha256: SHA, header: '@@ -1 +1 @@', oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, rows: 2 }] }] },
    ]),
    markReviewFile: vi.fn(() => ({ taskId: ID, artifactSha256: SHA, path: 'README.md', afterSha256: null, mark: 'accepted', comment: '', createdAt: 1 })),
    returnReviewFiles: vi.fn(async () => ({ taskId: ID, id: REQ, runId: RUN, text: '再短', status: 'pending', createdAt: 1, error: null })),
    reviewComment: vi.fn((_id: string, input: { commentId: string; delete?: true }) => input.delete ? { deleted: input.commentId } : { comment: { id: input.commentId, hunk: 0, body: 'x', state: 'draft' } }),
    sendReviewComments: vi.fn(async () => ({ input: { taskId: ID, id: REQ }, sent: 2, remaining: 0, skippedDiscarded: 1 })),
    rewindPreview: vi.fn(async (_id: string, input: { artifactId: string; to: 'start' | 'end' }) => ({
      token: 'cd'.repeat(32), target: { artifactId: input.artifactId, to: input.to, round: 2 }, discarded: [{ artifactId: input.artifactId, round: 2 }],
      files: { count: 1, paths: [{ status: 'M', path: 'README.md' }] }, extraChanges: null, droppedCommits: { count: 0, elsewhere: false },
      ignoredUntouched: true, rebuildHint: '', refsNote: '', session: 'none', devServer: false, goal: null,
    })),
    rewind: vi.fn(async () => ({ rewindId: REQ, backupRef: 'refs/cc/backup', head: 'abc1234', discarded: [ROUND] })),
    undoRewind: vi.fn(async () => ({ rewindId: REQ, backupRef: 'refs/cc/backup', head: 'abc1234', discarded: [] })),
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
  // P3e-2(GET / POST /v1/matter/rewind 同一条路径,按方法各一行)
  'GET /v1/matter/rewind': { ok: `?id=${ID}&artifactId=${OLD_ROUND}&to=end`, bad: `?id=${ID}&artifactId=${OLD_ROUND}`, boom: ['rewindPreview', `?id=${ID}&artifactId=${ROUND}&to=start`] },
  'POST /v1/matter/rewind': { ok: { id: ID, artifactId: OLD_ROUND, to: 'end', token: SHA }, bad: { id: ID, artifactId: ROUND, token: SHA }, boom: ['undoRewind', { id: ID, undo: REQ }] },
  '/v1/matter/changes': { ok: `?id=${ID}`, bad: `?id=${ID}&id=${ID}`, boom: ['reviewList', `?id=${ID}`] },
  '/v1/matter/review-mark': { ok: { id: ID, artifactId: ROUND, path: 'README.md', mark: 'returned', comment: '再短一点' }, bad: { id: ID, artifactId: ROUND, path: 'README.md', mark: 'maybe' }, boom: ['markReviewFile', { id: ID, artifactId: ROUND, path: 'README.md', mark: 'accepted' }] },
  '/v1/matter/review-return': { ok: { id: ID, artifactId: ROUND, paths: ['README.md'], comment: '标题再短', restartToken: SHA, asLesson: true }, bad: { id: ID, artifactId: ROUND, paths: [], comment: 'x' }, boom: ['returnReviewFiles', { id: ID, artifactId: ROUND, paths: ['README.md'], comment: 'x' }] },
  '/v1/matter/review-comment': { ok: { id: ID, commentId: COMMENT, body: '改一下措辞' }, bad: { id: ID, commentId: COMMENT, delete: false }, boom: ['reviewComment', { id: ID, commentId: COMMENT, delete: true }] },
  '/v1/matter/review-comments-send': { ok: { id: ID, summary: '两处', restartToken: SHA }, bad: { id: ID, extra: 1 }, boom: ['sendReviewComments', { id: ID }] },
}
const BOOM: Partial<Record<WbFn, string>> = {
  reviewList: 'not_found', markReviewFile: 'review_file_unmarkable', returnReviewFiles: 'restart_confirmation_required', reviewComment: 'review_hunk_stale',
  sendReviewComments: 'workbench_busy', rewindPreview: 'rewind_not_latest', undoRewind: 'rewind_failed', cancel: 'not_found', resolvePermission: 'permission_stale', resolveAnswer: 'question_stale', artifact: 'artifact_changed', handOff: 'quota_handoff_changed', scriptAction: 'script_approval_required', createEntry: 'unattended_ack_required', entryReceipt: 'invalid_entry_owner' }

describe('桌面的 /v1/workbench/* 双胞胎:旧键与新键同一个处理器,operator 打两条一字不差', () => {
  it('每一行别名都有用例', () => {
    expect(DESKTOP.map(r => DESKTOP_CASES[r.to] ? r.to : pathOf(r.to)).sort()).toEqual(Object.keys(DESKTOP_CASES).sort())
  })
  it.each(DESKTOP.map(r => [r.from, r.to] as const))('%s ≡ %s', async (from, to) => {
    const method = from.split(' ')[0]!, c = (DESKTOP_CASES[to] ?? DESKTOP_CASES[pathOf(to)])!
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

describe('手机令牌走新键(P3e-2):撤掉这一轮、改动与审阅', () => {
  it('撤掉这一轮:只撤最新那一轮、只回到它开始之前;旧的那轮 ⇒ 409 rewind_not_latest;桌面那一份的 to / undo 手机用不了', async () => {
    const p = await viaPanel(`/v1/matter/rewind?id=${ID}&artifactId=${ROUND}`, { d: device })
    expect(p.status).toBe(200)
    expect(await p.json()).toEqual({ ok: true, preview: { token: 'cd'.repeat(32), round: 2, rounds: [2], files: { count: 1, paths: [{ status: 'M', path: 'README.md' }] }, extraChanges: null, droppedCommits: { count: 0, elsewhere: false }, rebuildHint: '', session: 'none', devServer: false, goalWillStop: false } })
    expect(wb.rewindPreview).toHaveBeenLastCalledWith(ID, { artifactId: ROUND, to: 'start' })
    const old = await viaPanel(`/v1/matter/rewind?id=${ID}&artifactId=${OLD_ROUND}`, { d: device })
    expect(old.status).toBe(409); expect(await old.json()).toEqual({ error: 'rewind_not_latest' })
    expect((await viaPanel(`/v1/matter/rewind?id=${ID}&artifactId=${ROUND}&to=end`, { d: device })).status).toBe(400)
    const run = await viaPanel('/v1/matter/rewind', { d: device }, post({ id: ID, artifactId: ROUND, token: SHA }))
    expect(await run.json()).toEqual({ ok: true, discarded: [ROUND] })
    expect(wb.rewind).toHaveBeenLastCalledWith(ID, { artifactId: ROUND, to: 'start', token: SHA })
    expect((await viaPanel('/v1/matter/rewind', { d: device }, post({ id: ID, undo: REQ }))).status).toBe(400)
    expect(wb.undoRewind).not.toHaveBeenCalled()
  })
  it('回退失败:手机只看到 reason(短码)/ rolledBack,桌面那一份的 detail / 路径不给', async () => {
    wb.rewind.mockImplementation(async () => { throw Object.assign(new Error('rewind_failed'), { rolledBack: false, detail: 'git said: /Users/owner/secret', path: '/Users/owner/secret' }) })
    const r = await viaPanel('/v1/matter/rewind', { d: device }, post({ id: ID, artifactId: ROUND, token: SHA }))
    expect(r.status).toBe(502); expect(await r.json()).toEqual({ error: 'rewind_failed', rolledBack: false })
    const old = await viaPanel('/m/api/matter/rewind', { d: device }, post({ id: ID, artifactId: ROUND, token: SHA }))
    expect(await old.json()).toEqual({ ok: false, error: 'rewind_failed', rolledBack: false })
    const desk = await viaLocal('/v1/matter/rewind', post({ id: ID, artifactId: ROUND, to: 'start', token: SHA }))
    expect(await desk.json()).toEqual({ error: 'rewind_failed', detail: 'git said: /Users/owner/secret', path: '/Users/owner/secret', rolledBack: false })
  })
  it('改动:手机只拿最新那一轮(裁到一帧),桌面拿各轮原样;参数不对新键是 400 invalid_request', async () => {
    const r = await viaPanel(`/v1/matter/changes?id=${ID}`, { d: device })
    const body = await r.json() as { ok: true; turn: { artifactId: string; files: unknown[] } }
    expect(r.status).toBe(200); expect(body.ok).toBe(true); expect(body.turn.artifactId).toBe(ROUND); expect(body.turn.files).toHaveLength(1)
    const desk = await (await viaLocal(`/v1/matter/changes?id=${ID}`)).json() as { reviews: unknown[] }
    expect(desk.reviews).toHaveLength(2)
    const bad = await viaPanel('/v1/matter/changes?id=nope', { d: device })
    expect(bad.status).toBe(400); expect(await bad.json()).toEqual({ error: 'invalid_request' })
  })
  it('审阅:手机的标记不带评论、打回不带 restartToken / asLesson、发出评论不给回执', async () => {
    expect(await (await viaPanel('/v1/matter/review-mark', { d: device }, post({ id: ID, artifactId: ROUND, path: 'README.md', mark: 'accepted', comment: 'x' }))).json()).toEqual({ ok: true })
    expect(wb.markReviewFile).toHaveBeenLastCalledWith(ID, { artifactId: ROUND, path: 'README.md', mark: 'accepted' })
    expect(await (await viaPanel('/v1/matter/review-return', { d: device }, post({ id: ID, artifactId: ROUND, paths: ['README.md'], comment: '再短', restartToken: SHA, asLesson: true }))).json()).toEqual({ ok: true })
    expect(wb.returnReviewFiles).toHaveBeenLastCalledWith(ID, { artifactId: ROUND, paths: ['README.md'], comment: '再短' })
    expect(await (await viaPanel('/v1/matter/review-comment', { d: device }, post({ id: ID, commentId: COMMENT.toUpperCase(), delete: true }))).json()).toEqual({ ok: true, deleted: true })
    expect(wb.reviewComment).toHaveBeenLastCalledWith(ID, { commentId: COMMENT, delete: true })
    // 改评论正文是桌面那一份(手机只建 / 删)
    expect((await viaPanel('/v1/matter/review-comment', { d: device }, post({ id: ID, commentId: COMMENT, body: '改' }))).status).toBe(400)
    expect(await (await viaPanel('/v1/matter/review-comments-send', { d: device }, post({ id: ID, summary: '两处' }))).json()).toEqual({ ok: true, sent: 2, remaining: 0, skippedDiscarded: 1 })
    expect((await viaPanel('/v1/matter/review-comments-send', { d: device }, post({ id: ID, restartToken: SHA }))).status).toBe(400)
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


it('P3h: real panel/local entry records aliases and activity without changing response semantics', async () => {
  const path = '/m/api/matter/stop'
  const make = (token: string) => new Request(`http://127.0.0.1:1${path}?d=${token}&private=not-recorded`, post({}))
  await panel.handleRequest(markAppRequest(make(device), '2'))
  await panel.handleRequest(make(device)) // old cached web, no version marker
  await panel.handleRequest(markAppRequest(make('invalid'), '1'))
  await fetch(`${localBase}/v1/workbench/cancel`, { ...post({}), headers: { Authorization: `Bearer ${operator}`, 'content-type': 'application/json', 'x-cc-desktop-version': '1.7.8' } })
  await fetch(`${localBase}/v1/workbench/cancel`, { ...post({}), headers: { Authorization: `Bearer ${operator}`, 'content-type': 'application/json' } })
  await panel.handleRequest(new Request(`http://127.0.0.1:1/v1/matter/stop?d=${device}`, { ...post({}), headers: { 'content-type': 'application/json', 'x-cc-web-routes': 'P3g' } }))
  await panel.handleRequest(markAppRequest(new Request(`http://127.0.0.1:1/v1/matter/stop?d=${device}`, post({})), 'selftest-P3d'))
  const beforeFile = readRouteUsage(stateDir)!.rows.find(r => r.alias === 'POST /v1/workbench/cancel' && r.version === 'unknown')!.count
  await fetch(`${localBase}/v1/workbench/cancel`, { ...post({}), headers: { Authorization: `Bearer ${readFileSync(join(stateDir, 'internal-token'), 'utf8').trim()}`, 'content-type': 'application/json' } })
  const rows = readRouteUsage(stateDir)!.rows
  expect(rows.find(r => r.alias === 'POST /v1/workbench/cancel' && r.version === 'unknown')!.count).toBe(beforeFile + 1)
  expect(rows.filter(r => r.alias === 'POST /m/api/matter/stop').map(r => [r.client, r.version, r.count])).toEqual([['app', '2', 1], ['web', 'unknown', 1]])
  expect(rows.filter(r => r.alias === 'POST /v1/workbench/cancel').map(r => r.version)).toEqual(['1.7.8', 'unknown'])
  expect(rows.some(r => r.client === 'web' && r.version === 'P3g' && r.alias === '')).toBe(true)
  expect(JSON.stringify(rows)).not.toContain('not-recorded')
  expect(rows.some(r => r.version === '1')).toBe(false)
  expect(rows.some(r => r.client === 'selftest' && r.version === 'P3d')).toBe(true)
  expect(rows.some(r => r.client === 'app' && r.version === 'selftest-P3d')).toBe(false)
})
