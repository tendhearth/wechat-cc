/**
 * 网络闸门 —— 守护 v2(2026-10-02 主人收窄):**根据约定的网络信号,判断 CC 能不能「开始」
 * 一次需要保护的调用。**
 *
 *   1. 先分类这一次调用(lib/call-classifier.ts):连到哪、用哪个模型。不需要保护的
 *      (国内平台、自建、Cursor auto、自定义网关……)**直接放行,不看信号**。
 *   2. 需要保护的才看信号(NetworkGate.check()):装了 bx 只认 bx;没装看 daemon 自己的
 *      google 探测。不安全就不出发。
 *
 * 只拒绝那一次需要保护的调用;同一时刻不需要保护的调用照常。国内 / 自建的失败仍是普通的
 * 连接错误,**永远不贴「网络未受保护」**。
 *
 * 这里只放契约(类型 + 统一文案 + 错误类 + 判定助手),放在 lib 是因为 core/workbench 与
 * daemon 都要用,而 core 不许依赖 daemon。实现(bx 状态 / 探测)在 src/daemon/guard/gate.ts。
 *
 * 规矩:不重试、不退避排队 —— 断线时停手;定时 / 后台任务安静跳过,只留一行日志。
 */
import { classifyCall, type CallClass, type CallTarget } from './call-classifier'

export type { CallTarget, CallClass } from './call-classifier'

export type NetworkGateSource = 'bx' | 'probe' | 'off'

export interface NetworkGateVerdict {
  safe: boolean
  /** bx:按 `bx status --json` 判;probe:按 daemon 自己的 google 探测判;off:守护关着,不拦。 */
  source: NetworkGateSource
  detail: string
}

export interface NetworkGate {
  /** 网络信号:此刻网络受保护吗。只回答信号,不管是哪种调用。 */
  check(): Promise<NetworkGateVerdict>
  /**
   * 这一次调用要不要保护。daemon 实现会补齐端点(ANTHROPIC_BASE_URL、openaiBaseUrl)、
   * Cursor 默认模型,并套上 guard.json 的覆盖。缺省 = classifyCall(target)(无覆盖)。
   */
  classify?(target: CallTarget): CallClass
}

/** 没接守护(测试、CLI 一次性命令)时的默认:放行。 */
export const OPEN_NETWORK_GATE: NetworkGate = {
  check: async () => ({ safe: true, source: 'off', detail: '守护未接入' }),
}

/**
 * 统一拒绝文案。label = 被暂停的那一步用到的接口(「Claude」「Cursor(gpt-5)」……)。
 * 例:「网络未受保护(bx 未连上),用到 Claude 的这一步先暂停，恢复后再试。」
 */
export function unprotectedMessage(v: Pick<NetworkGateVerdict, 'source'>, label?: string): string {
  const why = v.source === 'bx' ? 'bx 未连上' : 'VPN 探测失败'
  return `网络未受保护(${why}),用到 ${label || '海外模型'} 的这一步先暂停，恢复后再试。`
}

export class NetworkUnprotectedError extends Error {
  readonly code = 'network_unprotected' as const
  constructor(readonly verdict: NetworkGateVerdict, readonly label?: string) {
    super(unprotectedMessage(verdict, label))
    this.name = 'NetworkUnprotectedError'
  }
}

export function isNetworkUnprotectedError(err: unknown): err is NetworkUnprotectedError {
  return err instanceof NetworkUnprotectedError
    || (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'network_unprotected')
}

/** 拿不准实际目标时的占位:classify 一律判成需要保护(fail closed)。 */
export function unresolvedTarget(provider: string, purpose: CallTarget['purpose'] = 'turn'): CallTarget {
  return { provider, purpose, unresolved: true }
}

/**
 * 一个**在用的**会话 / 执行者这一轮真正连到哪里(评审 #193 P1-1):它在起来那一刻定下的端点 + 模型,
 * 而不是此刻配置里写的。会话没报(或报错)⇒ unresolved ⇒ 按需要保护。
 */
export function sessionCallTarget(session: { callTarget?: () => CallTarget | null } | null | undefined, provider: string): CallTarget {
  try {
    const t = session?.callTarget?.()
    if (t) return { ...t, exact: true }
  } catch { /* 报不出来就按拿不准处理 */ }
  return unresolvedTarget(provider)
}

export function classifyWith(gate: NetworkGate | undefined, target: CallTarget): CallClass {
  try { return gate?.classify ? gate.classify(target) : classifyCall(target) }
  catch { return classifyCall(target) }
}

export interface CallDecision {
  allowed: boolean
  /** 这一次调用是否需要保护。false ⇒ 根本没看信号。 */
  protectedCall: boolean
  cls: CallClass
  /** 需要保护时的信号读数;不需要保护时为 null。 */
  verdict: NetworkGateVerdict | null
}

/** 判一次调用:不需要保护 → 直接放行(不读信号);需要保护 → 看信号。永不抛。 */
export async function decideCall(gate: NetworkGate | undefined, target: CallTarget): Promise<CallDecision> {
  const cls = classifyWith(gate, target)
  if (!gate || !cls.protected) return { allowed: true, protectedCall: cls.protected, cls, verdict: null }
  let v: NetworkGateVerdict
  try { v = await gate.check() } catch (err) {
    v = { safe: false, source: 'bx', detail: `守护自检出错(${err instanceof Error ? err.message : String(err)})` }
  }
  return { allowed: v.safe, protectedCall: true, cls, verdict: v }
}

/** 需要保护且不安全就抛 NetworkUnprotectedError(带被暂停那一步的名字)。 */
export async function assertCallAllowed(gate: NetworkGate | undefined, target: CallTarget): Promise<void> {
  const d = await decideCall(gate, target)
  if (!d.allowed) throw new NetworkUnprotectedError(d.verdict!, d.cls.label)
}
