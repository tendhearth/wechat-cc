/**
 * CLI 自动升级在 daemon 里的接线(主人 2026-10-04,docs/maintainer/cli-auto-upgrade.md)。
 *
 * 一分钟一拍(unref 的 setInterval,不新增 launchd 任务);引擎自己判「今天查过没有 / 有没有报错触发 /
 * 有没有在等空闲的升级 / 有没有欠着的自检」。这里只提供 daemon 侧的真实现:
 *  - 空闲:没有在途回合、没有这家的活会话、busy 登记处里除了我们自己(和触发这次操作的那条内部 API 请求)
 *    之外没人 —— 工作台在跑的任务、A2A 委派、终端会话续接都在 busy 登记处里;
 *  - 自检:verify.ts(对话 + 工作台,过网络守护);
 *  - 通知:微信发给主人 + 桌面系统通知,两路各自尽力。
 */
import type { Lifecycle } from '../../lib/lifecycle'
import { loadAgentConfig } from '../../lib/agent-config'
import { CLI_SPECS } from '../../core/cli-upgrade/specs'
import { resolveCliUpgradeConfig } from '../../core/cli-upgrade/config'
import { defaultRunner, latestVersion, type CommandRunner } from '../../core/cli-upgrade/detect'
import { defaultLocate } from '../../core/cli-upgrade/locate'
import { makeCliUpgrader, type CliUpgrader, type IdleVerdict, type VerifyResult } from '../../core/cli-upgrade/engine'
import { makeFileStateStore } from '../../core/cli-upgrade/state'
import type { CliSpec } from '../../core/cli-upgrade/specs'
import { homedir } from 'node:os'

/** 不算「有工作在跑」的 busy label:我们自己,和正在请求我们升级 / 退回的那条内部 API。 */
export function ignoredBusyLabel(label: string): boolean {
  return label.startsWith('cli-upgrade:') || label === 'api:POST /v1/cli/upgrade' || label === 'api:POST /v1/cli/rollback'
}

export interface IdleDeps {
  anyInFlight: () => boolean
  liveSessionProviders: () => string[]
  busyLabels: () => string[]
}

export function makeIdleCheck(d: IdleDeps): (spec: CliSpec) => IdleVerdict {
  return (spec) => {
    try {
      if (d.anyInFlight()) return { idle: false, reason: '有回合在跑' }
      const live = d.liveSessionProviders().filter(p => p === spec.providerId).length
      if (live > 0) return { idle: false, reason: `${spec.providerId} 还有 ${live} 个活会话` }
      const busy = d.busyLabels().filter(l => !ignoredBusyLabel(l))
      if (busy.length > 0) return { idle: false, reason: `有工作在跑:${busy.slice(0, 3).join(', ')}` }
      return { idle: true }
    } catch (err) {
      // 判不出来 ⇒ 当忙(失败方向安全:宁可晚升,不打断)。
      return { idle: false, reason: `空闲判定出错:${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

export interface WireCliUpgradeDeps extends IdleDeps {
  stateDir: string
  holdBusy: (label: string) => () => void
  verify: (spec: CliSpec) => Promise<VerifyResult>
  notify: (text: string) => Promise<void>
  log: (tag: string, line: string) => void
  run?: CommandRunner
  fetch?: typeof globalThis.fetch
  intervalMs?: number
}

export function wireCliUpgrade(d: WireCliUpgradeDeps): { upgrader: CliUpgrader; lifecycle: Lifecycle } {
  const upgrader = makeCliUpgrader({
    specs: CLI_SPECS,
    config: () => resolveCliUpgradeConfig(loadAgentConfig(d.stateDir).cli_auto_upgrade),
    locate: (id) => {
      const cfg = loadAgentConfig(d.stateDir)
      return defaultLocate(id, { ...(cfg.cursorAgentBin ? { cursorAgentBin: cfg.cursorAgentBin } : {}), ...(cfg.agyBin ? { agyBin: cfg.agyBin } : {}) })
    },
    run: d.run ?? defaultRunner,
    latest: (spec) => latestVersion(spec, { fetch: d.fetch ?? fetch, homeDir: homedir() }),
    isIdle: makeIdleCheck(d),
    holdBusy: d.holdBusy,
    verify: d.verify,
    notify: d.notify,
    state: makeFileStateStore(d.stateDir),
    log: d.log,
  })
  const timer = setInterval(() => { void upgrader.tick() }, d.intervalMs ?? 60_000)
  timer.unref?.()
  let stopped = false
  return {
    upgrader,
    lifecycle: { name: 'cli-upgrade', stop: async () => { if (!stopped) { stopped = true; clearInterval(timer) } } },
  }
}
