/** Codex rust-v0.167.0 (086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a).
 * SandboxPolicy only has a network boolean. Managed proxy + Seatbelt supplies
 * loopback binding while its explicit denylist blocks every nonempty host.
 * '?' is one byte and '*' any suffix; bare '*' is rejected by the native parser.
 */
export const TASK_LOOPBACK_PROXY = {
  enabled: true, allow_local_binding: true, allow_upstream_proxy: false,
  enable_socks5: false, enable_socks5_udp: false,
  dangerously_allow_non_loopback_proxy: false, dangerously_allow_all_unix_sockets: false,
  credential_broker: false, mode: 'full', domains: { '?*': 'deny' },
} as const
export function supportsTaskLoopback(userAgent: unknown): boolean {
  return typeof userAgent === 'string' && /^[^/\r\n]+\/0\.167\.0(?:\s|$)/.test(userAgent)
}
export function verifyTaskLoopback(config: Record<string, any>): void {
  const proxy = config.features?.network_proxy
  // Empty override tables merge with disk layers. An inherited Unix socket
  // grant (e.g. Docker) must never become reachable by enabling the proxy.
  const sockets = proxy?.unix_sockets
  if (sockets != null && (typeof sockets !== 'object' || Array.isArray(sockets) || Object.values(sockets).some(value => value !== 'deny'))) throw Error('codex_unverified_loopback_policy')
  for (const [key, value] of Object.entries(TASK_LOOPBACK_PROXY)) {
    if (key === 'domains') { if (proxy?.domains?.['?*'] !== 'deny') throw Error('codex_unverified_loopback_policy') }
    else if (proxy?.[key] !== value) throw Error('codex_unverified_loopback_policy')
  }
}
export function verifyEffectiveTaskLoopback(result: Record<string, any>): void {
  const features = Array.isArray(result.data) ? result.data.filter((item: any) => item?.name === 'network_proxy') : []
  if (features.length !== 1 || features[0].enabled !== true || result.nextCursor != null) throw Error('codex_unverified_loopback_policy')
}
export function verifyTaskNetworkRequirements(result: Record<string, any>): void {
  if (result.requirements !== null && (!result.requirements || result.requirements.network != null || result.requirements.allowedPermissionProfiles != null || result.requirements.defaultPermissions != null || result.requirements.featureRequirements?.network_proxy === false)) throw Error('codex_unverified_loopback_policy')
}
