// Pure boundaries for the dedicated, offline Mac mini UI executor.
import { posix } from 'node:path'

const QA_APPS = new Set(['com.tendhearth.cc-motion-qa-20261029', 'com.tendhearth.cc-native-control-20261030'])
const COMMANDS = new Set(['status', 'doctor', 'native-smoke', 'browser', 'unit', 'full', 'full-platform', 'capture', 'embedded', 'embedded-build', 'production-build', 'affected'])

export function assertMiniIdentity({ computerName, homeDir, platformName }) {
  if (computerName !== 'Home’s Mac mini' || homeDir !== '/Users/home' || platformName !== 'darwin') {
    throw Error('UI execution requires the dedicated Mac mini; no local desktop fallback is allowed')
  }
}

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
  if (typeof value !== 'string' || !value.startsWith('/Users/home/cc-ui-lab/') || value.includes('\0') || posix.normalize(value) !== value) {
    throw Error('QA paths must remain inside the dedicated UI lab')
  }
  return value
}

export function createOfflineSession({ bundleId, appPath, stateRoot }) {
  if (!QA_APPS.has(bundleId)) throw Error('Only isolated QA applications may be controlled')
  labPath(appPath); labPath(stateRoot)
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

export function sshInvocation(command) {
  if (!COMMANDS.has(command)) throw Error('Unsupported UI lab command')
  return { file: 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=6',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no', '-o', 'ClearAllForwardings=yes',
    'homes-mac-mini', 'env PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin /opt/homebrew/bin/node /Users/home/cc-ui-lab/run.mjs'],
  input: JSON.stringify({ command }) + '\n' }
}
