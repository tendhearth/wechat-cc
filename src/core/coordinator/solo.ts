/**
 * 单模型:solo、primary_tool,以及 /both、/chat 退成一家的那一轮。只编排 —— acquire、拼 prompt(交接块)、
 * 交付走哪条路(legacy / shadow / daemon)、出错怎么说;跑回合本身交给 TurnRunner。
 */
import type { ProviderId } from '../conversation'
import type { InboundMsg } from '../prompt-format'
import { buildHandoffBlock, buildColdStartBlock, type HandoffTurn } from '../provider-handoff'
import { describeProviderDenial, slashFor } from '../provider-policy'
import { capabilitiesFor } from '../capability-matrix'
import { makeTurnTextCollector, type DeliveryReport, type TurnDeliveryHandle } from '../turn-reply'
import { TURN_TIMEOUT_CODE, type TurnSummary } from '../agent-provider'
import { isAuthErrorCode, providerErrorCodeOf } from '../../lib/provider-error-code'
import type { CoordinatorCtx, ProjectRef } from './ctx'
import type { TurnPlan } from './plan'
import type { TurnRunner } from './runner'
import { LONG_TURN_PROGRESS } from './runner'
import { spawnFailedNotice, turnErrorNotice, type FailureHandlers } from './failures'
import type { TurnRecord } from './types'

type SoloPlan = TurnPlan & { kind: 'solo' }
type RefusedPlan = TurnPlan & { kind: 'refused' }

export interface Solo {
  dispatch(msg: InboundMsg, proj: ProjectRef, plan: SoloPlan): Promise<void>
  /**
   * Dispatch-time fail-closed provider gate (core/provider-policy.ts).
   * mode-commands' slash gate only guards the SLASH flip: POST
   * /v1/conversation/set-mode can set any solo row directly, and a row set
   * validly while the chat WAS trusted survives a later demotion to guest in
   * access.json with no re-validation. Both land here — refuse to spawn
   * rather than trust the mode row's vintage. The decision itself is made in
   * admit() on the raw tier (see TurnAuth.rawTier). Originally agy-only
   * ("agy final-review Important 2").
   */
  refuse(msg: InboundMsg, plan: RefusedPlan): Promise<void>
}

export function createSolo(ctx: CoordinatorCtx, runner: TurnRunner, failures: FailureHandlers): Solo {
  const { deps, notice, nowMs } = ctx
  // 每家 provider 连续走 fallback 的轮数(见 deps.onFallbackStreak)。
  const fallbackStreak = new Map<ProviderId, number>()

  async function refuse(msg: InboundMsg, plan: RefusedPlan): Promise<void> {
    const { providerId, denial } = plan
    deps.log('COORDINATOR', `chat=${msg.chatId} refuse solo+${providerId} dispatch: ${denial.kind} tier=${plan.auth.rawTier} (dispatch-time gate)`, {
      event: denial.kind === 'shared_token_guest' ? 'shared_token_guest_refused' : denial.kind === 'unconfined_guest' ? 'unconfined_guest_refused' : 'provider_not_allowed_refused',
      chat_id: msg.chatId,
      provider: providerId,
    })
    await notice(msg.chatId, describeProviderDenial(denial, slashFor(providerId)))
  }

  async function dispatch(msg: InboundMsg, proj: ProjectRef, plan: SoloPlan): Promise<void> {
    const { providerId, auth } = plan
    // The mode this dispatch is serving, for the TurnRecord. This is the
    // single-provider dispatch path for solo AND primary_tool AND a
    // parallel/chatroom that degraded to one participant — recording a literal
    // 'solo' would mislabel those in GET /v1/turns and misdirect diagnosis.
    const recordMode: TurnRecord['mode'] = plan.recordMode
    deps.log('COORDINATOR', `solo chat=${msg.chatId} → project=${proj.alias} provider=${providerId} tier=${auth.tier}`, {
      event: 'dispatch_solo',
      chat_id: msg.chatId,
      project_alias: proj.alias,
      provider: providerId,
      tier: auth.tier,
    })
    // One structured TurnRecord is emitted per dispatch in the finally
    // below — exactly once, on every path (completed / timeout / auth /
    // unexpected throw).
    const startedAt = nowMs()
    let outcome: TurnRecord['outcome'] = 'error'
    let summary: TurnSummary | undefined
    let unregisterCancel: (() => void) | undefined
    // 回复交付 shadow(spec §5.1 第 3 项):照旧走 legacy,另外把「按新路会发什么」与 legacy 实际
    // 发出去的比一比,只记日志。从 dispatch 开始前就开着,reply 路由 / fallback 发出的每一条才旁听得到。
    let shadow: TurnDeliveryHandle | undefined
    // 回复交付 daemon(spec §4.3):最后的话经端口送达;report 落进 TurnRecord。
    let delivery: TurnDeliveryHandle | undefined
    let report: DeliveryReport | undefined
    let deliverySettled = false
    try {
      // Per-chat model pin lives on the solo mode row; only solo carries it.
      const cur = ctx.getMode(msg.chatId)
      const pinnedModel = cur.kind === 'solo' && cur.provider === providerId ? cur.model : undefined
      // 冷启动判定要在 acquire 之前看:acquire 之后缓存里一定有了。
      const coldSpawn = deps.manager.has ? !deps.manager.has({ alias: proj.alias, providerId, chatId: msg.chatId }) : false
      let handle: Awaited<ReturnType<typeof deps.manager.acquire>>
      try {
        handle = await deps.manager.acquire({
          alias: proj.alias,
          path: proj.path,
          providerId,
          chatId: msg.chatId,
          tierProfile: auth.tierProfile,
          permissionMode: auth.permissionMode,
          ...(pinnedModel !== undefined ? { model: pinnedModel } : {}),
        })
      } catch (err) {
        // spawn 阶段就挂了(二进制不在 / 首次使用探测没过 / SDK 起不来):
        // 之前这个异常一路冒到 dispatch 外层只记日志,用户端一片沉默。
        // 沉默 = 被无视;把原因用人话交给用户,并记一条 turn。
        const detail = err instanceof Error ? err.message : String(err)
        // 边界在抛出物上挂了码(比如 Cursor ACP 建会话时的 -32000 未登录)就按码走:
        // 认证 ⇒ 与回合里的认证失败同一条路(释放 + 节流提示,措辞按码分);其余 ⇒ 老实的原因。
        const code = providerErrorCodeOf(err)
        summary = { assistantText: [], replyToolCalled: false, toolCalls: [], error: detail, ...(code ? { errorCode: code } : {}) }
        deps.log('COORDINATOR', `chat=${msg.chatId} provider=${providerId} spawn failed${code ? ` code=${code}` : ''}: ${detail.slice(0, 300)}`, { event: 'spawn_failed', chat_id: msg.chatId, provider: providerId })
        if (isAuthErrorCode(code)) {
          outcome = 'auth_failed'
          await failures.handleAuthFailed(msg.chatId, proj.alias, providerId, summary)
          return
        }
        outcome = 'error'
        await notice(msg.chatId, spawnFailedNotice(providerId, detail, code))
        return
      }
      // Registered before the turn starts draining so /stop can reach
      // this turn for its entire lifetime — cleared in the finally below,
      // same lifecycle as chatroom's aborters.
      unregisterCancel = runner.registerCancel(msg.chatId, () => { void handle.cancel?.() })
      const stopped = runner.stopMark(msg.chatId)
      let text = deps.format(msg)
      // 换 provider 后的第一条:前置交接块(近况原文 + chat_history 提示)。
      const handoff = ctx.handoffLedger.takeHandoff(msg.chatId)
      if (handoff) {
        let recent: HandoffTurn[] = []
        try { recent = await deps.recentTurns?.(msg.chatId, 12) ?? [] } catch { /* 交接是增强,拿不到就只给提示语 */ }
        text = `${buildHandoffBlock(handoff.from, handoff.to, recent)}\n\n${text}`
        deps.log?.('HANDOFF', `chat=${msg.chatId} ${handoff.from}→${handoff.to} recent=${recent.length}`)
      } else if (coldSpawn && !capabilitiesFor(providerId).supportsResume) {
        // 不能续线程的 provider(openai/gemini)刚被冷 spawn:daemon 重启 /
        // 空闲驱逐后它对「刚才聊到哪」一无所知,而 claude/agy 都接得上。
        // 用交接块同样的原文源补一段近况;新对话(没记录)就什么都不加。
        let recent: HandoffTurn[] = []
        try { recent = await deps.recentTurns?.(msg.chatId, 12) ?? [] } catch { /* 增强,拿不到就算了 */ }
        if (recent.length > 0) {
          text = `${buildColdStartBlock(providerId, recent)}\n\n${text}`
          deps.log?.('HANDOFF', `chat=${msg.chatId} cold-start ${providerId} recent=${recent.length}`)
        }
      }
      const deliveryMode = ctx.deliveryModeFor(providerId)
      if (deliveryMode === 'shadow') {
        try { shadow = deps.replyDelivery!.begin(msg.chatId, { mode: 'shadow', context: 'dm', providerId, textStrategy: ctx.textStrategyFor(providerId) }) } catch { shadow = undefined }
      }
      // daemon:开轮(附件从此刻起登记到这一轮)。编码型执行者(last_segment)挂上长任务进度(已定 ①:
      // 一轮最多一次,有旁白用最近一段);聊天型模型(all_segments)每段都会交付,不发进度。
      const textStrategy = ctx.textStrategyFor(providerId)
      const live = deliveryMode === 'daemon' ? makeTurnTextCollector() : undefined
      if (deliveryMode === 'daemon') {
        delivery = deps.replyDelivery!.begin(msg.chatId, { mode: 'daemon', context: 'dm', providerId, textStrategy })
      }
      const d = delivery
      summary = await runner.run({
        chatId: msg.chatId, alias: proj.alias, providerId, handle, prompt: text, budget: 'turn',
        ...(live ? { observe: (ev) => live.push(ev) } : {}),
        ...(d && textStrategy === 'last_segment' ? { progress: () => { void d.progress(live!.latestSegment() ?? LONG_TURN_PROGRESS).catch(() => {}) } } : {}),
      })
      const assistantTexts = summary.assistantText
      const replyToolCalled = summary.replyToolCalled
      const settle = (reason: string) => { if (delivery && !deliverySettled) { deliverySettled = true; delivery.abandon(reason) } }

      // Per-turn watchdog fired: the SDK stream went silent. Discard the
      // wedged session and tell the user to retry — must come before the
      // fallback-text path so a stalled turn never leaks a partial reply.
      if (summary.errorCode === TURN_TIMEOUT_CODE) {
        outcome = 'timeout'
        settle('timeout')
        await failures.handleTurnTimeout(msg.chatId, proj.alias, providerId, summary)
        return
      }

      // Structured auth-failure path: provider intercepted the "Not logged in"
      // assistant text and re-emitted it as a coded error. Suppress fallback
      // and send a throttled neutral notice instead — never leak provider
      // failure text to the user.
      if (isAuthErrorCode(summary.errorCode)) {
        outcome = 'auth_failed'
        settle('auth_failed')
        await failures.handleAuthFailed(msg.chatId, proj.alias, providerId, summary)
        return
      }

      outcome = summary.error ? 'error' : 'completed'

      if (delivery && stopped()) {
        settle('cancelled')
        deps.log('REPLY', `chat=${msg.chatId} provider=${providerId} 主人中止了这一轮 —— 不发通知、不交付半截话`)
        return
      }

      // 回复交付 daemon(spec §4.2 末段 / §4.3):只有 completed 的轮交付最后的话;出错一律只发通知、
      // 不发残文(与 #190「错误不许当回复发」同一条红线)。没有 FALLBACK_REPLY:有文字没调工具是正常路径。
      if (delivery) {
        if (outcome !== 'completed') {
          settle('error')
          await notice(msg.chatId, turnErrorNotice(providerId, summary.error, summary.errorCode))
          return
        }
        deliverySettled = true
        // 核对(回复交付第 5 步):provider 自己也报了「最后的话」(Claude 的 result.result)⇒ 和分段的结果比一下。
        // 交付永远用分段的结果;对不上只记一行,留给真机看分段规则有没有漏(子 agent 文字、块顺序……)。
        if (summary.providerFinalText !== undefined && summary.providerFinalText.trim() !== (summary.finalText ?? '').trim()) {
          deps.log('REPLY_FINAL_CHECK', `chat=${msg.chatId} provider=${providerId} match=differs segments_len=${(summary.finalText ?? '').length} sdk_len=${summary.providerFinalText.length}`)
        }
        report = await delivery.deliver({ finalText: summary.finalText ?? '', narration: summary.narration ?? [] })
        ctx.noteDelivery(providerId, report.delivery)
        return
      }

      // Generic-error silence guard (2026-08-25): a turn that died with an
      // error, called no reply tool and produced no assistant text used to
      // leave the user staring at nothing — silence reads as being ignored.
      // Tell them, in CC's voice, that the message was dropped and where the
      // fix lives. Unthrottled on purpose (same rationale as the timeout
      // notice: each dropped message deserves an acknowledgement).
      if (summary.error && !replyToolCalled && assistantTexts.length === 0) {
        await notice(msg.chatId, turnErrorNotice(providerId, summary.error, summary.errorCode))
        return
      }

      // Same fallback semantics as the legacy routeInbound: only forward
      // raw assistant text when the agent did NOT call a reply-family
      // tool this turn. Prevents the duplicate-message footgun while
      // protecting users from a forgetful agent that describes an image
      // in plain text without ever calling reply.
      if (replyToolCalled) {
        if ((fallbackStreak.get(providerId) ?? 0) > 0) { fallbackStreak.set(providerId, 0); deps.onFallbackStreak?.(providerId, 0) }
        return
      }
      if (assistantTexts.length === 0) return
      {
        const n = (fallbackStreak.get(providerId) ?? 0) + 1
        fallbackStreak.set(providerId, n)
        deps.onFallbackStreak?.(providerId, n)
      }
      deps.log('FALLBACK_REPLY', `chat=${msg.chatId} project=${proj.alias} provider=${providerId} chunks=${assistantTexts.length} preview=${JSON.stringify(assistantTexts[0]?.slice(0, 80) ?? '')}`)
      for (const t of assistantTexts) {
        await deps.sendAssistantText?.(msg.chatId, t)
      }
    } finally {
      unregisterCancel?.()
      if (delivery && !deliverySettled) { deliverySettled = true; try { delivery.abandon(outcome) } catch { /* 记账不影响回合 */ } }
      // shadow 只是记账:绝不能影响这一轮(抛错就地吞掉)。只有 completed 的轮才比 —— 新路也只交付那些。
      if (shadow) {
        try {
          if (outcome === 'completed' && summary) await shadow.deliver({ finalText: summary.finalText ?? '', narration: summary.narration ?? [] })
          else shadow.abandon(outcome)
        } catch (err) {
          deps.log('REPLY_SHADOW', `chat=${msg.chatId} provider=${providerId} shadow threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      runner.record({ chatId: msg.chatId, provider: providerId, alias: proj.alias, mode: recordMode, startedAt, endedAt: nowMs(), outcome, summary, report })
    }
  }

  return { dispatch, refuse }
}
