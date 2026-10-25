/**
 * conversation-coordinator — replaces the straight-line routeInbound
 * with mode-aware dispatch (RFC 03 §3.2 / §4).
 *
 * 一条流水线(架构终态第 5 条):
 *   planTurn(msg) → TurnPlan     一轮跑谁、什么档位、守护放不放行,一次定完(plan.ts)
 *   solo / parallel / chatroom   只编排(solo.ts / parallel.ts / chatroom.ts)
 *   TurnRunner                   每一位每一轮的超时 / 取消 / 进度 / 记账,三种派法共用(runner.ts)
 *
 * All Mode variants are implemented: `solo` (single provider), `parallel`
 * (`/both` — concurrent replies), `primary_tool` (`/cc + codex` — one drives,
 * the other is exposed as a tool), and `chatroom` (`/chat` — moderated
 * round-table).
 */
import type { Mode, ProviderId } from '../../domain/conversation'
import type { InboundMsg } from '../../domain/prompt-format'
import { capabilitiesFor } from '../../domain/capability-matrix'
import { makeChatMutex } from '../async-mutex'
import { createCoordinatorCtx } from './ctx'
import { createPlanner } from './plan'
import { createTurnRunner } from './runner'
import { createFailureHandlers } from './failures'
import { createSolo } from './solo'
import { createParallel } from './parallel'
import { createChatroom } from './chatroom'
import type { ConversationCoordinator, ConversationCoordinatorDeps, TurnPolicy } from './types'

/**
 * The per-chat serialization strategy for a mode, made EXPLICIT (D3):
 *  - `queue`: turns serialize on the per-chat mutex (solo/parallel/primary_tool)
 *    — single-turn dispatches with no self-preemption, so wrapping them in the
 *    mutex is a pure win: two rapid inbound messages for one chat run their
 *    turns one at a time instead of racing on session/history state.
 *  - `preempt`: a new turn aborts the in-flight one (chatroom's latest-wins;
 *    the shape a future voice channel needs for barge-in). Chatroom is EXEMPT
 *    from the mutex because `dispatchChatroom` implements its OWN
 *    preempt-on-arrival protocol (inFlightAborters / inFlightDispatchPromises):
 *    a new message aborts the prior in-flight loop and awaits its cleanup rather
 *    than running it to completion. Routing it through the mutex would make a
 *    new message wait for the lock — handed over only after the PRIOR dispatch
 *    fully settles — before it could even reach the preempt-abort check, turning
 *    "abort the stale loop and start now" into "wait for the stale loop to
 *    drain, THEN start" and defeating latest-wins. (Verified pre-D3 by
 *    temporarily routing chatroom through the mutex: no deadlock, but the abort
 *    never fired early — B just waited behind A's held lock.)
 * Adding a preempt mode is a one-line entry here, not a re-derivation across callers.
 */
export function turnPolicy(mode: Mode): TurnPolicy {
  return mode.kind === 'chatroom' ? 'preempt' : 'queue'
}

export function createConversationCoordinator(deps: ConversationCoordinatorDeps): ConversationCoordinator {
  const ctx = createCoordinatorCtx(deps)
  const { getMode } = ctx
  const planner = createPlanner(ctx)
  const runner = createTurnRunner(ctx)
  const failures = createFailureHandlers(ctx)
  const solo = createSolo(ctx, runner, failures)
  const dispatchParallel = createParallel(ctx, runner, failures)
  const chatroom = createChatroom(ctx, runner, failures)

  const parallelProviders: ProviderId[] = deps.parallelProviders ?? ['claude', 'codex']

  // Task 1 (session-serialization) — per-chatId async mutex. `submitTurn`
  // wraps `dispatchInner` in this for solo/parallel/primary_tool so
  // two rapid inbound messages for one chat never run concurrently. Chatroom
  // is exempt — see turnPolicy.
  const mutex = makeChatMutex()

  function validateMode(mode: Mode): void {
    // Reject unknown providers up front so the caller (mode-commands or
    // a programmatic setter) gets a clear error instead of a downstream
    // "unknown provider" from acquire().
    if (mode.kind === 'solo') {
      if (!deps.registry.has(mode.provider)) {
        throw new Error(`unknown provider: ${mode.provider} (registered: ${deps.registry.list().join(', ')})`)
      }
    }
    if (mode.kind === 'primary_tool') {
      if (!deps.registry.has(mode.primary)) {
        throw new Error(`unknown primary provider: ${mode.primary}`)
      }
      // B2(spec §4):持久化状态里翻出的旧非法组合也要拦 —— 与 registry
      // 未注册同姿势,抛错由 setMode 调用方转成用户可见的失败。
      if (!capabilitiesFor(mode.primary).supportsDelegation) {
        throw new Error(`provider '${mode.primary}' cannot delegate (supportsDelegation=false) — primary_tool mode unavailable`)
      }
      // The peer (other registered provider) must also be available so
      // delegate-mcp can actually do something. parallelProviders is
      // also the "all participating providers" set for primary_tool.
      const missing = parallelProviders.filter(p => !deps.registry.has(p))
      if (missing.length > 0) {
        throw new Error(`mode 'primary_tool' requires both providers ${parallelProviders.join(', ')}; missing: ${missing.join(', ')}`)
      }
    }
    if (mode.kind === 'parallel' || mode.kind === 'chatroom') {
      // Explicit participants must all be registered. Undefined defers
      // to dispatch-time resolution (resolveParticipants).
      if (mode.participants !== undefined) {
        // agy final-review CRITICAL 1: agy rides a tier-C shared 'trusted'
        // MCP token (spec §3) — spec §7 declares parallel/chatroom an
        // explicit non-goal. `/both claude agy` / `/chat codex agy` (or a
        // programmatic POST /v1/conversation/set-mode with the same shape)
        // would otherwise put a guest chat's turn on the same channel a
        // trusted chat's agy session uses. Reject structurally here — this
        // is the ONE validateMode chokepoint every caller (mode-commands
        // AND the HTTP route) goes through, so there's no second path that
        // can smuggle agy into a participants list.
        if (mode.participants.includes('agy')) {
          throw new Error(`provider 'agy' cannot join parallel/chatroom modes (shared-token channel; spec §7 non-goal)`)
        }
        const unknown = mode.participants.filter(p => !deps.registry.has(p))
        if (unknown.length > 0) {
          throw new Error(`mode '${mode.kind}' has unknown providers: ${unknown.join(', ')} (registered: ${deps.registry.list().join(', ')})`)
        }
        if (mode.participants.length < 2) {
          throw new Error(`mode '${mode.kind}' requires ≥2 participants; got ${mode.participants.length}`)
        }
      }
      // No else — undefined is fine; resolveParticipants handles fresh
      // and legacy chats.
    }
  }

  /**
   * 这一轮真正开跑的那一刻(queue 在 per-chat 锁里;/chat 抢占在等完排队的单模型回合之后)定计划、照计划派发。
   * 档位 / 被拒 / 守护**只在这里**定:排队那段时间里 access.json 可能把这个 chat 降成访客、trusted_providers
   * 可能拿掉某家、网络可能断 —— 不信排队之前的结论(和「不信模式行的年份」同一个道理)。
   */
  async function dispatchInner(msg: InboundMsg): Promise<void> {
    const proj = deps.resolveProject(msg.chatId)
    if (!proj) {
      deps.log('COORDINATOR', `drop: no project for chat=${msg.chatId}`)
      return
    }
    const mode = getMode(msg.chatId)
    // /chat:先按 latest-wins 停掉上一场、等它收尾,再定计划 —— 档位要在等完之后读(以前 dispatchChatroom
    // 也是等完才读档位)。没有在跑的就不 await(不多让出一拍)。
    if (mode.kind === 'chatroom') {
      const prior = chatroom.preemptPrior(msg.chatId)
      if (prior) await prior
    }
    const planned = planner.planTurn(msg, mode)
    // 没接守护时计划是同步的:不 await,不多让出一拍(取消 / latest-wins 抢占都靠同步登记)。
    const p = planned instanceof Promise ? await planned : planned
    // 回落 / 退成单模型的那句日志在派发这一刻记(和以前同一个位置)。
    if ('notes' in p) for (const line of p.notes) deps.log('COORDINATOR', line)
    switch (p.kind) {
      case 'paused': return
      case 'refused': return solo.refuse(msg, p)
      case 'solo': return solo.dispatch(msg, proj, p)
      case 'parallel': return dispatchParallel(msg, proj, p)
      case 'chatroom': return chatroom.dispatch(msg, proj, p)
    }
  }

  /**
   * D3 — the single turn entrypoint. Resolves the mode's turn policy (see
   * {@link turnPolicy} for the queue-vs-preempt rationale), then runs
   * the turn under it: `preempt` (chatroom) bypasses the mutex (its own
   * abort-on-arrival protocol IS the preemption); `queue` serializes on the
   * per-chat mutex. `opts.within`, when given, runs INSIDE that locked/preempt
   * region and receives the dispatch closure (used by the app path to open a
   * reply-sink, dispatch, and read the captured reply — all under one lock).
   */
  async function submitTurn<T = void>(
    msg: InboundMsg,
    opts?: { within?: (dispatch: () => Promise<void>) => Promise<T> },
  ): Promise<T | void> {
    const mode = getMode(msg.chatId)
    let policy = turnPolicy(mode)
    // 评审 #193 P2-4:排队方式跟着**实际执行的集合**走,不跟着模式名走。/chat 被守护筛到只剩
    // 一个(或一个都不剩)时执行已经退成单模型 —— 那就得像 solo 一样排队,否则第二条消息会在
    // 同一个会话上撞上还在跑的第一条(ACP 的 acp_turn_already_running,第二条就丢了)。
    if (policy === 'preempt' && mode.kind === 'chatroom' && deps.resolveProject(msg.chatId)) {
      // 只是预估,只决定排队方式(quiet:不记日志、不回话);真正跑谁、什么档位,开跑时在 dispatchInner 里重新定。
      // 没接守护时同步定(不多让出一拍,latest-wins 的抢占时机不变)。
      const planned = planner.planTurn(msg, mode, { quiet: true })
      const estimate = planned instanceof Promise ? await planned : planned
      if (estimate.kind !== 'chatroom') policy = 'queue'
    }
    const run = async (): Promise<T | void> => {
      const doDispatch = (): Promise<void> => dispatchInner(msg)
      return opts?.within ? opts.within(doDispatch) : doDispatch()
    }
    if (policy === 'preempt') {
      // 真的一组人在辩:latest-wins 的抢占照旧(不持锁)。但先等排着队的单模型回合跑完 ——
      // 它们和辩论会用到同一个会话。
      const queued = mutex.tail(msg.chatId)
      if (queued) await queued
      return run()
    }
    // 退成单模型的 /chat:先按 latest-wins 停掉还在跑的整组辩论(和它共用会话),再排队。
    if (mode.kind === 'chatroom') await chatroom.preemptInFlight(msg.chatId)
    return mutex.runExclusive(msg.chatId, run)
  }

  // Back-compat thin wrapper — the WeChat inbound path. Identical behavior to
  // the old mode-branching dispatch, now expressed via submitTurn's policy.
  async function dispatch(msg: InboundMsg): Promise<void> {
    await submitTurn(msg)
  }

  return {
    submitTurn,
    getMode,
    setMode(chatId, mode) {
      validateMode(mode)
      const oldMode = getMode(chatId)
      deps.conversationStore.set(chatId, mode)
      // 换 provider 交接:solo→solo 且 provider 变化时标记。同 provider 换
      // 模型不换会话线(session key 含 provider 不含 model),无需交接。
      if (oldMode.kind === 'solo' && mode.kind === 'solo' && oldMode.provider !== mode.provider) {
        ctx.handoffLedger.markSwitch(chatId, oldMode.provider, mode.provider)
      }
      // 同 provider 换钉模型:session 缓存键里没有 model,不放掉旧会话它就
      // 一直在旧模型上答 ——「说了换、没换」。best-effort,失败只记日志。
      if (oldMode.kind === 'solo' && mode.kind === 'solo' && oldMode.provider === mode.provider && oldMode.model !== mode.model) {
        void deps.manager.releaseFor?.(mode.provider, chatId).catch(err => {
          deps.log('COORDINATOR', `releaseFor after model pin change failed chat=${chatId}: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    },
    cancel(chatId) {
      let cancelledAny = chatroom.abort(chatId)
      // Post-cancel-review CRITICAL 1 — solo/parallel/primary_tool turns
      // have no aborter loop, but their acquired SessionHandle(s) do
      // support cancel(); invoke every in-flight one for this chat.
      if (runner.cancelHandles(chatId)) cancelledAny = true
      if (cancelledAny) runner.markStopped(chatId)
      return cancelledAny
    },
    runExclusive: mutex.runExclusive,
    dispatch,
  }
}
