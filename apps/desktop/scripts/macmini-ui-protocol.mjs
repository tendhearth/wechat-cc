// Pure boundaries for the dedicated, offline Mac mini UI executor.
import { posix } from 'node:path'

const QA_APPS = new Set(['com.tendhearth.cc-motion-qa-20261029', 'com.tendhearth.cc-native-control-20261030'])
const COMMANDS = new Set(['status', 'doctor', 'native-smoke', 'browser', 'unit', 'full', 'full-platform', 'capture', 'embedded', 'embedded-build', 'production-build', 'affected', 'app-status', 'app-build', 'app-maestro'])

const MINIS = Object.freeze({
  home: { computerName: 'Home’s Mac mini', homeDir: '/Users/home', labHome: '/Users/home/cc-ui-lab',
    root: '/Users/home/cc-ui-lab/cc-motion-drag-20261030', host: 'homes-mac-mini', sharedLock: null,
    bun: '/Users/home/.bun/bin/bun', cargo: '/Users/home/cc-ui-lab/cc-motion-drag-20261030/toolchain/bin/cargo' },
  homebot: { computerName: 'Homebot’s Mac mini', homeDir: '/Users/homebot', labHome: '/Users/homebot/ci/cc-ui-lab',
    root: '/Users/homebot/ci/cc-ui-lab/cc-pet-feel-20261101', host: 'homebot-mac-mini', sharedLock: '/Users/homebot/ci/lock',
    bun: '/Users/homebot/ci/cc-ui-lab/cc-pet-feel-20261101/toolchain/bin/bun',
    cargo: '/Users/homebot/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo',
    rustc: '/Users/homebot/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc' },
})

export function miniConfiguration({ computerName, homeDir, platformName }) {
  const mini = platformName === 'darwin' && Object.values(MINIS).find(value => value.computerName === computerName && value.homeDir === homeDir)
  if (!mini) throw Error('UI execution requires a configured Mac mini; no local desktop fallback is allowed')
  return { ...mini }
}

export function assertMiniIdentity(identity) { miniConfiguration(identity) }

export function assertLoopbackEndpoint(value) {
  return loopbackEndpoint(value, 4723)
}

function loopbackEndpoint(value, port) {
  let url
  try { url = new URL(value) } catch { throw Error('UI API must use the dedicated loopback endpoint') }
  if (url.origin !== `http://127.0.0.1:${port}` || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('UI API must use the dedicated loopback endpoint')
  }
  return url.origin
}

export function assertEmbeddedEndpoint(value) {
  return loopbackEndpoint(value, 4199)
}

function labPath(value) {
  const mini = typeof value === 'string' && Object.values(MINIS).find(mini => value.startsWith(mini.labHome + '/'))
  if (!mini || value.includes('\0') || posix.normalize(value) !== value) {
    throw Error('QA paths must remain inside the dedicated UI lab')
  }
  return mini.labHome
}

export function createOfflineSession({ bundleId, appPath, stateRoot }) {
  if (!QA_APPS.has(bundleId)) throw Error('Only isolated QA applications may be controlled')
  if (labPath(appPath) !== labPath(stateRoot)) throw Error('QA app and state must use the same Mini lab')
  if (!appPath.endsWith('.app')) throw Error('QA application path must name an app bundle')
  return { capabilities: { alwaysMatch: {
    platformName: 'mac', 'appium:automationName': 'mac2', 'appium:bundleId': bundleId, 'appium:appPath': appPath,
    'appium:environment': {
      WECHAT_STATE_DIR: posix.join(stateRoot, 'daemon'),
      WECHAT_CC_WORKBENCH_STATE_DIR: posix.join(stateRoot, 'workbench'), WECHAT_CC_NO_BUNDLE_MIGRATE: '1',
    },
    'appium:systemHost': '127.0.0.1', 'appium:systemPort': 10100, 'appium:noReset': false,
    'appium:showServerLogs': true, 'appium:serverStartupTimeout': 120000, 'appium:newCommandTimeout': 180,
  } } }
}

export const APP_FLOWS = Object.freeze(['agent-avatars', 'approve', 'chat', 'chat-extras', 'connections', 'compose', 'worktree', 'quota-handoff', 'demo-walkthrough', 'pair-invalid', 'pair-link', 'terminal-sessions', 'push-open', 'cc-acts', 'continue-session', 'design-shots'])

export function appFlow(value = 'all') {
  if (value !== 'all' && !APP_FLOWS.includes(value)) throw Error('Unsupported App flow')
  return value
}

export function validateRequest(request) {
  if (!request || typeof request !== 'object' || !COMMANDS.has(request.command)) throw Error('Unsupported UI lab command')
  const keys = Object.keys(request)
  if (keys.some(key => key !== 'command' && !(request.command === 'app-maestro' && key === 'flow'))) throw Error('Unexpected UI lab request fields')
  if (request.command === 'app-maestro') appFlow(request.flow)
  return request
}

export function sshInvocation(command, target = 'home', sshConfig, flow) {
  if (!COMMANDS.has(command)) throw Error('Unsupported UI lab command')
  if (!Object.hasOwn(MINIS, target)) throw Error('Unsupported UI lab target')
  if (sshConfig !== undefined && (typeof sshConfig !== 'string' || !posix.isAbsolute(sshConfig) || sshConfig.includes('\0'))) throw Error('SSH config must be an absolute local path')
  const mini = MINIS[target]
  return { file: 'ssh', args: [...(sshConfig ? ['-F', sshConfig] : []), '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=6',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no', '-o', 'ClearAllForwardings=yes',
    mini.host, `env PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin /opt/homebrew/bin/node ${mini.labHome}/run.mjs`],
  input: JSON.stringify(validateRequest({ command, ...(flow !== undefined ? { flow } : {}) })) + '\n' }
}
