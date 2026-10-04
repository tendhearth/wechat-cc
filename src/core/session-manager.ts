import type { ProviderId, SessionStore } from './session-store'
import type { AgentEvent, AgentSession } from './agent-provider'
import { assertCallAllowed, classifyWith, sessionCallTarget, type CallTarget, type NetworkGate } from '../lib/network-gate'
import { providerCallTarget, type ProviderRegistry } from './provider-registry'
import { tierNameFromProfile, sessionAuthEnv, type TierProfile, type UserTier } from './user-tier'
import type { PermissionMode } from './capability-matrix'
import {pathsConflict} from './workbench/scheduler'
import {canonicalClaimPath} from './workbench/execution-claims'
import { log } from '../lib/log'

export interface SessionManagerOptions {
  maxConcurrent: number
  idleEvictMs: number
  /**
   * Provider catalogue (RFC 03 §3.3 / P2). The manager dispatches each
   * acquire() to the right provider instance based on the providerId
   * argument. Two providers can hold concurrent sessions on the same
   * alias — solo-mode chats on different providers do not interfere.
   */
  registry: ProviderRegistry
  /**
   * When present, the manager persists the SDK-reported session_id per
   * (alias, provider, chatId) and passes it back as `resume` on the next
   * spawn — slashing daemon-restart cold-start from ~10 s to <3 s.
   */
  sessionStore?: SessionStore
  /** Stored session_id older than this is treated as stale. Default 7 d. */
  resumeTTLMs?: number
  /**
   * Called whenever a session is released — by the coordinator (timeout /
   * auth-fail self-heal) OR internally (LRU `enforceCapacity`, idle
   * `sweepIdle`, `shutdown`). Wired to the internal-api token registry so the
   * session's per-session auth token is revoked, NOT just the coordinator's
   * explicit releases. `sessionKey` is `provider/alias/chatId` (matches the
   * coordinator's mint key). Centralising here is the single chokepoint that
   * covers every eviction path. Optional — omitted when no registry is wired.
   */
  invalidateSessionToken?: (sessionKey: string) => void
  /**
   * Mint a per-session internal-api token for (tier, sessionKey), wired to the
   * token registry. Called once per real spawn; the tier is recovered from the
   * acquire's tierProfile. Paired with `invalidateSessionToken` at release.
   */
  mintSessionToken?: (tier: UserTier, sessionKey: string) => string
  /**
   * Assemble the per-session system prompt for (providerId, tierProfile,
   * chatId), called ONCE per real spawn (cache miss) — the daemon owns
   * prompt content (provider/peer/companion/delegate config + tier-gated
   * sections), the provider just injects the returned string via its
   * transport. Mirrors the `mcpEnv` seam. The `chatId` param enables
   * per-chat prompt sections — currently the care section (gated on this
   * chat's care level), with per-chat persona a likely future addition.
   * Omitted in tests/embeddings → `appendInstructions` is left off the
   * SpawnContext entirely.
   */
  buildInstructions?: (providerId: ProviderId, tierProfile: TierProfile, chatId: string, model?: string) => string
  /**
   * The pinned model id for a (provider) spawn, read per-spawn so a `/model`
   * switch applies without a daemon restart. Returns undefined when no pin
   * applies to this provider (provider falls back to its construction default).
   * Same place + posture as `buildInstructions`.
   */
  currentModelFor?: (providerId: ProviderId) => string | undefined
  /**
   * 网络闸门(守护 v2)。spawn 与每次 dispatch 之前按**这条会话实际连到的目标**分类(评审 #193:
   * spawn 那一刻定下的端点 + 模型,不是此刻的配置;会话报不出来 ⇒ 按需要保护):
   * 需要保护且不安全才抛 NetworkUnprotectedError,不起子进程、不发请求;不需要保护的
   * 照常。这是所有对话类调用的兜底(协调器在更前面已经拦过并给了用户一句话)。
   * 缺省 = 不拦(测试 / 嵌入)。
   */
  networkGate?: NetworkGate
}

/**
 * Options-object argument to `SessionManager.acquire`. The triple
 * (providerId, alias, chatId) is the cache + in-flight key — two chats
 * on the same alias+provider get independent sessions (separate
 * session_ids, separate jsonl files). `tierProfile` is forwarded to
 * `provider.spawn` so the SDK boots with the right permission knobs for
 * this particular chat's caller.
 */
export interface AcquireRequest {
  alias: string
  path: string
  providerId: ProviderId
  chatId: string
  tierProfile: TierProfile
  /**
   * Per-chat model pin (Mode.solo.model). When set it wins over the daemon's
   * `currentModelFor(providerId)` global rule for this spawn only.
   */
  model?: string
  /**
   * Daemon-wide permission mode. Forwarded into `provider.spawn`'s
   * SpawnContext so providers can honor `--dangerously` independently of
   * tier (see RFC 05 §2.1). When dangerously, every provider's
   * translation short-circuits to its SDK-level bypass equivalent
   * (claude → bypassPermissions, codex → danger-full-access + never).
   */
  permissionMode: PermissionMode
}

/**
 * Options-object argument for the read/write methods that consult the
 * cache but don't need a path/tier (release, isInFlight). Same triple
 * as `AcquireRequest` minus the spawn-time-only fields.
 */
export interface InFlightKey {
  alias: string
  providerId: ProviderId
  chatId: string
}

export interface SessionHandle {
  readonly alias: string
  readonly path: string
  readonly providerId: ProviderId
  /** spawn 时钉的模型;undefined = provider 默认。 */
  readonly model?: string
  /**
   * 这条会话每一轮真正连到哪里(评审 #193 P1-1):会话自己报的,或 spawn 那一刻 provider 报的。
   * 守护按它判,不按此刻的配置判。可选只是为了让测试里的假 handle 少写一行。
   */
  callTarget?(): CallTarget
  lastUsedAt: number
  dispatch(text: string): AsyncIterable<AgentEvent>
  /**
   * Interrupt the in-flight dispatch (if any) on this session. Forwards
   * to the underlying `AgentSession.cancel?.()` — see that interface for
   * provider-specific semantics. Always present on a real handle (the
   * wrapper here no-ops when the session itself doesn't implement
   * cancel). Marked optional so ad-hoc test mocks of SessionHandle can
   * omit it; production code should treat it as always-present.
   */
  cancel?(): Promise<void>
  close(): Promise<void>
}

interface Internal {
  handle: SessionHandle
  session: AgentSession
  chatId: string
}

/** Composite key for the (provider, alias, chatId) session map. */
function sessionKey(k: { alias: string; providerId: ProviderId; chatId: string }): string {
  return `${k.providerId}|${k.alias}|${k.chatId}`
}

export class SessionManager {
  private readonly opts: SessionManagerOptions
  private readonly sessions = new Map<string, Internal>()
  // In-flight spawn promises keyed by (provider, alias, chatId). acquire()
  // inserts the spawn promise here BEFORE awaiting provider.spawn(), so a
  // second concurrent acquire on the same triple returns the in-flight
  // promise instead of forking a duplicate subprocess. Without this, the
  // companion tick + an inbound message racing on the same chat would both
  // miss the cache and both spawn — first one ends up orphaned.
  private executionGuard:((path:string,providerId:string,nativeId:string|null)=>boolean)|undefined
  private readonly pendingPaths=new Map<string,string>()
  private readonly closingPaths=new Map<string,string>()
  setExecutionGuard(guard:(path:string,providerId:string,nativeId:string|null)=>boolean){this.executionGuard=guard}
  hasProjectConflict(path:string):boolean {
    const target=canonicalClaimPath(path)
    return [...this.pendingPaths.values(),...this.closingPaths.values(),...[...this.sessions.values()].map(s=>s.handle.path)].some(p=>pathsConflict(canonicalClaimPath(p),target))
  }
  private checkExecution(req:AcquireRequest){
    const nativeId=this.opts.sessionStore?.get({alias:req.alias,provider:req.providerId,chatId:req.chatId})?.session_id??null
    if(this.executionGuard?.(req.path,req.providerId,nativeId))throw new Error('native_session_busy')
  }
  private readonly pending = new Map<string, Promise<SessionHandle>>()
  // In-flight dispatch counter keyed by (provider, alias, chatId). Each
  // dispatch() iterator increments on first .next() entry and decrements
  // in its finally block. sweepIdle skips any session with count > 0 — a
  // 30 min+ turn must not be killed mid-stream just because lastUsedAt
  // looks stale. release() / shutdown / enforceCapacity ignore the counter
  // (those are operator-triggered or capacity-enforced and must be
  // unconditional).
  private readonly inFlight = new Map<string, number>()

  constructor(opts: SessionManagerOptions) {
    this.opts = opts
  }

  /**
   * Get or spawn an agent session for (providerId, alias, chatId). The
   * same call with different providerIds returns independent sessions
   * — supports RFC 03 P2 solo-mode where chat A is on claude and chat B
   * is on codex but both reference the same project. Different chatIds
   * on the same (alias, provider) also return independent sessions —
   * required for per-chat tier policy + per-chat conversation isolation.
   */
  async acquire(req: AcquireRequest): Promise<SessionHandle> {
    this.checkExecution(req)
    const k = sessionKey({ alias: req.alias, providerId: req.providerId, chatId: req.chatId })
    const existing = this.sessions.get(k)
    if (existing) {
      existing.handle.lastUsedAt = Date.now()
      return existing.handle
    }
    const inFlight = this.pending.get(k)
    if (inFlight) return inFlight
    this.pendingPaths.set(k,req.path)
    const promise = this.spawn(req).finally(() => {
      this.pending.delete(k);this.pendingPaths.delete(k)
    })
    this.pending.set(k, promise)
    return promise
  }

  private async spawn(req: AcquireRequest): Promise<SessionHandle> {
    const model = req.model ?? this.opts.currentModelFor?.(req.providerId)
    const entry = this.opts.registry.get(req.providerId)
    if (!entry) throw new Error(`unknown provider: ${req.providerId} (registered: ${this.opts.registry.list().join(', ')})`)
    const { provider, opts: regOpts } = entry
    // 评审 #193:问 provider 这次 spawn 实际会连到哪里(构造时的端点 + 这次的模型),不按配置猜。
    await assertCallAllowed(this.opts.networkGate, providerCallTarget(provider, req.providerId, 'spawn', model !== undefined ? { model } : {}))

    // Check for a recent session_id to resume — cut cold-start latency.
    const ttl = this.opts.resumeTTLMs ?? 7 * 24 * 60 * 60_000
    const record = this.opts.sessionStore?.get({ alias: req.alias, provider: req.providerId, chatId: req.chatId }) ?? null
    let resumeSessionId: string | undefined
    if (record) {
      const age = Date.now() - Date.parse(record.last_used_at)
      const jsonlStillThere = regOpts.canResume(req.path, record.session_id)
      if (age < ttl && jsonlStillThere) {
        resumeSessionId = record.session_id
        log('SESSION_RESUME', `alias=${req.alias} chat=${req.chatId} sid=${record.session_id} provider=${req.providerId} age=${Math.round(age / 1000)}s`)
      } else {
        // stale — forget THIS (provider, chatId) row only. delete() would
        // also wipe sibling rows for the same chat under other providers.
        this.opts.sessionStore?.deleteOne({ alias: req.alias, provider: req.providerId, chatId: req.chatId })
      }
    }

    const project = { alias: req.alias, path: req.path }
    // Mint the per-session auth token HERE — once per real spawn (cache miss),
    // not per dispatch. The token's tier is recovered from the resolved
    // tierProfile; its key matches release-time invalidation (provider/alias/
    // chatId). Minting in the coordinator instead would re-mint on every cache
    // hit (acquire ignores it), leaking one registered-but-unused token per
    // dispatch into the registry.
    const tokenKey = `${req.providerId}/${req.alias}/${req.chatId}`
    const tier = tierNameFromProfile(req.tierProfile)
    const sessionToken = this.opts.mintSessionToken?.(tier, tokenKey)
    // Compute the per-spawn MCP env overlay ONCE here (the daemon owns the
    // tier→env policy); providers merge it blindly into their MCP children.
    const mcpEnv = sessionAuthEnv(tier, sessionToken)
    // Assemble the per-session system prompt the same place + same way as
    // mcpEnv: daemon-owned, computed once per spawn, forwarded for the provider
    // to inject. Conditionally spread so non-wired callers (tests/embeddings)
    // leave the field off entirely.
    // Model first, then the prompt: the prompt states the model so the agent
    // can answer「你是哪个模型」truthfully instead of guessing (or calling an
    // admin-only tool a trusted user can't reach).
    const appendInstructions = this.opts.buildInstructions?.(req.providerId, req.tierProfile, req.chatId, model)
    // spawn 这一刻 provider 报的会话目标:会话自己不报时,之后每一轮都按它判(配置后来再改也不跟)。
    const spawnTarget = providerCallTarget(provider, req.providerId, 'session', model !== undefined ? { model } : {})
    let session: AgentSession
    try {
      session = await provider.spawn(project, {
        ...(resumeSessionId ? { resumeSessionId } : {}),
        tierProfile: req.tierProfile,
        permissionMode: req.permissionMode,
        // Forward chatId so the Claude provider can bake it into a
        // per-session canUseTool closure (see bootstrap/index.ts).
        chatId: req.chatId,
        mcpEnv,
        ...(appendInstructions !== undefined ? { appendInstructions } : {}),
        ...(model !== undefined ? { model } : {}),
      })
    } catch (err) {
      // spawn failed → the session is never cached, so release() never runs
      // and the just-minted token would leak in the registry forever. Revoke
      // it on the error path before propagating.
      this.opts.invalidateSessionToken?.(tokenKey)
      throw err
    }

    const sessionStore = this.opts.sessionStore
    const k = sessionKey({ alias: req.alias, providerId: req.providerId, chatId: req.chatId })
    const inFlight = this.inFlight,checkExecution=()=>this.checkExecution(req),networkGate=this.opts.networkGate
    const effectiveTarget = (): CallTarget => typeof session.callTarget === 'function' ? sessionCallTarget(session, req.providerId) : spawnTarget
    const handle: SessionHandle = {
      alias: req.alias,
      path: req.path,
      providerId: req.providerId,
      ...(model !== undefined ? { model } : {}),
      callTarget: effectiveTarget,
      lastUsedAt: Date.now(),
      dispatch(text: string): AsyncIterable<AgentEvent> {
        checkExecution()
        handle.lastUsedAt = Date.now()
        // Track in-flight under (provider, alias, chatId) so sweepIdle
        // can skip busy sessions. Wrap unconditionally — even when
        // sessionStore is absent — otherwise an iterator started without
        // persistence won't bump the counter and a long turn gets evicted
        // mid-stream.
        return {
          async *[Symbol.asyncIterator]() {
            checkExecution()
            // 先过网络闸门再碰 provider:session.dispatch 本身可能就立刻发请求。按这条会话实际的目标判。
            await assertCallAllowed(networkGate, effectiveTarget())
            const inner = session.dispatch(text)
            inFlight.set(k, (inFlight.get(k) ?? 0) + 1)
            try {
              for await (const ev of inner) {
                yield ev
                if (ev.kind === 'result' && ev.sessionId && sessionStore) {
                  sessionStore.set({ alias: req.alias, provider: req.providerId, chatId: req.chatId, sessionId: ev.sessionId })
                }
              }
            } finally {
              const n = inFlight.get(k) ?? 1
              if (n <= 1) inFlight.delete(k)
              else inFlight.set(k, n - 1)
            }
          },
        }
      },
      async cancel() {
        await session.cancel?.()
      },
      async close() {
        await session.close()
      },
    }

    this.sessions.set(k, { handle, session, chatId: req.chatId })
    await this.enforceCapacity()
    return handle
  }

  async release(k: InFlightKey): Promise<void> {
    const key = sessionKey(k)
    const s = this.sessions.get(key)
    if (!s) return
    this.closingPaths.set(key,s.handle.path)
    this.sessions.delete(key)
    // Revoke the session's auth token on EVERY release path (coordinator +
    // internal LRU/idle/shutdown eviction). The token key matches what the
    // coordinator minted: provider/alias/chatId (NOT the cache `sessionKey`).
    this.opts.invalidateSessionToken?.(`${k.providerId}/${k.alias}/${k.chatId}`)
    // close() 会抛(ACP provider 等不到进程组退出就抛 acp_process_not_exited)。release 的调用方
    // 里有三个是没人接的内部清扫:sweepIdle / enforceCapacity / shutdown —— 一个杀不干净的子进程
    // 就能把整轮清扫掀掉(后面的会话不再释放、容量上限失守、关机卡住)。会话已经从表里摘掉了,
    // 记一行继续走:泄漏一个进程,好过泄漏其余所有会话。
    try { await s.handle.close() }
    catch (err) { log('SESSION_CLOSE_FAILED', `alias=${k.alias} provider=${k.providerId} chat=${k.chatId} — ${err instanceof Error ? err.message : String(err)}`) }
    this.closingPaths.delete(key)
  }

  /**
   * True when (alias, providerId, chatId) has at least one dispatch
   * iterator currently running. Caller can use this to gate background
   * work (companion ticks, etc.) so it doesn't contend with a
   * user-initiated turn on the same session. Counter is incremented at
   * iterator entry and decremented in finally — accurate without
   * external locking.
   */
  isInFlight(k: InFlightKey): boolean {
    return (this.inFlight.get(sessionKey(k)) ?? 0) > 0
  }

  /**
   * 是否有任何在途轮次(不分 chat)。self-restart 用它判断"现在能不能安全
   * 退出" —— 逐 key 的 isInFlight 回答不了这个问题。
   */
  anyInFlight(): boolean {
    for (const n of this.inFlight.values()) if (n > 0) return true
    return false
  }

  /** Is there a cached (live) session for this key right now? Coordinator uses
   *  it to know a dispatch is about to cold-spawn (→ cold-start context block). */
  has(k: InFlightKey): boolean {
    return this.sessions.has(sessionKey(k))
  }

  /**
   * Release every cached session for (providerId, chatId) across aliases,
   * AND forget the store's stored resume points for that pair. Used when a
   * chat's pinned model changes: the cache key has no model in it, so
   * releasing the live sessions alone isn't enough — the next spawn would
   * otherwise resume from a stored session id, and a resumed session keeps
   * the model it was opened with (ACP `session/load` carries no model,
   * Claude/Codex resume the same thread) — "改了但没生效" again. Per-chat
   * twin of the provider-wide `deleteProvider` fix. Returns the count of
   * LIVE sessions released (unchanged contract) — the store's own row count
   * isn't folded in since callers only ever used this number for the live
   * side. Also fires when there's no live session at all (idle-evicted then
   * re-pinned) — the store delete still has to happen since the stale
   * resume row can outlive the cache entry.
   *
   * 已知竞态(暂不修,controller ruling):微信 `/cursor <model>` 走 per-chat
   * 轮次互斥锁里的 setMode,上一轮的 result 事件落存档已经排完队;但桌面
   * 「模型与后端」面板的 `POST /v1/conversation/set-mode` 不经过那把锁,若
   * 调用这一刻恰好有一轮在途,它的 result 事件可能在这次 delete 之后才把
   * 旧 session_id 写回存档,下一次 spawn 又会续到旧模型上。
   */
  async releaseFor(providerId: ProviderId, chatId: string): Promise<number> {
    let n = 0
    for (const s of Array.from(this.sessions.values())) {
      if (s.handle.providerId !== providerId || s.chatId !== chatId) continue
      await this.release({ alias: s.handle.alias, providerId, chatId })
      n++
    }
    this.opts.sessionStore?.deleteProviderChat?.(providerId, chatId)
    return n
  }

  list() {
    return Array.from(this.sessions.values()).map(s => ({
      alias: s.handle.alias,
      path: s.handle.path,
      providerId: s.handle.providerId,
      chatId: s.chatId,
      lastUsedAt: s.handle.lastUsedAt,
      ...(s.handle.model !== undefined ? { model: s.handle.model } : {}),
    }))
  }

  /**
   * 这一轮对话会连到哪里(评审 #193 P1-1,协调器的预判用):有在用的会话 ⇒ 它实际的目标;
   * 没有 ⇒ provider 按这次会用的模型报的目标(新会话就是按这份参数起的)。
   */
  effectiveTarget(k: InFlightKey, model?: string): CallTarget {
    const live = this.sessions.get(sessionKey(k))
    if (live?.handle.callTarget) return live.handle.callTarget()
    const m = model ?? this.opts.currentModelFor?.(k.providerId)
    return providerCallTarget(this.opts.registry.get(k.providerId)?.provider, k.providerId, 'session', m !== undefined ? { model: m } : {})
  }

  /**
   * 守护 v2:网络翻到不安全时只关**需要保护**的对话会话(按这条会话实际连到的目标分类),
   * 不需要保护的(国内 / 自建 / Cursor auto)照常留着。返回关了几个。
   */
  async shutdownProtected(): Promise<number> {
    const gate = this.opts.networkGate
    const entries = Array.from(this.sessions.values())
      .filter(s => classifyWith(gate, s.handle.callTarget ? s.handle.callTarget() : sessionCallTarget(null, s.handle.providerId)).protected)
    await Promise.all(entries.map(s => this.release({ alias: s.handle.alias, providerId: s.handle.providerId, chatId: s.chatId })))
    return entries.length
  }

  async shutdown(): Promise<void> {
    const entries = Array.from(this.sessions.values())
    await Promise.all(entries.map(s => this.release({
      alias: s.handle.alias,
      providerId: s.handle.providerId,
      chatId: s.chatId,
    })))
  }

  private async enforceCapacity(): Promise<void> {
    while (this.sessions.size > this.opts.maxConcurrent) {
      const lru = this.pickLru()
      if (!lru) break
      await this.release(lru)
    }
  }

  private pickLru(): InFlightKey | null {
    let worst: InFlightKey | null = null
    let worstAt = Infinity
    for (const s of this.sessions.values()) {
      if (s.handle.lastUsedAt < worstAt) {
        worstAt = s.handle.lastUsedAt
        worst = { alias: s.handle.alias, providerId: s.handle.providerId, chatId: s.chatId }
      }
    }
    return worst
  }

  async sweepIdle(): Promise<void> {
    const now = Date.now()
    for (const s of Array.from(this.sessions.values())) {
      // Never evict a session with an active dispatch — killing it mid-
      // stream would leave the coordinator's collectTurn loop hanging on
      // a queue that's about to be nulled out.
      const k = sessionKey({ alias: s.handle.alias, providerId: s.handle.providerId, chatId: s.chatId })
      if ((this.inFlight.get(k) ?? 0) > 0) continue
      if (now - s.handle.lastUsedAt >= this.opts.idleEvictMs) {
        await this.release({ alias: s.handle.alias, providerId: s.handle.providerId, chatId: s.chatId })
      }
    }
  }
}
