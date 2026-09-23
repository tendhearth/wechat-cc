import { loadAgentConfig, saveAgentConfig, type AgentConfig, type SelfChangeSettings } from '../../lib/agent-config'
import { SELF_CHANGE_DEFAULTS, defaultWorkdir } from './policy'

/**
 * 流水线跑起来真正用的那份配置:配置文件 + 缺省值 + 命令行覆盖合成后的结果,
 * 字段名换成驼峰、时间换成毫秒,后面每个 step 只读这一份(不再各自去碰
 * agent-config)。
 */
export interface SelfChangeConfig {
  repoUrl: string
  branch: string
  workdir: string
  implementBudgetUsd: number
  reviewBudgetUsd: number
  maxTurns: number
  maxPerDay: number
  approvalTimeoutMs: number
  selftestExecutor: string
  selftestProvider: string
  haltedAt: number | null
  haltReason: string | null
  failStreak: number
}

/**
 * 拍板超时的上下界。**下界不是拍脑袋的**:daemon 那侧的
 * `POST /v1/permissions/ask` 把 timeout 卡在 [60s, 48h],超出就 400 ——
 * 而 400 在这条流水线里看起来是「daemon 不知道主人是谁」(owner_chat_unknown),
 * 和真因(`approval_timeout_h` 写了个 72)毫无关系。与其让主人去追一个假症状,
 * 不如在这里就掐到两边都认的范围里,并说一声。
 */
const APPROVAL_TIMEOUT_MIN_MS = 3_600_000
const APPROVAL_TIMEOUT_MAX_MS = 48 * 3_600_000

/** 掐过一次就别再刷屏了(一个进程里只跑一条自改)。 */
let clampWarned = false

export function clampApprovalTimeoutMs(hours: number): number {
  const wanted = hours * 3_600_000
  if (!Number.isFinite(wanted)) return SELF_CHANGE_DEFAULTS.approval_timeout_h * 3_600_000
  const clamped = Math.min(Math.max(wanted, APPROVAL_TIMEOUT_MIN_MS), APPROVAL_TIMEOUT_MAX_MS)
  if (clamped !== wanted && !clampWarned) {
    clampWarned = true
    console.error(`self change: approval_timeout_h=${hours} 超出 [1, 48] 小时(daemon 的拍板卡只认这个范围),按 ${clamped / 3_600_000} 小时算`)
  }
  return clamped
}

/**
 * 合成配置。唯一会失败的一件事是**不知道该克隆哪个仓库**:源码模式下
 * `git remote get-url origin` 能拿到(调用方传 originUrl),打包版拿不到,
 * 就只能要求主人在 agent-config 里写 `self_change.repo_url`。
 */
export function resolveSelfChangeConfig(input: {
  agent: AgentConfig['self_change'] | undefined
  homeDir: string
  platform: NodeJS.Platform
  originUrl: string | null
  overrides?: Partial<Pick<SelfChangeConfig, 'implementBudgetUsd'>>
}): { ok: true; config: SelfChangeConfig } | { ok: false; error: 'repo_url_unknown' } {
  const { agent, overrides } = input
  const repoUrl = (agent?.repo_url ?? input.originUrl ?? '').trim()
  if (!repoUrl) return { ok: false, error: 'repo_url_unknown' }

  const approvalTimeoutH = agent?.approval_timeout_h ?? SELF_CHANGE_DEFAULTS.approval_timeout_h
  return {
    ok: true,
    config: {
      repoUrl,
      branch: agent?.branch ?? SELF_CHANGE_DEFAULTS.branch,
      workdir: agent?.workdir ?? defaultWorkdir(input.homeDir, input.platform),
      implementBudgetUsd: overrides?.implementBudgetUsd ?? agent?.implement_budget_usd ?? SELF_CHANGE_DEFAULTS.implement_budget_usd,
      reviewBudgetUsd: agent?.review_budget_usd ?? SELF_CHANGE_DEFAULTS.review_budget_usd,
      maxTurns: agent?.max_turns ?? SELF_CHANGE_DEFAULTS.max_turns,
      maxPerDay: agent?.max_per_day ?? SELF_CHANGE_DEFAULTS.max_per_day,
      approvalTimeoutMs: clampApprovalTimeoutMs(approvalTimeoutH),
      selftestExecutor: agent?.selftest_executor ?? SELF_CHANGE_DEFAULTS.selftest_executor,
      selftestProvider: agent?.selftest_provider ?? SELF_CHANGE_DEFAULTS.selftest_provider,
      haltedAt: agent?.halted_at ?? null,
      haltReason: agent?.halt_reason ?? null,
      failStreak: agent?.fail_streak ?? 0,
    },
  }
}

/**
 * 往 agent-config 的 `self_change` 里打一个补丁(停机、清零 fail_streak、
 * `--unhalt`)。读 → 合 → 存,照 wire-workbench 的 makeUnattendedAckStore:
 * **整份配置读进来再写回去**,不能只写自己这块,不然会把主人刚改的 model 抹掉。
 *
 * 补丁里给 `undefined` 等于删掉那个键(JSON.stringify 不序列化 undefined)——
 * `--unhalt` 就靠这个把 halted_at 抹掉。
 */
export function writeSelfChangeConfigPatch(stateDir: string, patch: Partial<SelfChangeSettings>): void {
  const current = loadAgentConfig(stateDir)
  saveAgentConfig(stateDir, { ...current, self_change: { ...(current.self_change ?? {}), ...patch } })
}
