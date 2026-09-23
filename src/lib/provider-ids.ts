/**
 * provider-ids — 六家 provider 的唯一名单(lib 层,零依赖)。
 *
 * 之前这份名单抄了 7 处(agent-config 的 zod 枚举、cli/schema、config-surface、
 * routes-daemon-control、tools-mode、mode-commands、settings-panel),而且已经
 * 不一致:agent-config 和 cli/schema 的枚举里**没有 agy**,主人机器上
 * agent-config.json 写着 provider:"agy",loadAgentConfig 静默映射成 claude,
 * 半个月没人发现。core/capability-matrix 的 CAPABILITIES_BY_PROVIDER 是能力
 * 的事实源,它的键必须与这里相等(capability-matrix.test 钉死)。
 */
export const PROVIDER_IDS = ['claude', 'codex', 'cursor', 'openai', 'gemini', 'agy'] as const
export type KnownProviderId = (typeof PROVIDER_IDS)[number]

export function isKnownProviderId(x: unknown): x is KnownProviderId {
  return typeof x === 'string' && (PROVIDER_IDS as readonly string[]).includes(x)
}
