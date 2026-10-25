/**
 * RFC 03 §4.3 parallel mode(/both):同一条消息同时给每位参与者。各跑各的;一位抛错,其他人的回复照常
 * (Promise.allSettled)。每位的最后的话经交付端口送达(前缀 [名字] 由 daemon 加)。最后补一条综合。
 * 跑回合本身交给 TurnRunner。
 */
import { namesIn } from '../provider-registry'
import type { InboundMsg } from '../../domain/prompt-format'
import { labelOpenings, buildParallelSynthesisPrompt, type Opening } from '../../domain/chatroom-conductor'
import { buildTurnReply, type DeliveryReport } from '../../domain/turn-reply'
import { TURN_TIMEOUT_CODE, type TurnSummary } from '../agent-provider'
import { isAuthErrorCode } from '../../lib/provider-error-code'
import type { CoordinatorCtx, ProjectRef } from './ctx'
import type { TurnPlan } from './plan'
import type { TurnRunner } from './runner'
import type { FailureHandlers } from './failures'

type ParallelPlan = TurnPlan & { kind: 'parallel' }

export function createParallel(ctx: CoordinatorCtx, runner: TurnRunner, failures: FailureHandlers) {
  const { deps, nowMs } = ctx

  return async function dispatchParallel(msg: InboundMsg, proj: ProjectRef, plan: ParallelPlan): Promise<void> {
    const { participants, auth } = plan
    deps.log('COORDINATOR', `parallel chat=${msg.chatId} → project=${proj.alias} providers=${participants.join(',')} tier=${auth.tier}`)
    // allSettled the ACQUIRE phase too (not just dispatch): a single provider's
    // acquire rejection (spawn failure / pool exhausted) must NOT drop the other
    // provider's reply. A failed acquire is propagated into the same per-
    // participant settled shape below (as a rejected turn → recorded as an error
    // TurnRecord), keeping index alignment with `participants`.
    const acquired = await Promise.allSettled(
      participants.map(p => deps.manager.acquire({
        alias: proj.alias,
        path: proj.path,
        providerId: p,
        chatId: msg.chatId,
        tierProfile: auth.tierProfile,
        permissionMode: auth.permissionMode,
      })),
    )
    const text = deps.format(msg)
    const startedAt = nowMs()
    // 回复交付:这家参与者的最后的话经端口送达(前缀 [名字] 由 daemon 加);开轮在 dispatch 之前,
    // 附件才登记得上。
    const deliveries = acquired.map((a, i) => {
      if (a.status !== 'fulfilled') return undefined
      const dn = namesIn(deps.registry, participants[i]!).short
      return deps.replyDelivery.begin(msg.chatId, { context: 'parallel', providerId: participants[i]!, participantLabel: dn, textStrategy: ctx.textStrategyFor(participants[i]!) })
    })
    // Register every acquired handle's cancel BEFORE dispatching — /stop must
    // reach whichever participants are in flight, not just the first. Each
    // handle gets its own slot in the shared per-chat set (N participants
    // share one chatId); all unregister together once the whole round settles.
    const stopped = runner.stopMark(msg.chatId)
    const unregisterCancels = acquired.map(a =>
      a.status === 'fulfilled' ? runner.registerCancel(msg.chatId, () => { void a.value.cancel?.() }) : undefined,
    )
    let settled: PromiseSettledResult<TurnSummary>[]
    try {
      settled = await Promise.allSettled(acquired.map(a =>
        a.status === 'fulfilled'
          ? runner.run({ chatId: msg.chatId, alias: proj.alias, providerId: a.value.providerId, handle: a.value, prompt: text, budget: 'turn' })
          : Promise.reject(a.reason),
      ))
    } finally {
      for (const u of unregisterCancels) u?.()
    }
    // Batch end — all participants dispatched together and allSettled awaits
    // them all, so a single endedAt is the honest wall-clock for the round.
    const endedAt = nowMs()

    const answers: Opening[] = []
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]!
      const providerId = participants[i]!

      // Exactly one TurnRecord per participant, emitted in the finally below — every branch
      // `continue`s, the finally still records. Recorded AFTER delivery so a participant's
      // record carries the delivery columns like a solo turn (spec §4.10).
      const recSummary = r.status === 'fulfilled' ? r.value : undefined
      const recOutcome = runner.outcomeOf(recSummary, r.status === 'rejected')
      let report: DeliveryReport | undefined
      try {
        const turnDelivery = deliveries[i]
        if (turnDelivery && stopped()) { turnDelivery.abandon('cancelled'); continue }
        if (turnDelivery && (r.status === 'rejected' || r.value.error)) turnDelivery.abandon(r.status === 'rejected' ? 'threw' : (r.value.errorCode ?? 'error'))
        if (r.status === 'rejected') {
          deps.log('COORDINATOR_PARALLEL', `provider=${providerId} threw: ${r.reason instanceof Error ? r.reason.message : r.reason}`)
          continue
        }
        // Watchdog fired for this participant — release its wedged session and
        // notify; the other provider's reply (handled below) still goes out.
        if (r.value.errorCode === TURN_TIMEOUT_CODE) {
          await failures.handleTurnTimeout(msg.chatId, proj.alias, providerId, r.value)
          continue
        }
        // Same self-heal as solo: the failing provider's session is released
        // so the next /both dispatch spawns a fresh subprocess. handleAuthFailed
        // also fires (one throttled neutral notice across both providers per
        // chat per hour). The other provider's reply (if any) still goes
        // through below — partial reply is better than no reply.
        if (isAuthErrorCode(r.value.errorCode)) {
          await failures.handleAuthFailed(msg.chatId, proj.alias, providerId, r.value)
          continue
        }
        // acquire 成功才走到这里(失败的 r 是 rejected,上面已经 continue),所以这一位一定开过轮。
        if (!turnDelivery || r.value.error) continue
        const parts = { finalText: r.value.finalText ?? '', narration: r.value.narration ?? [] }
        report = await turnDelivery.deliver(parts)
        // 综合用的答案和交付出去的是同一份文字(同一个策略、同样剥掉令牌)。
        const said = buildTurnReply(parts, [], 'parallel', ctx.textStrategyFor(providerId)).reply
        if (!said.silent && said.text.trim()) answers.push({ speaker: providerId, text: said.text.trim() })
      } finally {
        runner.record({
          chatId: msg.chatId, provider: providerId, alias: proj.alias, mode: 'parallel', startedAt, endedAt,
          outcome: recOutcome, summary: recSummary,
          error: r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : undefined,
          report,
        })
      }
    }

    // ── /both 的收口。原本是「N 条答案并排丢给用户」,合并的活全推给人 ——
    // 在微信这块屏幕上尤其糟。并排保留(对比本身有价值),末尾补一条可以
    // 直接用的答案。不做互驳:那是 /chat 的事,/both 要的就是便宜和快。
    //
    // 少于两条就没什么可合的(一条答案的"综合"只是复读);拿不到文本的
    // 参与者(静默 / 出错 / 超时)不参与。
    const synthEval = deps.verdictEval ?? deps.haikuEval
    if (answers.length >= 2 && synthEval) {
      try {
        const synth = (await synthEval(buildParallelSynthesisPrompt(text, labelOpenings(answers)))).trim()
        if (synth) await deps.sendAssistantText?.(msg.chatId, synth.startsWith('🎯') ? synth : `🎯 ${synth}`)
      } catch (e) {
        deps.log('COORDINATOR_PARALLEL', `synthesis failed: ${e instanceof Error ? e.message : e}`)
      }
    } else if (answers.length >= 2) {
      deps.log('COORDINATOR_PARALLEL', `chat=${msg.chatId} 没有可用的 eval —— 跳过收口,只并排`)
    }
  }
}
