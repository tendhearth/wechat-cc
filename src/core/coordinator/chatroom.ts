/**
 * RFC 03 §4.4 chatroom mode(/chat,conductor pipeline — three beats)。
 *
 * Beat ①: parallel opening — all participants answer the raw question.
 * Beat ②: parallel cross-talk — each engages the others' openings
 *          (optional extra round if still materially split after the first).
 * Beat ③: verdict — a judged haiku synthesis prefixed with 🎯.
 *
 * 这里只编排拍子和 latest-wins 抢占;每一拍里每一位的回合交给 TurnRunner。
 */
import type { ProviderId } from '../conversation'
import { namesIn } from '../provider-registry'
import type { InboundMsg } from '../prompt-format'
import {
  buildOpeningPrompt, buildRebuttalPrompt, buildVerdictPrompt, buildConvergencePrompt, parseConvergence,
  labelOpenings, buildContentionPrompt, parseContention, lensFor,
  parsePeerRank, aggregateRanking, formatRankingFooter,
  type Opening, type Contention, type RankedSpeaker,
} from '../chatroom-conductor'
import { buildTurnReply, type DeliveryReport, type TurnDeliveryHandle } from '../turn-reply'
import type { TurnSummary } from '../agent-provider'
import type { CoordinatorCtx, ProjectRef } from './ctx'
import type { TurnAuth, TurnPlan } from './plan'
import type { TurnRunner } from './runner'
import type { FailureHandlers } from './failures'

type ChatroomPlan = TurnPlan & { kind: 'chatroom' }

/** 一位参与者在一拍里的产出。`ranking` 只有互驳拍才非空(见 parsePeerRank)。 */
interface BeatResult extends Opening { ranking: string[] }

export interface Chatroom {
  dispatch(msg: InboundMsg, proj: ProjectRef, plan: ChatroomPlan): Promise<void>
  /** 停掉这个 chat 正在跑的 /chat 辩论并等它收尾(下一轮退成单模型时用)。 */
  preemptInFlight(chatId: string): Promise<void>
  /** coordinator.cancel 的辩论那一半:有在跑的就打断,返回 true。 */
  abort(chatId: string): boolean
}

export function createChatroom(ctx: CoordinatorCtx, runner: TurnRunner, failures: FailureHandlers): Chatroom {
  const { deps, notice, nowMs } = ctx
  // RFC 03 review #11 — per-chat AbortController for in-flight chatroom
  // loops. dispatch registers; coordinator.cancel() signals; /stop
  // in mode-commands triggers cancel before flipping mode.
  const inFlightAborters = new Map<string, AbortController>()
  // PR C2 — per-chat promise that resolves when the active chatroom dispatch
  // call has finished its finally block (aborter slot cleared). A NEW
  // chatroom dispatch in the same chat awaits this so the "latest user msg
  // wins" preempt path doesn't race the prior loop's cleanup.
  const inFlightDispatchPromises = new Map<string, Promise<void>>()

  async function dispatch(msg: InboundMsg, proj: ProjectRef, plan: ChatroomPlan): Promise<void> {
    // P3 — N participants. admit() enforces ≥2 and ≤3. Empty/single is
    // degraded to solo upstream.
    const { participants } = plan
    // PR C2 — preempt any in-flight dispatch for this same chat. Without
    // this, two rapid messages produce concurrent loops that race on
    // chatroomHistories.set (last writer wins → lost user msgs).
    //
    // Loop is required for ≥3 rapid dispatches: when B and C both arrive
    // while A is in flight, both read A as their prior and both await A.
    // After A finishes, both wake; if only the FIRST checks-and-claims
    // the slot, the SECOND would silently overwrite without aborting. We
    // re-read after each await so each new wave gets preempted by the
    // next arrival, all the way until the slot is empty (in single-
    // threaded-JS sense — guaranteed by the synchronous map set below).
    while (true) {
      const priorAborter = inFlightAborters.get(msg.chatId)
      const priorPromise = inFlightDispatchPromises.get(msg.chatId)
      if (!priorAborter) break
      deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} → preempting prior in-flight dispatch`)
      priorAborter.abort()
      if (priorPromise) {
        try { await priorPromise } catch { /* prior dispatch's own error path */ }
      }
    }

    // RFC 03 review #11 — per-chat AbortController so /stop can preempt
    // an in-flight loop. Single-flight per chat (see preempt step above).
    const aborter = new AbortController()
    inFlightAborters.set(msg.chatId, aborter)

    let dispatchResolve!: () => void
    const dispatchPromise = new Promise<void>(resolve => { dispatchResolve = resolve })
    inFlightDispatchPromises.set(msg.chatId, dispatchPromise)

    // 档位在定计划时就定了(一轮一个快照):同一个 /chat 里每一拍、每一位都用同一份 —— access.json 在
    // 辩论中途被改,从下一条消息起生效。
    const auth = plan.auth

    try {
      // ── Beat ①: parallel opening — every panel agent answers the raw question.
      //
      // Re-inject [chat_id:xxx] ahead of the formatted envelope. Solo /
      // parallel dispatch deps.format(msg) verbatim, so the speaker sees the
      // <wechat chat_id="..."> envelope directly and can namespace
      // memory_*/set_user_name under it. Chatroom instead embeds
      // deps.format(msg) as `question` inside the conductor's prompt
      // builders (buildOpeningPrompt/buildRebuttalPrompt) — the envelope's
      // chat_id="..." attribute is present there too, but only as XML, not
      // the bracket form the speaker's tool-routing convention expects.
      // This was fixed once for the old LLM moderator (b69973f) which
      // paraphrased the envelope away entirely; deleting the moderator
      // (a4101ca) dropped the injection along with it even though the
      // bracket form was never restored. Prepending it here covers every
      // beat that embeds `question` (opening, rebuttal, convergence, verdict).
      const question = `[chat_id:${msg.chatId}]\n${deps.format(msg)}`

      const openings = await runBeat(msg, proj, auth, participants, (p) => buildOpeningPrompt(question, participants, p), false, aborter.signal)
      if (aborter.signal.aborted) { deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} aborted mid-debate`); return }
      if (openings.length === 0) {
        await notice(msg.chatId, '这轮没有 AI 成功回应，请稍后重发一次。')
        return
      }

      if (aborter.signal.aborted) { deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} aborted mid-debate`); return }

      // 从这里往下**全程匿名**。互驳与裁决的 prompt 里不再出现 provider 名字
      // (抄 karpathy/llm-council 的 Stage 2)——模型对着名牌客气、对着陌生
      // 名字挑刺,这是白送的偏见。用户那边照旧看到 [claude]/[codex] 前缀。
      const labels = labelOpenings(openings)

      // ── Beat ①b:争点地图。先花一次 cheapEval 问「他们到底在争什么」。
      // 抽不出争点 ⇒ **整个互驳拍跳过**,直接收口:三个模型说的是同一件事时
      // 再逼他们互驳,只会产出客套话和虚假对立(而且贵三倍)。
      let contention: Contention = { contested: [], agreed: [] }
      if (deps.haikuEval && openings.length >= 2) {
        try { contention = parseContention(await deps.haikuEval(buildContentionPrompt(question, labels))) }
        catch (e) { deps.log('COORDINATOR_CHATROOM', `contention map failed: ${e instanceof Error ? e.message : e}`) }
      }

      // 没有 cheapEval 时不能把「问不出争点」误当成「没有争点」—— 那会让
      // 整个辩论悄悄退化成一拍。没有它就退回旧行为:照常互驳,只是没有靶子。
      const shouldRebut = openings.length >= 2 && (!deps.haikuEval || contention.contested.length > 0)
      if (openings.length >= 2 && !shouldRebut) {
        deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} 开场无实质分歧 —— 跳过互驳,直接裁决`)
      }

      // 跳过互驳是**正确**行为,但它长得跟「互驳这个功能坏了」一模一样 ——
      // 用户只会看到少了两条发言。说一句,免得省下来的这一刀被当成 bug。
      const notes: string[] = []
      if (openings.length >= 2 && !shouldRebut) notes.push('（开场没有实质分歧，跳过了互驳这一轮）')

      let rebuttals: Opening[] = []
      let ranking: RankedSpeaker[] = []
      if (shouldRebut) {
        // ── Beat ②:匿名 + 只打争点 + 每人一个指派视角 + 顺带交一张互评票。
        const speakers = openings.map(o => o.speaker)
        const beat2 = await runBeat(msg, proj, auth, speakers,
          (p) => buildRebuttalPrompt(question, {
            labels, contested: contention.contested, lens: lensFor(speakers.indexOf(p)), self: p,
          }), true, aborter.signal)
        rebuttals = beat2.map(b => ({ speaker: b.speaker, text: b.text }))
        const votes = beat2.map(b => ({ voter: b.speaker, ranking: b.ranking }))

        if (aborter.signal.aborted) { deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} aborted mid-debate`); return }

        // ── Beat ②b (optional, capped at 1): only if still materially split.
        if (deps.haikuEval && rebuttals.length >= 2) {
          let conv = { converged: true } as { converged: boolean; disagreement?: string }
          try { conv = parseConvergence(await deps.haikuEval(buildConvergencePrompt(question, labels, rebuttals))) }
          catch { /* parseConvergence never throws; haikuEval might — treat as converged */ }
          if (!conv.converged && conv.disagreement) {
            const extra = await runBeat(msg, proj, auth, speakers,
              (p) => buildRebuttalPrompt(question, {
                labels, contested: contention.contested, lens: lensFor(speakers.indexOf(p)), self: p,
                focus: conv.disagreement!,
              }), true, aborter.signal)
            rebuttals = [...rebuttals, ...extra.map(b => ({ speaker: b.speaker, text: b.text }))]
            votes.push(...extra.map(b => ({ voter: b.speaker, ranking: b.ranking })))
          }
        }
        ranking = aggregateRanking(votes, labels)
        if (ranking.length) {
          deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} 互评(他评,不含自投):${ranking.map(r => `${r.speaker}=${r.score}`).join(' ')}`)
        }
      }

      if (aborter.signal.aborted) { deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} aborted mid-debate`); return }

      // ── Beat ③: verdict — a judged synthesis on the STRONG model (default
      // provider), falling back to the cheap eval. Plain text (no parse). Always emitted.
      const verdictEval = deps.verdictEval ?? deps.haikuEval
      if (verdictEval) {
        let verdict = ''
        try {
          verdict = (await verdictEval(buildVerdictPrompt(question, {
            labels, rebuttals, contested: contention.contested, ranking,
          }))).trim()
        }
        catch (e) { deps.log('COORDINATOR_CHATROOM', `verdict failed: ${e instanceof Error ? e.message : e}`) }
        if (verdict && !aborter.signal.aborted) {
          // 名次跟裁决同一条消息发出去 —— 微信上多一条消息就是多一次打扰,
          // 而这一行恰恰是让「这场辩论有没有用」变得可衡量的东西。
          const footer = [formatRankingFooter(ranking), ...notes].filter(Boolean).join('\n')
          const body = verdict.startsWith('🎯') ? verdict : `🎯 ${verdict}`
          await deps.sendAssistantText?.(msg.chatId, footer ? `${body}\n\n${footer}` : body)
        }
      }
    } finally {
      if (inFlightAborters.get(msg.chatId) === aborter) {
        inFlightAborters.delete(msg.chatId)
      }
      if (inFlightDispatchPromises.get(msg.chatId) === dispatchPromise) {
        inFlightDispatchPromises.delete(msg.chatId)
      }
      dispatchResolve()
    }
  }

  // One debate beat: run `participants` concurrently, each with its own prompt.
  // Emit each agent's text the moment that agent finishes (live feel, not
  // wait-for-slowest), record one chatroom TurnRecord per agent, and return the
  // {speaker,text} of agents that produced non-empty output (others dropped —
  // graceful degradation). Shares the fan-out shape with dispatchParallel.
  async function runBeat(
    msg: InboundMsg,
    proj: ProjectRef,
    auth: TurnAuth,
    participants: ProviderId[],
    promptFor: (p: ProviderId) => string,
    /** 互驳拍为 true:把 `#RANK:` 行当作这一位投出的选票计入互评。
     *  **剥离**那一行则是无条件的** —— 它是内部信号,任何一拍里冒出来都
     *  不该出现在给用户看的发言里(开场并没有要求它,但模型偶尔会自作主张)。 */
    countRank = false,
    /** 这一轮 /chat 的 aborter.signal:/stop 或新消息抢占时,正在说的几位当场取消,说出来的不再交付。 */
    signal?: AbortSignal,
  ): Promise<BeatResult[]> {
    const results = await Promise.all(participants.map(async (providerId): Promise<BeatResult | null> => {
      const startedAt = nowMs()
      let summary: TurnSummary | undefined
      let err: string | undefined
      const dn = namesIn(deps.registry, providerId).short
      // 回复交付 daemon(spec §4.9):这位发言人的最后的话经端口送达(前缀 [名字] 由 daemon 加,/chat 一人一条
      // 不分条);开轮在 dispatch 之前,附件才登记得上。legacy 的发言人照旧拼全部文字一条发。
      let delivery: TurnDeliveryHandle | undefined
      let report: DeliveryReport | undefined
      let unlink: (() => void) | undefined
      try {
        const handle = await deps.manager.acquire({
          alias: proj.alias, path: proj.path, providerId,
          chatId: msg.chatId, tierProfile: auth.tierProfile, permissionMode: auth.permissionMode,
        })
        unlink = runner.linkAbort(signal, () => { void handle.cancel?.() })
        if (ctx.deliveryModeFor(providerId) === 'daemon') {
          delivery = deps.replyDelivery!.begin(msg.chatId, { mode: 'daemon', context: 'chatroom', providerId, participantLabel: dn, textStrategy: ctx.textStrategyFor(providerId) })
        }
        summary = await runner.run({ chatId: msg.chatId, alias: proj.alias, providerId, handle, prompt: promptFor(providerId), budget: 'beat' })
      } catch (e) {
        err = e instanceof Error ? e.message : String(e)
      } finally {
        unlink?.()
      }
      const endedAt = nowMs()
      const outcome = runner.outcomeOf(summary, Boolean(err))
      try {
        // 主人中止 / 被新消息抢占:不发出错通知、不交付取消之后吐出来的话(与 solo/parallel 的 stopMark 同义)
        if (signal?.aborted) {
          delivery?.abandon('cancelled')
          deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} provider=${providerId} 这一拍被中止 —— 不交付`)
          return null
        }
        if (delivery && outcome !== 'completed') delivery.abandon(outcome)
        // Self-heal parity with dispatchParallel: release wedged/stale sessions
        // and notify the user, per-provider, so beats continue for healthy agents.
        if (outcome === 'timeout' && summary) {
          await failures.handleTurnTimeout(msg.chatId, proj.alias, providerId, summary)
          return null
        }
        if (outcome === 'auth_failed' && summary) {
          await failures.handleAuthFailed(msg.chatId, proj.alias, providerId, summary)
          return null
        }
        if (delivery) {
          if (outcome !== 'completed' || !summary) return null
          // `#RANK:` 是内部信号:先在 conductor 这一侧剥掉(§4.9),交付与互评用同一份剥过的文字。
          const ranks: string[][] = []
          const strip = (t: string): string => { const p = parsePeerRank(t); if (p.ranking.length) ranks.push(p.ranking); return p.text }
          const parts = { finalText: strip(summary.finalText ?? ''), narration: (summary.narration ?? []).map(strip) }
          report = await delivery.deliver(parts)
          const said = buildTurnReply(parts, [], 'chatroom', ctx.textStrategyFor(providerId)).reply
          const text = said.silent ? '' : said.text.trim()
          if (!text) return null
          return { speaker: providerId, text, ranking: countRank ? (ranks[ranks.length - 1] ?? []) : [] }
        }
        // Defense-in-depth: canUseTool already denies the reply tool in
        // chatroom mode, but if an agent still gets one through, its plain
        // `assistantText` is meta-chatter ("（本轮结束）"), not its real
        // argument — forwarding it leaks garbage AND poisons the verdict
        // transcript. Drop the turn instead. (Mirrors dispatchParallel.)
        if (summary?.replyToolCalled) {
          deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} provider=${providerId} used reply tool in a beat — dropped`)
          return null
        }
        const raw = (summary?.assistantText ?? []).join('\n').trim()
        if (!raw) return null
        const parsed = parsePeerRank(raw)
        const text = parsed.text
        const ranking = countRank ? parsed.ranking : []
        if (!text) return null
        await deps.sendAssistantText?.(msg.chatId, `[${dn}] ${text}`)
        return { speaker: providerId, text, ranking }
      } finally {
        runner.record({ chatId: msg.chatId, provider: providerId, alias: proj.alias, mode: 'chatroom', startedAt, endedAt, outcome, summary, error: err, report })
      }
    }))
    return results.filter((r): r is BeatResult => r !== null)
  }

  return {
    dispatch,
    async preemptInFlight(chatId) {
      while (true) {
        const priorAborter = inFlightAborters.get(chatId)
        const priorPromise = inFlightDispatchPromises.get(chatId)
        if (!priorAborter || !priorPromise) return
        deps.log('COORDINATOR_CHATROOM', `chat=${chatId} → preempting prior in-flight dispatch (next turn runs single-model)`)
        priorAborter.abort()
        try { await priorPromise } catch { /* prior dispatch's own error path */ }
      }
    },
    abort(chatId) {
      const ac = inFlightAborters.get(chatId)
      if (!ac) return false
      ac.abort()
      // delete is done in dispatch's finally; double-delete is harmless.
      return true
    },
  }
}
