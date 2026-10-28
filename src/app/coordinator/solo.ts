/**
 * 单模型:solo、primary_tool,以及 /both、/chat 退成一家的那一轮。只编排 —— acquire、拼 prompt(交接块)、
 * 开交付轮、出错怎么说;跑回合本身交给 TurnRunner。
 */
import type { ProviderId } from '../../domain/conversation'
import type { InboundMsg } from '../../domain/prompt-format'
import { buildHandoffBlock, buildColdStartBlock, type HandoffTurn } from '../../domain/provider-handoff'
import { describeProviderDenial, slashFor } from '../../domain/provider-policy'
import { capabilitiesFor } from '../../domain/capability-matrix'
import { makeTurnTextCollector, type DeliveryReport, type TurnDeliveryHandle } from '../../domain/turn-reply'
import { TURN_TIMEOUT_CODE, type TurnSummary } from '../../ports/agent-provider'
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
    // 回复交付(spec §4.3):最后的话经端口送达;report 落进 TurnRecord。
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
      } else if (coldSpawn && !(handle.resumedHistory ?? capabilitiesFor(providerId).supportsResume)) {
        // 不能续线程的 provider(gemini;openai 续不上的那几次)刚被冷 spawn:daemon 重启 /
        // 空闲驱逐后它对「刚才聊到哪」一无所知,而 claude/agy 都接得上。
        // 用交接块同样的原文源补一段近况;新对话(没记录)就什么都不加。
        // 会话自己报了续没续上(resumedHistory)就按它,不按能力表猜(B2:openai 对话能续接了,但超长 / 换了 key 时续不上)。
        let recent: HandoffTurn[] = []
        try { recent = await deps.recentTurns?.(msg.chatId, 12) ?? [] } catch { /* 增强,拿不到就算了 */ }
        if (recent.length > 0) {
          text = `${buildColdStartBlock(providerId, recent)}\n\n${text}`
          deps.log?.('HANDOFF', `chat=${msg.chatId} cold-start ${providerId} recent=${recent.length}`)
        }
      }
      // 开轮(附件从此刻起登记到这一轮)。编码型执行者(last_segment)挂上长任务进度(已定 ①:
      // 一轮最多一次,有旁白用最近一段);聊天型模型(all_segments)每段都会交付,不发进度。
      const textStrategy = ctx.textStrategyFor(providerId)
      const live = makeTurnTextCollector()
      const d = deps.replyDelivery.begin(msg.chatId, { context: 'dm', providerId, textStrategy })
      delivery = d
      summary = await runner.run({
        chatId: msg.chatId, alias: proj.alias, providerId, handle, prompt: text, budget: 'turn',
        observe: (ev) => live.push(ev),
        ...(textStrategy === 'last_segment' ? { progress: () => { void d.progress(live.latestSegment() ?? LONG_TURN_PROGRESS).catch(() => {}) } } : {}),
      })
      const settle = (reason: string) => { if (!deliverySettled) { deliverySettled = true; d.abandon(reason) } }

      // Per-turn watchdog fired: the SDK stream went silent. Discard the
      // wedged session and tell the user to retry — before delivery so a
      // stalled turn never leaks a partial reply.
      if (summary.errorCode === TURN_TIMEOUT_CODE) {
        outcome = 'timeout'
        settle('timeout')
        await failures.handleTurnTimeout(msg.chatId, proj.alias, providerId, summary)
        return
      }

      // Structured auth-failure path: provider intercepted the "Not logged in"
      // assistant text and re-emitted it as a coded error. Deliver nothing
      // and send a throttled neutral notice instead — never leak provider
      // failure text to the user.
      if (isAuthErrorCode(summary.errorCode)) {
        outcome = 'auth_failed'
        settle('auth_failed')
        await failures.handleAuthFailed(msg.chatId, proj.alias, providerId, summary)
        return
      }

      outcome = summary.error ? 'error' : 'completed'

      if (stopped()) {
        settle('cancelled')
        deps.log('REPLY', `chat=${msg.chatId} provider=${providerId} 主人中止了这一轮 —— 不发通知、不交付半截话`)
        return
      }

      // 回复交付(spec §4.2 末段 / §4.3):只有 completed 的轮交付最后的话;出错一律只发通知、
      // 不发残文(与 #190「错误不许当回复发」同一条红线)。
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
      report = await d.deliver({ finalText: summary.finalText ?? '', narration: summary.narration ?? [] })
      ctx.noteDelivery(providerId, report.delivery)
    } finally {
      unregisterCancel?.()
      if (delivery && !deliverySettled) { deliverySettled = true; try { delivery.abandon(outcome) } catch { /* 记账不影响回合 */ } }
      runner.record({ chatId: msg.chatId, provider: providerId, alias: proj.alias, mode: recordMode, startedAt, endedAt: nowMs(), outcome, summary, report })
    }
  }

  return { dispatch, refuse }
}
