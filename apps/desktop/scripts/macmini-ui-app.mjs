// App work executes only after the parent runner validates mini identity and owns its lock.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir, rm, chmod } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { APP_FLOWS, appFlow } from './macmini-ui-protocol.mjs'

// Maestro 2.12 chooses a free port before waiting for a manually managed runner.
// Starting the runner first either selects a different port or fails its free-port check.
export async function waitForMaestroPort(directory, udid, signal) {
  const deadline = Date.now() + 60000
  while (!signal.aborted && Date.now() < deadline) {
    let entries = []
    try { entries = await readdir(directory, { recursive: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const entry of entries.filter(name => name.endsWith('maestro.log'))) {
      const content = await readFile(join(directory, entry), 'utf8')
      const match = content.match(/Selected device ([\w-]+) using port (\d+) with execution plan/)
      if (match) {
        const port = Number(match[2])
        if (match[1] !== udid || port < 1024 || port > 65535) throw Error('Unexpected Maestro runner endpoint')
        return port
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw Error('Maestro did not select a runner port before startup ended')
}

export async function appStatus({ config, insideLab, labHome, bun }) {
  const probe = (file, args, env = {}) => {
    try { return execFileSync(file, args, { encoding: 'utf8', timeout: 20000, env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', MAESTRO_CLI_NO_ANALYTICS: 'true', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true', ...env } }).trim() }
    catch (error) { return { missing: true, detail: error.message } }
  }
  const tools = join(labHome, 'app-tools')
  const appRoot = config.appRoot ? await insideLab(config.appRoot) : null
  const packageVersion = async name => {
    try { return JSON.parse(await readFile(await insideLab(join(appRoot, 'project/apps/app/node_modules', name, 'package.json')), 'utf8')).version }
    catch (error) { return { missing: true, detail: error.message } }
  }
  return { appRoot, bun: bun ? probe(bun, ['--version']) : null, expo: appRoot ? await packageVersion('expo') : null,
    reactNative: appRoot ? await packageVersion('react-native') : null, source: appRoot ? JSON.parse(await readFile(join(appRoot, 'snapshot.json'), 'utf8')) : null,
    xcode: probe('/usr/bin/xcodebuild', ['-version']),
    simulators: probe('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j']),
    node: probe('/opt/homebrew/bin/node', ['--version']),
    java: probe(join(tools, 'java/Contents/Home/bin/java'), ['--version']),
    maestro: probe(join(tools, 'maestro/bin/maestro'), ['--version'], { HOME: join(tools, 'home'), JAVA_HOME: join(tools, 'java/Contents/Home') }),
    pods: probe(join(tools, 'gems/bin/pod'), ['--version'], { HOME: join(tools, 'home'), GEM_HOME: join(tools, 'gems'), GEM_PATH: join(tools, 'gems'), PATH: `${tools}/ruby/bin:/usr/bin:/bin` }),
    tools, productionAccess: false, localFallback: false,
    note: 'Requires app-tools/{maestro,java,gems}, prepared Expo dependencies and Pods. Status never boots a simulator.' }
}

export async function runApp({ request, config, insideLab, labHome, run, command, environment, bun = '/usr/bin/bun', waitForDriverPort = waitForMaestroPort }) {
  if (!config.appRoot) throw Error('APP_BLOCKED: integrator must place an App snapshot and set active.json appRoot')
  const root = await insideLab(config.appRoot)
  const project = await insideLab(join(root, 'project'))
  const cwd = await insideLab(join(project, 'apps/app'))
  const source = JSON.parse(await readFile(join(root, 'snapshot.json'), 'utf8'))
  const tools = await insideLab(join(labHome, 'app-tools'))
  const java = join(tools, 'java/Contents/Home')
  const home = join(root, 'home')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const extraEnv = { HOME: home, CFFIXED_USER_HOME: home, JAVA_HOME: java,
    GEM_HOME: join(tools, 'gems'), GEM_PATH: join(tools, 'gems'),
    PATH: `${tools}/ruby/bin:${tools}/gems/bin:${java}/bin:${tools}/maestro/bin:${dirname(bun)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    GEM_SPEC_CACHE: join(tools, 'gem-spec-cache'), BUN_INSTALL_CACHE_DIR: join(root, 'cache/bun'),
    COCOAPODS_DISABLE_STATS: 'true', EXPO_NO_TELEMETRY: '1', EXPO_OFFLINE: '1', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', MAESTRO_CLI_NO_ANALYTICS: 'true', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
    TENDHEARTH_UITESTS: '1', NODE_BINARY: '/opt/homebrew/bin/node', RCT_NO_LAUNCH_PACKAGER: '1' }
  const execute = (label, file, args, options = {}) => command(label, file, args, { cwd, extraEnv, ...options })
  const jsiTemp = join(root, 'cache/swiftpm-tmp')
  await mkdir(jsiTemp, { recursive: true, mode: 0o700 })
  Object.assign(extraEnv, { CC_UI_JSI_PATH: extraEnv.PATH, CC_UI_JSI_TMPDIR: jsiTemp, CC_UI_JSI_PACKAGE_CACHE: join(root, 'cache/swiftpm-packages') })
  const jsiScript = async () => {
    const expo = createRequire(join(cwd, 'package.json')).resolve('expo/package.json')
    const core = createRequire(expo).resolve('expo-modules-core/package.json')
    const jsi = createRequire(core).resolve('expo-modules-jsi/package.json')
    return insideLab(join(dirname(jsi), 'apple/scripts/build-xcframework.sh'))
  }
  const prepareFile = join(root, 'prepare-receipt.json')
  const nativeLockHash = async () => createHash('sha256').update(await readFile(join(cwd, 'ios/Podfile.lock'))).digest('hex')
  if (request.command === 'app-prepare') {
    await rm(join(root, 'build-receipt.json'), { force: true })
    await rm(prepareFile, { force: true })
    await execute('app-js-dependencies', bun, ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: project, offline: false })
    await execute('expo-prebuild-prepare', '/opt/homebrew/bin/node', ['node_modules/expo/bin/cli', 'prebuild', '--platform', 'ios', '--no-install'], { offline: false })
    await execute('pods-prepare', join(tools, 'gems/bin/pod'), ['install'], { cwd: join(cwd, 'ios'), offline: false })
    const scriptPath = await jsiScript()
    const original = await readFile(scriptPath, 'utf8')
    const from = 'local env_args=(PATH="$PATH" HOME="$HOME" PODS_ROOT="$PODS_ROOT" RN_ROOT="$RN_ROOT")'
    const to = 'local env_args=(PATH="${CC_UI_JSI_PATH:?}" HOME="$HOME" PODS_ROOT="$PODS_ROOT" RN_ROOT="$RN_ROOT" TMPDIR="${CC_UI_JSI_TMPDIR:?}" CFFIXED_USER_HOME="$HOME")'
    if (!original.includes(from) && !original.includes(to)) throw Error('Unknown Expo JSI environment setup; refusing to alter dependency script')
    const cacheFrom = '-derivedDataPath "$DERIVED_DATA_PATH"'
    const cacheTo = '-packageCachePath "$CC_UI_JSI_PACKAGE_CACHE" -derivedDataPath "$DERIVED_DATA_PATH"'
    if (!original.includes(cacheFrom)) throw Error('Unknown Expo JSI cache setup')
    const patched = original.replace(from, to).replace(original.includes(cacheTo) ? cacheTo : cacheFrom, cacheTo)
    await writeFile(scriptPath, patched)
    const packageDir = dirname(dirname(scriptPath))
    const rn = await insideLab(join(cwd, 'node_modules/react-native'))
    const developer = environment.DEVELOPER_DIR ?? execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).trim()
    await execute('swift-package-metadata', '/usr/bin/env', ['-i', `PATH=${extraEnv.CC_UI_JSI_PATH}`, `HOME=${home}`,
      `PODS_ROOT=${join(cwd, 'ios/Pods')}`, `RN_ROOT=${rn}`, `TMPDIR=${jsiTemp}`, `CFFIXED_USER_HOME=${home}`, `DEVELOPER_DIR=${developer}`, `__CF_USER_TEXT_ENCODING=0x${process.getuid().toString(16).toUpperCase()}:0:0`,
      '/usr/bin/xcodebuild', '-resolvePackageDependencies', '-scheme', 'ExpoModulesJSI', '-derivedDataPath', join(packageDir, '.DerivedData'), '-packageCachePath', extraEnv.CC_UI_JSI_PACKAGE_CACHE, '-sdk', 'iphonesimulator',
      '-destination', 'generic/platform=iOS Simulator', '-configuration', 'Release'], { cwd: packageDir, offline: false })
    await writeFile(prepareFile, JSON.stringify({ source, nativeLockHash: await nativeLockHash(), jsiScriptHash: createHash('sha256').update(patched).digest('hex') }))
    return { source, prepared: true, note: 'Public dependencies only; build and UI execution remain offline' }
  }
  const app = join(root, 'build/Build/Products/Release-iphonesimulator/Tendhearth.app')
  const receiptFile = join(root, 'build-receipt.json')
  if (request.command === 'app-build') {
    await rm(receiptFile, { force: true })
    const prepared = JSON.parse(await readFile(prepareFile, 'utf8'))
    if (JSON.stringify(prepared.source) !== JSON.stringify(source) || prepared.nativeLockHash !== await nativeLockHash()) throw Error('App preparation does not match the active snapshot; run app-prepare')
    if (prepared.jsiScriptHash !== createHash('sha256').update(await readFile(await jsiScript())).digest('hex')) throw Error('Expo JSI preparation changed; run app-prepare')
    await execute('app-build', '/usr/bin/xcodebuild', ['-workspace', 'ios/Tendhearth.xcworkspace', '-scheme', 'Tendhearth',
      '-configuration', 'Release', '-jobs', '2', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', join(root, 'build'), 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', 'CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_REQUIRED=NO', 'build'])
    await insideLab(app)
    await readFile(join(app, 'main.jsbundle'))
    await writeFile(receiptFile, JSON.stringify({ source, app, configuration: 'Release', metro: false }))
    return { source, app }
  }
  let receipt
  try { receipt = JSON.parse(await readFile(receiptFile, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') throw Error('APP_BLOCKED: no successful build for the active App snapshot; run app-build and inspect its artifacts'); throw error }
  if (JSON.stringify(receipt.source) !== JSON.stringify(source) || receipt.app !== app) throw Error('App build does not match the active snapshot')
  await insideLab(app)
  await insideLab(java)
  // A separate device set prevents selecting or clearing an owner's existing simulator.
  const devices = join(root, 'simulators')
  await mkdir(devices, { recursive: true, mode: 0o700 })
  // Maestro invokes xcrun through PATH. Scope every simctl request to this set;
  // setting HOME alone does not change CoreSimulator's default device set.
  const bin = join(root, 'maestro-bin')
  await mkdir(bin, { recursive: true, mode: 0o700 })
  const wrapper = join(bin, 'xcrun')
  await writeFile(wrapper, `#!/opt/homebrew/bin/node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const result = spawnSync('/usr/bin/xcrun', args[0] === 'simctl' ? ['simctl', '--set', ${JSON.stringify(devices)}, ...args.slice(1)] : args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`)
  await chmod(wrapper, 0o700)
  extraEnv.PATH = `${bin}:${extraEnv.PATH}`
  const sim = ['simctl', '--set', devices]
  const deviceFile = join(root, 'simulator.json')
  let udid
  try { udid = JSON.parse(await readFile(deviceFile, 'utf8')).udid } catch (error) { if (error.code !== 'ENOENT') throw error }
  const simOutput = args => execFileSync('/usr/bin/xcrun', [...sim, ...args], { encoding: 'utf8', env: { ...environment, ...extraEnv } }).trim()
  if (!udid) {
    const runtimes = JSON.parse(simOutput(['list', 'runtimes', '-j'])).runtimes
    const runtime = runtimes.find(value => value.isAvailable && value.identifier.includes('.iOS-'))
    if (!runtime) throw Error('APP_BLOCKED: install an iOS simulator runtime in Xcode on the mini')
    udid = simOutput(['create', 'CC UI Lab App', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', runtime.identifier])
    await writeFile(deviceFile, JSON.stringify({ udid }), { flag: 'wx' })
  }
  const device = Object.values(JSON.parse(simOutput(['list', 'devices', '-j'])).devices).flat().find(value => value.udid === udid)
  if (!device || device.name !== 'CC UI Lab App') throw Error('APP_BLOCKED: configured simulator is not the lab device')
  const flow = appFlow(request.flow)
  const available = (await readdir(join(cwd, '.maestro'))).filter(name => name.endsWith('.yaml')).map(name => name.slice(0, -5))
  if (!available.length || (flow !== 'all' && !available.includes(flow))) throw Error('Requested Maestro flow is absent from the snapshot')
  if (available.some(name => !APP_FLOWS.includes(name))) throw Error('Snapshot has unregistered Maestro flows; update the allowlist first')
  const flows = flow === 'all' ? available.sort() : [flow]
  const results = []
  try {
    if (device.state !== 'Booted') await execute('simulator-boot', '/usr/bin/xcrun', [...sim, 'boot', udid])
    await execute('simulator-ready', '/usr/bin/xcrun', [...sim, 'bootstatus', udid, '-b'])
    await execute('app-install', '/usr/bin/xcrun', [...sim, 'install', udid, app])
    // Maestro 2.12's bundled standalone runner supports custom device sets.
    // xcodebuild's destination discovery only sees the default set on Xcode 27.
    const driver = join(root, 'maestro-driver')
    await mkdir(driver, { recursive: true, mode: 0o700 })
    await execute('maestro-driver-extract', '/usr/bin/unzip', ['-qo', join(tools, 'maestro/lib/maestro-ios-driver.jar'), 'driver-iPhoneSimulator/*', '-d', driver])
    const products = join(driver, 'driver-iPhoneSimulator/Debug-iphonesimulator')
    await execute('maestro-runner-extract', '/usr/bin/unzip', ['-qo', join(products, 'maestro-driver-iosUITests-Runner.zip'), '-d', products])
    const runner = await insideLab(join(products, 'maestro-driver-iosUITests-Runner.app'))
    await execute('maestro-runner-install', '/usr/bin/xcrun', [...sim, 'install', udid, runner])
    extraEnv.USE_XCODE_TEST_RUNNER = '1'

    for (const name of flows) {
      try {
        const controller = new AbortController()
        const debug = join(run, name, 'debug')
        const maestro = execute(`maestro-${name}`, join(tools, 'maestro/bin/maestro'), ['--device', udid, 'test',
          '--test-output-dir', join(run, name), '--debug-output', debug, `.maestro/${name}.yaml`])
          .finally(() => controller.abort())
        const runner = waitForDriverPort(debug, udid, controller.signal).then(port =>
          execute(`maestro-runner-launch-${name}`, '/usr/bin/xcrun', [...sim, 'launch', '--terminate-running-process', udid, 'dev.mobile.maestro-driver-iosUITests.xctrunner'], {
            extraEnv: { ...extraEnv, SIMCTL_CHILD_PORT: String(port) },
          }))
        // Never shut down the device while either child is still using it.
        const settled = await Promise.allSettled([maestro, runner])
        const failed = settled.find(result => result.status === 'rejected')
        if (failed) throw failed.reason
        results.push({ flow: name, ok: true })
      } catch (error) { results.push({ flow: name, ok: false, error: error.message }) }
    }
    await writeFile(join(run, 'app-results.json'), JSON.stringify({ source, udid, results }, null, 2))
    if (results.some(result => !result.ok)) throw Error(`Maestro failed: ${JSON.stringify(results)}`)
    return { source, udid, results }
  } finally {
    await execute('simulator-shutdown', '/usr/bin/xcrun', [...sim, 'shutdown', udid])
  }
}
