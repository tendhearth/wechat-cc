/**
 * provider-policy — 谁能把对话切到哪家 provider。
 *
 * 两条规则,一处判定,mode-commands(斜杠命令)和 coordinator(分发时,防
 * set-mode 绕过 / 事后降级)都调它:
 *
 * 1. **共享钥匙的 provider 拒 guest。** agy / cursor-CLI 只读自己的全局
 *    MCP 配置,一把长期 trusted token 被它跑的所有对话共用,按对话隔离不了
 *    权限(ProviderCapabilities.adminMcpTools === false 就是这个意思)。guest
 *    切过去等于白拿 trusted 权限 —— 拒。以前只有 /agy 有这道门,cursor 没有。
 * 2. **管理员可以限定非管理员能用哪些。** agent-config `trusted_providers`
 *    (缺省 = 全部已注册)。admin 不受限。
 */
import type { ProviderId } from './conversation'
import type { UserTier } from './user-tier'
import { capabilitiesFor } from './capability-matrix'

export type ProviderDenial =
  | { kind: 'shared_token_guest' }
  | { kind: 'not_in_trusted_list'; allowed: readonly ProviderId[] }

export function providerDenialFor(
  providerId: ProviderId,
  tier: UserTier,
  trustedProviders: readonly ProviderId[] | undefined,
): ProviderDenial | null {
  if (tier === 'admin') return null
  let shared = false
  try { shared = !capabilitiesFor(providerId).adminMcpTools } catch { shared = false }
  if (tier === 'guest' && shared) return { kind: 'shared_token_guest' }
  if (trustedProviders && !trustedProviders.includes(providerId)) return { kind: 'not_in_trusted_list', allowed: trustedProviders }
  return null
}

/** 用户看得懂的拒绝语。slash = 用户打的那个词(cc/agy/cursor…)。 */
export function describeProviderDenial(d: ProviderDenial, slash: string): string {
  if (d.kind === 'shared_token_guest') return `❌ /${slash} 目前仅管理员/信任聊天可用（工具通道暂无法按会话隔离权限）。`
  return `❌ 管理员没把 /${slash} 开放给非管理员对话。可用: ${d.allowed.length ? d.allowed.join(', ') : '(无)'}`
}

/** provider id → 斜杠词(claude 是 /cc,其余同名)。 */
export function slashFor(providerId: ProviderId): string {
  return providerId === 'claude' ? 'cc' : providerId
}
