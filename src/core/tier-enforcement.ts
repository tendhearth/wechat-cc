/**
 * 执行者 × 档位:这家这一档靠哪一层守住(架构审查 #462 第一批,主人 10-20 拍板)。
 *
 * 档位(user-tier.ts 的 TIER_PROFILES)由三层执行,以前散着、没有一处能证明一致:
 *   ① 逐工具 gate —— Claude 的 canUseTool、openai gate、Gemini gate:每次工具调用按档位查 deny / relay / allow;
 *   ② 派发时拒 —— provider-policy.ts 的 providerDenialFor:不能逐工具执行档位的执行者,访客一来就拒(按原始档位,--dangerously 解不开);
 *   ③ 各家的翻译函数(沙箱 / SDK 选项)与 wechat MCP 按会话令牌档位注册工具 —— 粗粒度,补不了 ① 的细节。
 * 这里只按 ① ② 判(③ 是兜底,不当作「守住了」);做不到的就是 gap,必须写进 KNOWN_TIER_GAPS 说清楚。
 * 只看 strict:--dangerously 下 trusted 本来就算 admin、访客一律降回 strict(resolveEffectiveTier / effectivePermissionMode)。
 */
import { capabilitiesFor, KNOWN_PROVIDER_IDS } from './capability-matrix'
import { providerDenialFor } from './provider-policy'

export type EnforcementHow = 'per-tool' | 'dispatch-deny' | 'gap'
export interface TierEnforcement { how: EnforcementHow; note?: string }

/**
 * 已知的 trusted 缺口(strict 下)。trusted 的 deny 集合几乎都是 admin 专用的 MCP 工具,由 wechat MCP 按会话档位注册挡住(③);
 * 真缺的是 relay 那几类(shell_destructive / memory_delete / a2a_send)—— 没有逐工具回调就没法在那一步停下来问主人。
 */
export const KNOWN_TIER_GAPS: Readonly<Record<string, { trusted?: string }>> = {
  codex: { trusted: 'strict 下 workspace-write 沙箱 + approval never:破坏性 shell 不会停下来问(档位要求 relay);admin 专用工具靠 wechat MCP 按档注册挡住;插件 MCP 在 strict 下被 codex 取消' },
  cursor: { trusted: 'ACP:执行命令有权限卡,改文件不弹卡(trusted 本来允许改);只挂 wechat MCP(按会话档位注册),不挂插件和 delegate;memory_delete / a2a_send 这类 relay 不会逐个问' },
  agy: { trusted: '没有逐工具回调,wechat MCP 是钉死 trusted 的静态配置;relay 那几类不会停下来问' },
}

export function tierEnforcement(provider: string, tier: 'guest' | 'trusted'): TierEnforcement {
  if (providerDenialFor(provider, tier, undefined) !== null) return { how: 'dispatch-deny' }
  if (capabilitiesFor(provider).perToolCallback) return { how: 'per-tool' }
  const note = tier === 'trusted' ? KNOWN_TIER_GAPS[provider]?.trusted : undefined
  return { how: 'gap', ...(note ? { note } : {}) }
}

/** 整张表(启动日志 / 文档 / 测试用)。 */
export function TIER_ENFORCEMENT_TABLE(): Record<string, { guest: EnforcementHow; trusted: EnforcementHow }> {
  return Object.fromEntries(KNOWN_PROVIDER_IDS.map(p => [p, { guest: tierEnforcement(p, 'guest').how, trusted: tierEnforcement(p, 'trusted').how }]))
}
