/**
 * 网络闸门 —— 所有「往模型供应商发请求」的路径在出发前问一句:此刻网络受保护吗?
 * (2026-10-02,主人拍板:不走隧道直连供应商可能导致账号被封。)
 *
 * 这里只放契约(类型 + 统一文案 + 错误类),放在 lib 是因为 core/workbench 与
 * daemon 都要用,而 core 不许依赖 daemon。实现(bx 状态 / ipify+探测)在
 * src/daemon/guard/gate.ts。
 *
 * 规矩:
 *   - 不安全就**不出发**,在发起的那个表面给一句统一的话(unprotectedMessage)。
 *   - 不重试、不退避排队 —— 断线时停手(见「断线不重试风暴」规矩)。
 *   - 定时 / 后台任务安静跳过,只留一行日志,下一拍再看。
 */

export type NetworkGateSource = 'bx' | 'probe' | 'off'

export interface NetworkGateVerdict {
  safe: boolean
  /** bx:按 `bx status --json` 判;probe:没装 bx,按 ipify+探测判;off:守护关着,不拦。 */
  source: NetworkGateSource
  detail: string
}

export interface NetworkGate {
  check(): Promise<NetworkGateVerdict>
}

/** 没接守护(测试、CLI 一次性命令)时的默认:放行。 */
export const OPEN_NETWORK_GATE: NetworkGate = {
  check: async () => ({ safe: true, source: 'off', detail: '守护未接入' }),
}

export function unprotectedMessage(v: Pick<NetworkGateVerdict, 'source'>): string {
  return v.source === 'bx'
    ? '网络未受保护(bx 未连上),CC 先暂停，恢复后再试。'
    : '网络未受保护(VPN 探测失败),CC 先暂停，恢复后再试。'
}

export class NetworkUnprotectedError extends Error {
  readonly code = 'network_unprotected' as const
  constructor(readonly verdict: NetworkGateVerdict) {
    super(unprotectedMessage(verdict))
    this.name = 'NetworkUnprotectedError'
  }
}

export function isNetworkUnprotectedError(err: unknown): err is NetworkUnprotectedError {
  return err instanceof NetworkUnprotectedError
    || (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'network_unprotected')
}

/** 不安全就抛 NetworkUnprotectedError;gate 自己出错也按不安全处理。 */
export async function assertNetworkSafe(gate: NetworkGate | undefined): Promise<void> {
  if (!gate) return
  let v: NetworkGateVerdict
  try { v = await gate.check() } catch (err) {
    v = { safe: false, source: 'bx', detail: `守护自检出错(${err instanceof Error ? err.message : String(err)})` }
  }
  if (!v.safe) throw new NetworkUnprotectedError(v)
}
