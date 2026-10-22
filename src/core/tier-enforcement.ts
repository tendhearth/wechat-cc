/**
 * 执行者 × 档位:这家这一档靠哪一层守住(架构审查 #462 第一批,主人 10-20 拍板)。
 *
 * 档位(user-tier.ts 的 TIER_PROFILES)由三层执行,以前散着、没有一处能证明一致:
 *   ① 逐工具 gate —— Claude 的 canUseTool、openai gate、Gemini gate:每次工具调用按档位查 deny / relay / allow;
 *   ② 派发时拒 —— provider-policy.ts 的 providerDenialFor:不能逐工具执行档位的执行者,访客一来就拒(按原始档位,--dangerously 解不开);
 *   ③ 各家的翻译函数(沙箱 / SDK 选项)与 wechat MCP 按会话令牌档位注册工具 —— 粗粒度,补不了 ① 的细节。
 * 这里只按 ① ② 判(③ 是兜底,不当作「守住了」);做不到的就是 gap,必须写进 KNOWN_TIER_GAPS 说清楚。
 * 只看 strict:--dangerously 下 trusted 本来就算 admin、访客一律降回 strict(resolveEffectiveTier / effectivePermissionMode)。
 *
 * 「per-tool」不靠自报:tier-enforcement.proof.test.ts 对每家真调一次 gate(访客碰 shell、trusted 碰 admin 专用工具都要被拒)。
 * 「dispatch-deny」证明的是 providerDenialFor 对这家会拒;**访客能进的派发入口有两处**:conversation-coordinator
 * 分派时,和主动 / 定时那一拍(daemon/wiring/tick-dispatch.ts,默认对话可以是非管理员,#562 补上)。工作台、主人建的
 * 定时、换一家来审都只给主人。以后新开一个访客能进的入口,要在那里同样调 providerDenialFor。
 *
 * admin(3c Policy 第 2 步,2026-10-22):以前只核 guest / trusted。admin 在 strict 下也有「要问」的几类
 * (shell_destructive / memory_delete / daemon_remediate),没有逐工具回调的执行者同样做不到,一样登记。
 * 准绳(设计稿 2026-10-22-policy-compile-design.md §6,9d 同意):**档位说「问」的,执行者能问就必须问;问不了的登记成
 * 缺口,主人切过去时照实说一句**(`noAskNotice`)。
 */
import { capabilitiesFor, KNOWN_PROVIDER_IDS } from './capability-matrix'
import { providerDenialFor } from './provider-policy'

export type EnforcementHow = 'per-tool' | 'dispatch-deny' | 'gap'
export interface TierEnforcement { how: EnforcementHow; note?: string }

/**
 * 已知缺口(strict 下)。trusted 的 deny 集合几乎都是 admin 专用的 MCP 工具,由 wechat MCP 按会话档位注册挡住(③);
 * 真缺的是 relay 那几类 —— 没有逐工具回调就没法在那一步停下来问主人。
 * `doesNotAsk`:这家「问」的那几类**放行**了(比档位松),主人切过去时要照实说一句;没有这个标记的缺口是比档位**严**
 * (问的直接拒),不用提醒。
 */
export const KNOWN_TIER_GAPS: Readonly<Record<string, { trusted?: string; admin?: string; doesNotAsk?: true }>> = {
  codex: {
    trusted: 'strict 下 workspace-write 沙箱 + approval never:破坏性 shell 不会停下来问(档位要求 relay);admin 专用工具靠 wechat MCP 按档注册挡住;插件 MCP 在 strict 下被 codex 取消',
    admin: 'strict 下 workspace-write 沙箱 + approval never:shell_destructive / memory_delete / daemon_remediate 不会停下来问。codex 的审批只有整轮粗粒度(on-request 会让每条越界命令都弹卡,也分不出哪条是破坏性的),问不了 ⇒ 维持不问,切过去时照实说(稿 §6)',
    doesNotAsk: true,
  },
  cursor: {
    trusted: 'ACP:执行命令有权限卡,改文件不弹卡(trusted 本来允许改);只挂 wechat MCP(按会话档位注册),不挂插件和 delegate;memory_delete / a2a_send 这类 relay 不会逐个问',
    admin: 'ACP 对话侧按模式应答:strict 下每条权限请求都拒(比档位严 —— 档位说问,它直接拒,不是放行);改成真的问是稿 §6 第 5 步,等主人点头',
  },
  agy: {
    trusted: '没有逐工具回调,wechat MCP 是钉死 trusted 的静态配置;relay 那几类不会停下来问',
    admin: '没有逐工具回调:shell_destructive / memory_delete / daemon_remediate 不会停下来问;问不了 ⇒ 维持不问,切过去时照实说(稿 §6)',
    doesNotAsk: true,
  },
}

export function tierEnforcement(provider: string, tier: 'guest' | 'trusted' | 'admin'): TierEnforcement {
  if (providerDenialFor(provider, tier, undefined) !== null) return { how: 'dispatch-deny' }
  if (capabilitiesFor(provider).perToolCallback) return { how: 'per-tool' }
  const note = tier === 'guest' ? undefined : KNOWN_TIER_GAPS[provider]?.[tier]
  return { how: 'gap', ...(note ? { note } : {}) }
}

/** 整张表(启动日志 / 文档 / 测试用)。 */
export function TIER_ENFORCEMENT_TABLE(): Record<string, { guest: EnforcementHow; trusted: EnforcementHow; admin: EnforcementHow }> {
  return Object.fromEntries(KNOWN_PROVIDER_IDS.map(p => [p, { guest: tierEnforcement(p, 'guest').how, trusted: tierEnforcement(p, 'trusted').how, admin: tierEnforcement(p, 'admin').how }]))
}

/**
 * 主人切到这家时要照实说的那一句(CC 不骗人):档位说「问」的,它放行、不问。没有就 null。
 * 微信 /codex /agy、控制台切换、provider_switch 工具三条路都用这一句。
 */
export function noAskNotice(provider: string): string | null {
  // 用「它」不用名字:这一句总是跟在「切到 X」后面;agy 的短名是 Gemini,单说会跟密钥连接的 Gemini 混。
  return KNOWN_TIER_GAPS[provider]?.doesNotAsk ? '提醒:它不会逐条问你,删东西也不会。' : null
}
