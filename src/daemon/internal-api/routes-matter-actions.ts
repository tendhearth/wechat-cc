/**
 * routes-matter-actions — 一件事上的动作收在 `/v1/matter/*`(P3e,设计稿 docs/superpowers/specs/2026-11-05-p3-one-route-family-design.md「P3e」)。
 *
 * 一个动作一个处理器,底下是 MattersService 那一层(键是 matter id;任务的 matter id 就是工作台任务 id)。两种调用方、两份参数:
 *   - 手机令牌(设备 / 链接,从设置面板那一口进来):参数、语义同搬来之前的 `/m/api/matter/*` —— 带 runId 过期判断
 *     (手机看到的那一轮换了 ⇒ input_stale / permission_stale / question_stale)、成果按块读、交办记手机表面与出生地;
 *     成功回包就是手机那一份(带 `ok: true`);错误回包是桌面那一列的码,原始码经 `cause` 带给面板里的旧路径别名
 *     (legacy-routes.ts 换回 phone 那一列、套回原来的响应头)。
 *   - 别的(operator = 桌面宿主 / CLI,以及 admin 会话令牌):参数、回包、错误码同搬来之前的 `/v1/workbench/*` 双胞胎
 *     (`expectedRunId`、交办入口那一列错误码 `desktopEntry` …),走 MattersService.desktop —— 工作台原样。
 * 桌面装着的 .app 还调 `/v1/workbench/*`:那几条是 wire-compat.ts 的别名(读的人 = desktop),同一个处理器函数挂在旧键上
 * (legacy-desktop-routes.ts),所以旧路径的回包一个字节不变。
 * 路由表这几行标 `module: 'workbench'`:工作台此刻不是 ok ⇒ 模块门原样回 503 workbench_not_wired(同搬来之前)。
 */
import { isWorkbenchProviderId } from '../../domain/workbench/executor-capabilities'
import { parseEntryInput } from '../../adapters/workbench/task-entry'
import { PHONE_ANSWER_MAX_JSON, workbenchErrorHttp, workbenchErrorSpec } from '@wechat-cc/protocol'
import type { MattersService } from '../../app/matters/service'
import type { InternalApiDeps, RouteHandler, RouteResult, RouteTable } from './types'

const ID = /^[a-f0-9]{8}$/
/** 桌面那一份的 id 写法(同搬来之前的工作台路由)。 */
const TASK_ID = ID
const EXPECTED_RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const ARTIFACT_ID = /^[a-f0-9-]{8,64}$/
const SHA256 = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
/** 手机交给另一位时执行者 id 的写法(并之前 /m/api/matter/handoff 的那一条,不是 isWorkbenchProviderId)。 */
const PHONE_PROVIDER_ID = /^[a-z][a-z0-9._-]{0,63}$/
const CAUSE = /^[a-z][a-z0-9_]{0,63}$/

type Caller = Parameters<RouteHandler>[2]
type JsonObject = Record<string, unknown>
const objectBody = (v: unknown): JsonObject | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : null
/** 手机设置面板那一口的令牌(设备 / 链接)。 */
const fromPhone = (caller: Caller): boolean => caller?.origin === 'device' || caller?.origin === 'link'

// ── 桌面那一份的错误(同搬来之前 features/workbench/routes.ts 的 mappedError)──────────────────────────────
function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code
  return err instanceof Error ? err.message : ''
}
/** 只带这几个字段出去(service 挂在 Error 上的);别的(steps 原文这类)不外泄。 */
function rewindExtra(err: unknown): JsonObject {
  if (!err || typeof err !== 'object') return {}
  const e = err as JsonObject, out: JsonObject = {}
  for (const key of ['reason', 'detail', 'backupRef', 'path']) if (typeof e[key] === 'string') out[key] = e[key]
  if (typeof e.rolledBack === 'boolean') out.rolledBack = e.rolledBack
  if (Array.isArray(e.paths)) out.paths = e.paths.filter(p => typeof p === 'string').slice(0, 50)
  return out
}
function mappedError(err: unknown, entry = false): RouteResult {
  const code = errorCode(err)
  const { status, error } = workbenchErrorHttp(code, 'desktop', entry)
  return { status, body: workbenchErrorSpec(code)?.rewind ? { error, ...rewindExtra(err) } : { error } }
}
const invalid = (): RouteResult => ({ status: 400, body: { error: 'invalid_request' } })

// ── 手机那一份的错误:码取 message(同并之前 mobileMatterError 的取法),正文是桌面那一列,原始码经 cause 给别名 ──
function phoneError(err: unknown, entry = false): RouteResult {
  const code = err instanceof Error ? err.message : 'internal'
  const { status, error } = workbenchErrorHttp(code, 'desktop', entry)
  return { status, body: { error }, ...(CAUSE.test(code) ? { cause: code } : {}) }
}
/** 手机的参数不对:码同并之前手机那条回的(invalid_request / invalid_decision …)。 */
const phoneInvalid = (code: string): RouteResult => phoneError(Error(code))

/** MattersService 还没交给内部 API(开机途中):同工作台没挂上时的码。 */
const notWired = (caller: Caller): RouteResult =>
  fromPhone(caller) ? { status: 503, body: { error: 'workbench_not_wired' }, cause: 'workbench_not_wired' } : { status: 503, body: { error: 'workbench_not_wired' } }

export function matterActionRoutes(deps: InternalApiDeps): RouteTable {
  /** 两份参数一个处理器:先看 MattersService 交来没有,再按调用方分。 */
  const action = (phone: (m: MattersService, query: URLSearchParams, body: unknown, caller: Caller) => Promise<RouteResult> | RouteResult,
    desktop: (m: MattersService, query: URLSearchParams, body: unknown, caller: Caller) => Promise<RouteResult> | RouteResult): RouteHandler =>
    async (query, body, caller) => {
      const m = deps.matters
      if (!m) return notWired(caller)
      return fromPhone(caller) ? await phone(m, query, body, caller) : await desktop(m, query, body, caller)
    }
  // 桌面交办的上下文(同搬来之前 workbenchRoutes 的 entryContext / desktopOrigin):只有桌面 app 的 operator 令牌才算「从电脑来的」。
  const ownerKey = () => deps.resolveAdminChatId?.() ?? ''
  const desktopOrigin = (caller: Caller) => caller?.origin === 'operator' ? { origin: 'desktop' as const } : {}

  return {
    // 停下正在跑的这一轮。手机:正文恰好 id + runId,runId 必须是手机看到的那一轮(换了 ⇒ input_stale)。
    // 桌面(原 /v1/workbench/cancel):{id, expectedRunId?},expectedRunId 不对 ⇒ 不停;202 回任务视图。
    'POST /v1/matter/stop': action(async (m, _q, body) => {
      const b = objectBody(body)
      if (!b || Object.keys(b).some(k => k !== 'id' && k !== 'runId') || typeof b.id !== 'string' || !ID.test(b.id) || typeof b.runId !== 'string' || !UUID.test(b.runId)) return phoneInvalid('invalid_request')
      try { await m.stop(b.id, b.runId.toLowerCase()); return { status: 200, body: { ok: true } } } catch (err) { return phoneError(err) }
    }, async (m, _q, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      if (!TASK_ID.test(id)) return invalid()
      const expectedRunIdRaw = value?.expectedRunId
      if (typeof expectedRunIdRaw === 'string' && !EXPECTED_RUN_ID.test(expectedRunIdRaw)) return invalid()
      const expectedRunId = typeof expectedRunIdRaw === 'string' ? expectedRunIdRaw : undefined
      try { return { status: 202, body: { task: await m.desktop.cancel(id, expectedRunId) } } } catch (err) { return mappedError(err) }
    }),

    // 批准 / 拒绝一项权限。手机:带 runId(这一轮换了、这一项不在了 ⇒ permission_stale)。桌面(原 /v1/workbench/permission):没有 runId。
    'POST /v1/matter/permission': action(async (m, _q, body) => {
      const b = objectBody(body)
      if (!b || typeof b.id !== 'string' || !ID.test(b.id) || typeof b.runId !== 'string' || !UUID.test(b.runId) || typeof b.requestId !== 'string' || !UUID.test(b.requestId)) return phoneInvalid('invalid_request')
      if (b.decision !== 'allow' && b.decision !== 'deny') return phoneInvalid('invalid_decision')
      try { m.permission(b.id, b.runId, b.requestId, b.decision); return { status: 200, body: { ok: true } } } catch (err) { return phoneError(err) }
    }, async (m, _q, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      const requestId = typeof value?.requestId === 'string' ? value.requestId : ''
      const decision = value?.decision
      if (!TASK_ID.test(id) || !UUID.test(requestId) || (decision !== 'allow' && decision !== 'deny')) return invalid()
      try { await m.desktop.resolvePermission(id, requestId, decision); return { status: 200, body: { ok: true } } } catch (err) { return mappedError(err) }
    }),

    // 回答提问。手机:带 runId(换了 ⇒ question_stale),answers 至多 PHONE_ANSWER_MAX_JSON。桌面(原 /v1/workbench/answer):没有 runId,至多 20000。
    'POST /v1/matter/answer': action(async (m, _q, body) => {
      const b = objectBody(body)
      if (!b || typeof b.id !== 'string' || !ID.test(b.id) || typeof b.runId !== 'string' || !UUID.test(b.runId) || typeof b.requestId !== 'string' || !UUID.test(b.requestId)) return phoneInvalid('invalid_request')
      if ((b.answers !== null && !objectBody(b.answers)) || JSON.stringify(b.answers).length > PHONE_ANSWER_MAX_JSON) return phoneInvalid('invalid_answer')
      try { m.answer(b.id, b.runId, b.requestId, b.answers); return { status: 200, body: { ok: true } } } catch (err) { return phoneError(err) }
    }, async (m, _q, body) => {
      const value = objectBody(body)
      if (!value || typeof value.id !== 'string' || !TASK_ID.test(value.id) || typeof value.requestId !== 'string' || !UUID.test(value.requestId) || (value.answers !== null && !objectBody(value.answers)) || JSON.stringify(value.answers).length > 20_000) return invalid()
      try { m.desktop.resolveAnswer(value.id, value.requestId, value.answers); return { status: 200, body: { ok: true } } } catch (err) { return mappedError(err) }
    }),

    // 成果。手机:按块读(sha256 对得上才给,offset / length 一块至多 128 KiB)。桌面(原 /v1/workbench/artifact):整份。
    'GET /v1/matter/artifact': action(async (m, q) => {
      const id = q.get('id'), artifactId = q.get('artifactId'), sha256 = q.get('sha256'), offset = q.get('offset'), length = q.get('length')
      if (['id', 'artifactId', 'sha256', 'offset'].some(k => q.getAll(k).length !== 1) || q.getAll('length').length > 1 || !id || !ID.test(id) || !artifactId || !UUID.test(artifactId) || !sha256 || !SHA256.test(sha256) || offset === null || !/^\d+$/.test(offset) || (length !== null && !/^\d+$/.test(length))) return phoneInvalid('invalid_request')
      try { return { status: 200, body: { ok: true, ...m.artifactChunk(id, { artifactId, sha256, offset: Number(offset), ...(length !== null ? { length: Number(length) } : {}) }) } } } catch (err) { return phoneError(err) }
    }, async (m, q) => {
      const id = q.get('id') ?? ''
      const artifactId = q.get('artifactId') ?? ''
      if (!TASK_ID.test(id) || !ARTIFACT_ID.test(artifactId)) return invalid()
      try { return { status: 200, body: await m.desktop.artifact(id, artifactId) } } catch (err) { return mappedError(err) }
    }),

    // 额度用完 ⇒ 交给确认卡上那位继续(spec 2026-10-01-tendhearth-continue-sessions §7-3)。正文恰好三键,按 requestId 幂等。
    // 手机:新那件记手机露面,回 {matterId, created}。桌面(原 /v1/workbench/quota-handoff —— 不是 /v1/workbench/handoff,那条是
    // 交接预览之后带 token 的另一个动作):202 回工作台原样。
    'POST /v1/matter/handoff': action(async (m, _q, body) => {
      const b = objectBody(body)
      if (!b || Object.keys(b).some(k => !['id', 'requestId', 'providerId'].includes(k)) || typeof b.id !== 'string' || !ID.test(b.id) || typeof b.requestId !== 'string' || !UUID.test(b.requestId) || typeof b.providerId !== 'string' || !PHONE_PROVIDER_ID.test(b.providerId)) return phoneInvalid('invalid_request')
      try { return { status: 200, body: { ok: true, ...await m.handoff(b.id, { requestId: b.requestId, providerId: b.providerId }, 'phone') } } } catch (err) { return phoneError(err) }
    }, async (m, query, body) => {
      const value = objectBody(body)
      if (query.size || !value || Object.keys(value).some(key => !['id', 'requestId', 'providerId'].includes(key)) || typeof value.id !== 'string' || !TASK_ID.test(value.id) || typeof value.requestId !== 'string' || !UUID.test(value.requestId) || !isWorkbenchProviderId(value.providerId)) return invalid()
      try { return { status: 202, body: m.desktop.quotaHandoff(value.id, { requestId: value.requestId, providerId: value.providerId }) } } catch (err) { return mappedError(err) }
    }),

    // 独立工作区:提交到分支 / 删除 / 合回 / 另开(2026-10-07 / 10-08);run / stop 是工作区脚本(2026-10-20,批准只在电脑上:
    // 没批 ⇒ script_approval_required)。正文恰好 id + action。手机只回分支和结果(不给合并命令、脚本原文、路径);桌面回工作台原样。
    'POST /v1/matter/worktree': action(async (m, _q, body) => {
      const b = objectBody(body)
      if (!b || Object.keys(b).some(k => k !== 'id' && k !== 'action') || typeof b.id !== 'string' || !ID.test(b.id) || (b.action !== 'commit' && b.action !== 'remove' && b.action !== 'merge' && b.action !== 'reopen' && b.action !== 'run' && b.action !== 'stop')) return phoneInvalid('invalid_request')
      try {
        if (b.action === 'run' || b.action === 'stop') return { status: 200, body: { ok: true, ...await m.worktreeScript(b.id, b.action) } }
        return { status: 200, body: { ok: true, ...m.worktree(b.id, b.action) } }
      } catch (err) { return phoneError(err) }
    }, async (m, _q, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : '', act = value?.action
      if (!TASK_ID.test(id) || (act !== 'commit' && act !== 'remove' && act !== 'merge' && act !== 'reopen' && act !== 'run' && act !== 'stop') || Object.keys(value ?? {}).some(k => k !== 'id' && k !== 'action')) return invalid()
      try { return { status: 200, body: { worktree: await m.desktop.worktree(id, act) } } } catch (err) { return mappedError(err) }
    }),

    // 交办一件新事(parseEntryInput 验正文)。手机:手机表面,出生地按传输(App / 浏览器),202 回 {ok, …结果};
    // 桌面(原 /v1/workbench/create-entry):桌面表面,只有 operator 令牌记出生地 desktop,错误码是交办入口那一列(desktopEntry)。
    'POST /v1/matter/create': action(async (m, _q, body, caller) => {
      try { return { status: 202, body: { ok: true, ...m.createEntry(parseEntryInput(body), { surface: 'phone', origin: caller?.client ?? null }) as object } } } catch (err) { return phoneError(err, true) }
    }, async (m, query, body, caller) => {
      if (query.size) return invalid()
      try {
        const input = parseEntryInput(body)
        return { status: 202, body: m.createEntry(input, { surface: 'desktop', ownerKey: ownerKey(), ...desktopOrigin(caller) }) }
      } catch (err) { return mappedError(err, true) }
    }),

    // 交办的回执(按 requestId)。手机:查询参数里恰好一个 requestId(多出来的不管,同并之前);没有 ⇒ not_found。
    // 桌面(原 /v1/workbench/entry-receipt):查询参数恰好 requestId 一个。
    'GET /v1/matter/create-receipt': action(async (m, q) => {
      const requestId = q.get('requestId')
      if (!requestId || !UUID.test(requestId) || q.getAll('requestId').length !== 1) return phoneInvalid('invalid_request_id')
      try {
        const result = m.entryReceipt(requestId.toLowerCase(), { surface: 'phone' })
        if (!result) return phoneError(Error('not_found'))
        return { status: 200, body: { ok: true, ...result as object } }
      } catch (err) { return phoneError(err) }
    }, async (m, query) => {
      const requestId = query.get('requestId')
      if (query.size !== 1 || !requestId || !UUID.test(requestId)) return invalid()
      try {
        const result = m.entryReceipt(requestId.toLowerCase(), { surface: 'desktop', ownerKey: ownerKey() })
        return result ? { status: 200, body: result } : { status: 404, body: { error: 'not_found' } }
      } catch (err) { return mappedError(err) }
    }),
  }
}
