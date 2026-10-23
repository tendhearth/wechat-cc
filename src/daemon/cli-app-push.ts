/**
 * cli-app-push.ts — 终端 claude / codex 会话的事,除了微信,也推到主人手机 app(中继 v2 原生推送)。
 *
 * 起因(2026-10-14 真机):微信拒主动外发(ilink errcode=-2,日志「wechat refused the send」),
 * 主人什么都收不到;权限请求更糟 —— 卡片没送到,askUser 当场 fail,码作废,手机上也拍不了。
 *
 * 两条路,都不另起一套策略:
 * - 做完 / 等你批准的提醒:cli-events 的 hub 照旧判在场、快问快答、合并窗;合并窗到点时 pushApp
 *   与微信各发一次(buildCliPushPayload 把那一批变成一条推送)。
 * - 权限中继:中继 open 时已判过在场;这里先推手机,手机够得着 ⇒ 微信卡片没送到也不作废码
 *   (askUser keepOnUndelivered),手机经 /m/api/cli/permission 拍板;谁都够不着 ⇒ 'undelivered',同改造前。
 *
 * 推送载荷沿用协议包的 PushPlaintext(原生两端只认协议包 PushKind 里那几种,新 kind 老 app 会丢):
 * kind 用 permission / task_done,taskId 写成 `cli:<session_id>` —— app 认这个前缀就去
 * /terminal/[id](那页能拍板、能接着说);同一会话的通知按它折叠(collapse-id / 线程)。
 * 失败只记日志、丢弃 —— 断线不重试。
 */
import type { CliPushItem } from '../core/cli-events'
import type { CliPermissionRequest } from '../core/cli-permission-relay'
import type { PendingPermissionMeta, PermissionDecision } from './pending-permissions'
import type { PushPayload } from './phone-push'

/** app 认这个前缀:后面是终端会话 id;空 ⇒ 去「一起做」的终端列表。 */
export const CLI_PUSH_TASK_PREFIX = 'cli:'
/** 能放进深链的会话 id(app 那头同一条正则;APNs collapse-id ≤ 64 字节)。 */
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,56}$/
const BODY_MAX = 280

/** 推一条;回交给中继的台数与因在线跳过的台数。没接推送(没开中继 v2)⇒ null。 */
export type AppPushOutlet = (p: PushPayload) => { sent: number; online: number } | null

export function cliPushTaskId(sessionId?: string): string {
  return sessionId && SESSION_ID_RE.test(sessionId) ? `${CLI_PUSH_TASK_PREFIX}${sessionId}` : CLI_PUSH_TASK_PREFIX
}

function where(i: Pick<CliPushItem, 'projectName' | 'remoteMachine'>): string {
  return i.remoteMachine ? `${i.projectName}(${i.remoteMachine})` : i.projectName
}

/** 合并窗里的一批 → 一条推送(同微信一批一条)。单条 ⇒ 深链那条会话;多条 ⇒ 终端列表。 */
export function buildCliPushPayload(items: readonly CliPushItem[]): PushPayload | null {
  if (items.length === 0) return null
  const anyPermission = items.some(i => i.kind === 'permission')
  const kind = anyPermission ? 'permission' : 'task_done'
  if (items.length === 1) {
    const i = items[0]!
    const verb = i.kind === 'permission' ? '等你批准' : '完成了'
    return {
      kind,
      title: `${i.source} ${verb}`,
      body: clip(i.summary ? `${where(i)}:${i.summary}` : `${where(i)} · ${i.source} ${verb}`),
      taskId: cliPushTaskId(i.session_id),
    }
  }
  return {
    kind,
    title: anyPermission ? '终端会话等你' : `${items.length} 个终端会话完成了`,
    body: clip(items.map(i => (i.summary ? `${where(i)}:${i.summary}` : where(i))).join(' / ')),
    taskId: CLI_PUSH_TASK_PREFIX,
  }
}

/** 权限中继开出码之后推的那一条:深链到这条会话(那页就能拍),requestId 带码。 */
export function buildCliPermissionPayload(req: CliPermissionRequest, projectName: string, hash: string, localMachine?: string): PushPayload {
  const remote = req.machine && localMachine && req.machine !== localMachine ? req.machine : undefined
  const what = req.summary ? `${req.tool_name}: ${req.summary.replace(/\s+/g, ' ').trim()}` : req.tool_name
  return {
    kind: 'permission',
    title: `${req.source} 等你批准`,
    body: clip(`${where({ projectName, ...(remote ? { remoteMachine: remote } : {}) })}:${what}`),
    taskId: cliPushTaskId(req.session_id),
    requestId: hash,
  }
}

function clip(s: string): string {
  const a = [...s]
  return a.length <= BODY_MAX ? s : a.slice(0, BODY_MAX - 1).join('') + '…'
}

/** hub 的 pushApp:一批 → 一条推送,只投不等;没设备 / 没接推送 ⇒ 静默。 */
/** 回 true = 至少交给了一台手机(在线跳过的那几台算送到:它们正开着 App,看得见)。 */
export function makeCliHubAppPush(deps: { push: () => AppPushOutlet | null; log: (tag: string, line: string) => void }): (items: CliPushItem[]) => boolean {
  return (items) => {
    const outlet = deps.push()
    if (!outlet) return false
    const p = buildCliPushPayload(items)
    if (!p) return false
    const r = outlet(p)
    if (r) deps.log('CLI_PUSH', `app push ${p.kind} (${items.length} item(s)): sent to ${r.sent} device(s)${r.online ? `, ${r.online} online skipped` : ''}`)
    return !!r && r.sent + r.online > 0
  }
}

type Answer = 'allow' | 'deny' | 'timeout' | 'undelivered'

export interface CliPermissionAskDeps {
  ownerChatId: () => string | null
  /** = ilink.askUser。 */
  askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number, opts?: { keepOnUndelivered?: boolean }) => Promise<Answer>
  /** = ilink.registerPendingPermission(只登记、不发卡):没有微信主人 chat、但手机够得着时用。 */
  registerPending: (hash: string, timeoutMs: number, meta: PendingPermissionMeta) => Promise<PermissionDecision>
  /** = ilink.sweepPendingPermissions:到点让条目以 timeout 落定。 */
  sweepPending: () => void
  /** 手机 app 推送;没接(没开中继 v2)⇒ 返回 null。 */
  push: () => AppPushOutlet | null
  localMachine?: string
  log: (tag: string, line: string) => void
}

/**
 * 中继的 ask:先推手机(码已在中继登记,手机一点进来就能拍),再发微信卡。
 * 手机够得着(交给中继 ≥1 台,或有台正连着、页面上就看得见)⇒ 微信卡没送到也留着码等到点。
 */
export function makeCliPermissionAsk(deps: CliPermissionAskDeps): (prompt: string, hash: string, timeoutMs: number, ctx: { req: CliPermissionRequest; projectName: string }) => Promise<Answer> {
  return async (prompt, hash, timeoutMs, ctx) => {
    let phone = false
    const outlet = deps.push()
    if (outlet) {
      try {
        const r = outlet(buildCliPermissionPayload(ctx.req, ctx.projectName, hash, deps.localMachine))
        phone = !!r && r.sent + r.online > 0
        deps.log('CLI_PERMISSION', `app push hash=${hash}: ${r ? `sent ${r.sent}, online ${r.online}` : 'no push channel'}`)
      } catch (err) {
        deps.log('CLI_PERMISSION', `app push failed hash=${hash}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const owner = deps.ownerChatId()
    if (owner) return deps.askUser(owner, prompt, hash, timeoutMs, { keepOnUndelivered: phone })
    if (!phone) return 'undelivered'
    // 没有微信主人 chat(没绑微信):只登记,手机拍板。chatId 空串 ⇒ 任何微信 chat 都拍不了它。
    const result = deps.registerPending(hash, timeoutMs, { chatId: '', prompt })
    const t = setTimeout(() => { deps.sweepPending() }, timeoutMs + 1)
    ;(t as { unref?: () => void }).unref?.()
    return result
  }
}
