import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultSelfDeployDeps,
  executeSelfDeploy,
  parseLaunchAgentPlist,
  planSelfDeploy,
  type SelfDeployDeps,
  type SelfDeployPlan,
} from './self-deploy'

// ── parseLaunchAgentPlist ────────────────────────────────────────────

function plistWith(programArgs: string[], stderrPath?: string): string {
  const argsXml = programArgs.map((a) => `    <string>${a}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.wechat-cc.daemon</string>
  <key>ProgramArguments</key><array>
${argsXml}
  </array>
  <key>WorkingDirectory</key><string>/Users/nate/wechat-cc</string>
  <key>StandardOutPath</key><string>/Users/nate/.claude/channels/wechat/launchd.out.log</string>
${stderrPath ? `  <key>StandardErrorPath</key><string>${stderrPath}</string>\n` : ''}  <key>RunAtLoad</key><true/>
</dict></plist>
`
}

describe('parseLaunchAgentPlist', () => {
  it('parses the current shape (app main binary wechat_cc_desktop)', () => {
    const xml = plistWith(
      ['/Applications/wechat-cc.app/Contents/MacOS/wechat_cc_desktop', '--daemon', 'run', '--dangerously'],
      '/Users/nate/.claude/channels/wechat/launchd.err.log',
    )
    const r = parseLaunchAgentPlist(xml)
    expect(r).toEqual({
      programArguments: ['/Applications/wechat-cc.app/Contents/MacOS/wechat_cc_desktop', '--daemon', 'run', '--dangerously'],
      stderrPath: '/Users/nate/.claude/channels/wechat/launchd.err.log',
    })
  })

  it('parses the older shape (app main binary named wechat-cc)', () => {
    const xml = plistWith(
      ['/Applications/wechat-cc.app/Contents/MacOS/wechat-cc', '--daemon', 'run'],
      '/Users/nate/.claude/channels/wechat/launchd.err.log',
    )
    const r = parseLaunchAgentPlist(xml)
    expect(r?.programArguments[0]).toBe('/Applications/wechat-cc.app/Contents/MacOS/wechat-cc')
    expect(r?.stderrPath).toBe('/Users/nate/.claude/channels/wechat/launchd.err.log')
  })

  it('returns null StandardErrorPath when the key is absent', () => {
    const xml = plistWith(['/Applications/wechat-cc.app/Contents/MacOS/wechat-cc', '--daemon', 'run'])
    const r = parseLaunchAgentPlist(xml)
    expect(r?.stderrPath).toBeNull()
  })

  it('returns null on malformed/unrelated XML', () => {
    expect(parseLaunchAgentPlist('<plist><dict><key>Label</key><string>com.wechat-cc.daemon</string></dict></plist>')).toBeNull()
    expect(parseLaunchAgentPlist('not xml at all')).toBeNull()
    expect(parseLaunchAgentPlist('')).toBeNull()
  })
})

// ── planSelfDeploy ───────────────────────────────────────────────────

describe('planSelfDeploy', () => {
  const baseInput = {
    platform: 'darwin' as NodeJS.Platform,
    homeDir: '/Users/nate',
    uid: 501,
    repoRoot: '/Users/nate/wechat-cc-cc-kit',
    stateDir: '/Users/nate/.claude/channels/wechat',
  }

  it('derives sidecar path from the plist main binary dir (arm64 default binary)', () => {
    const xml = plistWith(['/Applications/wechat-cc.app/Contents/MacOS/wechat_cc_desktop', '--daemon', 'run', '--dangerously'], '/Users/nate/.claude/channels/wechat/launchd.err.log')
    const plan = planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: xml })
    expect(plan.sidecarPath).toBe('/Applications/wechat-cc.app/Contents/MacOS/wechat-cc-cli')
    expect(plan.newBinaryPath).toBe('/Users/nate/wechat-cc-cc-kit/apps/desktop/src-tauri/binaries/wechat-cc-cli-aarch64-apple-darwin')
    expect(plan.prevPath).toBe(`${plan.sidecarPath}.prev`)
    expect(plan.tmpPath).toBe(`${plan.sidecarPath}.new`)
    expect(plan.serviceTarget).toBe('gui/501/com.wechat-cc.daemon')
    expect(plan.stderrLogPath).toBe('/Users/nate/.claude/channels/wechat/launchd.err.log')
    expect(plan.infoPath).toBe('/Users/nate/.claude/channels/wechat/internal-api-info.json')
    expect(plan.healthTimeoutMs).toBe(60_000)
    expect(plan.rollback).toBe(true)
  })

  it('x64 defaults to the x86_64-apple-darwin binary name', () => {
    const xml = plistWith(['/Applications/wechat-cc.app/Contents/MacOS/wechat-cc', '--daemon', 'run'])
    const plan = planSelfDeploy({ ...baseInput, arch: 'x64', plistXml: xml })
    expect(plan.newBinaryPath).toBe('/Users/nate/wechat-cc-cc-kit/apps/desktop/src-tauri/binaries/wechat-cc-cli-x86_64-apple-darwin')
  })

  it('honors an explicit --binary override', () => {
    const xml = plistWith(['/Applications/wechat-cc.app/Contents/MacOS/wechat-cc', '--daemon', 'run'])
    const plan = planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: xml, binary: '/tmp/custom-sidecar' })
    expect(plan.newBinaryPath).toBe('/tmp/custom-sidecar')
  })

  it('falls back to a default stderr log path when the plist has none', () => {
    const xml = plistWith(['/Applications/wechat-cc.app/Contents/MacOS/wechat-cc', '--daemon', 'run'])
    const plan = planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: xml })
    expect(plan.stderrLogPath).toBe('/Users/nate/.claude/channels/wechat/launchd.err.log')
  })

  it('--app overrides the plist-derived target', () => {
    const xml = plistWith(['/Applications/wechat-cc.app/Contents/MacOS/wechat-cc', '--daemon', 'run'])
    const plan = planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: xml, app: '/Users/nate/Downloads/wechat-cc.app' })
    expect(plan.sidecarPath).toBe('/Users/nate/Downloads/wechat-cc.app/Contents/MacOS/wechat-cc-cli')
  })

  it('--app works even with no plist at all', () => {
    const plan = planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: null, app: '/Users/nate/Downloads/wechat-cc.app' })
    expect(plan.sidecarPath).toBe('/Users/nate/Downloads/wechat-cc.app/Contents/MacOS/wechat-cc-cli')
  })

  it('--app given as the .app root joins Contents/MacOS', () => {
    const plan = planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: null, app: '/Users/nate/Downloads/wechat-cc.app' })
    expect(plan.sidecarPath).toBe('/Users/nate/Downloads/wechat-cc.app/Contents/MacOS/wechat-cc-cli')
  })

  it('--app given as an already-fully-qualified Contents/MacOS path does not double-nest', () => {
    const plan = planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: null, app: '/Users/nate/Downloads/wechat-cc.app/Contents/MacOS' })
    expect(plan.sidecarPath).toBe('/Users/nate/Downloads/wechat-cc.app/Contents/MacOS/wechat-cc-cli')
  })

  it('--app tolerates a trailing slash on a Contents/MacOS path', () => {
    const plan = planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: null, app: '/Users/nate/Downloads/wechat-cc.app/Contents/MacOS/' })
    expect(plan.sidecarPath).toBe('/Users/nate/Downloads/wechat-cc.app/Contents/MacOS/wechat-cc-cli')
  })

  it('throws launchagent_not_app_bundle for a dev-mode plist (bun + cli.ts, not an app bundle)', () => {
    // Shape buildServicePlan() emits for a source checkout before
    // `service install --binary` ever ran: ProgramArguments[0] is `bun` on
    // PATH (e.g. /opt/homebrew/bin/bun), argv[1] is the repo's cli.ts.
    const xml = plistWith(['/opt/homebrew/bin/bun', '/Users/nate/wechat-cc-cc-kit/cli.ts', 'run', '--dangerously'])
    expect(() => planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: xml }))
      .toThrow('launchagent_not_app_bundle')
  })

  it('throws launchagent_not_app_bundle when dirname is MacOS but argv[1] is still a .ts source file', () => {
    // Contrived, but pins the second half of the guard independently of the
    // first: a MacOS/-shaped dirname is not sufficient on its own.
    const xml = plistWith(['/Applications/wechat-cc.app/Contents/MacOS/bun', '/Users/nate/wechat-cc-cc-kit/cli.ts', 'run'])
    expect(() => planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: xml }))
      .toThrow('launchagent_not_app_bundle')
  })

  it('a real app-bundle plist with a leading flag (not a .ts path) as argv[1] is accepted', () => {
    const xml = plistWith(['/Applications/wechat-cc.app/Contents/MacOS/wechat_cc_desktop', '--daemon', 'run', '--dangerously'])
    const plan = planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: xml })
    expect(plan.sidecarPath).toBe('/Applications/wechat-cc.app/Contents/MacOS/wechat-cc-cli')
  })

  it('throws self_deploy_unsupported_platform on non-darwin', () => {
    expect(() => planSelfDeploy({ ...baseInput, platform: 'win32', arch: 'x64', plistXml: null, app: '/x' }))
      .toThrow('self_deploy_unsupported_platform')
  })

  it('throws launchagent_not_found when there is no plist and no --app', () => {
    expect(() => planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: null }))
      .toThrow('launchagent_not_found')
  })

  it('throws launchagent_not_found when the plist fails to parse and no --app', () => {
    expect(() => planSelfDeploy({ ...baseInput, arch: 'arm64', plistXml: 'garbage' }))
      .toThrow('launchagent_not_found')
  })
})

// ── executeSelfDeploy ────────────────────────────────────────────────

interface Harness {
  dir: string
  plan: SelfDeployPlan
  deps: SelfDeployDeps
  kickstartCalls: number
  printCalls: number
  setDaemonHealthyAfterKickstart(n: number): void
  neverHealthy(): void
  /** Make the sidecar currently on disk fail `--version` (the crash-loop
   *  machine state `self deploy` is usually run to get out of). */
  breakCurrentSidecar(): void
}

// Real tmp dir + real fs (via defaultSelfDeployDeps().fs / .readFileToken /
// .now), but fake spawnSync + fetch + a fast sleep — per the brief: the
// swap/rename/inode behaviour must be real, the launchd + HTTP world is
// simulated.
function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'self-deploy-test-'))
  const macosDir = join(dir, 'app', 'Contents', 'MacOS')
  const buildDir = join(dir, 'build')
  const stateDir = join(dir, 'state')
  mkdirSync(macosDir, { recursive: true })
  mkdirSync(buildDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  const sidecarPath = join(macosDir, 'wechat-cc-cli')
  const newBinaryPath = join(buildDir, 'wechat-cc-cli-new')
  writeFileSync(sidecarPath, 'OLD_BINARY_CONTENT')
  writeFileSync(newBinaryPath, 'NEW_BINARY_CONTENT')

  const infoPath = join(stateDir, 'internal-api-info.json')
  const tokenFilePath = join(stateDir, 'internal-token')
  const operatorTokenFilePath = join(stateDir, 'operator-token')
  writeFileSync(tokenFilePath, 'test-token-123')
  writeFileSync(operatorTokenFilePath, 'operator-token-456')

  const stderrLogPath = join(dir, 'launchd.err.log')
  writeFileSync(stderrLogPath, Array.from({ length: 60 }, (_, i) => `log line ${i}`).join('\n'))

  const plan: SelfDeployPlan = {
    platform: 'darwin',
    sidecarPath,
    newBinaryPath,
    prevPath: `${sidecarPath}.prev`,
    tmpPath: `${sidecarPath}.new`,
    serviceTarget: 'gui/501/com.wechat-cc.daemon',
    stderrLogPath,
    infoPath,
    healthTimeoutMs: 300,
    rollback: true,
  }

  let kickstartCalls = 0
  let printCalls = 0
  let healthyAfterKickstart = 1 // by default the very first kickstart brings up a healthy daemon
  let alwaysUnhealthy = false
  let brokenCurrentSidecar = false

  const real = defaultSelfDeployDeps()

  const deps: SelfDeployDeps = {
    ...real,
    log: () => {},
    sleep: () => new Promise((resolve) => setTimeout(resolve, 3)),
    spawnSync(cmd, args) {
      if (cmd === newBinaryPath && args[0] === '--version') {
        return { status: 0, stdout: 'wechat-cc-cli 9.9.9-test\n', stderr: '' }
      }
      // The sidecar currently installed — probed before the backup step so
      // a broken (crash-looping) sidecar never overwrites a good `.prev`.
      // `brokenCurrentSidecar` simulates exactly that machine state.
      if (cmd === sidecarPath && args[0] === '--version') {
        if (brokenCurrentSidecar) return { status: null, stdout: '', stderr: 'Killed: 9' }
        return { status: 0, stdout: 'wechat-cc-cli 9.9.8-old\n', stderr: '' }
      }
      if (cmd === `${sidecarPath}.prev` && args[0] === '--version') {
        return { status: 0, stdout: 'wechat-cc-cli 9.9.8-old\n', stderr: '' }
      }
      if (cmd === 'launchctl' && args[0] === 'kickstart') {
        kickstartCalls++
        // Simulate the newly (re)started daemon rewriting internal-api-info.json
        // shortly after launchd brings it up — mtime deliberately bumped into
        // the future so it's unambiguously later than the `since` capture,
        // regardless of filesystem mtime resolution.
        writeFileSync(infoPath, JSON.stringify({ baseUrl: 'http://127.0.0.1:9', tokenFilePath, operatorTokenFilePath }))
        const bumped = new Date(Date.now() + 50 * kickstartCalls)
        utimesSync(infoPath, bumped, bumped)
        return { status: 0, stdout: '', stderr: '' }
      }
      if (cmd === 'launchctl' && args[0] === 'print') {
        printCalls++
        return {
          status: 0,
          stdout: [
            'com.wechat-cc.daemon = {',
            '  state = running',
            '  last exit reason = SIGKILL',
            '  runs = 3',
            '  some unrelated line',
            '}',
          ].join('\n'),
          stderr: '',
        }
      }
      return { status: 1, stdout: '', stderr: `unexpected spawnSync(${cmd})` }
    },
    fetch: (async () => {
      const healthy = alwaysUnhealthy ? false : kickstartCalls >= healthyAfterKickstart
      if (!healthy) {
        return { ok: false, status: 503, json: async () => ({}) } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, version: { cli: '9.9.9-test', head: null, boot_at: 'x' } }),
      } as Response
    }) as unknown as typeof fetch,
  }

  return {
    dir,
    plan,
    deps,
    get kickstartCalls() { return kickstartCalls },
    get printCalls() { return printCalls },
    setDaemonHealthyAfterKickstart(n: number) { healthyAfterKickstart = n },
    neverHealthy() { alwaysUnhealthy = true },
    breakCurrentSidecar() { brokenCurrentSidecar = true },
  } as Harness
}

const harnesses: string[] = []
afterEach(() => {
  for (const d of harnesses.splice(0)) rmSync(d, { recursive: true, force: true })
})

function harness(): Harness {
  const h = makeHarness()
  harnesses.push(h.dir)
  return h
}

describe('executeSelfDeploy', () => {
  it('succeeds: backs up, swaps to a new inode, kickstarts once, passes health', async () => {
    const h = harness()
    // inode isn't a meaningful concept on Windows (no real self-deploy
    // target there anyway — darwin/launchd only); guard just those two
    // assertions so the rest of this test still runs on every platform.
    const originalIno = process.platform !== 'win32' ? statSync(h.plan.sidecarPath).ino : null

    const result = await executeSelfDeploy(h.plan, h.deps)

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.version).toBe('wechat-cc-cli 9.9.9-test')
    expect(h.kickstartCalls).toBe(1)
    expect(readFileSync(h.plan.prevPath, 'utf8')).toBe('OLD_BINARY_CONTENT')
    expect(readFileSync(h.plan.sidecarPath, 'utf8')).toBe('NEW_BINARY_CONTENT')
    if (process.platform !== 'win32') expect(statSync(h.plan.sidecarPath).ino).not.toBe(originalIno)
    expect(result.steps.map((s) => s.name)).toEqual(['preflight', 'stage', 'backup', 'swap', 'restart', 'health'])
    expect(result.steps.every((s) => s.ok)).toBe(true)
  })

  it('rolls back when health never passes on the new binary, and reports diagnostics', async () => {
    const h = harness()
    // Never healthy on the first kickstart (the "bad new binary"); healthy
    // again starting from the 2nd kickstart (the rollback).
    h.setDaemonHealthyAfterKickstart(2)

    const result = await executeSelfDeploy(h.plan, h.deps)

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.rolledBack).toBe(true)
    expect(h.kickstartCalls).toBe(2)
    expect(readFileSync(h.plan.sidecarPath, 'utf8')).toBe('OLD_BINARY_CONTENT')
    expect(result.diagnostics).toBeDefined()
    expect(result.diagnostics).toContain('last exit reason = SIGKILL')
    expect(result.diagnostics).toContain('log line 59')
    expect(h.printCalls).toBe(1)
  })

  it('does not roll back when rollback:false', async () => {
    const h = harness()
    h.plan.rollback = false
    h.neverHealthy()

    const result = await executeSelfDeploy(h.plan, h.deps)

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.rolledBack).toBe(false)
    expect(h.kickstartCalls).toBe(1)
    // sidecar was swapped and never restored
    expect(readFileSync(h.plan.sidecarPath, 'utf8')).toBe('NEW_BINARY_CONTENT')
  })

  it('preflight failure touches no files', async () => {
    const h = harness()
    h.deps.spawnSync = (cmd, args) => {
      if (cmd === h.plan.newBinaryPath && args[0] === '--version') return { status: 1, stdout: '', stderr: 'bad binary' }
      return { status: 1, stdout: '', stderr: 'unexpected' }
    }

    const result = await executeSelfDeploy(h.plan, h.deps)

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.steps).toEqual([{ name: 'preflight', ok: false, detail: expect.stringContaining('bad binary') }])
    expect(readFileSync(h.plan.sidecarPath, 'utf8')).toBe('OLD_BINARY_CONTENT')
    const { existsSync } = await import('node:fs')
    expect(existsSync(h.plan.prevPath)).toBe(false)
  })

  // ── C1 (2026-09-18 review): the rollback recipe must not eat its own
  // backup. `self deploy --binary <sidecar>.prev` used to (1) copy the
  // CURRENT broken sidecar over `.prev`, destroying the good bytes, then
  // (2) "install" that now-broken `.prev`. Both of these pin the fix.
  it('--binary <sidecar>.prev installs the backup and leaves .prev untouched', async () => {
    const h = harness()
    // A real machine gets here after a bad deploy: `.prev` holds the last
    // known good binary, the live sidecar is the broken one.
    writeFileSync(h.plan.prevPath, 'GOOD_OLD_BINARY')
    writeFileSync(h.plan.sidecarPath, 'BROKEN_BINARY')
    h.plan.newBinaryPath = h.plan.prevPath
    h.breakCurrentSidecar()

    const result = await executeSelfDeploy(h.plan, h.deps)

    expect(result.ok).toBe(true)
    // The good binary is live...
    expect(readFileSync(h.plan.sidecarPath, 'utf8')).toBe('GOOD_OLD_BINARY')
    // ...and the backup still holds it (not the broken sidecar we replaced).
    expect(readFileSync(h.plan.prevPath, 'utf8')).toBe('GOOD_OLD_BINARY')
    const backup = result.steps.find((s) => s.name === 'backup')!
    expect(backup.ok).toBe(true)
    expect(backup.detail).toContain('skipped')
  })

  it('a broken current sidecar never overwrites the backup', async () => {
    const h = harness()
    writeFileSync(h.plan.prevPath, 'GOOD_OLD_BINARY')
    writeFileSync(h.plan.sidecarPath, 'BROKEN_BINARY')
    h.breakCurrentSidecar()

    const result = await executeSelfDeploy(h.plan, h.deps)

    expect(result.ok).toBe(true)
    expect(readFileSync(h.plan.sidecarPath, 'utf8')).toBe('NEW_BINARY_CONTENT')
    expect(readFileSync(h.plan.prevPath, 'utf8')).toBe('GOOD_OLD_BINARY')
    expect(result.steps.find((s) => s.name === 'backup')).toEqual({
      name: 'backup', ok: true, detail: 'kept previous backup: current sidecar is broken',
    })
  })

  it('rollback health expects the OLD version, so a good rollback prints no version mismatch', async () => {
    const h = harness()
    h.setDaemonHealthyAfterKickstart(2)
    // Health reports the version the OLD binary announces (9.9.8-old) once
    // the rollback is live — preflight's 9.9.9-test must not be what the
    // rollback gate compares against.
    h.deps.fetch = (async () => ({
      ok: h.kickstartCalls >= 2,
      status: h.kickstartCalls >= 2 ? 200 : 503,
      json: async () => ({ ok: true, version: { cli: 'wechat-cc-cli 9.9.8-old' } }),
    })) as unknown as typeof fetch

    const result = await executeSelfDeploy(h.plan, h.deps)

    expect(result.rolledBack).toBe(true)
    const rollbackHealth = result.steps.find((s) => s.name === 'rollback_health')!
    expect(rollbackHealth.ok).toBe(true)
    expect(rollbackHealth.detail ?? '').not.toContain('mismatch')
  })

  // 2026-09-22:`--version` 开始带构建 sha(`1.7.0 (63edf14c)`),而健康接口把它分成
  // cli + head 两格。整行相等的老比较从此永远不成立 —— 门照样绿,却每次部署都打一行
  // 假的 "version mismatch"。这两条钉住:该静的时候静,该响的时候响。
  it('带构建 sha 的版本行对上 cli+head 两格时,不报 mismatch', async () => {
    const h = harness()
    h.setDaemonHealthyAfterKickstart(1)
    const inner = h.deps.spawnSync
    h.deps.spawnSync = ((cmd: string, args: string[]) => {
      if (cmd === h.plan.newBinaryPath && args[0] === '--version') return { status: 0, stdout: '1.7.0 (63edf14c)\n', stderr: '' }
      return inner(cmd, args)
    }) as typeof h.deps.spawnSync
    h.deps.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, version: { cli: '1.7.0', head: '63edf14c' } }),
    })) as unknown as typeof fetch

    const health = (await executeSelfDeploy(h.plan, h.deps)).steps.find((x) => x.name === 'health')!
    expect(health.ok).toBe(true)
    expect(health.detail ?? '').not.toContain('mismatch')
    expect(health.detail).toBe('1.7.0 (63edf14c)')
  })

  it('跑着的构建 sha 与刚装的对不上时,照报 mismatch —— 这正是加 sha 的目的', async () => {
    const h = harness()
    h.setDaemonHealthyAfterKickstart(1)
    const inner = h.deps.spawnSync
    h.deps.spawnSync = ((cmd: string, args: string[]) => {
      if (cmd === h.plan.newBinaryPath && args[0] === '--version') return { status: 0, stdout: '1.7.0 (63edf14c)\n', stderr: '' }
      return inner(cmd, args)
    }) as typeof h.deps.spawnSync
    h.deps.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, version: { cli: '1.7.0', head: 'deadbeef' } }),
    })) as unknown as typeof fetch

    const health = (await executeSelfDeploy(h.plan, h.deps)).steps.find((x) => x.name === 'health')!
    expect(health.detail ?? '').toContain('mismatch')
    expect(health.detail ?? '').toContain('deadbeef')
  })

  it('exits 3 when rollback itself cannot confirm health', async () => {
    const h = harness()
    h.neverHealthy()

    const result = await executeSelfDeploy(h.plan, h.deps)

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.rolledBack).toBe(true)
    expect(h.kickstartCalls).toBe(2)
    // rollback still restored the old binary even though health couldn't be confirmed
    expect(readFileSync(h.plan.sidecarPath, 'utf8')).toBe('OLD_BINARY_CONTENT')
  })
})
