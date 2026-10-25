/**
 * 执行者 × 档位 × 工具类别:这一格**实际**会怎样(架构终态决定 4,阶段 C3)。
 *
 * 以前是 tier-enforcement.ts 一张手写的表(每家每档「逐工具 / 派发拒 / 缺口」+ 一个手设的 doesNotAsk 标记),
 * 说的是代码「应该」怎样。现在从真判定推出来,不再描述:
 *   - 派发时拒:`providerDenialFor`(访客一来就拒,按原始档位,--dangerously 解不开);
 *   - 有逐工具回调的执行者(能力表 perToolCallback):每一格就是 `authorize()` 在对话面上的结论 ——
 *     「问」落成拒(openai 的 relayAs)也由它算;
 *   - 没有逐工具回调的执行者:档位那一格(`decideTool`,能力表把 askUser 压成 never)+ 两样静态事实 ——
 *       · wechat MCP / 插件上的工具:wechat MCP 按会话档位注册(能力表 adminMcpTools 为假 ⇒ 钉成 trusted),
 *         没注册的就调不到;注册了的,执行者照自己的方式跑;
 *       · 执行者自带的工具(`isExecutorOwnKind`):没有回调就拦不住单个工具 —— 档位说拒的,按「拦不住」算;
 *     档位说「问」、它又问不了时怎么落,读 `compilePolicy` 编出来的 strict 设置(`unattendedAnswer`)。
 *
 * 只看 strict:--dangerously 下 trusted 本来就算 admin、访客一律降回 strict(resolveEffectiveTier / effectivePermissionMode)。
 *
 * 准绳(设计稿 docs/superpowers/specs/2026-10-22-policy-compile-design.md §6):**档位说「问」的,执行者能问就必须问;
 * 问不了的照实落成放或拒;落成放的,主人切过去时照实说一句**(`noAskNotice`)。为什么每家落成这样,写在
 * enforcement-matrix.test.ts 快照旁边;快照钉住整张表,能力表、档位、authorize、compilePolicy 哪一样改了都会在 PR 里看见。
 *
 * 访客能进的派发入口有两处,都调 providerDenialFor:conversation-coordinator 分派时(admit),和主动 / 定时那一拍
 * (daemon/wiring/tick-dispatch.ts)。工作台、主人建的定时、换一家来审都只给主人。以后新开一个访客能进的入口,要在那里同样调。
 *
 * 纯函数,不碰 I/O。
 */
import { capabilitiesFor, deriveCapability, KNOWN_PROVIDER_IDS } from './capability-matrix'
import { providerDenialFor } from './provider-policy'
import { authorize, type GateExecutor } from './authorize'
import { compilePolicy, isExecutorOwnKind } from './policy'
import { decideTool } from './tool-decision'
import { ALL_KINDS, TIER_PROFILES, type TierProfile, type ToolKind, type UserTier } from './user-tier'

/**
 * 一格的结果。档位说的和实际一样 ⇒ 一个词;不一样 ⇒ 「档位说的→实际」:
 *   allow / ask / deny    照档位办(ask = 真的停下来问主人)
 *   refused               这一档派发时就被拒(整档,不看工具)
 *   ask→allow             档位说问,问不了,放了(比档位松 ⇒ 主人切过去时要说一句)
 *   ask→deny              档位说问,问不了,拒了(比档位严)
 *   allow→deny            档位说放,这家调不到(比档位严,例:agy 的 wechat MCP 钉成 trusted,admin 专用工具不注册)
 *   deny→allow            档位说拒,这家拦不住(安全缺口;规则测试要求它只出现在 refused 的档里 —— 也就是不出现)
 */
export type EnforcementOutcome = 'allow' | 'ask' | 'deny' | 'refused' | 'ask→allow' | 'ask→deny' | 'allow→deny' | 'deny→allow'

export const ENFORCEMENT_TIERS: readonly UserTier[] = ['guest', 'trusted', 'admin']

/** 逐工具回调的执行者 ⇒ authorize 里它的闸门是哪一家。 */
const GATE_EXECUTOR: Readonly<Record<string, GateExecutor>> = { claude: 'claude', gemini: 'gemini', openai: 'openai' }

/**
 * 没有逐工具回调的执行者:档位说「问」时它实际怎么落,从 compilePolicy 编出来的 strict 设置读。
 *   codex       approvalPolicy 'never' ⇒ 不问就跑(放);别的审批档在 SDK 的 exec 里没人应答 ⇒ 拒
 *   cursor-acp  对话侧按模式应答权限请求:answer 'allow' ⇒ 放,'reject' ⇒ 拒
 *   agy         设置里没有「被问到怎么答」这一项(只有跳过权限的开关),也没有能问的通道 ⇒ 没人拦它 ⇒ 放
 * 新接一家没有逐工具回调的执行者:这里没它就抛,逼着说清楚它问不了时怎么落。
 */
function unattendedAnswer(provider: string, tp: TierProfile): 'allow' | 'deny' {
  if (provider === 'codex') return compilePolicy('codex', tp, 'strict').approvalPolicy === 'never' ? 'allow' : 'deny'
  if (provider === 'cursor') return compilePolicy('cursor-acp', tp, 'strict').answer === 'allow' ? 'allow' : 'deny'
  if (provider === 'agy') return 'allow'
  throw new Error(`enforcement-matrix: ${provider} 没有逐工具回调,也没说明问不了时怎么落(unattendedAnswer)`)
}

function tierSays(v: 'allow' | 'relay' | 'deny'): 'allow' | 'ask' | 'deny' {
  return v === 'relay' ? 'ask' : v
}

/** 这家执行者、这一档(strict)、这一类工具,实际会怎样。 */
export function enforcementFor(provider: string, tier: UserTier, kind: ToolKind): EnforcementOutcome {
  if (providerDenialFor(provider, tier, undefined) !== null) return 'refused'
  const cap = capabilitiesFor(provider)
  const tp = TIER_PROFILES[tier]
  const askUser = deriveCapability(cap, 'solo', 'strict').askUser

  if (cap.perToolCallback) {
    const executor = GATE_EXECUTOR[provider]
    if (!executor) throw new Error(`enforcement-matrix: ${provider} 标了 perToolCallback,authorize 里却没有它的闸门`)
    // openai 不看能力表(authorize 的 ToolDescriptor.askUser 注释),其余两家传能力表这一行。
    const a = authorize({ surface: 'chat', tier: tp, permissionMode: 'strict', executor }, { name: kind, kind, ...(executor === 'openai' ? {} : { askUser }) })
    if (a.verdict === 'deny' && a.reason === 'relay_unavailable') return 'ask→deny'
    return a.verdict
  }

  const said = tierSays(decideTool(tp, kind, askUser))
  const asked = (): EnforcementOutcome => (unattendedAnswer(provider, tp) === 'allow' ? 'ask→allow' : 'ask→deny')
  if (isExecutorOwnKind(kind)) {
    // 自带的工具:没有回调就拦不住单个工具 —— 沙箱是整轮粗粒度的,不当作「拒住了这一类」。
    if (said === 'allow') return 'allow'
    if (said === 'ask') return asked()
    return 'deny→allow'
  }
  // wechat MCP / 插件上的工具:按会话档位注册(adminMcpTools 为假 ⇒ MCP 钉成 trusted)。
  const registered = !TIER_PROFILES[cap.adminMcpTools ? tier : 'trusted'].deny.has(kind)
  if (!registered) return said === 'deny' ? 'deny' : said === 'allow' ? 'allow→deny' : 'ask→deny'
  if (said === 'allow') return 'allow'
  if (said === 'ask') return asked()
  return 'deny→allow'
}

export type EnforcementMatrix = Record<string, Record<UserTier, Record<ToolKind, EnforcementOutcome>>>

/** 整张表(测试快照用)。 */
export function enforcementMatrix(providers: readonly string[] = KNOWN_PROVIDER_IDS): EnforcementMatrix {
  return Object.fromEntries(providers.map(p => [p, Object.fromEntries(ENFORCEMENT_TIERS.map(t => [t, Object.fromEntries([...ALL_KINDS].map(k => [k, enforcementFor(p, t, k)]))]))])) as EnforcementMatrix
}

/** 档位说「问」、这家放了的那几格还有没有(任一档、任一类)。 */
export function letsAskKindsThrough(provider: string): boolean {
  return ENFORCEMENT_TIERS.some(t => [...ALL_KINDS].some(k => enforcementFor(provider, t, k) === 'ask→allow'))
}

/**
 * 主人切到这家时要照实说的那一句(CC 不骗人):档位说「问」的,它放行、不问。没有就 null。
 * 微信 /codex /agy、控制台切换、provider_switch 工具三条路都用这一句。能力表里没有的(自定义执行者)⇒ null,和以前一样。
 */
export function noAskNotice(provider: string): string | null {
  if (!KNOWN_PROVIDER_IDS.includes(provider)) return null
  // 用「它」不用名字:这一句总是跟在「切到 X」后面;agy 的短名是 Gemini,单说会跟密钥连接的 Gemini 混。
  return letsAskKindsThrough(provider) ? '提醒:它不会逐条问你,删东西也不会。' : null
}
