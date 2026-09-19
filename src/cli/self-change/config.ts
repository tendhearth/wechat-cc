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
      approvalTimeoutMs: approvalTimeoutH * 3_600_000,
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
