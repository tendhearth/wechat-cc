/**
 * 主动外发的那一步(从 tick-bodies.ts 原样搬出):两道闸(微信断了 / 会话在跑)、会话解析、claim-before-dispatch。
 * 推送那一拍(tick-push)和定时那一轮(tick-job)共用这一份,所以单独成文件。
 */
import { loadCompanionConfig } from '../companion/config'
import { resolveEffectiveTier, resolveTier, TIER_PROFILES, effectivePermissionMode } from '../../domain/user-tier'
import { providerDenialFor } from '../../domain/provider-policy'
import { loadAgentConfig } from '../../lib/agent-config'
import { replyTextStrategyFor } from '../../domain/capability-matrix'
import { collectTurn } from '../../ports/agent-provider'
import { isNetworkUnprotectedError } from '../../lib/network-gate'
import type { TickDeps } from './tick-deps'
import type { TickTextStyle } from './tick-texts'
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

export function makeTickDispatch(deps: TickDeps) {
  const launchCwd = process.cwd()

  /**
   * 主动外发的两道闸,连同它们要用的会话解析(project / tier / provider)。
   * 一份逻辑两处用:真发之前(dispatchToChat)和**日程判断之前**
   * —— 断线时不该先烧一次判断模型再发现这条根本发不出去
   * (memory: no-retry-storm-when-disconnected)。
   *
   * 只算不打日志:两个调用点要打的日志不一样(dispatchToChat 打
   * COMPANION / SCHED 那两行原文,判断那边打一行 PLAN skip)。
   */
  type DispatchGate =
    | { blocked: 'wechat_degraded' }
    | { blocked: 'session_in_flight' | 'provider_denied' | null; proj: { alias: string; path: string }; tier: ReturnType<typeof resolveEffectiveTier>; providerId: typeof deps.boot.defaultProviderId }
  /** 微信断了还能不能照跑:App 收得到这个 chat(交付由 daemon 管,文字能改道落到 App)。 */
  const appCarries = (chatId: string): boolean =>
    !!deps.proactive && deps.proactive.appDeliverable(chatId)
  function resolveDispatch(chatId: string): DispatchGate {
    const snapshot = deps.projects.load()
    const currentAlias = snapshot.current && snapshot.projects[snapshot.current] ? snapshot.current : null
    const proj = currentAlias
      ? { alias: currentAlias, path: snapshot.projects[currentAlias]!.path }
      : { alias: '_default', path: launchCwd }
    const tier = resolveEffectiveTier(chatId, deps.loadAccess(), deps.permissionMode)
    // Dispatch on the chat's OWN mode provider (what its normal replies use),
    // not the daemon default. A codex-default install whose chat is solo-claude
    // would otherwise push via codex — a provider the chat never uses, which on
    // the Claude-designed companion prompt hangs and delivers nothing.
    const mode = deps.boot.coordinator.getMode(chatId)
    const providerId =
      mode.kind === 'solo' ? mode.provider
      : mode.kind === 'primary_tool' ? mode.primary
      : (mode.participants?.[0] ?? deps.boot.defaultProviderId)
    // 和协调器分派时同一道门(conversation-coordinator 的 dispatch-time gate,3c 2026-10-22 补上):对话的 mode
    // 行可能是还是 trusted 时设的,降成 guest 以后留着 —— 主动 / 定时这一拍照样会拿它起执行者。用原始 tier
    // (不是 effective:--dangerously 不能替访客解锁),名单读 agent-config 的 trusted_providers。
    const rawTier = resolveTier(chatId, deps.loadAccess())
    let denied = false
    if (rawTier !== 'admin') {
      try { denied = providerDenialFor(providerId, rawTier, loadAgentConfig(deps.stateDir).trusted_providers) !== null }
      catch { denied = true }  // 非管理员、判不了就不起执行者:缺省往拒绝的方向兜底(主人那条不受影响)
    }
    if (denied) return { blocked: 'provider_denied', proj, tier, providerId }
    // 在 LLM 生成之前就拦下:degraded 时这条消息既发不出去,生成它也是白烧
    // token,而且等链路恢复后内容早已过时 —— 所以直接丢弃,不排队。
    // 例外(2026-10-18):App 收得到 ⇒ 这一拍照跑,文字落到 App(「有一条路送得到」才是闸)。
    if (deps.health?.shouldSuspend('wechat') && !appCarries(chatId)) return { blocked: 'wechat_degraded' }
    // Proactive fast-skip (TOCTOU-prone on its own, kept ABOVE the mutex
    // deliberately): avoids waiting on the lock in the common case where a
    // user session is obviously already busy. The runExclusive below closes
    // the residual race window this check alone can't — see the comment on
    // it just below.
    const inFlight = deps.boot.sessionManager.isInFlight({ alias: proj.alias, providerId, chatId })
    return { blocked: inFlight ? 'session_in_flight' : null, proj, tier, providerId }
  }

  /** 判断这一步用的薄壳:能不能发?不能就给个理由。 */
  const dispatchBlockedReason = (chatId: string): string | null => resolveDispatch(chatId).blocked

  /**
   * Resolves the chat's session (project/tier/provider), checks the
   * in-flight guard, acquires the handle, runs `claim()` (write the
   * at-most-once marker BEFORE dispatch — see the at-most-once note below),
   * then dispatches `buildText()`. Shared by the agenda and gap branches so
   * both get the same session-isolation + claim-before-dispatch contract.
   */
  async function dispatchToChat(
    chatId: string,
    args: { claim: () => (() => void) | void; buildText: (style: TickTextStyle) => string },
  ): Promise<boolean> {
    const gate = resolveDispatch(chatId)
    if (gate.blocked === 'wechat_degraded') {
      deps.log('COMPANION', `chat=${chatId} skipped: wechat connection degraded`)
      return false
    }
    const { proj, tier, providerId } = gate
    if (tier !== 'admin') {
      deps.log('COMPANION', `chat=${chatId} is non-admin tier (${tier}); push tick will run with reduced capabilities`)
    }
    const tierProfile = TIER_PROFILES[tier]
    if (gate.blocked === 'provider_denied') {
      deps.log('COMPANION', `chat=${chatId} skipped: provider=${providerId} not allowed for this chat's tier (${tier})`)
      return false
    }
    if (gate.blocked === 'session_in_flight') {
      deps.log('SCHED', `[companion] skipping push tick: user session in-flight (alias=${proj.alias} provider=${providerId} chat=${chatId})`)
      return false // leave the item pending — retry next tick
    }
    // Session-serialization (Task 3) — serialize the tick's acquire+claim+
    // dispatch against the SAME per-chatId mutex app converse turns
    // (companionConverse) and WeChat inbound turns (coordinator.dispatch)
    // use. Without this, the isInFlight check above is a TOCTOU: an app
    // turn opens its reply-sink AFTER its own (slower) manager.acquire, so
    // a tick could slip through in that window and have its reply captured
    // into the still-open app sink. The tick never calls
    // coordinator.dispatch/dispatchInner itself (it drives the
    // SessionManager handle directly), so this can never re-enter the
    // mutex and self-deadlock. See docs/superpowers/specs/2026-07-10-
    // session-serialization-design.md.
    await deps.boot.coordinator.runExclusive(chatId, async () => {
      const handle = await deps.boot.sessionManager.acquire({
        alias: proj.alias,
        path: proj.path,
        providerId,
        chatId,
        tierProfile,
        permissionMode: effectivePermissionMode(chatId, deps.loadAccess(), deps.permissionMode),
      })
      // Claim BEFORE dispatch — mark the send up front so a push that is
      // interrupted (machine sleeps mid-turn; daemon restart / lock-steal on
      // wake) cannot re-fire on the next tick. At-most-once: if the dispatch
      // then fails the nudge is simply skipped rather than retried — the
      // deliberate trade-off for proactive messages, where a duplicate is the
      // reported pain and a missed nudge is low-stakes (the agent can
      // re-author it, or the gap/agenda gate will surface it again later).
      // See docs/superpowers/specs/2026-06-25-companion-push-at-most-once-design.md
      const undo = args.claim()
      // 回复交付(spec 2026-10-03,已定 ③):推送也是一轮,最后的话就是推送,`NO_REPLY` = 这次不发(撤回登记)。
      const allSegments = replyTextStrategyFor(providerId) === 'all_segments'
      const tickText = args.buildText({ allSegments })
      // 往哪儿送(微信能用走微信,不能用 / 发失败落到 App)由 proactive-channel 定,一轮粘住一条路。
      const outbound = deps.proactive?.open(chatId)
      const turn = deps.replyDelivery.begin(chatId, { context: 'tick', providerId, textStrategy: replyTextStrategyFor(providerId), ...(outbound ? { outbound } : {}) })
      try {
        const summary = await collectTurn(handle.dispatch(tickText))
        if (summary.error) {
          deps.log('SCHED', `companion tick dispatch error event: ${summary.errorCode ? `${summary.errorCode}: ` : ''}${summary.error}`)
          turn.abandon(summary.errorCode ?? 'error')
        } else {
          const report = await turn.deliver({ finalText: summary.finalText ?? '', narration: summary.narration ?? [] })
          // 「CC 做过的事」(B9):说出去了 / 想说没发出去 分开记;静默是一个决定,不算做了什么。只记主人。
          const said = report.bubbles > 0 || report.attachmentsSent > 0
          if ((said || report.failures.length > 0) && chatId === loadCompanionConfig(deps.stateDir).default_chat_id) {
            try { deps.activityLog?.append({ kind: 'proactive', status: said ? 'sent' : 'deferred' }) } catch { /* 记不上不影响发 */ }
          }
          // 落在 App ⇒ 整轮一条 companion 推送;落在微信 ⇒ 什么都不做(App 对话页已经看得见那一行)。
          outbound?.finish()
          if (outbound?.channel() === 'app') deps.log('COMPANION', `chat=${chatId} tick delivered to the app (wechat not usable)`)
          if (report.failures.length > 0 && report.bubbles === 0 && report.attachmentsSent === 0) {
            // 发了但没发出去(断线 / 风控):登记保留,不在下一拍重跑模型再发一次(2026-10-10)。
            // 「失败」也可能其实送到了(超时之后服务端已收),重发就是重复;断线时每拍一轮模型也违背「断线时停掉外发与模型轮次」。
            deps.log('COMPANION', `chat=${chatId} tick send failed (${report.failures[0]}) — claim kept, not retried`)
          } else if (report.delivery === 'silent' || report.delivery === 'empty') {
            // 没发出去就不算发过:撤回登记(at-most-once 只管「发了一半」,静默是一个决定)。
            deps.log('COMPANION', `chat=${chatId} tick delivered nothing (${report.delivery}) — claim undone`)
            try { undo?.() } catch (e) { deps.log('SCHED', `undo claim failed: ${errMsg(e)}`) }
          }
        }
      } catch (err) {
        turn.abandon('threw')
        // 评审 #193 P2-3:网络守护拒了这一轮 —— SessionManager 在碰 provider **之前**就拒,一个字都
        // 没发出去。这不是「发了一半」,at-most-once 不适用:撤回登记,整拍算跳过,下一拍再来。
        if (isNetworkUnprotectedError(err)) {
          try { undo?.() } catch (e) { deps.log('SCHED', `undo claim failed: ${errMsg(e)}`) }
          throw err
        }
        deps.log('SCHED', `companion tick dispatch failed: ${errMsg(err)}`)
      }
    })
    return true
  }

  return { resolveDispatch, dispatchBlockedReason, dispatchToChat }
}

export type TickDispatch = ReturnType<typeof makeTickDispatch>
