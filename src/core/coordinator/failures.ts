/**
 * 出错怎么说、出错之后怎么自愈。上半是给主人的话(纯函数),下半是 solo / /both / /chat 共用的两种收尾:
 * 认证失败、回合超时 —— 都先放掉坏掉的会话(下一条起新子进程),再告诉主人。
 */
import type { ProviderId } from '../../domain/conversation'
import { capabilitiesFor } from '../../domain/capability-matrix'
import type { TurnSummary } from '../agent-provider'
import type { CoordinatorCtx } from './ctx'

/** User-facing notice when a provider reports an auth failure.
 *  `auth_failed`(默认):the user already authenticated once; the session
 *  lapsed and they need to re-run the provider's login command on the same
 *  machine.
 *  `auth_rejected`:凭证被 API 拒了(401/403),但**没有**证据说是登录过期 ——
 *  红线 A(owner 2026-10-02 细化):这时不许说「登录过期 / 重新登录」。 */
export function authFailNotice(providerId: ProviderId, code: string = 'auth_failed'): string {
  if (code === 'auth_rejected') {
    return `我这会儿够不着自己的脑子了:${providerId} 认证没通过(API 返回 401/403)。请主人在电脑上检查一下账号或密钥,弄好之后再发我一条,我就回来了。`
  }
  const hint = capabilitiesFor(providerId).authFailHint
  return hint
    ? `我这会儿够不着自己的脑子了,${providerId} 的登录好像过期了。\n${hint}\n弄好之后再发我一条,我就回来了。`
    : `我这会儿够不着自己的脑子了,${providerId} 的登录好像过期了。让主人在电脑上重新登录一下,再发我一条,我就回来了。`
}

/** User-facing notice when a turn dies with a GENERIC error and produced no
 *  reply at all (owner 2026-08-25: 「用户发你好,应该有个回复,比如大脑还未
 *  接入」— silence reads as being ignored). Two flavors: a spawn/missing-
 *  binary shape means the brain was never hooked up; anything else is a
 *  transient hiccup. Both point at the desktop 大脑 card, in CC's voice. */
/** spawn 阶段的失败(不是回合中途):探测没过 / 二进制不在。把 provider 自己
 *  给的人话原样带上 —— first-use-probe 的 failureMessage 就是写给用户看的。 */
/**
 * provider 边界产的码 → 给主人的一句**老实的原因**(arch backlog #4 第 2 步)。
 * 只按码说话,不读错误原文;认证两码不在这里(它们走 authFailNotice,措辞按红线 A 分)。
 * 没码 / 码说不出具体原因 ⇒ undefined,调用方用原来的通用说法。
 */
export function providerFailureReason(providerId: ProviderId, code: string | undefined): string | undefined {
  switch (code) {
    case 'network': return `这条没接住:连不上 ${providerId} 的服务(网络问题,不是你的消息有问题)。网络好了再发我一次就行。`
    case 'server_error': return `这条没接住:${providerId} 的服务那边出错了(服务端 5xx),通常过一会儿自己会好,稍后再发我一次。`
    case 'rate_limited': return `这条没接住:${providerId} 暂时限流了,等几分钟再发我一次。`
    case 'quota': return `这条没接住:${providerId} 的额度用完了。等额度恢复,或者先换一个脑子(比如 /cc)。`
    case 'region_unavailable': return `这条没接住:${providerId} 说你现在的网络出口所在地区用不了它(不是登录问题,重发也没用)。换一个出口地区,或者先换一个脑子(比如 /cc)。`
    default: return undefined
  }
}

export function spawnFailedNotice(providerId: ProviderId, detail: string, code?: string): string {
  const head = `${providerId} 这次没起来,这条我没接住。`
  const reason = providerFailureReason(providerId, code)
  if (reason) return `${head}${reason.replace(/^这条没接住:/, '')}\n先 /cc 用 Claude 也行。`
  const d = detail.trim()
  if (/enoent|not found|no such file|not installed/i.test(d)) return `${head}它好像还没在电脑上接好 —— 主人在「此刻」页的大脑卡里帮我接上,或者 /cc 先用 Claude。`
  return `${head}${d.length > 0 ? d.slice(0, 300) : ''}\n先 /cc 用 Claude 也行。`
}

export function turnErrorNotice(providerId: ProviderId, error: string | undefined, code?: string): string {
  const reason = providerFailureReason(providerId, code)
  if (reason) return reason
  const e = (error ?? '').toLowerCase()
  if (/enoent|not found|no such file|spawn|not installed/.test(e)) {
    return `这条我收到了,但没想起来怎么回——我的脑子(${providerId})好像还没在电脑上接好。麻烦主人打开 wechat-cc,在「此刻」页点一下大脑卡帮我接上,弄好再发我一条就行。`
  }
  return `刚刚脑子卡了一下,这条没接住…过一会儿再发我一次?老是这样的话,让主人在电脑上看看「此刻」页的大脑卡。`
}

export interface FailureHandlers {
  handleAuthFailed(chatId: string, alias: string, providerId: ProviderId, summary: TurnSummary): Promise<void>
  handleTurnTimeout(chatId: string, alias: string, providerId: ProviderId, summary: TurnSummary): Promise<void>
}

export function createFailureHandlers(ctx: CoordinatorCtx): FailureHandlers {
  const { deps, notice, nowMs } = ctx
  const authFailThrottleMs = deps.authFailNotifyThrottleMs ?? 60 * 60_000
  // chatId → last-notice-at; used to throttle the auth_failed notice.
  const authFailLastNotifyAt = new Map<string, number>()

  /** On auth_failed: release the in-memory session (so the next dispatch
   *  starts a fresh subprocess that re-reads keychain — self-heal without
   *  waiting for an idle gap that a busy chat never reaches), then send
   *  one throttled neutral notice. On throttle the chat is silent — the
   *  user already saw the notice within the window. */
  async function handleAuthFailed(chatId: string, alias: string, providerId: ProviderId, summary: TurnSummary): Promise<void> {
    deps.log('AUTH_FAILED', `chat=${chatId} alias=${alias} provider=${providerId} message=${JSON.stringify((summary.error ?? '').slice(0, 200))}`, {
      event: 'auth_failed',
      chat_id: chatId,
      project_alias: alias,
      provider: providerId,
    })
    // Release is best-effort — if it throws we still want to send the user
    // notice. release() being absent from the manager dep (e.g. in test
    // fixtures that don't exercise the recycle path) is also tolerated.
    try {
      // Release the same session triple that dispatchSolo/Parallel/Chatroom
      // registered under (per-chat now since Task 10). A fresh dispatch in
      // this chat re-acquires from a clean subprocess that re-reads
      // keychain creds.
      // SessionManager.release revokes the session's auth token (every release
      // path, incl. internal eviction) — no separate invalidate call here.
      await deps.manager.release?.({ alias, providerId, chatId })
    } catch (err) {
      deps.log('AUTH_FAILED', `release ${alias}/${providerId} threw: ${err instanceof Error ? err.message : err}`)
    }
    const last = authFailLastNotifyAt.get(chatId) ?? 0
    if (nowMs() - last < authFailThrottleMs) return
    authFailLastNotifyAt.set(chatId, nowMs())
    await notice(chatId, authFailNotice(providerId, summary.errorCode))
  }

  /** On a per-turn watchdog timeout: the agent stream stalled silently.
   *  Release the (now-poisoned) session so the NEXT message in this chat
   *  re-acquires a fresh subprocess instead of throwing "previous dispatch
   *  still in flight" forever — same self-heal shape as [[handleAuthFailed]].
   *  Then tell the user to retry. Unlike auth_failed this is not throttled:
   *  a timeout is a one-off transient, and the user needs to know their
   *  message was dropped, not silently swallowed. */
  async function handleTurnTimeout(chatId: string, alias: string, providerId: ProviderId, summary: TurnSummary): Promise<void> {
    deps.log('TURN_TIMEOUT', `chat=${chatId} alias=${alias} provider=${providerId} ${summary.error ?? ''}`, {
      event: 'turn_timeout',
      chat_id: chatId,
      project_alias: alias,
      provider: providerId,
    })
    try {
      // SessionManager.release revokes the session's auth token (see above).
      await deps.manager.release?.({ alias, providerId, chatId })
    } catch (err) {
      deps.log('TURN_TIMEOUT', `release ${alias}/${providerId} threw: ${err instanceof Error ? err.message : err}`)
    }
    await notice(chatId, '想了半天没想出来,刚才那条掉了…再发我一次?')
  }
  return { handleAuthFailed, handleTurnTimeout }
}
