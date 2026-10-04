/**
 * `wechat-cc cli status` 的逻辑:本机四个外部 agent CLI 装在哪、什么版本、能不能自动退回,
 * 加上 daemon 记下的自动升级状态(`cli-upgrade.json`,只读)。`--check` 再去查一次最新版本 ——
 * 只读探测,不装、不写状态、不碰 daemon。
 */
import { CLI_IDS, CLI_SPECS, type CliId } from '../core/cli-upgrade/specs'
import { installedVersion, latestVersion, type CommandRunner, type LatestResult } from '../core/cli-upgrade/detect'
import { detectLayout, type Layout } from '../core/cli-upgrade/layout'
import { isNewer } from '../core/cli-upgrade/version'
import { resolveCliUpgradeConfig, type ResolvedCliUpgradeConfig } from '../core/cli-upgrade/config'
import type { CliUpgradeState } from '../core/cli-upgrade/state'

export interface AgentCliRow {
  id: CliId
  label: string
  path: string | null
  installed: string | null
  latest: string | null
  latest_source: string | null
  latest_error: string | null
  update_available: boolean
  auto: boolean
  /** 官方升级器命令。 */
  updater: string
  /** 自动退回的方式:repoint(改链接指回本机留着的旧版本)/ install(官方装指定版本)/ none。 */
  rollback: 'repoint' | 'install' | 'none'
  layout: Layout['kind']
  verify: string
  known_bad: string[]
  last_check_at: string | null
  last_upgrade: CliUpgradeState[CliId]['lastUpgrade']
}

export interface AgentCliStatus {
  enabled: boolean
  check_hour: number
  checked_live: boolean
  clis: AgentCliRow[]
}

export interface AgentCliStatusDeps {
  locate: (id: CliId) => string | null
  run: CommandRunner
  latest: (id: CliId) => Promise<LatestResult>
  state: () => CliUpgradeState
  config: () => ResolvedCliUpgradeConfig
}

function rollbackKind(id: CliId, layout: Layout): AgentCliRow['rollback'] {
  if (layout.kind === 'claude-versions' || layout.kind === 'codex-standalone' || layout.kind === 'cursor-versions') return 'repoint'
  if (layout.kind === 'bundled') return 'none'
  return CLI_SPECS[id].installVersionArgs ? 'install' : 'none'
}

export async function collectAgentCliStatus(deps: AgentCliStatusDeps, opts: { check: boolean }): Promise<AgentCliStatus> {
  const cfg = deps.config()
  const st = deps.state()
  const clis = await Promise.all(CLI_IDS.map(async (id): Promise<AgentCliRow> => {
    const spec = CLI_SPECS[id]
    const s = st[id]
    const path = deps.locate(id)
    const installed = path ? await installedVersion(spec, path, deps.run) : null
    const layout: Layout = path ? detectLayout(spec, path) : { kind: 'other', realPath: null }
    let latest = s.latest
    let latestSource = s.latestSource ?? null
    let latestError = s.lastCheckError
    if (opts.check && path) {
      const r = await deps.latest(id)
      latest = r.version; latestSource = r.source; latestError = r.error ?? null
    }
    return {
      id, label: spec.label, path, installed, latest,
      latest_source: latestSource, latest_error: latestError,
      update_available: !!(installed && latest && isNewer(spec, latest, installed) && !s.knownBad.includes(latest)),
      auto: cfg.enabled && cfg.cli[id],
      updater: `${spec.bin} ${spec.updateArgs.join(' ')}`,
      rollback: path ? rollbackKind(id, layout) : 'none',
      layout: layout.kind,
      verify: s.verify,
      known_bad: s.knownBad,
      last_check_at: s.lastCheckAt,
      last_upgrade: s.lastUpgrade,
    }
  }))
  return { enabled: cfg.enabled, check_hour: cfg.checkHour, checked_live: opts.check, clis }
}

export function formatAgentCliStatus(s: AgentCliStatus): string {
  const lines = [`自动升级:${s.enabled ? '开' : '关'}(每天本地 ${s.check_hour} 点之后查一次)${s.checked_live ? ' · 最新版本是刚查的' : ' · 最新版本来自 daemon 上次检查(--check 现查)'}`]
  for (const c of s.clis) {
    if (!c.path) { lines.push(`  ${c.label.padEnd(12)} 没装`); continue }
    const latest = c.latest ? c.latest : c.latest_error ? `?(${c.latest_error})` : c.id === 'agy' ? '?(没有只读来源,升级器自己判)' : '?'
    const mark = c.update_available ? '  ← 有新版本' : ''
    lines.push(`  ${c.label.padEnd(12)} 装的 ${c.installed ?? '打不出版本'} · 最新 ${latest}${mark}`)
    lines.push(`  ${''.padEnd(12)} 升级器 \`${c.updater}\` · 退回 ${c.rollback === 'repoint' ? '本机留着旧版本,可自动退回' : c.rollback === 'install' ? '官方装指定版本' : '不能自动退回'} · 自检 ${c.verify}${c.auto ? '' : ' · 自动升级已关'}`)
    if (c.known_bad.length) lines.push(`  ${''.padEnd(12)} 有问题的版本:${c.known_bad.join(', ')}`)
    if (c.last_upgrade) lines.push(`  ${''.padEnd(12)} 上次:${c.last_upgrade.from ?? '?'} → ${c.last_upgrade.to ?? '?'} ${c.last_upgrade.result}(${c.last_upgrade.source},${c.last_upgrade.at})`)
  }
  return lines.join('\n')
}

export function defaultAgentCliStatusDeps(stateDir: string): Promise<AgentCliStatusDeps> {
  return (async () => {
    const { defaultLocate } = await import('../core/cli-upgrade/locate')
    const { defaultRunner } = await import('../core/cli-upgrade/detect')
    const { makeFileStateStore } = await import('../core/cli-upgrade/state')
    const { loadAgentConfig } = await import('../lib/agent-config')
    const { homedir } = await import('node:os')
    const cfg = loadAgentConfig(stateDir)
    const store = makeFileStateStore(stateDir)
    return {
      locate: (id) => defaultLocate(id, { ...(cfg.cursorAgentBin ? { cursorAgentBin: cfg.cursorAgentBin } : {}), ...(cfg.agyBin ? { agyBin: cfg.agyBin } : {}) }),
      run: defaultRunner,
      latest: (id) => latestVersion(CLI_SPECS[id], { fetch, homeDir: homedir() }),
      state: () => store.load(),
      config: () => resolveCliUpgradeConfig(cfg.cli_auto_upgrade),
    }
  })()
}
