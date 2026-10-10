/**
 * 引擎的端到端测试:临时目录里搭出和官方安装器同样布局的**假 CLI**(真的 exec 一个 sh 脚本),
 * 升级器 / 退回都在临时目录里改链接。永远不碰主人真装的 claude / codex / cursor-agent / agy。
 * 假 CLI 是 `#!/bin/sh`,win32 跳过。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir, writeWarmExecFixture } from '../../lib/test-temp'
import { CLI_SPECS, type CliId, type CliSpec } from './specs'
import { defaultRunner, installedVersion, type CommandRunner } from './detect'
import { makeCliUpgrader, type CliUpgraderDeps, type VerifyResult } from './engine'
import { makeMemoryStateStore } from './state'
import { resolveCliUpgradeConfig } from './config'
import { detectLayout, planRollback } from './layout'

const posix = process.platform !== 'win32'

interface Fake { bin: string; ctl: string; setNext(v: string | null): void; failUpdate(on: boolean): void; calls(): string[]; current(): Promise<string | null> }

function script(ctl: string, versionLine: string, switchCmd: string): string {
  return `#!/bin/sh
CTL='${ctl}'
case "$1" in
  --version) echo "${versionLine}"; exit 0;;
  update)
    echo update >> "$CTL/calls"
    if [ -f "$CTL/update_fail" ]; then echo "network down" >&2; exit 1; fi
    NEXT=$(cat "$CTL/next" 2>/dev/null)
    if [ -z "$NEXT" ]; then echo "already up to date"; exit 0; fi
    ${switchCmd}
    exit 0;;
  install)
    echo "install $2" >> "$CTL/calls"
    NEXT="$2"
    ${switchCmd}
    exit 0;;
esac
exit 2
`
}

function fakeControls(ctl: string, bin: string, spec: CliSpec): Fake {
  return {
    bin, ctl,
    setNext: (v) => writeFileSync(join(ctl, 'next'), v ?? ''),
    failUpdate: (on) => { if (on) writeFileSync(join(ctl, 'update_fail'), '1'); else try { unlinkSync(join(ctl, 'update_fail')) } catch { /* */ } },
    calls: () => existsSync(join(ctl, 'calls')) ? readFileSync(join(ctl, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : [],
    current: () => installedVersion(spec, bin, defaultRunner),
  }
}

/** Claude 原生安装:~/.local/bin/claude → ~/.local/share/claude/versions/<v>。 */
function fakeClaude(root: string, versions: string[], linked: string): Fake {
  const ctl = join(root, 'ctl'); mkdirSync(ctl, { recursive: true })
  const vers = join(root, 'home', '.local', 'share', 'claude', 'versions'); mkdirSync(vers, { recursive: true })
  const binDir = join(root, 'home', '.local', 'bin'); mkdirSync(binDir, { recursive: true })
  const link = join(binDir, 'claude')
  for (const v of versions) writeWarmExecFixture(join(vers, v), script(ctl, `${v} (Claude Code)`, `ln -sfn "${vers}/$NEXT" "${link}"`))
  symlinkSync(join(vers, linked), link)
  return fakeControls(ctl, link, CLI_SPECS.claude)
}

/** Codex standalone:current → releases/<v>-<triple>,~/.local/bin/codex → current/bin/codex。 */
function fakeCodex(root: string, versions: string[], linked: string): Fake {
  const ctl = join(root, 'ctl'); mkdirSync(ctl, { recursive: true })
  const sa = join(root, 'home', '.codex', 'packages', 'standalone')
  const rel = join(sa, 'releases')
  const cur = join(sa, 'current')
  for (const v of versions) {
    const d = join(rel, `${v}-aarch64-apple-darwin`, 'bin'); mkdirSync(d, { recursive: true })
    writeWarmExecFixture(join(d, 'codex'), script(ctl, `codex-cli ${v}`, `ln -sfn "${rel}/$NEXT-aarch64-apple-darwin" "${cur}"`))
  }
  symlinkSync(join(rel, `${linked}-aarch64-apple-darwin`), cur)
  const binDir = join(root, 'home', '.local', 'bin'); mkdirSync(binDir, { recursive: true })
  symlinkSync(join(cur, 'bin', 'codex'), join(binDir, 'codex'))
  return fakeControls(ctl, join(binDir, 'codex'), CLI_SPECS.codex)
}

/** cursor-agent:~/.local/bin/{cursor-agent,agent} → versions/<v>/cursor-agent。 */
function fakeCursor(root: string, versions: string[], linked: string): Fake {
  const ctl = join(root, 'ctl'); mkdirSync(ctl, { recursive: true })
  const vers = join(root, 'home', '.local', 'share', 'cursor-agent', 'versions')
  const binDir = join(root, 'home', '.local', 'bin'); mkdirSync(binDir, { recursive: true })
  const a = join(binDir, 'cursor-agent'), b = join(binDir, 'agent')
  for (const v of versions) {
    mkdirSync(join(vers, v), { recursive: true })
    writeWarmExecFixture(join(vers, v, 'cursor-agent'), script(ctl, v, `ln -sfn "${vers}/$NEXT/cursor-agent" "${a}"; ln -sfn "${vers}/$NEXT/cursor-agent" "${b}"`))
  }
  symlinkSync(join(vers, linked, 'cursor-agent'), a)
  symlinkSync(join(vers, linked, 'cursor-agent'), b)
  return fakeControls(ctl, a, CLI_SPECS.cursor)
}

/** agy:单个文件,升级器原地替换,不留旧版本。 */
function fakeAgy(root: string, versions: string[], linked: string): Fake {
  const ctl = join(root, 'ctl'); mkdirSync(ctl, { recursive: true })
  const binDir = join(root, 'home', '.local', 'bin'); mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'agy')
  for (const v of versions) writeWarmExecFixture(join(ctl, `agy-${v}`), script(ctl, v, `cp "${ctl}/agy-$NEXT" "${bin}"`))
  writeWarmExecFixture(bin, readFileSync(join(ctl, `agy-${linked}`), 'utf8'))
  return fakeControls(ctl, bin, CLI_SPECS.agy)
}

interface Harness {
  deps: CliUpgraderDeps
  store: ReturnType<typeof makeMemoryStateStore>
  notes: string[]
  holds: { label: string; released: boolean }[]
  runs: string[]
  setIdle(v: boolean): void
  setLatest(id: CliId, v: string | null, error?: string): void
  bad: Set<string>
  verifyMode: { mode: 'version' | 'deferred' }
  clock: { t: number; hour: number; day: string }
  latestCalls: CliId[]
}

function harness(fakes: Partial<Record<CliId, Fake>>): Harness {
  const store = makeMemoryStateStore()
  const notes: string[] = []
  const holds: { label: string; released: boolean }[] = []
  const runs: string[] = []
  const latest: Partial<Record<CliId, { v: string | null; error?: string }>> = {}
  const latestCalls: CliId[] = []
  const bad = new Set<string>()
  const verifyMode = { mode: 'version' as 'version' | 'deferred' }
  const clock = { t: Date.parse('2026-10-04T05:00:00Z'), hour: 5, day: '2026-10-04' }
  let idle = true
  const run: CommandRunner = async (cmd, args, opts) => { runs.push(`${cmd.split('/').pop()} ${args.join(' ')}`); return defaultRunner(cmd, args, opts) }
  const deps: CliUpgraderDeps = {
    config: () => resolveCliUpgradeConfig({}),
    locate: (id) => fakes[id]?.bin ?? null,
    run,
    latest: async (spec) => {
      latestCalls.push(spec.id)
      const l = latest[spec.id]
      return l ? { version: l.v, ...(l.error ? { error: l.error } : {}), source: 'test' } : { version: null, source: 'test', error: 'no fixture' }
    },
    isIdle: () => idle ? { idle: true } : { idle: false, reason: 'turn_in_flight' },
    holdBusy: (label) => { const h = { label, released: false }; holds.push(h); return () => { h.released = true } },
    verify: async (spec): Promise<VerifyResult> => {
      if (verifyMode.mode === 'deferred') return { status: 'deferred', detail: 'network_unprotected' }
      // 自检时 busy token 必须还拿着(空闲自动重启不能切进来)
      expect(holds.some(h => h.label === `cli-upgrade:${spec.id}` && !h.released)).toBe(true)
      const v = await fakes[spec.id]!.current()
      return v && bad.has(v) ? { status: 'fail', detail: `protocol_events 缺 result(${v})` } : { status: 'pass', detail: `replied ${v}` }
    },
    notify: (text) => { notes.push(text) },
    state: store,
    log: () => {},
    now: () => clock.t,
    localDay: () => clock.day,
    localHour: () => clock.hour,
  }
  return {
    deps, store, notes, holds, runs, bad, verifyMode, clock, latestCalls,
    setIdle: (v) => { idle = v },
    setLatest: (id, v, error) => { latest[id] = { v, ...(error ? { error } : {}) } },
  }
}

// 每条用例真 exec 好几次新写的假 CLI;满载套件里 macOS 首跑校验能到秒级(见 test-temp.ts),给足时间。
describe.skipIf(!posix)('cli-upgrade engine with fake CLIs', { timeout: 60_000 }, () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cli-upgrade-')) })
  afterEach(() => { removeTempDir(root) })

  it('layout detection + rollback plans match the official installers', () => {
    const c = fakeClaude(join(root, 'c'), ['1.0.0', '1.1.0'], '1.1.0')
    const lc = detectLayout(CLI_SPECS.claude, c.bin)
    expect(lc.kind).toBe('claude-versions')
    expect(planRollback(CLI_SPECS.claude, lc, '1.0.0').kind).toBe('repoint')
    // 本地没有那个版本 ⇒ 官方 `claude install <v>`
    expect(planRollback(CLI_SPECS.claude, lc, '0.9.0')).toEqual({ kind: 'install', args: ['install', '0.9.0'] })
    const x = fakeCodex(join(root, 'x'), ['0.150.0', '0.160.0'], '0.160.0')
    const lx = detectLayout(CLI_SPECS.codex, x.bin)
    expect(lx.kind).toBe('codex-standalone')
    expect(planRollback(CLI_SPECS.codex, lx, '0.150.0').kind).toBe('repoint')
    const u = fakeCursor(join(root, 'u'), ['2026.09.02-c22c1a3', '2026.10.01-e373342'], '2026.10.01-e373342')
    const lu = detectLayout(CLI_SPECS.cursor, u.bin)
    expect(lu.kind === 'cursor-versions' && lu.links.length).toBe(2)
    const a = fakeAgy(join(root, 'a'), ['1.2.16'], '1.2.16')
    expect(planRollback(CLI_SPECS.agy, detectLayout(CLI_SPECS.agy, a.bin), '1.2.15').kind).toBe('impossible')
  })

  it('check: newer latest ⇒ pending; idle tick upgrades via the official updater; selftest pass ⇒ one short notice', async () => {
    const c = fakeClaude(root, ['1.0.0', '1.1.0'], '1.0.0')
    const h = harness({ claude: c })
    h.setLatest('claude', '1.1.0')
    c.setNext('1.1.0')
    const up = makeCliUpgrader(h.deps)
    await up.tick()
    expect(await c.current()).toBe('1.1.0')
    const s = h.store.snapshot().claude
    expect(s.lastUpgrade).toMatchObject({ from: '1.0.0', to: '1.1.0', result: 'upgraded', source: 'scheduled' })
    expect(s.verify).toBe('ok')
    expect(s.accepted).toBe('1.1.0')
    expect(h.notes).toEqual(['Claude Code 已自动升级到 1.1.0，自检通过'])
    expect(h.holds.every(x => x.released)).toBe(true)
    expect(c.calls()).toEqual(['update'])
  })

  it('never upgrades while busy (idle gate); upgrades once idle', async () => {
    const c = fakeClaude(root, ['1.0.0', '1.1.0'], '1.0.0')
    const h = harness({ claude: c })
    h.setLatest('claude', '1.1.0'); c.setNext('1.1.0')
    h.setIdle(false)
    const up = makeCliUpgrader(h.deps)
    await up.tick()
    expect(c.calls()).toEqual([])
    expect(h.store.snapshot().claude.pending).toBe('scheduled')
    expect((await up.upgrade('claude')).result).toBe('not_idle')
    expect(c.calls()).toEqual([])
    h.setIdle(true)
    await up.tick()
    expect(await c.current()).toBe('1.1.0')
  })

  it('selftest fail ⇒ automatic rollback (repoint), re-selftest, known-bad, notify once; known-bad not retried until a newer one appears', async () => {
    const c = fakeClaude(root, ['1.0.0', '1.1.0', '1.2.0'], '1.0.0')
    const h = harness({ claude: c })
    h.setLatest('claude', '1.1.0'); c.setNext('1.1.0'); h.bad.add('1.1.0')
    const up = makeCliUpgrader(h.deps)
    const r = await up.upgrade('claude', { source: 'scheduled' })
    expect(r).toMatchObject({ result: 'rolled_back', from: '1.1.0', to: '1.0.0' })
    expect(await c.current()).toBe('1.0.0')
    expect(readlinkSync(c.bin)).toContain('1.0.0')
    const s = h.store.snapshot().claude
    expect(s.knownBad).toEqual(['1.1.0'])
    expect(s.verify).toBe('ok')
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0]).toContain('已自动退回 1.0.0，退回后自检通过')
    // 同一个坏版本:不再升
    h.clock.day = '2026-10-05'
    await up.tick()
    expect(c.calls()).toEqual(['update'])
    expect((await up.upgrade('claude', { source: 'scheduled' })).result).toBe('known_bad')
    // 出了更新的版本:照常升
    h.setLatest('claude', '1.2.0'); c.setNext('1.2.0'); h.clock.day = '2026-10-06'
    await up.tick()
    expect(await c.current()).toBe('1.2.0')
    expect(h.notes).toHaveLength(2)
  })

  it('codex standalone: rollback repoints `current`', async () => {
    const x = fakeCodex(root, ['0.153.4', '0.160.0'], '0.153.4')
    const h = harness({ codex: x })
    h.setLatest('codex', '0.160.0'); x.setNext('0.160.0'); h.bad.add('0.160.0')
    const up = makeCliUpgrader(h.deps)
    const r = await up.upgrade('codex', { source: 'scheduled' })
    expect(r.result).toBe('rolled_back')
    expect(await x.current()).toBe('0.153.4')
    expect(readlinkSync(join(root, 'home', '.codex', 'packages', 'standalone', 'current'))).toContain('0.153.4-aarch64-apple-darwin')
  })

  it('cursor: rollback repoints both cursor-agent and agent', async () => {
    const u = fakeCursor(root, ['2026.09.02-c22c1a3', '2026.10.01-e373342'], '2026.09.02-c22c1a3')
    const h = harness({ cursor: u })
    h.setLatest('cursor', '2026.10.01-e373342'); u.setNext('2026.10.01-e373342'); h.bad.add('2026.10.01-e373342')
    const r = await makeCliUpgrader(h.deps).upgrade('cursor', { source: 'reactive' })
    expect(r.result).toBe('rolled_back')
    expect(readlinkSync(join(root, 'home', '.local', 'bin', 'agent'))).toContain('2026.09.02-c22c1a3')
    expect(readlinkSync(u.bin)).toContain('2026.09.02-c22c1a3')
  })

  it('agy: no previous versions kept ⇒ rollback impossible ⇒ one notice with manual steps', async () => {
    const a = fakeAgy(root, ['1.2.16', '1.2.17'], '1.2.16')
    const h = harness({ agy: a })
    a.setNext('1.2.17'); h.bad.add('1.2.17')
    const up = makeCliUpgrader(h.deps)
    // agy 没有只读的最新来源:定时检查直接交给官方升级器
    await up.tick()
    expect(a.calls()).toEqual(['update'])
    const s = h.store.snapshot().agy
    expect(s.lastUpgrade?.result).toBe('rollback_failed')
    expect(s.knownBad).toEqual(['1.2.17'])
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0]).toContain('手动退回')
    // 之后的检查不再反复折腾这个坏版本
    h.clock.t += 3_600_000
    await up.tick()
    expect(h.notes).toHaveLength(1)
  })

  it('selftest deferred by the network guard ⇒ unverified, no rollback; retried later and then notified', async () => {
    const c = fakeClaude(root, ['1.0.0', '1.1.0'], '1.0.0')
    const h = harness({ claude: c })
    h.setLatest('claude', '1.1.0'); c.setNext('1.1.0')
    h.verifyMode.mode = 'deferred'
    const up = makeCliUpgrader(h.deps)
    const r = await up.upgrade('claude', { source: 'scheduled' })
    expect(r.result).toBe('unverified')
    expect(await c.current()).toBe('1.1.0')
    expect(h.store.snapshot().claude).toMatchObject({ verify: 'unverified', rollbackTo: '1.0.0' })
    expect(h.notes).toEqual([])
    // 不到 30 分钟不重试
    h.verifyMode.mode = 'version'
    h.clock.t += 10 * 60_000
    await up.tick()
    expect(h.store.snapshot().claude.verify).toBe('unverified')
    h.clock.t += 25 * 60_000
    await up.tick()
    expect(h.store.snapshot().claude).toMatchObject({ verify: 'ok', accepted: '1.1.0' })
    expect(h.notes).toEqual(['Claude Code 已自动升级到 1.1.0，自检通过'])
  })

  it('updater failure ⇒ failed + exponential backoff, CLI untouched, no rollback', async () => {
    const c = fakeClaude(root, ['1.0.0', '1.1.0'], '1.0.0')
    const h = harness({ claude: c })
    h.setLatest('claude', '1.1.0'); c.setNext('1.1.0'); c.failUpdate(true)
    const up = makeCliUpgrader(h.deps)
    const r = await up.upgrade('claude', { source: 'scheduled' })
    expect(r.result).toBe('failed')
    expect(r.detail).toContain('network down')
    expect(await c.current()).toBe('1.0.0')
    const s = h.store.snapshot().claude
    expect(s.nextCheckAt).toBe(new Date(h.clock.t + 3_600_000).toISOString())
    expect((await up.upgrade('claude', { source: 'scheduled' })).result).toBe('backoff')
  })

  it('latest-version lookup failures back off instead of retrying every tick', async () => {
    const c = fakeClaude(root, ['1.0.0'], '1.0.0')
    const h = harness({ claude: c })
    h.setLatest('claude', null, 'ENOTFOUND registry.npmjs.org')
    const up = makeCliUpgrader(h.deps)
    await up.check('claude', 'reactive')
    expect(h.store.snapshot().claude.checkFailures).toBe(1)
    await up.check('claude', 'reactive')
    expect(h.latestCalls).toEqual(['claude'])
    h.clock.t += 3_600_001
    await up.check('claude', 'reactive')
    expect(h.store.snapshot().claude.checkFailures).toBe(2)
    expect(h.store.snapshot().claude.nextCheckAt).toBe(new Date(h.clock.t + 7_200_000).toISOString())
  })

  it('reactive trigger: an outdated-client error schedules a check (debounced); the check finds a newer version and upgrades', async () => {
    const x = fakeCodex(root, ['0.153.4', '0.160.0'], '0.153.4')
    const h = harness({ codex: x })
    h.setLatest('codex', '0.160.0'); x.setNext('0.160.0')
    h.clock.hour = 1 // 还没到每天的检查点
    const up = makeCliUpgrader(h.deps)
    await up.tick()
    expect(h.latestCalls).toEqual([])
    const msg = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-terra\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}'
    expect(up.onTurnError('codex', 'invalid_request', msg)).toBe(true)
    expect(up.onTurnError('codex', 'invalid_request', msg)).toBe(false) // 去抖
    expect(up.onTurnError('codex', 'quota', 'You hit your usage limit')).toBe(false)
    expect(up.onTurnError('openai', null, msg)).toBe(false)
    await up.tick()
    expect(await x.current()).toBe('0.160.0')
    expect(h.store.snapshot().codex.lastUpgrade).toMatchObject({ source: 'reactive', result: 'upgraded' })
  })

  it('scheduled check runs once per local day, only after check_hour', async () => {
    const c = fakeClaude(root, ['1.0.0'], '1.0.0')
    const h = harness({ claude: c })
    h.setLatest('claude', '1.0.0')
    const up = makeCliUpgrader(h.deps)
    h.clock.hour = 3
    await up.tick()
    expect(h.latestCalls).toEqual([])
    h.clock.hour = 4
    await up.tick(); await up.tick()
    expect(h.latestCalls).toEqual(['claude'])
    h.clock.day = '2026-10-05'
    await up.tick()
    expect(h.latestCalls).toEqual(['claude', 'claude'])
    expect(c.calls()).toEqual([]) // 已是最新,不跑升级器
  })

  it('disabled (globally or per CLI) ⇒ tick does nothing; manual upgrade still works', async () => {
    const c = fakeClaude(root, ['1.0.0', '1.1.0'], '1.0.0')
    const h = harness({ claude: c })
    h.setLatest('claude', '1.1.0'); c.setNext('1.1.0')
    h.deps.config = () => resolveCliUpgradeConfig({ per_cli: { claude: { enabled: false } } })
    const up = makeCliUpgrader(h.deps)
    await up.tick()
    expect(h.latestCalls).toEqual([])
    expect((await up.upgrade('claude')).result).toBe('upgraded')
  })

  it('never two upgrades at once', async () => {
    const c = fakeClaude(join(root, 'c'), ['1.0.0', '1.1.0'], '1.0.0')
    const x = fakeCodex(join(root, 'x'), ['0.153.4', '0.160.0'], '0.153.4')
    const h = harness({ claude: c, codex: x })
    c.setNext('1.1.0'); x.setNext('0.160.0')
    const up = makeCliUpgrader(h.deps)
    const [a, b] = await Promise.all([up.upgrade('claude'), up.upgrade('codex')])
    expect(a.result).toBe('upgraded')
    expect(b.result).toBe('busy')
    expect(await x.current()).toBe('0.153.4')
  })

  it('CLI changed by its own background updater ⇒ owed selftest; failure rolls back to the accepted version', async () => {
    const c = fakeClaude(root, ['1.0.0', '1.1.0'], '1.0.0')
    const h = harness({ claude: c })
    h.setLatest('claude', '1.1.0')
    const up = makeCliUpgrader(h.deps)
    await up.check('claude', 'scheduled')
    expect(h.store.snapshot().claude.accepted).toBe('1.0.0')
    // CLI 自己在后台升了(不是我们)
    unlinkSync(c.bin)
    symlinkSync(join(root, 'home', '.local', 'share', 'claude', 'versions', '1.1.0'), c.bin)
    h.bad.add('1.1.0')
    h.clock.day = '2026-10-05'
    await up.tick()
    expect(await c.current()).toBe('1.0.0')
    expect(h.store.snapshot().claude.lastUpgrade).toMatchObject({ source: 'external', result: 'rolled_back' })
    expect(h.notes[0]).toContain('换到 1.1.0 后自检没通过')
    expect(c.calls()).toEqual([]) // 没跑升级器
  })

  it('manual rollback goes back to the pre-upgrade version and marks the current one known-bad', async () => {
    const c = fakeClaude(root, ['1.0.0', '1.1.0'], '1.0.0')
    const h = harness({ claude: c })
    h.setLatest('claude', '1.1.0'); c.setNext('1.1.0')
    const up = makeCliUpgrader(h.deps)
    expect((await up.upgrade('claude')).result).toBe('upgraded')
    const r = await up.rollback('claude')
    expect(r).toMatchObject({ result: 'rolled_back', from: '1.1.0', to: '1.0.0' })
    expect(await c.current()).toBe('1.0.0')
    expect(h.store.snapshot().claude.knownBad).toEqual(['1.1.0'])
  })

  it('an owed selftest that cannot run (CLI gone) is dropped and never starves the other CLIs (2026-10-10)', async () => {
    const c = fakeClaude(join(root, 'c'), ['1.0.0', '1.1.0'], '1.0.0')
    const x = fakeCodex(join(root, 'x'), ['0.1.0', '0.2.0'], '0.1.0')
    const fakes: Partial<Record<CliId, Fake>> = { claude: c, codex: x }
    const h = harness(fakes)
    h.setLatest('claude', '1.1.0'); c.setNext('1.1.0')
    h.verifyMode.mode = 'deferred'
    const up = makeCliUpgrader(h.deps)
    expect((await up.upgrade('claude', { source: 'scheduled' })).result).toBe('unverified')
    h.verifyMode.mode = 'version'
    // claude 被卸了;codex 有新版待升
    delete fakes.claude
    h.setLatest('codex', '0.2.0'); x.setNext('0.2.0')
    await up.check('codex', 'manual')
    h.clock.t += 31 * 60_000
    await up.tick()
    expect(h.store.snapshot().claude).toMatchObject({ rollbackTo: null })
    await up.tick()
    expect(await x.current()).toBe('0.2.0')
  })

  it('an upgrade that breaks --version marks the looked-up latest bad, so it is not retried every day (2026-10-10)', async () => {
    const c = fakeClaude(root, ['1.0.0'], '1.0.0')
    const vers = join(root, 'home', '.local', 'share', 'claude', 'versions')
    writeWarmExecFixture(join(vers, '1.1.0'), '#!/bin/sh\nexit 3\n')
    const h = harness({ claude: c })
    h.setLatest('claude', '1.1.0'); c.setNext('1.1.0')
    const up = makeCliUpgrader(h.deps)
    await up.check('claude', 'scheduled')
    expect((await up.upgrade('claude', { source: 'scheduled' })).result).toBe('rolled_back')
    expect(await c.current()).toBe('1.0.0')
    expect(h.store.snapshot().claude.knownBad).toEqual(['1.1.0'])
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0]).toContain('1.1.0')
    h.clock.day = '2026-10-05'
    await up.check('claude', 'scheduled')
    expect(h.store.snapshot().claude.pending).toBeNull()
  })

  it('a CLI that is not installed is reported, never touched', async () => {
    const h = harness({})
    const up = makeCliUpgrader(h.deps)
    expect((await up.upgrade('agy')).result).toBe('not_installed')
    const v = await up.check('agy', 'manual')
    expect(v.installed).toBeNull()
  })
})
