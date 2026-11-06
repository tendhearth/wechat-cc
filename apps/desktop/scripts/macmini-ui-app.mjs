// App work executes only after the parent runner validates mini identity and owns its lock.
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_FLOWS, appFlow } from './macmini-ui-protocol.mjs'

export async function appStatus({ config, insideLab, labHome }) {
  const probe = (file, args) => {
    try { return execFileSync(file, args, { encoding: 'utf8', timeout: 20000 }).trim() }
    catch (error) { return { missing: true, detail: error.message } }
  }
  const tools = join(labHome, 'app-tools')
  const appRoot = config.appRoot ? await insideLab(config.appRoot) : null
  return { appRoot, source: appRoot ? JSON.parse(await readFile(join(appRoot, 'snapshot.json'), 'utf8')) : null,
    xcode: probe('/usr/bin/xcodebuild', ['-version']),
    simulators: probe('/usr/bin/xcrun', ['simctl', 'list', '-j']),
    tools, productionAccess: false, localFallback: false,
    note: 'Requires app-tools/{maestro,java,gems}, prepared Expo dependencies and Pods. Status never boots a simulator.' }
}

export async function runApp({ request, config, insideLab, labHome, run, command, environment }) {
  if (!config.appRoot) throw Error('APP_BLOCKED: integrator must place an App snapshot and set active.json appRoot')
  const root = await insideLab(config.appRoot)
  const project = await insideLab(join(root, 'project'))
  const cwd = await insideLab(join(project, 'apps/app'))
  const source = JSON.parse(await readFile(join(root, 'snapshot.json'), 'utf8'))
  const tools = await insideLab(join(labHome, 'app-tools'))
  const java = await insideLab(join(tools, 'java/Contents/Home'))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const extraEnv = { HOME: home, CFFIXED_USER_HOME: home, JAVA_HOME: java,
    GEM_HOME: join(tools, 'gems'), GEM_PATH: join(tools, 'gems'),
    PATH: `${tools}/gems/bin:${java}/bin:${tools}/maestro/bin:${environment.PATH}`,
    EXPO_NO_TELEMETRY: '1', EXPO_OFFLINE: '1', MAESTRO_CLI_NO_ANALYTICS: 'true',
    NODE_BINARY: '/opt/homebrew/bin/node', RCT_NO_LAUNCH_PACKAGER: '1' }
  const execute = (label, file, args, options = {}) => command(label, file, args, { cwd, extraEnv, ...options })
  // A separate device set prevents selecting or clearing an owner's existing simulator.
  const devices = join(root, 'simulators')
  await mkdir(devices, { recursive: true, mode: 0o700 })
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
  const app = join(root, 'build/Build/Products/Release-iphonesimulator/Tendhearth.app')
  const receiptFile = join(root, 'build-receipt.json')
  if (request.command === 'app-build') {
    await execute('expo-prebuild', '/opt/homebrew/bin/node', ['node_modules/expo/bin/cli', 'prebuild', '--platform', 'ios', '--no-install'])
    await execute('pods', join(tools, 'gems/bin/pod'), ['install', '--no-repo-update'], { cwd: join(cwd, 'ios') })
    await execute('app-build', '/usr/bin/xcodebuild', ['-workspace', 'ios/Tendhearth.xcworkspace', '-scheme', 'Tendhearth',
      '-configuration', 'Release', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', join(root, 'build'), 'CODE_SIGNING_ALLOWED=NO', 'build'])
    await insideLab(app)
    await readFile(join(app, 'main.jsbundle'))
    await writeFile(receiptFile, JSON.stringify({ source, app, configuration: 'Release', metro: false }))
    return { source, app, udid }
  }
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'))
  if (JSON.stringify(receipt.source) !== JSON.stringify(source) || receipt.app !== app) throw Error('App build does not match the active snapshot')
  await insideLab(app)
  const flow = appFlow(request.flow)
  const available = (await readdir(join(cwd, '.maestro'))).filter(name => name.endsWith('.yaml')).map(name => name.slice(0, -5))
  if (available.some(name => !APP_FLOWS.includes(name))) throw Error('Snapshot has unregistered Maestro flows; update the allowlist first')
  const flows = flow === 'all' ? available.sort() : [flow]
  const results = []
  try {
    if (device.state !== 'Booted') await execute('simulator-boot', '/usr/bin/xcrun', [...sim, 'boot', udid])
    await execute('simulator-ready', '/usr/bin/xcrun', [...sim, 'bootstatus', udid, '-b'])
    await execute('app-install', '/usr/bin/xcrun', [...sim, 'install', udid, app])
    for (const name of flows) {
      try {
        await execute(`maestro-${name}`, join(tools, 'maestro/bin/maestro'), ['--device', udid, 'test',
          '--test-output-dir', join(run, name), '--debug-output', join(run, name, 'debug'), `.maestro/${name}.yaml`])
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
