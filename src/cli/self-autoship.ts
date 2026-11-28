import type { SelfChangeSettings } from '../lib/agent-config'
import { SHIP_EXIT, type ShipResult } from './self-ship'

export const AUTOSHIP_EXIT = { ok: 0, failed: 1, skipped: 2, blocked: 3 } as const
export const AUTOSHIP_EXIT_HELP = '退出码 0 已部署 / 无需部署 / 管理操作成功，1 本轮故障，2 跳过，3 用法或运行条件不满足'

export type CiStatus = 'green' | 'red' | 'pending' | 'unavailable'

interface DecisionInput {
  enabled: boolean
  locked: boolean
  halted: boolean
  dev: string | null
  installed: string | null
  ancestor: boolean
  files: readonly string[] | null
  ci: CiStatus | null
  redNotified: boolean
  failed: boolean
}

/** “读取 CI”是惰性的，前置判断通过后才去问 GitHub。 */
export function decideAutoship(input: DecisionInput) {
  if (!input.enabled) return 'disabled'
  if (!input.locked) return 'locked'
  if (input.halted) return 'halted'
  if (!input.dev) return 'fetch'
  if (input.dev === input.installed) return 'current'
  if (!input.installed || !input.ancestor) return 'off-dev'
  if (input.files?.every(file => file.endsWith('.md'))) return 'markdown'
  if (!input.ci) return 'check-ci'
  if (input.ci === 'pending') return 'ci-pending'
  if (input.ci === 'unavailable') return 'ci-unavailable'
  if (input.ci === 'red') return input.redNotified ? 'ci-red-known' : 'ci-red-notice'
  if (input.failed) return 'failed-sha'
  return 'ship'
}

export interface AutoshipState {
  failedShas: string[]
  redShas: string[]
  fail_streak: number
  halted_at: number | null
  halt_reason: string | null
}

export interface AutoshipRound {
  sha: string | null
  at: string
  exitCode: number
  message: string
}

export interface InstalledVersion { version: string; sha: string | null }
export interface AutoshipRepo {
  fetchDev(): string
  resolveInstalled(sha: string): string | null
  isAncestor(older: string, newer: string): boolean
  changedFiles(older: string, newer: string): string[] | null
  ci(sha: string): Promise<{ status: CiStatus; url: string | null }>
  ship(sha: string, installed: InstalledVersion): Promise<ShipResult>
}

interface AutoshipDeps {
  platform: NodeJS.Platform
  settings(): SelfChangeSettings | undefined
  writeSettings(patch: Partial<SelfChangeSettings>): void
  repoUrl(settings: SelfChangeSettings | undefined): string | null
  lock(): { ok: true; release(): void } | { ok: false; holder: number }
  repo(url: string, settings: SelfChangeSettings | undefined): AutoshipRepo
  installed(): InstalledVersion | null
  recentSelfChangeFailure(sha: string): boolean
  loadState(): AutoshipState
  saveState(state: AutoshipState): void
  lastRound(): AutoshipRound | null
  saveRound(round: AutoshipRound): void
  now(): number
  notice(text: string): Promise<boolean>
  log(text: string): void
}

type Result = Pick<AutoshipRound, 'exitCode' | 'message'>
const ok = (message: string): Result => ({ exitCode: AUTOSHIP_EXIT.ok, message })
const skip = (message: string): Result => ({ exitCode: AUTOSHIP_EXIT.skipped, message })
const fail = (message: string): Result => ({ exitCode: AUTOSHIP_EXIT.failed, message })
const blocked = (message: string): Result => ({ exitCode: AUTOSHIP_EXIT.blocked, message })

type Flags = Partial<Record<'enable' | 'disable' | 'status' | 'unhalt', boolean>>

async function notify(deps: AutoshipDeps, message: string) {
  // 去重先落盘。接口可能已经接收并排队，即使没拿到响应也不再投一次。
  if (!await deps.notice(message).catch(() => false)) deps.log('自动部署通知未确认送达，请查看 --status。')
}

const FAILURE_STAGE: Partial<Record<number, string>> = {
  [SHIP_EXIT.build_failed]: '构建',
  [SHIP_EXIT.deploy_failed]: '部署',
  [SHIP_EXIT.selftest_red]: '自检',
}

export async function runAutoshipCommand(deps: AutoshipDeps, flags: Flags = {}): Promise<Result> {
  let sha: string | null = null
  let release: (() => void) | undefined
  const management = Object.values(flags).some(Boolean)

  async function run(): Promise<Result> {
    if ([flags.enable, flags.disable, flags.status, flags.unhalt].filter(Boolean).length > 1) {
      return blocked('--enable / --disable / --status / --unhalt 每次只用一个。')
    }

    const settings = deps.settings()
    if (flags.status) {
      const state = deps.loadState()
      const last = deps.lastRound()
      return ok([
        `自动部署${settings?.auto_ship === true ? '已开启' : '未开启'}。`,
        `停机状态：${state.halted_at === null ? '未停机' : `${new Date(state.halted_at).toISOString()} · ${state.halt_reason}`}（连续故障 ${state.fail_streak} 次）。`,
        last ? `上次看到的 dev：${last.sha ?? '未知'}\n上轮：${last.at} · 退出 ${last.exitCode} · ${last.message}` : '还没有运行记录。',
      ].join('\n'))
    }
    if (flags.disable) {
      deps.writeSettings({ auto_ship: false })
      return ok('已关闭自动部署。')
    }
    if (deps.platform !== 'darwin') return blocked('自动部署只支持 macOS。')
    if (flags.enable) {
      const url = deps.repoUrl(settings)
      if (!url) return blocked('找不到仓库地址。请在源码工作区启用，或先配置 self_change.repo_url。')
      // 部署后的 daemon 从打包 sidecar 启动，届时身边没有源码可问 origin。
      deps.writeSettings({ auto_ship: true, repo_url: url })
      return ok('已开启自动部署。')
    }

    const decision: DecisionInput = {
      enabled: settings?.auto_ship === true,
      locked: false,
      halted: false,
      dev: null,
      installed: null,
      ancestor: false,
      files: null,
      ci: null,
      redNotified: false,
      failed: false,
    }
    if (!flags.unhalt && decideAutoship(decision) === 'disabled') return skip('自动部署未开启。')

    const lock = deps.lock()
    decision.locked = lock.ok
    if (!lock.ok) return skip(`自改或自动部署正在持锁（PID ${lock.holder}），本轮跳过。`)
    release = lock.release
    const state = deps.loadState()
    if (flags.unhalt) {
      deps.saveState({ ...state, halted_at: null, halt_reason: null, fail_streak: 0 })
      return ok('已解除自动部署停机。失败提交仍保留记录。')
    }
    decision.halted = state.halted_at !== null
    if (decideAutoship(decision) === 'halted') return skip(`自动部署已停机。运行 self autoship --unhalt 解除。`)

    const url = deps.repoUrl(settings)
    if (!url) return blocked('找不到仓库地址，请配置 self_change.repo_url。')
    const repo = deps.repo(url, settings)
    decision.dev = sha = repo.fetchDev()
    const installed = deps.installed()
    if (!installed?.sha) return skip('无法确认当前 sidecar 的提交，本轮跳过。')
    const installedSha = repo.resolveInstalled(installed.sha)
    decision.installed = installedSha
    if (decideAutoship(decision) === 'current') return ok('当前 sidecar 已经是 dev 顶端。')
    decision.ancestor = installedSha !== null && repo.isAncestor(installedSha, sha)
    if (!installedSha || decideAutoship(decision) === 'off-dev') return skip(`已安装的 ${installed.version} 无法确认为 dev 的祖先，本轮跳过。`)

    decision.files = repo.changedFiles(installedSha, sha)
    if (decideAutoship(decision) === 'markdown') return ok('相对已安装版本只有 Markdown 改动或没有文件差异，跳过部署。')
    const ci = await repo.ci(sha)
    decision.ci = ci.status
    decision.redNotified = state.redShas.includes(sha)
    decision.failed = state.failedShas.includes(sha) || (ci.status === 'green' && deps.recentSelfChangeFailure(sha))

    switch (decideAutoship(decision)) {
      case 'ci-pending': return skip('dev 的 CI 仍在运行。')
      case 'ci-unavailable': return skip('暂时拿不到 dev 的 CI 结果。')
      case 'ci-red-known': return skip('dev 的 CI 仍红，已记录过这条提交。')
      case 'ci-red-notice': {
        deps.saveState({ ...state, redShas: [...state.redShas, sha] })
        await notify(deps, `自动部署跳过 ${sha}，dev 的 CI 没有通过。${ci.url ? `\n${ci.url}` : ''}`)
        return skip('dev 的 CI 红，已记录并尝试通知主人。')
      }
      case 'failed-sha': return skip('此提交部署失败过，等 dev 前进。')
    }

    const result = await repo.ship(sha, installed)
    if (result.exitCode === SHIP_EXIT.shipped) {
      if (state.fail_streak) deps.saveState({ ...state, fail_streak: 0 })
      return ok(result.message)
    }
    const stage = FAILURE_STAGE[result.exitCode]
    if (!stage) return skip(result.message)

    const fail_streak = state.fail_streak + 1
    const halt = fail_streak >= 2
    deps.saveState({
      ...state,
      failedShas: [...state.failedShas, sha],
      fail_streak,
      halted_at: halt ? deps.now() : null,
      halt_reason: halt ? `${sha} ${stage}失败，连续两次` : null,
    })
    const current = deps.installed()?.version
    const version = current ? `当前 sidecar ${current}。` : '当前 sidecar 版本无法确认。'
    await notify(deps, `自动部署 ${sha} 在${stage}阶段失败。${version}${halt ? '连续两次失败，自动部署已停机。' : ''}\n${result.message.slice(0, 1000)}`)
    return fail(`${result.message}\n${version}`)
  }

  let result: Result
  try {
    try { result = await run() }
    catch (err) { result = fail(err instanceof Error ? err.message : String(err)) }
    if (!management) {
      const observed = sha ?? deps.lastRound()?.sha ?? null
      deps.saveRound({ sha: observed, at: new Date(deps.now()).toISOString(), ...result })
      deps.log(`dev=${observed ?? 'unknown'} exit=${result.exitCode} ${result.message.split('\n')[0]}`)
    }
    return result
  } catch (err) {
    return fail(`无法写入自动部署状态：${err instanceof Error ? err.message : err}`)
  } finally {
    release?.()
  }
}
