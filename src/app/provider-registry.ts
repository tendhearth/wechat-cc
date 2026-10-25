/**
 * provider-registry — central catalogue of available agent providers
 * (RFC 03 §3.3, Appendix D).
 *
 * Daemon registers `claude` and `codex` at boot; coordinator looks up
 * by ProviderId when dispatching. Adding a new provider in the future
 * is a single `registry.register(id, provider, opts)` call from
 * bootstrap.ts — no changes to Conversation/Mode/Coordinator/SessionManager
 * (the open string ProviderId design from §3.3 makes this work).
 *
 * The registry is intentionally not a singleton; it's constructed and
 * passed via deps. Tests can build their own with mock providers.
 */
import type { AgentAttachment, AgentEvent, AgentProvider, AgentSession, AgentWorkbenchRuntime, CallTargetKind, CheapEval, SpawnContext } from '../ports/agent-provider'
import type { WorkbenchExecutorCapabilities } from '../domain/workbench/executor-capabilities'
import type { ProviderId } from '../domain/conversation'
import { executorNames, type ExecutorNames } from '../domain/provider-display-names'
import { isKnownProviderId } from '../lib/provider-ids'
import { hasAuthCode } from '../lib/auth-failure'
import { errorWithProviderCode, isAuthErrorCode, providerErrorCodeOf } from '../lib/provider-error-code'
import { isConnectFailure } from '../lib/net-errors'
import { assertCallAllowed, decideCall, isNetworkUnprotectedError, NetworkUnprotectedError, sessionCallTarget, unprotectedMessage, unresolvedTarget, type CallTarget, type NetworkGate } from '../lib/network-gate'

/**
 * 这一次调用**真正**连到哪里(评审 #193 P1-1):问 provider 自己 —— 它用构造时定下的端点、构造时的
 * 默认模型、ctx 里钉的模型,和它真去调用时是同一份参数。provider 没报(或报错)⇒ unresolved ⇒ 闸门按
 * 需要保护(fail closed)。**不再**按 provider id + 此刻的配置去猜(配置改了,在用的执行者不会跟着改)。
 */
export function providerCallTarget(provider: AgentProvider | null | undefined, providerId: string, kind: CallTargetKind, ctx?: Partial<SpawnContext>): CallTarget {
  const purpose: CallTarget['purpose'] = kind === 'cheapEval' || kind === 'strongEval' ? 'eval' : 'turn'
  try {
    const t = provider?.callTarget?.(kind, ctx) ?? (kind === 'spawn' ? provider?.callTarget?.('session', ctx) : null)
    if (t) return { purpose, ...t, exact: true }
  } catch { /* 报不出来就按拿不准处理 */ }
  return unresolvedTarget(providerId, purpose)
}

/**
 * 网络闸门包装(守护 v2,2026-10-02;评审 #193 按实际目标判):spawn / cheapEval / strongEval /
 * modelCatalog 出发前按**这一次调用实际会连到的地方**分类(providerCallTarget)—— 需要保护且网络
 * 不安全才抛 NetworkUnprotectedError(不起子进程、不发请求);不需要保护的(国内 / 自建 / Cursor
 * auto / 自定义网关)照常走,不看信号。spawn 出来的会话若没自己报目标,就把 spawn 那一刻 provider
 * 报的目标钉在会话上(之后每一轮按它判,不按后来的配置判);会话的每一次发送都先过守护(guardSession)。
 * 用 Proxy 而不是展开:有的 provider 带额外方法(probeStatus 等),展开会丢原型方法和 this。
 * 注册进 registry 的每一个 provider 都套这一层。
 */
export function withNetworkGate<P extends AgentProvider>(inner: P, gate: NetworkGate, providerId: string): P {
  const gated = new Set<PropertyKey>(['spawn', 'cheapEval', 'strongEval', 'modelCatalog'])
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (!gated.has(prop) || typeof v !== 'function') return v
      return async (...args: unknown[]) => {
        if (prop === 'modelCatalog') {
          // 列模型目录不是一次模型回合(Cursor 按自家处理);端点按配置补,和 v2 一样。
          await assertCallAllowed(gate, { provider: providerId, purpose: 'catalog' })
          return (v as (...a: unknown[]) => unknown).apply(target, args)
        }
        const ctx = prop === 'spawn' ? (args[1] as Partial<SpawnContext> | undefined) : undefined
        await assertCallAllowed(gate, providerCallTarget(target, providerId, prop as CallTargetKind, ctx))
        const out = await (v as (...a: unknown[]) => unknown).apply(target, args)
        if (prop === 'spawn') return guardSession(out as AgentSession, gate, target, providerId, ctx)
        return out
      }
    },
  })
}

/**
 * 第二轮评审 #194 P1:把守护装进**会话自己的发送方法**里。spawn 出来的会话不管落到谁手里
 * (SessionManager、工作台、selftest、delegate……),每一次 dispatch / steer / 工作台 start / submit
 * 之前都按这条会话**此刻的实际目标**判一次 —— 不靠调用方记得补。ACP 那种「先起会话、起来才知道
 * 实际模型」的执行者尤其需要:spawn 只是 setup,真正的检查只能在发送时做。
 *
 * 目标:会话自报的(sessionCallTarget);会话不报,就是 spawn 那一刻 provider 报的(它就是按这份参数
 * 起的会话);都没有 ⇒ unresolved ⇒ 按需要保护。
 */
export function guardSession(session: AgentSession, gate: NetworkGate, provider: AgentProvider, providerId: string, ctx?: Partial<SpawnContext>): AgentSession {
  if (!session || typeof session !== 'object') return session
  const captured = providerCallTarget(provider, providerId, 'session', ctx)
  const target = (): CallTarget => (typeof session.callTarget === 'function' ? sessionCallTarget(session, providerId) : captured)
  const admit = () => assertCallAllowed(gate, target())
  let runtime: AgentWorkbenchRuntime | undefined
  return new Proxy(session, {
    get(t, prop, receiver) {
      if (prop === 'callTarget') return target
      if (prop === 'dispatch') {
        return (text: string, attachments?: readonly AgentAttachment[]): AsyncIterable<AgentEvent> => ({
          async *[Symbol.asyncIterator]() {
            await admit()
            yield* t.dispatch(text, attachments)
          },
        })
      }
      if (prop === 'steer') {
        const steer = t.steer
        return typeof steer === 'function' ? async (text: string, attachments?: readonly AgentAttachment[]) => { await admit(); return steer.call(t, text, attachments) } : steer
      }
      if (prop === 'workbenchRuntime') {
        const inner = t.workbenchRuntime
        if (!inner) return inner
        return (runtime ??= guardRuntime(inner, gate, target))
      }
      return Reflect.get(t, prop, receiver)
    },
  })
}

/**
 * 工作台 runtime:`start` 是同步的(契约:一个 epoch 只发一次初始请求),所以先挂住,等守护答复
 * 再真的 start;被拒 ⇒ 从不 start,事件流吐一条 network_unprotected 错误就结束。`submit` 直接先判。
 */
function guardRuntime(inner: AgentWorkbenchRuntime, gate: NetworkGate, target: () => CallTarget): AgentWorkbenchRuntime {
  let resolveStart!: (v: Promise<string | null>) => void
  const started = new Promise<Promise<string | null>>(r => { resolveStart = r })
  const events: AsyncIterable<AgentEvent> = {
    async *[Symbol.asyncIterator]() {
      const refused = await (await started)
      if (refused !== null) { yield { kind: 'error', message: refused, code: 'network_unprotected' }; return }
      yield* inner.events
    },
  }
  return {
    events,
    start(text, attachments) {
      resolveStart(decideCall(gate, target()).then(d => {
        if (!d.allowed) return unprotectedMessage(d.verdict!, d.cls.label)
        inner.start(text, attachments)
        return null
      }))
    },
    async submit(requestId, text, attachments) {
      await assertCallAllowed(gate, target())
      return inner.submit(requestId, text, attachments)
    },
    snapshot: () => inner.snapshot(),
  }
}

export interface CheapEvalHealth { consecutiveFailures: number; lastError: string | null; lastFailAt: number | null; lastOkAt: number | null }

export interface ProviderRegistration {
  /** Explicitly opted-in task protocol; a normal chat provider is not sufficient. */
  workbench?: WorkbenchExecutorCapabilities
  /** Synchronous provider limits, checked before accepting a task; no execution or material reads. */
  validateWorkbenchInput?: (input:{text:string;attachments:readonly {mime:string;size:number}[]})=>void
  /**
   * 只给**认不出的 id**(自定义 ACP 执行者)用的名字。六家内置执行者的名字一律由 lib/executor-facts 定,
   * 这里写了也不看 —— 读名字走 `registry.namesOf(id)`(收敛清单 ⑥)。
   */
  displayName?: string
  /**
   * Returns true if a stored thread/session id can still be resumed
   * (i.e. the provider's on-disk transcript is intact). SessionManager
   * checks this before passing a stale resume id to the SDK.
   */
  canResume: (cwd: string, threadId: string) => boolean
  /**
   * 这家自己的可执行文件现在在哪(3c 第 3 步,2026-10-22)。每次调用现判、不缓存;找不到 ⇒ null。
   * 登记它的那一侧(对话侧 providers.ts)说了算,工作台、额度查询都读这个,不再各自去找。
   */
  bin?: () => string | null
}

/**
 * 叫什么(收敛清单 ⑥):内置六家照 executor-facts,两种 Gemini 都开着时按 list() 区分;认不出的 id 用注册时给的名字。
 * 只要 get + list,所以只拿到 registry 一部分的调用方(协调器、mode-commands)也用这一个。
 */
export function namesIn(reg: Pick<ProviderRegistry, 'get' | 'list'>, id: ProviderId): ExecutorNames {
  const custom = reg.get(id)?.opts.displayName
  if (!isKnownProviderId(id) && custom) return { name: custom, short: custom, settings: custom }
  return executorNames(id, reg.list())
}

export interface ProviderRegistry {
  register(id: ProviderId, provider: AgentProvider, opts: ProviderRegistration): void
  get(id: ProviderId): { provider: AgentProvider; opts: ProviderRegistration } | null
  has(id: ProviderId): boolean
  list(): ProviderId[]
  /**
   * 注册之后通知(3c,2026-10-22):开机时没探到、后来重探成功的执行者,下游(工作台)靠这个跟上,
   * 不再只抄开机那一刻的快照。只增不减 —— 没有注销,也就没有对应的通知(稿 §4.1 ②)。
   * 回调同步、在登记完成后调;回调抛错不影响登记本身,回调自己负责记日志。返回退订。
   */
  onRegister(cb: (id: ProviderId) => void): () => void
  /** 叫什么:内置六家照 executor-facts(两种 Gemini 都开着时按现在注册了谁区分);自定义的用注册时给的名字。 */
  namesOf(id: ProviderId): ExecutorNames
  /**
   * Resolve a cheapEval callback from registered providers, picked by
   * cost-tier preference (cheapest first). Returns null if no registered
   * provider implements cheapEval. Caller is provider-agnostic — let
   * the registry decide which provider runs the one-shot eval.
   *
   * Preference order is hardcoded inside the resolver because cost
   * comparison is fundamentally cross-provider (we can't compare
   * Anthropic's haiku to OpenAI's mini purely from interface metadata).
   */
  getCheapEval(): CheapEval | null
  /**
   * 后台判断(getCheapEval 交出去的那些调用)最近的成败。只数**真失败**:网络没受保护、连不上不算 ——
   * 那两样「CC 现在怎么样」里已经有网络守护 / 微信两行在说。2026-10-13 gemini-3.7 下线,后台判断
   * 从 11:25 起全挂,只在日志里;这里让总览看得见。
   */
  cheapEvalHealth?(): CheapEvalHealth
  /**
   * Resolve the STRONG one-shot eval of a SPECIFIC provider (the default
   * provider, for the /chat verdict) — unlike getCheapEval, no cross-provider
   * cost picking. Returns null if that provider isn't registered or doesn't
   * implement strongEval; caller falls back to getCheapEval().
   */
  getStrongEval(id: ProviderId): CheapEval | null
  /**
   * 一次 cheapEval 的延迟预算(毫秒)—— 延迟敏感的调用方(披露闸门)据此
   * 定自己的超时。钉死了 provider 就只看它的;否则取**候选里最大的**:
   * 故障转移可能落到任何一个候选身上,按最快的那个定超时等于给慢的那个
   * 判了死刑。见 AgentProvider.cheapEvalBudgetMs。
   */
  getCheapEvalBudgetMs(): number
}

/** 未声明 `cheapEvalBudgetMs` 的 provider 按这个算 —— 与历史上写死在
 *  a2a-disclosure 里的 GATE_TIMEOUT_MS 同值,所以纯 in-process 的部署
 *  行为一个字节都不变。 */
export const DEFAULT_CHEAP_EVAL_BUDGET_MS = 12_000

// Cheapest known to most expensive. Claude haiku ≈ $0.001/1K input tokens
// and ~1s latency via in-process SDK; Codex mini ≈ $0.002/1K and ~3-5s
// per call (CLI subprocess overhead). agy rides Google AI Pro subscription
// quota (no per-token API cost) — spec §2 slots it after openai, before
// claude. Future providers append here.
const CHEAP_EVAL_PREFERENCE: ProviderId[] = ['openai', 'agy', 'claude', 'codex', 'gemini']

/** How long a cheapEval provider sits out after throwing. Long enough to
 *  stop hammering a dead credential every 25-minute ingest cycle, short
 *  enough that a re-login is picked up within minutes. */
const CHEAP_EVAL_COOLDOWN_MS = 10 * 60_000
// 确认的 auth 失败(登录过期)不会自愈,用更长冷却,少做无用重试。
// 只认 `auth_failed:` 前缀 —— 这是 assertNotAuthFailed 在 isAuthFail 确认
// 真登录问题后才加的确定信号。刻意不匹配裸 "authentication failed":agy
// CLI 把认证与超时打包成 "authentication failed or timed out"(2026-08-27:
// owner 确认 agy 能登录,这条其实是网络/超时,和同期 getUpdates cert /
// 隧道 churn 同源),那是瞬时错误,该走短冷却自愈,不能误判成登录过期。
const CHEAP_EVAL_AUTH_COOLDOWN_MS = 60 * 60_000
/**
 * 被服务方**拒绝**(不是坏了、也不是网络抖):agy 的 `region_unavailable`(出口地区不在服务范围)。重试不会好,
 * 只有出口换了才会好 —— 所以既不走 10 分钟冷却,也不进「大家都在冷却就先试第一个」那条兜底。
 * 指数退避:1h → 2h → 4h … 封顶 24h,成功一次清零(出口换了,下一次到点的尝试就能发现)。
 * 2026-10-23 真机:回忆每次收工都去问 agy,两天 28 次全是这句(单候选路径根本不看冷却)。
 */
const CHEAP_EVAL_REFUSED_CODES = new Set(['region_unavailable'])
const CHEAP_EVAL_REFUSED_BASE_MS = 60 * 60_000
const CHEAP_EVAL_REFUSED_CAP_MS = 24 * 60 * 60_000
/** 冷却时长这类内部决策用**窄档** —— 只认结构化码,不让厂商散文带偏。
 *  先看边界挂在抛出物上的 provider 码(arch backlog #4 第 2 步:`auth_failed` /
 *  `auth_rejected` 都是要主人动手的认证失败,不会自愈);有码但不是认证 ⇒ 不是。
 *  没码才回退到 `auth_failed:` 前缀(词汇来自 lib/auth-failure)。
 *  导出还为了诊断采集如实调用它本体。 */
export function isAuthError(err: unknown): boolean {
  const code = providerErrorCodeOf(err)
  if (code) return isAuthErrorCode(code)
  return err instanceof Error && hasAuthCode(err.message)
}

export function createProviderRegistry(opts?: {
  now?: () => number
  /**
   * 显式指定 cheapEval 的 provider (agent-config `cheap_eval_provider`)。
   * 外部集成反馈 #2 (2026-08-26):openai 在偏好序第一,配置 openai-compatible
   * provider 即静默劫持全部后台评估(记忆整理/moderator/introspect)——当
   * base_url 指向特化本地服务时,内部评估要么得到无意义回答、要么把费用记
   * 到意外的账上。指定后只用它(不参与 failover 轮替);未指定保持原偏好序。
   */
  cheapEvalProvider?: string | (() => string | undefined)
  /**
   * 后台 cheapEval 的网络预检(2026-08-29):开机 0.2s 的 introspect 补跑
   * 曾在代理未就绪时 spawn agy → agy 刷 token 撞超时 → 弹浏览器 OAuth 页。
   * failover 试某候选前先问一句「它的端点可达吗」,不可达直接跳过(不入
   * 冷却——网络恢复即重试),落到下一家。预检自身抛错按可达处理(fail-
   * open,探测机器坏了不能反过来卡死评估)。不影响 llm-health 的用户主动
   * 真拨(那条路直接调各 provider 的 cheapEval,不走这里)。daemon 侧用
   * net-probe 的端点表包一个带 TTL 缓存的实现注入;core 保持纯净。
   */
  cheapEvalPreflight?: (id: string) => Promise<boolean>
  /**
   * 诊断采集(可选):一次 cheapEval 失败时,把**真实形状**交出去。
   * 这条路是 agy 唯一真正跑的地方 —— turn_records 里 agy 是零行,不是埋点
   * 坏了,是它根本不走会话轮次。不接就是完全不采(默认行为不变)。
   */
  onProviderFailure?: (info: { provider: string; op: 'cheap_eval'; errorCode: string | null; message: string }) => void
  log?: (line: string) => void
  /**
   * 网络闸门(守护 v2)。给了就把注册进来的每个 provider 套上 withNetworkGate;
   * cheapEval 故障转移**逐个候选**判:需要保护且不安全的候选跳过(**不**记冷却,网络
   * 恢复那一刻就该能用),不需要保护的照常试;一个能试的都没有才抛。缺省 = 不拦。
   */
  networkGate?: NetworkGate
}): ProviderRegistry {
  const now = opts?.now ?? Date.now
  const entries = new Map<ProviderId, { provider: AgentProvider; opts: ProviderRegistration }>()
  // 显式指定优先 — 见 opts.cheapEvalProvider 文档。
  function resolveCheapEval(): CheapEval | null {
    // 可以是 getter(bootstrap 传 mtime 缓存的 config 读法),这样 /set cheap
    // 改完下一次评估就生效,不用重启。
    const pinnedId = readPinnedId()
    if (pinnedId) {
      const pinned = entries.get(pinnedId as ProviderId)?.provider.cheapEval
      // 钉死的那家也要看被拒:钉了 agy、agy 在这个出口被拒,就不能每次照问(2026-10-23 回忆 28 次)。
      if (pinned) return guardRefused(pinnedId as ProviderId, pinned)
      opts?.log?.(`cheap_eval_provider=${pinnedId} 未注册或无 cheapEval — 回落偏好序`)
      // 钉的 provider 此刻没注册(2026-10-04:开机 `--version` 探测一时失败、正在后台
      // 退避重探)。很多调用方在开机时就把这里返回的函数缓存住了(coordinator 的
      // haikuEval、social 的闸门 …),所以不能把「回落」焊死:返回一个**按调用现取**的
      // 派发器 —— 钉的那家晚注册上的那一刻起,每一次评估都回到它。
      const fallback = resolveUnpinned()
      if (!fallback) return null
      let returned = false
      return async (prompt: string) => {
        const id = readPinnedId()
        const live = id ? entries.get(id as ProviderId)?.provider.cheapEval : undefined
        if (live) {
          if (!returned) { returned = true; opts?.log?.(`cheap_eval_provider=${id} 已注册 — 后台评估回到它`) }
          return guardRefused(id as ProviderId, live)(prompt)
        }
        return (resolveUnpinned() ?? fallback)(prompt)
      }
    }
    return resolveUnpinned()
  }

  const evalHealth: CheapEvalHealth = { consecutiveFailures: 0, lastError: null, lastFailAt: null, lastOkAt: null }
  const tracked = (fn: CheapEval): CheapEval => async (prompt: string) => {
    try {
      const out = await fn(prompt)
      evalHealth.consecutiveFailures = 0
      evalHealth.lastOkAt = Date.now()
      return out
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!isNetworkUnprotectedError(e) && providerErrorCodeOf(e) !== 'network' && !isConnectFailure(msg)) {
        evalHealth.consecutiveFailures++
        evalHealth.lastError = msg.slice(0, 200)
        evalHealth.lastFailAt = Date.now()
      }
      throw e
    }
  }
  // cheapEval failover state — per-registry (= per-daemon-lifetime), never persisted.
  const cheapEvalCooldownUntil = new Map<ProviderId, number>()
  const cheapEvalRefused = new Map<ProviderId, { until: number; streak: number; code: string }>()
  const refusedNow = (id: ProviderId) => { const r = cheapEvalRefused.get(id); return r && r.until > now() ? r : null }
  /** 记一次被拒;回 true 表示这是被拒(调用方别再记普通冷却)。 */
  const noteRefusal = (id: ProviderId, err: unknown): boolean => {
    const code = providerErrorCodeOf(err)
    if (!code || !CHEAP_EVAL_REFUSED_CODES.has(code)) return false
    const streak = (cheapEvalRefused.get(id)?.streak ?? 0) + 1
    const wait = Math.min(CHEAP_EVAL_REFUSED_CAP_MS, CHEAP_EVAL_REFUSED_BASE_MS * 2 ** (streak - 1))
    cheapEvalRefused.set(id, { until: now() + wait, streak, code })
    opts?.log?.(`cheapEval: ${id} 被拒(${code}),${Math.round(wait / 60_000)} 分钟内不再问它`)
    return true
  }
  const refusedError = (id: ProviderId, r: { until: number; code: string }) =>
    errorWithProviderCode(`${r.code}: ${id} 被服务方拒绝,${new Date(r.until).toISOString()} 之前不再问它`, r.code)
  /** 包一层:被拒期间不调;成功清零;被拒就记。 */
  const guardRefused = (id: ProviderId, fn: CheapEval): CheapEval => async (prompt) => {
    const r = refusedNow(id)
    if (r) throw refusedError(id, r)
    try {
      const out = await fn(prompt)
      cheapEvalRefused.delete(id)
      return out
    } catch (err) { noteRefusal(id, err); throw err }
  }
  const networkGate = opts?.networkGate
  const readPinnedId = (): string | undefined =>
    typeof opts?.cheapEvalProvider === 'function' ? opts.cheapEvalProvider() : opts?.cheapEvalProvider
  /** 不看钉死项的解析:偏好序 → 其余;多个候选时带运行时故障转移。 */
  const resolveUnpinned = (): CheapEval | null => {
    // Preferred order first, then any other registered provider. The
    // implementations are arrow-like (close over `opts`, never `this`),
    // so calling them unbound is safe.
    const candidates: Array<{ id: ProviderId; fn: CheapEval }> = []
    for (const id of CHEAP_EVAL_PREFERENCE) {
      const ce = entries.get(id)?.provider.cheapEval
      if (ce) candidates.push({ id, fn: ce })
    }
    for (const [id, entry] of entries) {
      if (CHEAP_EVAL_PREFERENCE.includes(id)) continue
      if (entry.provider.cheapEval) candidates.push({ id, fn: entry.provider.cheapEval })
    }
    if (candidates.length === 0) return null
    if (candidates.length === 1) return guardRefused(candidates[0]!.id, candidates[0]!.fn)

    // Runtime failover (2026-08-24): the static preference order once froze
    // the entire ingest pipeline — agy sat at slot 2 with a dead credential
    // and every extract/judge call failed for hours without ever trying the
    // healthy providers behind it. A throwing provider goes on cooldown and
    // the call falls through; only when EVERY candidate fails does the
    // error propagate (callers' watermark-preserving retry semantics rely
    // on that).
    return async (prompt: string) => {
      let lastErr: unknown = new Error('no cheapEval provider available')
      let attempted = 0
      let preflightSkipped = 0
      // 守护 v2:需要保护且网络不安全的候选跳过(不入冷却);不需要保护的照常试。
      let guardRefusal: NetworkUnprotectedError | null = null
      const coolingEligible: typeof candidates = []
      let refusedErr: Error | null = null
      for (const c of candidates) {
        if (networkGate) {
          const d = await decideCall(networkGate, providerCallTarget(entries.get(c.id)?.provider, c.id, 'cheapEval'))
          if (!d.allowed) {
            guardRefusal ??= new NetworkUnprotectedError(d.verdict!, d.cls.label)
            opts?.log?.(`cheapEval: ${c.id} 需要网络保护、此刻不安全 — 跳过(不入冷却)`)
            continue
          }
        }
        const refused = refusedNow(c.id)
        if (refused) { refusedErr ??= refusedError(c.id, refused); continue }
        const until = cheapEvalCooldownUntil.get(c.id) ?? 0
        if (until > now()) { coolingEligible.push(c); continue }
        if (opts?.cheapEvalPreflight) {
          let reachable = true
          try {
            reachable = await opts.cheapEvalPreflight(c.id)
          } catch {
            // fail-open: a broken probe must never block evals
          }
          if (!reachable) {
            preflightSkipped++
            opts.log?.(`cheapEval preflight: ${c.id} 端点不可达 — 跳过(不入冷却)`)
            continue
          }
        }
        attempted++
        try {
          const out = await c.fn(prompt)
          cheapEvalRefused.delete(c.id)
          return out
        } catch (err) {
          // 评估途中网络掉了(闸门在这个候选里拦下):不记冷却,换下一个候选。
          if (isNetworkUnprotectedError(err)) { attempted--; guardRefusal ??= err as NetworkUnprotectedError; continue }
          if (noteRefusal(c.id, err)) { lastErr = err; continue }
          const cd = isAuthError(err) ? CHEAP_EVAL_AUTH_COOLDOWN_MS : CHEAP_EVAL_COOLDOWN_MS
          cheapEvalCooldownUntil.set(c.id, now() + cd)
          lastErr = err
          // 只采集,不改判。绝不让采集影响冷却/失败转移。
          try {
            const msg = err instanceof Error ? err.message : String(err)
            const m = /^([a-z_]+):/.exec(msg)
            opts?.onProviderFailure?.({ provider: c.id, op: 'cheap_eval', errorCode: m ? m[1]! : null, message: msg })
          } catch { /* 采集永不外泄 */ }
        }
      }
      if (attempted === 0) {
        // 网络预检把所有人都拦了 → 抛错让调用方按「本轮失败,下轮重试」
        // 处理(所有后台 judge 都有这个姿势),绝不硬闯——硬闯正是要防
        // 的那次 agy spawn。
        if (preflightSkipped > 0) {
          throw new Error('no reachable cheapEval provider (network preflight)')
        }
        // Everyone (still eligible under the network guard) is cooling down —
        // try the first one anyway rather than failing on a stale blacklist.
        const first = coolingEligible[0]
        if (first) {
          cheapEvalCooldownUntil.delete(first.id)
          return first.fn(prompt)
        }
        // 能试的候选全被守护挡下:一个都不出门,抛统一的「网络未受保护」。
        if (guardRefusal) throw guardRefusal
        // 剩下的全在被拒期:照实说被拒,不硬闯。
        if (refusedErr) throw refusedErr
      }
      throw lastErr
    }
  }
  const registerListeners = new Set<(id: ProviderId) => void>()
  const registry: ProviderRegistry = {
    register(id, provider, opts) {
      if (entries.has(id)) throw new Error(`provider already registered: ${id}`)
      entries.set(id, { provider: networkGate ? withNetworkGate(provider, networkGate, id) : provider, opts })
      for (const cb of [...registerListeners]) { try { cb(id) } catch { /* 回调自己记日志;登记已经成了,不因下游失败回滚 */ } }
    },
    onRegister(cb) {
      registerListeners.add(cb)
      return () => { registerListeners.delete(cb) }
    },
    get(id) {
      return entries.get(id) ?? null
    },
    has(id) {
      return entries.has(id)
    },
    list() {
      return Array.from(entries.keys())
    },
    namesOf(id) { return namesIn({ get: i => entries.get(i) ?? null, list: () => Array.from(entries.keys()) }, id) },
    cheapEvalHealth() {
      return { ...evalHealth }
    },
    getCheapEval() {
      const fn = resolveCheapEval()
      return fn ? tracked(fn) : null
    },
    getStrongEval(id) {
      return entries.get(id)?.provider.strongEval ?? null
    },
    getCheapEvalBudgetMs() {
      // 与 getCheapEval 同一套候选解析(钉死优先,再偏好序,再其余),
      // 否则超时会按一批「其实不会被调用的 provider」来定。
      // cheapEvalProvider 可能是 getter(bootstrap 就这么传),与 getCheapEval 同一种解析。
      const pinnedId = readPinnedId()
      if (pinnedId) {
        const pinned = entries.get(pinnedId as ProviderId)
        if (pinned?.provider.cheapEval) return pinned.provider.cheapEvalBudgetMs ?? DEFAULT_CHEAP_EVAL_BUDGET_MS
      }
      let budget = DEFAULT_CHEAP_EVAL_BUDGET_MS
      for (const entry of entries.values()) {
        if (!entry.provider.cheapEval) continue
        budget = Math.max(budget, entry.provider.cheapEvalBudgetMs ?? DEFAULT_CHEAP_EVAL_BUDGET_MS)
      }
      return budget
    },
  }
  return registry
}
