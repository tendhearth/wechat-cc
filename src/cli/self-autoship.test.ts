import { describe, expect, it, vi } from 'vitest'
import { AutoshipPreparationError, decideAutoship, runAutoshipCommand, type AutoshipState, type AutoshipRound, type AutoshipRepo } from './self-autoship'
import { SHIP_EXIT, type ShipResult } from './self-ship'
import { autoshipWindowStatus, type AutoshipConfig } from '../lib/autoship-config'
import { DeploymentLedgerError } from './deployment-failures'

const previous = '1'.repeat(40)
const dev = '2'.repeat(40)
const next = '3'.repeat(40)
const inWindow = new Date(2026, 10, 27, 2).getTime()
const version = '1.8.12 (111111111)'
const initial = { enabled: true, locked: true, halted: false, installed: previous, ancestor: true, dev,
  files: ['a.ts'], ci: 'green', redNotified: false, failed: false } as const

describe('decideAutoship', () => {
  const cases: Array<[string, Partial<Parameters<typeof decideAutoship>[0]>, string]> = [
    ['disabled wins', { enabled: false, locked: false, halted: true }, 'disabled'],
    ['lock wins over halt', { locked: false, halted: true }, 'locked'],
    ['halt before repo work', { halted: true, dev: null }, 'halted'],
    ['needs dev SHA', { dev: null }, 'fetch'],
    ['same commit', { installed: dev }, 'current'],
    ['unreadable installed SHA', { installed: null }, 'off-dev'],
    ['installed commit off dev', { ancestor: false, files: ['a.md'] }, 'off-dev'],
    ['Markdown only', { files: ['a.md', 'b.md'], ci: 'red' }, 'markdown'],
    ['same tree', { files: [] }, 'markdown'],
    ['code renamed to Markdown', { files: ['old.ts', 'new.md'] }, 'ship'],
    ['failed diff counts as code', { files: null }, 'ship'],
    ['needs CI', { ci: null }, 'check-ci'],
    ['CI running', { ci: 'pending' }, 'ci-pending'],
    ['CI missing or query failed', { ci: 'unavailable' }, 'ci-unavailable'],
    ['new red SHA', { ci: 'red' }, 'ci-red-notice'],
    ['known red SHA', { ci: 'red', redNotified: true }, 'ci-red-known'],
    ['failed deployment', { failed: true }, 'failed-sha'],
    ['green and new', {}, 'ship'],
  ]
  it.each(cases)('%s', (_label, input, expected) => expect(decideAutoship({ ...initial, ...input })).toBe(expected))
})

function fixture() {
  let settings: AutoshipConfig = { auto_ship: true }
  let state: AutoshipState = { failedShas: [], redShas: [], fail_streak: 0, halted_at: null, halt_reason: null }
  let last: AutoshipRound | null = null
  let lastSkip: AutoshipRound | null = null
  const release = vi.fn()
  const repo = {
    fetchDev: vi.fn((): string | null => dev),
    failedTree: vi.fn(() => false),
    resolveInstalled: vi.fn(() => previous as string | null),
    isAncestor: vi.fn(() => true),
    changedFiles: vi.fn((): string[] | null => ['code.ts']),
    ci: vi.fn(async (): ReturnType<AutoshipRepo['ci']> => ({ status: 'green', url: null })),
    ship: vi.fn(async (): Promise<ShipResult> => ({ exitCode: SHIP_EXIT.shipped, message: '全绿' })),
  }
  const deps = {
    platform: 'darwin' as NodeJS.Platform,
    settings: () => settings,
    writeSettings: vi.fn((patch: Partial<AutoshipConfig>) => { settings = { ...settings, ...patch } }),
    repoUrl: vi.fn(() => 'git@example.test:cc' as string | null),
    lock: vi.fn((): ReturnType<Parameters<typeof runAutoshipCommand>[0]['lock']> => ({ ok: true, release })),
    installed: vi.fn(() => ({ version, sha: '111111111' })),
    repo: vi.fn(() => repo),
    targetMismatch: vi.fn(async (): Promise<string | null> => null),
    idleSeconds: vi.fn(async (): Promise<number | null> => 0),
    pendingTransaction: vi.fn((): string | null => null),
    clearTransaction: vi.fn(),
    repairLedger: vi.fn((): string | null => null),
    lastSkip: () => lastSkip,
    saveSkip: (value: AutoshipRound) => { lastSkip = value },
    loadState: () => state,
    saveState: (value: AutoshipState) => { state = value },
    lastRound: () => last,
    saveRound: (value: AutoshipRound) => { last = value },
    now: () => inWindow,
    notice: vi.fn(async () => true),
    log: vi.fn(),
  }
  return { deps, repo, release, run: (flags?: Parameters<typeof runAutoshipCommand>[1]) => runAutoshipCommand(deps, flags) }
}

describe('autoship CLI', () => {
  it('enable persists the repo for the deployed sidecar; disable is independent of the lock', async () => {
    const { deps, run } = fixture()
    expect((await run({ enable: true })).exitCode).toBe(0)
    expect(deps.writeSettings).toHaveBeenCalledWith({ auto_ship: true, repo_url: 'git@example.test:cc' })
    expect((await run({ disable: true })).exitCode).toBe(0)
    expect((await run()).exitCode).toBe(2)
    expect(deps.lock).not.toHaveBeenCalled()
    expect(deps.repo).not.toHaveBeenCalled()
    expect(deps.lastSkip()).toMatchObject({ sha: null, exitCode: 2, message: '自动部署未开启。' })
  })

  it('requires a repo on enable and rejects conflicting flags or an unsupported platform', async () => {
    const { deps, run } = fixture()
    deps.repoUrl.mockReturnValue(null)
    expect(await run({ enable: true })).toMatchObject({ exitCode: 3, message: expect.stringContaining('仓库地址') })
    expect((await run({ enable: true, disable: true })).exitCode).toBe(3)
    deps.platform = 'linux'
    expect((await run()).exitCode).toBe(3)
    expect(deps.writeSettings).not.toHaveBeenCalled()
  })

  it('shared lock busy records a skip and does not touch the hub', async () => {
    const { deps, run, release } = fixture()
    deps.lock.mockReturnValue({ ok: false, reason: '部署锁忙' })
    expect(await run()).toMatchObject({ exitCode: 2, message: expect.stringContaining('部署锁忙') })
    expect(deps.lastSkip()?.exitCode).toBe(2)
    expect(deps.repo).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it.each([
    [dev, true, ['code.ts'], 0],
    [previous, false, ['code.ts'], 2],
    [previous, true, ['note.md'], 0],
    [null, false, ['code.ts'], 2],
  ] as const)('checks installed and diff before querying CI', async (installed, ancestor, files, code) => {
    const { deps, repo, run, release } = fixture()
    repo.resolveInstalled.mockReturnValue(installed)
    repo.isAncestor.mockReturnValue(ancestor)
    repo.changedFiles.mockReturnValue([...files])
    expect((await run()).exitCode).toBe(code)
    expect(repo.ci).not.toHaveBeenCalled()
    expect(repo.ship).not.toHaveBeenCalled()
    expect(code === 2 ? deps.lastSkip() : deps.lastRound()).toMatchObject({ sha: dev, at: new Date(inWindow).toISOString(), exitCode: code })
    expect(release).toHaveBeenCalledOnce()
  })

  it('skips running, unavailable, and red CI; only tries one notice per red SHA', async () => {
    const { deps, repo, run } = fixture()
    repo.ci.mockResolvedValueOnce({ status: 'pending', url: null })
      .mockResolvedValueOnce({ status: 'unavailable', url: null })
      .mockResolvedValue({ status: 'red', url: 'https://example.test/ci' })
    for (let i = 0; i < 4; i++) expect((await run()).exitCode).toBe(2)
    expect(repo.ship).not.toHaveBeenCalled()
    expect(deps.notice).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(dev))
    expect(deps.loadState()).toMatchObject({ redShas: [dev], fail_streak: 0 })
  })

  it.each([SHIP_EXIT.busy, SHIP_EXIT.unguarded, SHIP_EXIT.tree_unfit])('quiet deferred ship %s never consumes a failure', async code => {
    const { deps, repo, run } = fixture()
    repo.ship.mockResolvedValue({ exitCode: code, message: '本轮跳过' })
    expect((await run()).exitCode).toBe(2)
    expect(deps.notice).not.toHaveBeenCalled()
    expect(deps.loadState().fail_streak).toBe(0)
  })

  it.each([[SHIP_EXIT.build_failed, '构建'], [SHIP_EXIT.deploy_failed, '部署'], [SHIP_EXIT.selftest_red, '自检']])(
    'reports %s once with target, stage, and installed version', async (code, stage) => {
      const { deps, repo, run } = fixture()
      repo.ship.mockResolvedValue({ exitCode: code, message: '故障详情' })
      expect((await run()).exitCode).toBe(1)
      expect((await run()).exitCode).toBe(2)
      expect(repo.ship).toHaveBeenCalledOnce()
      expect(deps.notice).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`${dev} 在${stage}阶段失败。当前 sidecar ${version}`))
    },
  )

  it('halts after two distinct failures; status shows halt, unhalt retains failed SHAs', async () => {
    const { deps, repo, run } = fixture()
    repo.ship.mockResolvedValue({ exitCode: SHIP_EXIT.selftest_red, message: '已回滚' })
    expect((await run()).exitCode).toBe(1)
    repo.fetchDev.mockReturnValue(next)
    expect((await run()).exitCode).toBe(1)
    expect((await run()).exitCode).toBe(2)
    expect(repo.fetchDev).toHaveBeenCalledTimes(2)
    const status = await run({ status: true })
    expect(status.exitCode).toBe(0)
    expect(status.message).toContain(next)
    expect(status.message).toContain('连续故障 2 次')
    expect(deps.notice).toHaveBeenCalledTimes(2)
    expect((await run({ unhalt: true })).exitCode).toBe(0)
    expect(deps.loadState()).toMatchObject({ failedShas: [dev, next], halted_at: null, fail_streak: 0 })
    expect((await run()).exitCode).toBe(2)
    expect(repo.ship).toHaveBeenCalledTimes(2)
  })

  it('success resets the streak; inherited self-change failure skips without notification', async () => {
    const { deps, repo, run } = fixture()
    repo.failedTree.mockReturnValueOnce(true)
    expect((await run()).exitCode).toBe(2)
    expect(repo.ship).not.toHaveBeenCalled()
    deps.saveState({ ...deps.loadState(), fail_streak: 1 })
    repo.changedFiles.mockReturnValue(null)
    expect((await run()).exitCode).toBe(0)
    expect(repo.ship).toHaveBeenCalledWith(dev, { sha: '111111111', version })
    expect(deps.loadState().fail_streak).toBe(0)
    expect(deps.notice).not.toHaveBeenCalled()
  })

  it('records transient fetch failure as a quiet skip and releases the lock', async () => {
    const { deps, repo, run, release } = fixture()
    repo.fetchDev.mockReturnValueOnce(null)
    expect(await run()).toEqual({ exitCode: 2, message: '暂时无法刷新远端 dev，本轮跳过。' })
    expect(deps.lastSkip()).toMatchObject({ sha: null, exitCode: 2 })
    expect(deps.notice).not.toHaveBeenCalled()
    expect(deps.loadState().fail_streak).toBe(0)
    expect(release).toHaveBeenCalledOnce()
  })

  it('checks for an interrupted transaction before even checking whether the installed commit is current', async () => {
    const { deps, repo, run } = fixture()
    deps.pendingTransaction.mockReturnValue('未完成事务，核对 .prev')
    repo.resolveInstalled.mockReturnValue(dev)
    expect((await run()).exitCode).toBe(1)
    expect((await run()).exitCode).toBe(2)
    expect(repo.fetchDev).not.toHaveBeenCalled()
    expect(deps.installed).not.toHaveBeenCalled()
    expect(deps.notice).toHaveBeenCalledExactlyOnceWith('未完成事务，核对 .prev')
    expect((await run({ status: true })).message).toContain('未完成事务，核对 .prev')
    expect((await run({ unhalt: true })).exitCode).toBe(0)
    expect(deps.clearTransaction).toHaveBeenCalledOnce()
  })

  it('persists instance mismatch and lock contention as skips without losing the last deployment result', async () => {
    const { deps, repo, run } = fixture()
    expect((await run()).exitCode).toBe(0)
    deps.targetMismatch.mockResolvedValueOnce('LaunchAgent 与 daemon 不匹配')
    expect((await run()).exitCode).toBe(2)
    expect((await run({ status: true })).message).toContain('LaunchAgent 与 daemon 不匹配')
    deps.lock.mockReturnValueOnce({ ok: false, reason: '部署锁忙' })
    expect((await run()).exitCode).toBe(2)
    expect(repo.fetchDev).toHaveBeenCalledOnce()
    expect(deps.lastRound()?.message).toBe('全绿')
    expect(deps.lastSkip()?.message).toContain('部署锁忙')
    expect(deps.notice).not.toHaveBeenCalled()
    expect(deps.loadState().fail_streak).toBe(0)
  })

  it('pauses persistent preparation failures until unhalt, and attempts one notice', async () => {
    const { deps, repo, run } = fixture()
    repo.ship.mockRejectedValueOnce(new AutoshipPreparationError('工作树有未提交改动'))
    expect((await run()).exitCode).toBe(1)
    expect((await run()).exitCode).toBe(2)
    expect(repo.ship).toHaveBeenCalledOnce()
    expect(deps.notice).toHaveBeenCalledOnce()
    expect(deps.loadState()).toMatchObject({ pause_reason: '工作树有未提交改动', fail_streak: 0 })
    expect((await run({ unhalt: true })).exitCode).toBe(0)
    expect((await run()).exitCode).toBe(0)
    expect(deps.loadState().pause_reason).toBeUndefined()
  })

  it('treats a post-build task refusal as a skip even though manual ship returns 1', async () => {
    const { deps, repo, run } = fixture()
    repo.ship.mockResolvedValueOnce({ exitCode: 1, blocked: 'tasks', message: '正在处理交办' })
    expect(await run()).toEqual({ exitCode: 2, message: '正在处理交办' })
    expect(deps.notice).not.toHaveBeenCalled()
    expect(deps.loadState().fail_streak).toBe(0)
  })

})

describe('automatic deployment window', () => {
  const time = (hours: number, minutes: number) => new Date(2026, 10, 27, hours, minutes).getTime()
  it('includes 01:00 and excludes 07:00 by default', () => {
    expect(autoshipWindowStatus({}, time(0, 59))).toContain('下次窗口')
    expect(autoshipWindowStatus({}, time(1, 0))).toBeNull()
    expect(autoshipWindowStatus({}, time(6, 59))).toBeNull()
    expect(autoshipWindowStatus({}, time(7, 0))).toContain('下次窗口')
  })
  it('accepts both sides of midnight within a configured window', () => {
    const config = { auto_ship_window: { start: '22:30', end: '04:15' } }
    expect(autoshipWindowStatus(config, time(22, 29))).toContain('22:30–04:15')
    expect(autoshipWindowStatus(config, time(22, 30))).toBeNull()
    expect(autoshipWindowStatus(config, time(0, 0))).toBeNull()
    expect(autoshipWindowStatus(config, time(4, 15))).toContain('下次窗口')
  })
  it('outside the window, a machine nobody has touched for 30 minutes (configurable, at least 5) is allowed; unknown idle counts as someone there', () => {
    expect(autoshipWindowStatus({}, time(12, 0), 30 * 60)).toBeNull()
    expect(autoshipWindowStatus({}, time(12, 0), 30 * 60 - 1)).toContain('没人用够 30 分钟')
    expect(autoshipWindowStatus({}, time(12, 0), null)).toContain('下次窗口')
    expect(autoshipWindowStatus({}, time(12, 0), Number.NaN)).toContain('下次窗口')
    expect(autoshipWindowStatus({ auto_ship_idle_min: 60 }, time(12, 0), 45 * 60)).toContain('没人用够 60 分钟')
    expect(autoshipWindowStatus({ auto_ship_idle_min: 1 }, time(12, 0), 4 * 60)).toContain('没人用够 5 分钟')
    expect(autoshipWindowStatus({ auto_ship_idle_min: 1 }, time(12, 0), 5 * 60)).toBeNull()
  })
  it('an idle machine outside the window goes on to the normal checks', async () => {
    const { deps, run } = fixture()
    deps.now = () => time(12, 0)
    deps.idleSeconds = vi.fn(async () => 3600)
    expect((await run()).message).not.toContain('下次窗口')
    expect(deps.targetMismatch).toHaveBeenCalled()
  })
  it('skips before any target or repo work outside the window and reports the next local window', async () => {
    const { deps, run } = fixture()
    deps.now = () => time(12, 0)
    expect(await run()).toMatchObject({ exitCode: 2, message: expect.stringContaining('下次窗口') })
    expect((await run({ status: true })).message).toContain('下次窗口')
    expect(deps.targetMismatch).not.toHaveBeenCalled()
    expect(deps.repo).not.toHaveBeenCalled()
  })
})

it('pauses on a ledger read error without counting a deployment or retrying before unhalt', async () => {
  const { deps, repo, run } = fixture()
  repo.failedTree.mockImplementationOnce(() => { throw new DeploymentLedgerError('坏 JSON') })
  expect(await run()).toMatchObject({ exitCode: 1, message: expect.stringContaining('坏 JSON') })
  expect(deps.loadState()).toMatchObject({ fail_streak: 0, pause_reason: expect.stringContaining('坏 JSON') })
  expect(await run()).toMatchObject({ exitCode: 2, message: expect.stringContaining('坏 JSON') })
  expect(repo.ship).not.toHaveBeenCalled()
  expect(deps.notice).toHaveBeenCalledOnce()
  deps.repairLedger.mockReturnValueOnce('/fixture/ledger.bad')
  expect(await run({ unhalt: true })).toMatchObject({ exitCode: 0, message: expect.stringContaining('/fixture/ledger.bad') })
  expect(deps.loadState().pause_reason).toBeUndefined()
})

it('keeps failure count, rollback conclusion and notification when the ledger write fails', async () => {
  const { deps, repo, run } = fixture()
  repo.ship.mockResolvedValueOnce({ exitCode: SHIP_EXIT.selftest_red, message: '自检红，已回滚。', ledgerError: '失败账磁盘只读' })
  expect(await run()).toMatchObject({ exitCode: 1, message: expect.stringContaining('自检红，已回滚。') })
  expect(deps.loadState()).toMatchObject({ failedShas: [dev], fail_streak: 1, pause_reason: '失败账磁盘只读' })
  expect(deps.notice).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/自检[\s\S]*已回滚[\s\S]*失败账磁盘只读/))
  expect(await run()).toMatchObject({ exitCode: 2, message: expect.stringContaining('失败账磁盘只读') })
  expect(repo.ship).toHaveBeenCalledOnce()
})

it('acknowledges a handled transaction independently if the ledger repair still fails', async () => {
  const { deps, run } = fixture()
  deps.pendingTransaction.mockReturnValue('待确认事务')
  deps.repairLedger.mockImplementationOnce(() => { throw new DeploymentLedgerError('无法备份') })
  expect(await run({ unhalt: true })).toMatchObject({
    exitCode: 1, message: expect.stringMatching(/已确认清除部署事务.*无法备份/),
  })
  expect(deps.clearTransaction).toHaveBeenCalledOnce()
  expect(deps.loadState().pause_reason).toContain('无法备份')
})
