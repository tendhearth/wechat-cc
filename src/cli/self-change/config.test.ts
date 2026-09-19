import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import { removeTempDir } from '../../lib/test-temp'
import { defaultWorkdir } from './policy'
import { resolveSelfChangeConfig, writeSelfChangeConfigPatch } from './config'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'self-change-config-'))
  dirs.push(d)
  return d
}
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d) })

describe('resolveSelfChangeConfig', () => {
  const base = { homeDir: '/Users/a', platform: 'darwin' as NodeJS.Platform }

  it('既没有 repo_url 也没有 origin ⇒ repo_url_unknown', () => {
    const r = resolveSelfChangeConfig({ ...base, agent: undefined, originUrl: null })
    expect(r).toEqual({ ok: false, error: 'repo_url_unknown' })
  })

  it('空串的 origin 也算不知道', () => {
    const r = resolveSelfChangeConfig({ ...base, agent: {}, originUrl: '  ' })
    expect(r.ok).toBe(false)
  })

  it('没配就用 origin,缺省值填齐', () => {
    const r = resolveSelfChangeConfig({ ...base, agent: undefined, originUrl: 'git@github.com:x/y.git' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config).toEqual({
      repoUrl: 'git@github.com:x/y.git',
      branch: 'dev',
      workdir: defaultWorkdir('/Users/a', 'darwin'),
      implementBudgetUsd: 20,
      reviewBudgetUsd: 5,
      maxTurns: 300,
      maxPerDay: 5,
      approvalTimeoutMs: 24 * 3_600_000,
      selftestExecutor: 'claude',
      selftestProvider: 'claude',
      haltedAt: null,
      haltReason: null,
      failStreak: 0,
    })
  })

  it('配了的字段盖过缺省,approval_timeout_h 换算成毫秒', () => {
    const r = resolveSelfChangeConfig({
      ...base,
      agent: {
        repo_url: 'https://example.com/r.git', branch: 'main', workdir: '/w',
        implement_budget_usd: 3.5, review_budget_usd: 1.25, max_turns: 10, max_per_day: 2,
        approval_timeout_h: 2, selftest_executor: 'cursor', selftest_provider: 'openai',
        halted_at: 1_700_000_000_000, halt_reason: '连红两次', fail_streak: 2,
      },
      originUrl: 'git@github.com:other/repo.git',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.repoUrl).toBe('https://example.com/r.git')
    expect(r.config.branch).toBe('main')
    expect(r.config.workdir).toBe('/w')
    expect(r.config.implementBudgetUsd).toBe(3.5)
    expect(r.config.reviewBudgetUsd).toBe(1.25)
    expect(r.config.approvalTimeoutMs).toBe(2 * 3_600_000)
    expect(r.config.selftestExecutor).toBe('cursor')
    expect(r.config.haltedAt).toBe(1_700_000_000_000)
    expect(r.config.haltReason).toBe('连红两次')
    expect(r.config.failStreak).toBe(2)
  })

  it('--budget-usd 覆盖压过配置', () => {
    const r = resolveSelfChangeConfig({
      ...base, agent: { implement_budget_usd: 20 }, originUrl: 'o', overrides: { implementBudgetUsd: 2 },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.implementBudgetUsd).toBe(2)
  })

  it('非 darwin 的缺省 workdir 跟着平台走', () => {
    const r = resolveSelfChangeConfig({ agent: undefined, homeDir: '/home/a', platform: 'linux', originUrl: 'o' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.workdir).toBe(defaultWorkdir('/home/a', 'linux'))
  })
})

describe('writeSelfChangeConfigPatch', () => {
  it('读-合-存:不碰别的字段,也不碰 self_change 里没提到的键', () => {
    const dir = tempDir()
    saveAgentConfig(dir, {
      provider: 'codex', model: 'gpt', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false,
      self_change: { repo_url: 'r', fail_streak: 1 },
    })
    writeSelfChangeConfigPatch(dir, { fail_streak: 2, halted_at: 123 })
    const cfg = loadAgentConfig(dir)
    expect(cfg.provider).toBe('codex')
    expect(cfg.model).toBe('gpt')
    expect(cfg.self_change).toEqual({ repo_url: 'r', fail_streak: 2, halted_at: 123 })
  })

  it('原来没有 self_change 也能写(第一次停机)', () => {
    const dir = tempDir()
    saveAgentConfig(dir, { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false })
    writeSelfChangeConfigPatch(dir, { halted_at: 9, halt_reason: 'x' })
    expect(loadAgentConfig(dir).self_change).toEqual({ halted_at: 9, halt_reason: 'x' })
  })

  it('--unhalt:把 halted_at / halt_reason 置 undefined 就等于删掉', () => {
    const dir = tempDir()
    saveAgentConfig(dir, {
      provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false,
      self_change: { halted_at: 9, halt_reason: 'x', fail_streak: 2 },
    })
    writeSelfChangeConfigPatch(dir, { halted_at: undefined, halt_reason: undefined, fail_streak: 0 })
    const onDisk = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf8')) as Record<string, unknown>
    expect(onDisk.self_change).toEqual({ fail_streak: 0 })
    expect(loadAgentConfig(dir).self_change).toEqual({ fail_streak: 0 })
  })

  it('配置文件本来就不存在也不炸(装完还没配过)', () => {
    const dir = tempDir()
    writeSelfChangeConfigPatch(dir, { fail_streak: 1 })
    expect(loadAgentConfig(dir).self_change).toEqual({ fail_streak: 1 })
  })

  it('磁盘上是坏 JSON:不静默吃掉别人的配置,新块照写', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'agent-config.json'), '{ not json')
    writeSelfChangeConfigPatch(dir, { fail_streak: 1 })
    expect(loadAgentConfig(dir).self_change).toEqual({ fail_streak: 1 })
  })
})
