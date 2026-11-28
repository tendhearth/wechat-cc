import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { autoshipStore, defaultAutoshipDeps, matchesLaunchAgent, parseInstalledVersion, parseLoadedLaunchAgent, refreshAutoshipDev } from './self-autoship-runtime'

import { makeGit, nodeGitSpawnSync } from './self-change/git'
import { loadAgentConfig, saveAgentConfig } from '../lib/agent-config'
import { deploymentTransactions, deploymentLockPath } from './deployment-transaction'
import { patchAutoshipConfig } from '../lib/autoship-config'
import { AutoshipPreparationError, runAutoshipCommand } from './self-autoship'

const sha = 'b'.repeat(40)

describe('autoship persistence', () => {
  it('persists single-line rounds and independent safety state at 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-autoship-'))
    try {
      const store = autoshipStore(dir)
      expect(store.lastRound()).toBeNull()
      expect(store.loadState()).toEqual({ failedShas: [], redShas: [], fail_streak: 0, halted_at: null, halt_reason: null })
      const halt = { failedShas: [sha], redShas: [sha], fail_streak: 2, halted_at: 3, halt_reason: '失败两次' }
      const round = { sha, at: '2026-11-27T00:00:00.000Z', exitCode: 1, message: '阶段失败\n已回滚' }
      store.saveState(halt)
      store.saveRound(round)
      store.saveSkip({ ...round, exitCode: 2, message: '持锁\n跳过' })
      const reopened = autoshipStore(dir)
      expect(reopened.loadState()).toEqual(halt)
      expect(reopened.lastRound()).toEqual(round)
      expect(reopened.lastSkip()).toEqual({ ...round, exitCode: 2, message: '持锁\n跳过' })
      for (const name of ['autoship.json', 'autoship-skip.json', 'autoship-state.json']) {
        const path = join(dir, 'self-change', name)
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
        expect(readFileSync(path, 'utf8').split('\n')).toHaveLength(2)
      }

      writeFileSync(join(dir, 'self-change', 'autoship-state.json'), '{bad')
      expect(() => reopened.loadState()).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('accepts a sidecar commit suffix and leaves unstamped versions unknown', () => {
    expect(parseInstalledVersion('1.8.12 (832d27d03)\n')).toEqual({ version: '1.8.12 (832d27d03)', sha: '832d27d03' })
    expect(parseInstalledVersion('1.8.12')).toEqual({ version: '1.8.12', sha: null })
  })
})

it('journal survives reopening and describes target, previous version, backup and start time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-autoship-journal-'))
  try {
    const transaction = { sha, previousVersion: '1.2.3 (1234567)', backupPath: '/app/cli.prev', startedAt: '2026-11-27T00:00:00.000Z' }
    const lock = deploymentLockPath(dir)
    const path = join(dir, 'self-change', 'autoship-transaction.json')
    mkdirSync(join(dir, 'self-change'))
    writeFileSync(path, JSON.stringify(transaction))
    const reopened = deploymentTransactions(lock, dir)
    for (const value of Object.values(transaction)) expect(reopened.pending()?.message).toContain(value)
    writeFileSync(path, '{bad')
    expect(reopened.pending()?.message).toContain('无法读取')
    reopened.confirm()
    expect(reopened.pending()).toBeNull()
    reopened.begin(transaction)
    const journalPath = lock + '.transaction.json'
    if (process.platform !== 'win32') expect(statSync(journalPath).mode & 0o777).toBe(0o600)
    expect(deploymentTransactions(lock, join(dir, 'alternate-state')).pending()?.transaction).toEqual(transaction)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('requires the initiating daemon to be the compiled sidecar of the loaded LaunchAgent', () => {
  const daemon = { pid: 73, parentPid: 31, bootAt: 'current-boot', compiled: true, execPath: '/app/cli', stateDir: '/state', idle: true, guarded: true }
  const expected = { pid: 73, bootAt: 'current-boot', stateDir: '/state', sidecar: '/app/cli', program: '/app/main', plistPath: '/launch/cc.plist', supervisedByApp: true }
  const job = { pid: 31, program: '/app/main', path: '/launch/cc.plist' }
  const match = (a: string, b: string) => a === b
  expect(matchesLaunchAgent(daemon, expected, job, match)).toBe(true)
  for (const mutation of [{ pid: 74 }, { parentPid: 32 }, { bootAt: 'previous-boot' }, { compiled: false }, { execPath: '/other/cli' }, { stateDir: '/other' }]) {
    expect(matchesLaunchAgent({ ...daemon, ...mutation }, expected, job, match)).toBe(false)
  }
  expect(matchesLaunchAgent(daemon, expected, { ...job, program: '/other/main' }, match)).toBe(false)
  expect(matchesLaunchAgent(daemon, expected, { ...job, path: '/other/cc.plist' }, match)).toBe(false)
  expect(matchesLaunchAgent(daemon, { ...expected, program: daemon.execPath, supervisedByApp: false }, { ...job, pid: daemon.pid, program: daemon.execPath }, match)).toBe(true)
})

it('refreshes the remote ref with a deadline and never trusts a stale ref on network failure', () => {
  const git = { run: vi.fn().mockReturnValueOnce({ code: 1, stderr: 'timeout', stdout: '' }) }
  expect(refreshAutoshipDev(git, 25_000)).toBeNull()
  expect(git.run).toHaveBeenCalledExactlyOnceWith(['fetch', 'origin', '+refs/heads/dev:refs/remotes/origin/dev'], { timeoutMs: 25_000 })
  const newer = 'c'.repeat(40)
  git.run.mockReturnValueOnce({ code: 0 }).mockReturnValueOnce({ code: 0, stdout: newer })
  expect(refreshAutoshipDev(git, 25_000)).toBe(newer)
})

it('reads only the loaded service attributes from launchctl output', () => {
  const output = [
    'gui/501/com.wechat-cc.daemon = {',
    '\tpath = /home/cc/Library/LaunchAgents/com.wechat-cc.daemon.plist',
    '\tprogram = /Applications/CC Example.app/Contents/MacOS/CC Example',
    '\tproperties = {',
    '\t\tpid = 9999',
    '\t}',
    '\tpid = 310',
    '}',
  ].join('\n')
  expect(parseLoadedLaunchAgent(output)).toEqual({
    pid: 310,
    path: '/home/cc/Library/LaunchAgents/com.wechat-cc.daemon.plist',
    program: '/Applications/CC Example.app/Contents/MacOS/CC Example',
  })
})

it('initializes an isolated hub, retries a missing remote quietly, and rejects a mismatched origin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-autoship-repo-'))
  try {
    const workdir = join(dir, 'work')
    const remote = join(dir, 'remote')
    const stateDir = join(dir, 'state')
    mkdirSync(stateDir)
    saveAgentConfig(stateDir, { ...loadAgentConfig(stateDir), self_change: { workdir, repo_url: remote } })
    const deps = defaultAutoshipDeps(stateDir, null)
    const repo = deps.repo(remote)
    expect(repo.fetchDev()).toBeNull()

    mkdirSync(remote)
    const git = makeGit(nodeGitSpawnSync, remote)
    function run(args: string[]) {
      const result = git.run(args)
      if (result.code !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    run(['init', '-q'])
    run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture dev'])
    run(['update-ref', 'refs/heads/dev', 'HEAD'])
    expect(repo.fetchDev()).toBe(run(['rev-parse', 'HEAD']))
    expect(() => deps.repo(join(dir, 'other')).fetchDev()).toThrow(AutoshipPreparationError)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it.each(['lock', 'lock.steal'])('leaves a dead self-change %s intact and reports the residue in status', async name => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-autoship-busy-'))
  try {
    patchAutoshipConfig(dir, { auto_ship: true })
    const path = join(dir, 'self-change', name)
    const body = JSON.stringify({ pid: 2_147_483_647, at: 1 })
    writeFileSync(path, body)
    const deps = defaultAutoshipDeps(dir, null, dir)
    const safeDeps = { ...deps, platform: 'darwin' as const,
      targetMismatch: vi.fn(() => { throw new Error('did not skip') }) }
    expect(await runAutoshipCommand(safeDeps)).toMatchObject({ exitCode: 2, message: expect.stringContaining('自改锁残留') })
    expect((await runAutoshipCommand(safeDeps, { status: true })).message).toContain('自改锁残留')
    expect(readFileSync(path, 'utf8')).toBe(body)
    expect(safeDeps.targetMismatch).not.toHaveBeenCalled()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
