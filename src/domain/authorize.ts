/**
 * 「能不能做」只有一个判定(架构终态决定 4,阶段 C2):每一次工具调用放 / 问 / 拒,都由这里算。
 *
 *   authorize(subject, descriptor, action) → { verdict: allow | ask | deny, reason, … }
 *
 * 纯函数:不碰 node、不碰盘、不发网络。要碰盘才知道的事实(路径是否在项目里、红线、放行规则的裁决)由调用方
 * 算好放进 action / descriptor;它们**怎么组合成结论**只在这里。
 *
 * 分清两样东西:
 *   (a) 执行者开局给自己配的静态设置(沙箱、SDK 的 permissionMode / disallowedTools / ask 名单)—— 那是
 *       `compilePolicy`(policy.ts)的事,不在这里;
 *   (b) 一次调用来了、当场判 —— 只能是这里。
 *
 * 组合的层,按顺序(每层只在它管的面上生效,顺序与改之前各处手写的那几份一位不差,见 authorize.parity.test.ts):
 *   1. 旁路:权限模式 dangerously 时,这家执行者的逐工具闸门整个不判(只有自己跑闸门的 gemini / openai 有这一层;
 *      Claude 的旁路是 SDK 的 bypassPermissions —— 静态设置,canUseTool 根本不会被调);
 *   2. 扇出拒 reply:/chat、/both 里 reply 族和 `message` 一律拒(协调器看不到那句话,前缀 / 收口管不到);
 *   3. 名字不合规:gemini 的裸名里带 `__`(拼上前缀会变成别的工具)⇒ 拒;
 *   4. 登记表:一起做的 Claude 只认这件事登记过的原生 MCP(没登记 / 登记了但不放进来 ⇒ 拒,登记且放进来 ⇒ 问);
 *   5. 定时任务只读档:不在档里 ⇒ 拒;读过本机之后不再上网;读文件只限项目目录、不碰红线;
 *   6. 档位 × 工具类别(tool-decision.ts 的 decideTool,三家共用)⇒ 放 / 问 / 拒;
 *   7. 问不了:编译好的策略说这家执行者「问」落成拒(openai v1)⇒ 拒;
 *   8. 主人的放行规则:**只在终端会话(terminal)和一起做(workbench)两个面**上、而且只在前面落到「问」时才看。
 *
 * 网络守护不在这里:它判的是「这一次 spawn / 这一次模型调用连哪个端点」(lib/network-gate 的 decideCall,按调用
 * 目标、不按工具),没有逐工具的那一层。
 *
 * 「问」之后的事 —— 有没有人可问(没配 admin、手机 / 微信卡没送到)、超时、主人点了拒、调用被取消 —— 是问的
 * 那条通道的结果,不是策略;它们留在各家执行者的问法里。
 */
import type { PermissionMode } from './permission-mode'
import type { Verdict } from './permission-rules/types'
import type { TierProfile, ToolKind } from './user-tier'
import { compilePolicy } from './policy'
import { decideTool } from './tool-decision'

/**
 * 放行规则的裁决:permission-gate.decide 给的 Decision(permission-rules/types.ts)。`by` 按字符串收 —— 一起做的
 * 接口(PermissionDecide)本来就是 string;认不出的 by 一律不算数(落回问)。
 */
export interface OwnerRuling { verdict: Verdict; by: string }

/**
 * 这一次调用发生在哪个面上。放行规则按它开关(见 OWNER_RULE_SURFACES)。
 *   chat      微信 / App 对话(Claude 的 permission-relay、Gemini、OpenAI 兼容的闸门)
 *   workbench 一起做(工作台任务)
 *   terminal  终端会话(hook 报上来的权限请求)
 *   job       定时任务那一轮的只读档(没人看着)
 */
export type AuthSurface = 'chat' | 'workbench' | 'terminal' | 'job'

/**
 * 放行规则今天只在这两个面上生效,收进 authorize 以后照旧(按 surface 判,决定 4 的「不改行为」)。
 * 对话(chat)要不要也走放行规则,是主人天天看得见的变化,单列等主人点头 —— 别在这里顺手加上 'chat'。
 */
export const OWNER_RULE_SURFACES: ReadonlySet<AuthSurface> = new Set<AuthSurface>(['terminal', 'workbench'])

/** 自己跑逐工具闸门、并且闸门的旁路 / 「问」怎么落由编译策略说了算的执行者。其余执行者在这里不看权限模式。 */
export type GateExecutor = 'claude' | 'gemini' | 'openai'

/** 谁在调:哪个面、哪一档、什么权限模式、哪家执行者的闸门、这个对话是不是扇出。 */
export interface AuthSubject {
  surface: AuthSurface
  tier: TierProfile
  permissionMode: PermissionMode
  executor: GateExecutor
  /** 对话处在 chatroom / parallel(扇出)模式。只有 Claude 的对话闸门报这一项(今天只有它管扇出里的 reply)。 */
  fanOut?: boolean
}

/** 调的是什么工具。 */
export interface ToolDescriptor {
  name: string
  /** classifyToolUse 的结果。 */
  kind: ToolKind
  /**
   * 能力表这一行的 askUser(档位没明说时的落点);不给 ⇒ 'never'(openai 不看能力表)。
   * 可以给一个函数:只在走到档位那一层时才取(Gemini 取它要读对话模式,旁路 / 名字不合规的路上不读)。
   */
  askUser?: 'per-tool' | 'never' | (() => 'per-tool' | 'never')
  /** reply 族或 `mcp__wechat__message`(扇出时要拒的那几个)。 */
  replyFamily?: boolean
  /** 名字本身不合规(gemini:裸名里带 `__`)。 */
  malformed?: boolean
  /**
   * 一起做的 Claude:这个 MCP 工具在这件事的登记表里是什么地位(登记表是 wire-workbench 读出来的原生 MCP)。
   *   unregistered  任何登记过的 server 前缀都对不上
   *   not_admitted  前缀对上了,但那是伙伴自己的 server(wechat / delegate …)或后面没有工具名
   *   admitted      登记且放进来 ⇒ 逐条问
   * 不是 MCP 工具 ⇒ 不给。
   */
  mcp?: 'unregistered' | 'not_admitted' | 'admitted'
  /**
   * 执行者自己已经把这次调用当成「要批准」报上来了(终端 hook 的权限请求、一起做里执行者的 requestPermission)。
   * 这一层之前的判定(档位等)已经由执行者 / 上一次 authorize 做过,这里起点就是「问」。
   */
  reported?: boolean
}

/** 这一次调用的事实。 */
export interface AuthAction {
  /** 定时任务:这一轮已经读过本机的东西(文件 / 记忆 / 观察)。 */
  tainted?: boolean
  /** 定时任务读文件的范围事实(调用方按项目目录、红线算好):没带路径的 MCP 读 / 出了项目目录 / 红线理由。 */
  readScope?: { pathless: boolean; outside: boolean; redLine: string | null }
  /** 放行规则的裁决(permission-gate.decide 的结果)。只在 consultOwnerRules 为真之后才有。 */
  ownerRuling?: OwnerRuling
}

export type AuthVerdict = 'allow' | 'ask' | 'deny'

export type AuthReason =
  | 'bypass'           // 权限模式 dangerously:这家的闸门不判
  | 'fanout_reply'     // 扇出模式里的 reply 族 / message
  | 'malformed_name'   // 名字不合规
  | 'unregistered'     // 一起做:没登记的 MCP
  | 'not_admitted'     // 一起做:登记了但不放进来的 MCP
  | 'admitted'         // 一起做:登记且放进来的 MCP ⇒ 问
  | 'job_profile'      // 定时任务:不在只读档里
  | 'job_tainted'      // 定时任务:读过本机之后上网
  | 'job_pathless'     // 定时任务:MCP 读文件没带路径
  | 'job_outside'      // 定时任务:读到项目目录外
  | 'job_red_line'     // 定时任务:碰到红线(detail = 理由)
  | 'job_allowed'      // 定时任务:放
  | 'tier'             // 档位 × 类别
  | 'relay_unavailable'// 档位说问、这家执行者问不了 ⇒ 拒
  | 'reported'         // 执行者报上来要批准的调用 ⇒ 问
  | 'owner_rules'      // 放行规则拿了主意

export interface Authorization {
  verdict: AuthVerdict
  reason: AuthReason
  /** job_red_line 的中文理由(调用方拼进给执行者的话里)。 */
  detail?: string
  /** owner_rules:规则表 / 初审 / 红线谁拿的主意(一起做的时间线照写)。 */
  by?: 'rule' | 'review' | 'floor'
  /**
   * 落到「问」、这个面上放行规则生效、还没拿到裁决 ⇒ 真。调用方去问 permission-gate,拿 ownerRuling 再调一次。
   * 对话面永远假(见 OWNER_RULE_SURFACES)。
   */
  consultOwnerRules: boolean
}

const done = (verdict: AuthVerdict, reason: AuthReason, extra: Partial<Authorization> = {}): Authorization => ({ verdict, reason, consultOwnerRules: false, ...extra })

/** 「问」:放行规则生效的面上,先交给规则(有裁决就按裁决落)。 */
function ask(subject: AuthSubject, reason: AuthReason, action: AuthAction): Authorization {
  if (!OWNER_RULE_SURFACES.has(subject.surface)) return done('ask', reason)
  const r = action.ownerRuling
  if (!r) return done('ask', reason, { consultOwnerRules: true })
  // 规则表 / 初审 / 红线明确放或拒 ⇒ 照办;什么都没命中(by default)、规则说问、或认不出是谁拿的主意 ⇒ 还是问主人。
  // 一起做原来只认 by ∈ rule/review/floor 的放 / 拒;终端原来直接取 verdict —— permission-gate 只会给出
  // ask/default、allow/rule、allow/review、deny/rule、ask/floor、ask/rule,这六种上两边一位不差(parity 测试逐格钉)。
  if ((r.verdict === 'allow' || r.verdict === 'deny') && (r.by === 'rule' || r.by === 'review' || r.by === 'floor')) return done(r.verdict, 'owner_rules', { by: r.by })
  return done('ask', reason)
}

export function authorize(subject: AuthSubject, descriptor: ToolDescriptor, action: AuthAction = {}): Authorization {
  // 8 的入口:执行者已经报上来要批准 ⇒ 起点就是问。
  if (descriptor.reported) return ask(subject, 'reported', action)

  // 5. 定时任务只读档:不走 decideTool —— 档里没写 allow 的一律拒、不弹卡(没人看着),relay 也是拒。
  if (subject.surface === 'job') {
    const tp = subject.tier
    if (!tp.allow.has(descriptor.kind)) return done('deny', 'job_profile')
    if (descriptor.kind === 'network' && action.tainted) return done('deny', 'job_tainted')
    if (descriptor.kind === 'fs_read' && action.readScope) {
      if (action.readScope.pathless) return done('deny', 'job_pathless')
      if (action.readScope.outside) return done('deny', 'job_outside')
      if (action.readScope.redLine) return done('deny', 'job_red_line', { detail: action.readScope.redLine })
    }
    return done('allow', 'job_allowed')
  }

  // 1. 旁路(只看自己跑闸门的执行者;Claude 的旁路在 SDK 静态设置里)。
  const relayAs = gateRelay(subject)
  if (relayAs === 'bypass') return done('allow', 'bypass')

  // 2. 扇出里的 reply。
  if (subject.fanOut && descriptor.replyFamily) return done('deny', 'fanout_reply')

  // 3. 名字。
  if (descriptor.malformed) return done('deny', 'malformed_name')

  // 4. 一起做的登记表:MCP 工具不看档位,只看登记;登记且放进来的逐条问。
  if (descriptor.mcp === 'unregistered') return done('deny', 'unregistered')
  if (descriptor.mcp === 'not_admitted') return done('deny', 'not_admitted')
  if (descriptor.mcp === 'admitted') return ask(subject, 'admitted', action)

  // 6. 档位 × 类别。
  const v = decideTool(subject.tier, descriptor.kind, matrixAskUser(descriptor))
  if (v === 'allow') return done('allow', 'tier')
  if (v === 'deny') return done('deny', 'tier')
  // 7. 问不了。
  if (relayAs === 'deny') return done('deny', 'relay_unavailable')
  return ask(subject, 'tier', action)
}

function matrixAskUser(d: ToolDescriptor): 'per-tool' | 'never' {
  return typeof d.askUser === 'function' ? d.askUser() : d.askUser ?? 'never'
}

/** 编译好的策略里,这家闸门的旁路与「问」怎么落:bypass ⇒ 不判;deny ⇒ 问落成拒;ask ⇒ 真问。 */
function gateRelay(subject: AuthSubject): 'bypass' | 'deny' | 'ask' {
  if (subject.executor === 'openai') {
    const p = compilePolicy('openai', subject.tier, subject.permissionMode)
    return p.bypass ? 'bypass' : p.relayAs
  }
  if (subject.executor === 'gemini') return compilePolicy('gemini', subject.tier, subject.permissionMode).gateEnabled ? 'ask' : 'bypass'
  // claude:canUseTool 只在 SDK 没被旁路时才会被调(bypassPermissions 是 compilePolicy('claude') 给的静态设置),
  // 闸门里从来不看权限模式 —— 这里也不看。
  return 'ask'
}
