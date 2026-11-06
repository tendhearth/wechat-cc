// Dedicated-mini executor. The local entry only transports a bounded JSON request.
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { miniConfiguration, assertLoopbackEndpoint, createOfflineSession, validateRequest } from './macmini-ui-protocol.mjs'

const textCommand = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim()
const identity = { computerName: textCommand('/usr/sbin/scutil', ['--get', 'ComputerName']),
  homeDir: homedir(), platformName: process.platform }
const mini = miniConfiguration(identity)
const labHome = mini.labHome
const configPath = join(labHome, 'active.json')

let input = ''
for await (const chunk of process.stdin) {
  input += chunk
  if (input.length > 1024) throw Error('UI lab request is too large')
}
const request = JSON.parse(input)
validateRequest(request) // Reuse the same command allowlist at the receiving boundary.
const config = JSON.parse(await readFile(configPath, 'utf8'))
const endpoint = assertLoopbackEndpoint(config.endpoint)

async function insideLab(path) {
  const resolved = await realpath(path)
  if (!resolved.startsWith(labHome + '/')) throw Error('Configured path leaves the dedicated UI lab')
  return resolved
}
const root = await insideLab(config.root)
const project = await insideLab(join(root, 'project'))
const runtime = await insideLab(config.runtime)
const environment = {}
for (const name of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL']) {
  if (process.env[name]) environment[name] = process.env[name]
}
Object.assign(environment, {
  PATH: `${root}/toolchain/bin:${mini.homeDir}/.cargo/bin:${mini.homeDir}/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  APPIUM_HOME: join(runtime, 'extensions'), CARGO_HOME: join(root, 'cargo-cache'),
  CARGO_TARGET_DIR: join(root, 'native-target'), CARGO_BUILD_JOBS: '2', CARGO_NET_OFFLINE: 'true',
  WECHAT_CC_NO_BUNDLE_MIGRATE: '1', PLAYWRIGHT_SHIM_PORT: '4198', CI: '1',
})
if (mini.sharedLock) {
  environment.PLAYWRIGHT_BROWSERS_PATH = join(root, 'cache/browser')
  environment.RUSTC = mini.rustc
}

async function api(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(endpoint + path, {
    method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(150000), redirect: 'error',
  })
  const result = await response.json()
  if (!response.ok || result.value?.error) throw Error(result.value?.message ?? `UI API returned ${response.status}`)
  return result.value
}

function consoleState() {
  const output = textCommand('/usr/sbin/ioreg', ['-n', 'Root', '-d1'])
  const consoleUser = textCommand('/usr/bin/stat', ['-f', '%Su', '/dev/console'])
  const locked = /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(output)
  const userSessionPresent = /"IOConsoleUsers"/.test(output) && consoleUser === mini.homeDir.split('/').at(-1)
  return { consoleUser, locked: userSessionPresent ? locked : null }
}

if (request.command === 'app-status') {
  const { appStatus } = await import('./macmini-ui-app.mjs')
  console.log(JSON.stringify(await appStatus({ config, insideLab, labHome, bun: mini.bun }), null, 2))
  process.exit(0)
}

if (request.command === 'status') {
  let controller
  try { controller = await api('/status') } catch (error) { controller = { ready: false, message: error.message } }
  console.log(JSON.stringify({ identity, root, sourceCommit: textCommand('/usr/bin/git', ['-C', project, 'rev-parse', 'HEAD']),
    console: consoleState(), endpoint, controller,
    nativeAcceptance: 'requires an unlocked mini and its system UI Automation authorization; status does not prove either',
    productionAccess: false, localDesktopFallback: false }, null, 2))
  process.exit(controller.ready ? 0 : 1)
}

const executionRoot = request.command.startsWith('app-')
  ? await insideLab(config.appRoot ?? (() => { throw Error('APP_BLOCKED: configure an App snapshot first') })()) : root

// No two test runs may control the same lab or use the same fixture port.
const lock = join(labHome, '.execution-lock')
try { await mkdir(lock, { mode: 0o700 }) } catch { throw Error('Another UI lab run owns the execution lock; inspect its owner before recovery') }
const ownership = JSON.stringify({ pid: process.pid, command: request.command, started: new Date().toISOString() })
const ownedLocks = [{ path: lock, file: join(lock, 'owner.json'), content: ownership }]
const releaseLocks = async () => {
  for (const owned of [...ownedLocks].reverse()) {
    try {
      if (await readFile(owned.file, 'utf8') === owned.content) await rm(owned.path, { recursive: true })
    } catch { /* Never reclaim a lock whose owner is missing or changed. */ }
  }
}
try {
  await writeFile(join(lock, 'owner.json'), ownership, { flag: 'wx' })
  if (mini.sharedLock) {
    try { await mkdir(mini.sharedLock, { mode: 0o700 }) } catch { throw Error('Another family check owns this Mini; no UI tests started') }
    const owned = { path: mini.sharedLock, file: join(mini.sharedLock, 'info'),
      content: `pid=${process.pid}\nsince=${Math.floor(Date.now() / 1000)}\nowner=cc-ui-lab ${request.command}\n` }
    ownedLocks.push(owned)
    await writeFile(owned.file, owned.content, { flag: 'wx' })
  }
} catch (error) { await releaseLocks(); throw error }
const run = join(executionRoot, 'artifacts', new Date().toISOString().replaceAll(':', '-') + '-' + request.command)
const temporaryRoot = join(run, 'tmp')
try {
  await mkdir(run, { recursive: true, mode: 0o700 })
  await mkdir(temporaryRoot, { mode: 0o700 })
} catch (error) { await releaseLocks(); throw error }
// Keep explicit state inside this run's temp root, preserving the repository's
// test-runner state guard and avoiding state shared by different lab runs.
Object.assign(environment, { TMPDIR: temporaryRoot,
  WECHAT_STATE_DIR: join(temporaryRoot, 'daemon'), WECHAT_CC_WORKBENCH_STATE_DIR: join(temporaryRoot, 'workbench') })
let sequence = 0

async function command(label, file, args, { offline = true, cwd = project, extraEnv = {} } = {}) {
  const log = join(run, `${++sequence}-${label}.log`)
  console.log(JSON.stringify({ step: label, log, offline }))
  const chunks = []
  const logStream = createWriteStream(log, { flags: 'wx', mode: 0o600 })
  let logError
  logStream.on('error', error => { logError = error })
  const child = offline
    ? spawn('/usr/bin/sandbox-exec', ['-f', join(root, 'offline-tests.sb'), file, ...args], { cwd, env: { ...environment, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(file, args, { cwd, env: { ...environment, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { chunks.push(chunk); logStream.write(chunk) })
  let code
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }) }
  finally { await new Promise(resolve => logStream.end(resolve)) }
  if (logError) throw logError
  console.log(Buffer.concat(chunks).toString().split('\n').slice(-18).join('\n'))
  if (code !== 0) throw Error(`${label} failed (${code}); see ${log}`)
  return { label, exitCode: code, log }
}

async function unit() {
  const qaConfig = await readFile(join(project, 'apps/desktop/art/cc-v1/native-motion-qa/tauri.qa.json'), 'utf8')
  await command('qa-stage', '/opt/homebrew/bin/node', ['apps/desktop/scripts/prepare-cc-motion-native-qa.mjs'])
  return [
    await command('protocol', mini.bun, ['--bun', 'vitest', 'run', 'apps/desktop/scripts/macmini-ui-protocol.test.mjs']),
    await command('companion-gesture', mini.bun, ['--bun', 'vitest', 'run', '--maxWorkers=2', 'src/features/workbench/service/view.test.ts', 'src/daemon/wiring/wire-pet-activities.test.ts', 'packages/protocol/src/desktop-api-pet.test.ts', 'apps/desktop/src/pet-activities.test.ts', 'apps/desktop/src/companion-drag.test.ts', 'apps/desktop/src/companion-motion.test.ts', 'apps/desktop/src/companion-window.test.ts', 'apps/desktop/src/companion-status.test.ts', 'apps/desktop/src/main-navigation.test.ts', 'apps/desktop/src/pet/pet.test.ts', 'apps/desktop/src/pet/life/life-director.test.ts', 'apps/desktop/src/pet/renderer/sprite-renderer.test.ts', 'apps/desktop/scripts/prepare-cc-motion-native-qa.test.ts']),
    await command('test-environment', mini.bun, ['--bun', 'vitest', 'run', 'src/lib/config.test.ts', 'apps/desktop/shim.e2e.test.ts']),
    await command('native-library', mini.cargo, ['test', '--offline', '--locked', '--lib'], {
      cwd: join(project, 'apps/desktop/src-tauri'), extraEnv: { TAURI_CONFIG: qaConfig },
    }),
  ]
}

async function browser() {
  return command('browser', mini.bun, ['x', '--no-install', 'playwright', 'test', '-c', '.superpowers/macmini.config.ts',
    'companion-controls.spec.ts', 'companion-entry.spec.ts', 'companion-life.spec.ts', 'now-hero.spec.ts', 'companion-status.spec.ts', 'pet-lab.spec.ts'], {
      cwd: join(project, 'apps/desktop'), extraEnv: { WECHAT_CC_INJECT_CSP: '1' },
    })
}

async function native() {
  const state = consoleState()
  if (state.locked !== false || state.consoleUser !== mini.homeDir.split('/').at(-1)) {
    throw Error('NATIVE_BLOCKED: the mini desktop is locked or unavailable. No session or input was sent; SSH cannot replace system authentication.')
  }
  const appPath = await insideLab(join(root, 'Native Input Control.app'))
  const bundleId = textCommand('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(appPath, 'Contents/Info.plist')])
  const caps = createOfflineSession({ bundleId, appPath, stateRoot: join(run, 'state') })
  for (const folder of ['daemon', 'workbench']) await mkdir(join(run, 'state', folder), { recursive: true, mode: 0o700 })
  caps.capabilities.alwaysMatch['appium:environment'].CC_UI_CONTROL_LOG = join(run, 'native-events.jsonl')
  let session
  try {
    const created = await api('/session', caps)
    session = created.sessionId
    if (!session) throw Error('UI driver returned no session identifier')
    const execute = (script, args = {}) => api(`/session/${session}/execute/sync`, { script, args: [args] })
    const windows = await execute('macos: listWindows')
    const before = windows.find(window => window.title === 'CC Native Input Control')
    if (!before?.windowId || !before.rect) throw Error('Owned native control window was not found')
    const png = await api(`/session/${session}/element/${before.windowId}/screenshot`)
    await writeFile(join(run, 'control-before.png'), Buffer.from(png, 'base64'))
    if (request.command !== 'capture') {
      const { x, y, width, height } = before.rect
      const startX = x + width * .75, startY = y + height * .5
      await execute('macos: clickAndDragAndHold', { startX, startY, endX: startX + 90, endY: startY + 60,
        duration: .8, holdDuration: .2, velocity: 200 })
      const after = (await execute('macos: listWindows')).find(window => window.windowId === before.windowId)
      if (!after || Math.abs(after.rect.x - x - 90) > 6 || Math.abs(after.rect.y - y - 60) > 6
        || after.rect.width !== width || after.rect.height !== height) throw Error('Native control did not follow the input by the expected displacement')
      const events = (await readFile(join(run, 'native-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      if (!events.some(event => event.event === 'down') || !events.some(event => event.event === 'dragged') || !events.some(event => event.event === 'up')) {
        throw Error('Native control did not receive a complete native input sequence')
      }
      await writeFile(join(run, 'frames.json'), JSON.stringify({ before, after }, null, 2))
    }
    return { nativeControl: request.command === 'capture' ? 'not tested; capture only' : 'passed',
      productDrag: 'not tested by this control', artifacts: run }
  } finally {
    if (session) await api(`/session/${session}`, undefined, 'DELETE')
  }
}

try {
  let result
  switch (request.command) {
    case 'app-prepare': case 'app-build': case 'app-maestro': {
      const { runApp } = await import('./macmini-ui-app.mjs')
      result = await runApp({ request, config, insideLab, labHome, run, command, environment, bun: mini.bun }); break
    }
    case 'doctor': result = await command('doctor', '/opt/homebrew/bin/node', [join(runtime, 'node_modules/appium/build/lib/main.js'), 'driver', 'doctor', 'mac2'], { offline: false }); break
    case 'unit': result = await unit(); break
    case 'browser': result = await browser(); break
    case 'affected': result = await command('verify-affected', mini.bun, ['run', 'verify', '--base', config.baseCommit ?? 'a4b8b2547d96e0f8301709e90370469d9408571d']); break
    case 'embedded': result = await command('embedded-webkit', '/opt/homebrew/bin/node', ['apps/desktop/scripts/macmini-embedded-ui.mjs'], {
      extraEnv: { CC_UI_ARTIFACT_DIR: run },
    }); break
    case 'embedded-build': result = await command('embedded-qa-build', mini.bun, ['run', '--cwd', 'apps/desktop', 'tauri', 'build',
      '--debug', '--features', 'qa-webdriver', '--bundles', 'app', '--no-sign', '--config', 'art/cc-v1/native-motion-qa/tauri.qa.json'], { extraEnv: { CI: 'true' } }); break
    // Build only: never launch this production-identity application on the mini.
    // Developer ID keys remain on the primary; updater/release signing is off.
    case 'production-build': result = await command('production-app-build', mini.bun, ['run', '--cwd', 'apps/desktop', 'tauri', 'build',
      '--bundles', 'app', '--no-sign', '--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }), '--', '--locked'], {
      extraEnv: { CI: 'true', WECHAT_CC_ATELIER_SD_CLI: join(root, 'public-inputs/sd-cli') },
    }); break
    case 'full': result = [await command('verify-full', mini.bun, ['run', 'verify', '--full']), ...await unit(), await browser()]; break
    // Standard repository regression needs platform-entitled /bin/ps, which
    // macOS refuses under ANY Seatbelt profile, including allow-default.
    // This separate role keeps sanitized env/empty state/test fakes and the
    // serial lock. It does not claim OS-enforced offline coverage. UI tests
    // and QA builds above always retain their outbound-deny profile.
    case 'full-platform': result = await command('verify-full-platform', mini.bun, ['run', 'verify', '--full'], { offline: false }); break
    case 'native-smoke': case 'capture': result = await native(); break
  }
  await writeFile(join(run, 'result.json'), JSON.stringify({ ok: true, command: request.command, result }, null, 2))
  console.log(JSON.stringify({ ok: true, artifacts: run, result }))
} catch (error) {
  await writeFile(join(run, 'result.json'), JSON.stringify({ ok: false, command: request.command, error: error.message }, null, 2))
  console.error(error.message)
  process.exitCode = error.message.startsWith('NATIVE_BLOCKED:') ? 2 : 1
} finally {
  await releaseLocks()
}
