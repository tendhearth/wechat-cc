import { describe, it, expect, vi } from 'vitest'
import { collectAgentCliStatus, formatAgentCliStatus } from './agent-cli-status'
import { makeMemoryStateStore } from '../core/cli-upgrade/state'
import { resolveCliUpgradeConfig } from '../core/cli-upgrade/config'
import type { CommandRunner } from '../core/cli-upgrade/detect'

const versions: Record<string, string> = {
  '/fake/claude': '2.1.289 (Claude Code)', '/fake/codex': 'codex-cli 0.153.4', '/fake/cursor-agent': '2026.09.02-c22c1a3',
}
const run: CommandRunner = async (cmd) => versions[cmd] ? { code: 0, stdout: versions[cmd]!, stderr: '' } : { code: 1, stdout: '', stderr: 'nope' }

describe('wechat-cc cli status (read-only detection; injected runner/fetch, never the real CLIs)', () => {
  it('installed vs latest, updater and rollback capability per CLI; --check fetches latest without writing state', async () => {
    const store = makeMemoryStateStore({ codex: { knownBad: ['0.160.0'], verify: 'ok' } })
    const latest = vi.fn(async (id: string) => ({ version: ({ claude: '2.1.290', codex: '0.160.0', cursor: '2026.10.01-e373342' } as Record<string, string>)[id] ?? null, source: 't' }))
    const s = await collectAgentCliStatus({
      locate: (id) => ({ claude: '/fake/claude', codex: '/fake/codex', cursor: '/fake/cursor-agent' } as Record<string, string>)[id] ?? null,
      run,
      latest,
      state: () => store.load(),
      config: () => resolveCliUpgradeConfig({ per_cli: { agy: { enabled: false } } }),
    }, { check: true })
    const by = Object.fromEntries(s.clis.map(c => [c.id, c]))
    expect(by.claude).toMatchObject({ installed: '2.1.289', latest: '2.1.290', update_available: true, updater: 'claude update', rollback: 'install' })
    // 0.160.0 是记过的坏版本 ⇒ 不算「有更新」
    expect(by.codex).toMatchObject({ installed: '0.153.4', latest: '0.160.0', update_available: false, known_bad: ['0.160.0'] })
    expect(by.cursor).toMatchObject({ update_available: true, rollback: 'none', updater: 'cursor-agent update' })
    expect(by.agy).toMatchObject({ path: null, installed: null, auto: false })
    expect(latest).toHaveBeenCalledTimes(3) // 没装的不查
    expect(store.snapshot().claude.latest).toBeNull() // --check 不写状态
    expect(formatAgentCliStatus(s)).toContain('有新版本')
  })
})
