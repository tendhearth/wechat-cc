/**
 * 放行规则(spec 2026-10-19-permission-rules-design):两处权限入口(终端会话 hook、一起做)在问主人之前
 * 先问这里。纯类型,不带逻辑。
 */
export type Surface = 'terminal' | 'workbench'
export type Tier = 'admin' | 'trusted' | 'guest'
export type Verdict = 'allow' | 'ask' | 'deny'

/** 一条要拍板的请求。缺的字段就缺着 —— 不猜(缺 command / paths ⇒ allow 规则与初审都放不了)。 */
export interface PermissionAsk {
  surface: Surface
  provider: string
  tool: string
  command?: string
  paths?: string[]
  cwd: string | null
  /** realpath 后的项目根;一起做 = 独立工作区根或任务路径;终端 = git toplevel;取不到 null。 */
  project: string | null
  /** 一起做开了独立工作区 ⇒ true(写文件算低风险的前提,10-19 定)。 */
  isolatedWorktree: boolean
  /** 这件事主人最初交代的那句话(一起做有;终端 v1 没有)。 */
  intent?: string
  /** 执行者给主人看的那段说明(Codex 的 diff、ACP 的标题……);只给初审看,规则不匹配它。 */
  description?: string
  tier: Tier
  /** 防一路放行的计数单位:任务 id / 终端 session_id。 */
  scope: string
}

export interface Decision {
  verdict: Verdict
  /** rule = 规则表;review = 便宜模型初审;floor = 固定红线;default = 什么都没命中(= 今天的老路)。 */
  by: 'rule' | 'review' | 'floor' | 'default'
  ruleId?: string
  reason: string
}

export interface RuleWhen {
  surface?: Surface
  provider?: string
  /** 路径前缀(按分隔符边界;`~` 展开)。 */
  project?: string
  /** 精确,或 `mcp:server:*`。 */
  tool?: string
  /** 正则(≤ 200 字)。 */
  command?: string
  /** glob:`**` 任意层、`*` 单层;请求里的每一条路径都要命中。 */
  paths?: string
}

export interface Rule { id: string; when: RuleWhen; then: Verdict; note?: string }

export interface RulesFile { version: 1; enabled: boolean; review: 'off' | 'low_risk'; rules: Rule[] }

/** 请求本身,或造它的函数 —— 规则关着时不造(终端要跑 git、一起做要 realpath 和翻时间线,关着就一样都不做)。 */
export type AskSource = PermissionAsk | (() => PermissionAsk | Promise<PermissionAsk>)
