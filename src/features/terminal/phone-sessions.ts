/**
 * 手机令牌(设备 / 链接)看终端会话登记处的那一份(P3c-2,设计稿 2026-11-05-p3-one-route-family「按范围不按路径的差别」)。
 *
 * 以前写在手机处理器里(features/phone/mobile-reads.ts 的 `/m/api/cli/sessions`);P3c-2 起 `GET /v1/cli/sessions` 是这份数据
 * 唯一的处理器,手机令牌从面板那一口进来也走它 —— 处理器看 caller,是手机令牌就回这里拼的行。规矩原样搬来:
 *   - 项目只给目录名(`project`),**不给**完整路径 `cwd`、也不给 `origin_agent`(哪台手报来的);
 *   - 最多 50 条;等批准的那一项带上中继开的码(`hash` / `actionable`),主人在场时没有码 ⇒ 手机只显示「在终端里等你」;
 *   - 在跑的前 8 条带此刻那一步(`now`)、开在电脑窗口里的 Claude 会话带 `live_window`、最近一句送进窗口的结果 `last_say`;
 *   - 行里带执行者正式名字(`displayName`)与这条会话的那件事(`matter_id`)。
 */
import type { CliSessionView } from '../../ports/cli-session'
import type { CliPhoneActions } from './phone-actions'

/** 手机上终端会话列表最多给这么多条。 */
export const PHONE_CLI_SESSIONS_MAX = 50
/** 列表里最多给这么多条在跑的会话读「此刻那一步」。 */
export const PHONE_CLI_NOW_MAX = 8

/**
 * 手机口径的一条终端会话:项目只给目录名,不给完整路径。其余字段同 GET /v1/cli/sessions(状态已折算 stale、等你批准的在前)。
 * 字段是一个一个挑的(不是 `...v`):登记处以后多了字段,手机不会跟着多看见。
 */
export function phoneCliSession(v: CliSessionView, pendingHash?: (sessionId: string) => string | null) {
  // 等批准的那一项带上码:只有中继真开了码(主人不在、问到了微信)才能在手机上拍;
  // 主人在场时留给终端自己问,没有码 ⇒ actionable:false,手机只显示「在终端里等你」。
  let hash: string | null = null
  if (v.pending && pendingHash) { try { hash = pendingHash(v.session_id) } catch { hash = null } }
  return {
    session_id: v.session_id, code: v.code, source: v.source, status: v.status, stale: v.stale,
    project: v.project, machine: v.machine, last_summary: v.last_summary,
    last_event_at: v.last_event_at, last_prompt_at: v.last_prompt_at, created_at: v.created_at,
    pending: v.pending ? { tool: v.pending.tool, summary: v.pending.summary, since: v.pending.since, hash, actionable: hash !== null } : null,
    ...(v.matter_id ? { matter_id: v.matter_id } : {}),
  }
}

export interface PhoneCliSessionsDeps {
  /** 登记处的行(带 matter_id 的那一份;wiring 里是 hub.list({ limit: 50 }) + 那件事)。 */
  list: () => CliSessionView[]
  /** 手机拍板 / 说一句 / 看着它跑那一组(features/terminal/phone-actions.ts);缺 ⇒ 不带码、不带此刻那一步。 */
  actions?: CliPhoneActions
  /** 执行者 id → 正式名字(收敛清单 ⑥);缺 ⇒ 行里不带 displayName,App 退回 id。 */
  executorName?: (id: string) => string
}

/** 手机那一份列表(抛 ⇒ 由路由回 503 unavailable)。 */
export function phoneCliSessionRows(deps: PhoneCliSessionsDeps): object[] {
  const actions = deps.actions
  const ph = actions ? (id: string) => actions.pendingHash(id) : undefined
  // 在跑的会话带上此刻那一步(列表一眼看到谁在做什么);最多前 PHONE_CLI_NOW_MAX 条,读不到就不带。
  let budget = PHONE_CLI_NOW_MAX
  // 开在电脑窗口里的 Claude 会话(2026-10-18):手机上在跑时也能接着说(话送进那个窗口)。
  const live = actions?.liveWindows?.() ?? new Set<string>()
  return deps.list().slice(0, PHONE_CLI_SESSIONS_MAX).map(v => {
    const plain = phoneCliSession(v, ph)
    const base = deps.executorName ? { ...plain, displayName: deps.executorName(v.source) } : plain
    const lw = v.source === 'claude' && live.has(v.session_id) ? { ...base, live_window: true } : base
    let said: ReturnType<NonNullable<CliPhoneActions['lastSay']>> = null
    try { said = actions?.lastSay?.(v.session_id) ?? null } catch { said = null }
    const row = said ? { ...lw, last_say: said } : lw
    if (v.status !== 'running' || v.stale || budget <= 0 || !actions?.currentStep) return row
    budget--
    let now: ReturnType<CliPhoneActions['currentStep']> = null
    try { now = actions.currentStep(v.session_id) } catch { now = null }
    return now ? { ...row, now } : row
  })
}
