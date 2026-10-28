/**
 * provider-policy — 谁能把对话切到哪家 provider。
 *
 * 三条规则,一处判定,mode-commands(斜杠命令)和 coordinator(分发时,防
 * set-mode 绕过 / 事后降级)都调它:
 *
 * 1. **共享钥匙的 provider 拒 guest。** agy 只读自己的全局 MCP 配置,一把长期
 *    trusted token 被它跑的所有对话共用,按对话隔离不了权限
 *    (ProviderCapabilities.adminMcpTools === false 就是这个意思)。guest 切
 *    过去等于白拿 trusted 权限 —— 拒。cursor 以前也走这条(退休的 print-mode
 *    对话 provider 往全局 mcp.json 塞一把静态钥匙),2026-09-18 对话侧改走
 *    ACP 后 MCP 按会话注入、带逐会话 token 与 tier(acp-cursor-chat.ts),
 *    不再共享钥匙,这道门也就不再挡它 —— 换成下面第 2 条挡。
 * 2. **约束不了自己工具面的 provider 拒 guest。**
 *    `guestSafe(cap) === false`(能力表 `confines` 里有一件收不住):provider 自带的工具不经过
 *    daemon 的权限卡、也不看 tierProfile。cursor 走 ACP 后就是这样 ——
 *    权限按 permissionMode 就地判,而工作区内的文件编辑压根不请求批准
 *    (真机 spike 2026-09-17)。guest 切过去等于让访客改主人的项目 —— 拒。
 * 3. **管理员可以限定非管理员能用哪些。** agent-config `trusted_providers`
 *    (缺省 = 全部已注册)。admin 不受限。
 */
import type { ProviderId } from './conversation'
import { PROVIDER_IDS, type KnownProviderId } from '../lib/provider-ids'
import { EXECUTOR_FACTS } from '../lib/executor-facts'
import type { UserTier } from './user-tier'
import { capabilitiesFor } from './capability-matrix'
import { guestSafe } from './confinement'

export type ProviderDenial =
  | { kind: 'shared_token_guest' }
  | { kind: 'unconfined_guest' }
  | { kind: 'not_in_trusted_list'; allowed: readonly ProviderId[] }

export function providerDenialFor(
  providerId: ProviderId,
  tier: UserTier,
  trustedProviders: readonly ProviderId[] | undefined,
): ProviderDenial | null {
  if (tier === 'admin') return null
  if (tier === 'guest') {
    // 能力表里查不到的 id(拼错、或新加一家漏了登记)对访客关门:缺省往拒绝的方向兜底(3c,2026-10-22)。
    let cap: ReturnType<typeof capabilitiesFor> | null = null
    try { cap = capabilitiesFor(providerId) } catch { cap = null }
    if (!cap) return { kind: 'unconfined_guest' }
    if (!cap.adminMcpTools) return { kind: 'shared_token_guest' }
    if (!guestSafe(cap)) return { kind: 'unconfined_guest' }
  }
  if (trustedProviders && !trustedProviders.includes(providerId)) return { kind: 'not_in_trusted_list', allowed: trustedProviders }
  return null
}

/** 用户看得懂的拒绝语。slash = 用户打的那个词(cc/agy/cursor…)。 */
export function describeProviderDenial(d: ProviderDenial, slash: string): string {
  if (d.kind === 'shared_token_guest') return `/${slash} 目前仅管理员/信任聊天可用（工具通道暂无法按会话隔离权限）。`
  if (d.kind === 'unconfined_guest') {
    if (slash === 'cursor') return 'Cursor 对访客不开放：它在工作区内的文件编辑不经过权限卡，访客的权限约束不到它。'
    if (slash === 'codex') return '/codex 对访客不开放：它的只读沙盒仍能读这台电脑上的任意文件，访客的权限约束不到它。'
    return `/${slash} 对访客不开放：访客的权限约束不到它。`
  }
  return `管理员没把 /${slash} 开放给非管理员对话。可用: ${d.allowed.length ? d.allowed.join(', ') : '(无)'}`
}

/**
 * 微信里切到某家用的斜杠词 —— 唯一一份(mode-commands 解析、拒绝语里报给用户的都读它)。
 * claude 是 /cc;OpenAI 兼容后端是 /api(是「主人自己的 API」,不绑哪家厂商);其余同名。
 * 10-21:以前这里只特判了 claude,拒绝语会叫访客发「/openai」—— 没有这个命令。
 */
export const PROVIDER_SLASH: Readonly<Record<KnownProviderId, string>> =
  Object.fromEntries(PROVIDER_IDS.map(id => [id, EXECUTOR_FACTS[id].slash])) as Record<KnownProviderId, string>

/** provider id → 斜杠词。不在表里的(自定义执行者)⇒ 同名。 */
export function slashFor(providerId: ProviderId): string {
  return (PROVIDER_SLASH as Record<string, string>)[providerId] ?? providerId
}

/** 斜杠词 → provider id(不分大小写);不是哪家的词 ⇒ null。 */
export function providerForSlash(word: string): KnownProviderId | null {
  const lower = word.toLowerCase()
  for (const id of Object.keys(PROVIDER_SLASH) as KnownProviderId[]) if (PROVIDER_SLASH[id] === lower) return id
  return null
}
