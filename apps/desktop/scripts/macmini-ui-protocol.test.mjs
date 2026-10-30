import { test, expect } from 'vitest'
import { assertMiniIdentity, assertLoopbackEndpoint, assertEmbeddedEndpoint, createOfflineSession, sshInvocation } from './macmini-ui-protocol.mjs'

const lab = '/Users/home/cc-ui-lab/cc-motion-drag-20261030'
const fixture = () => ({ bundleId: 'com.tendhearth.cc-motion-qa-20261029',
  appPath: `${lab}/native-target/debug/bundle/macos/Tendhearth CC Motion QA.app`, stateRoot: `${lab}/state/run-1` })

test('embedded WebKit requests stay on the dedicated loopback service', () => {
  expect(assertEmbeddedEndpoint('http://127.0.0.1:4199')).toBe('http://127.0.0.1:4199')
  for (const endpoint of ['http://0.0.0.0:4199', 'http://example.com:4199', 'http://127.0.0.1:4723',
    'http://user:secret@127.0.0.1:4199', 'http://127.0.0.1:4199/other', 'http://127.0.0.1:4199?token=secret']) {
    expect(() => assertEmbeddedEndpoint(endpoint)).toThrow(/loopback/)
  }
})

test('embedded requests use the same SSH-only executor', () => {
  const request = sshInvocation('embedded')
  expect(request.file).toBe('ssh')
  expect(JSON.parse(request.input)).toEqual({ command: 'embedded' })
  expect(request.args).toContain('ForwardAgent=no')
})

test('only the configured mini identity may execute desktop commands', () => {
  expect(() => assertMiniIdentity({ computerName: 'Home’s Mac mini', homeDir: '/Users/home', platformName: 'darwin' })).not.toThrow()
  for (const identity of [
    { computerName: 'nategu_mac_company’s MacBook Pro', homeDir: '/Users/nategu_mac_company', platformName: 'darwin' },
    { computerName: 'Home’s Mac mini', homeDir: '/Users/home', platformName: 'linux' },
    { computerName: 'Home’s Mac mini', homeDir: '/Users/another', platformName: 'darwin' },
  ]) expect(() => assertMiniIdentity(identity)).toThrow(/Mac mini/)
})

test('the UI API cannot be redirected to a LAN/public host, credentials or another endpoint', () => {
  expect(assertLoopbackEndpoint('http://127.0.0.1:4723')).toBe('http://127.0.0.1:4723')
  for (const endpoint of ['http://0.0.0.0:4723', 'http://example.com:4723', 'http://127.0.0.1:8080',
    'http://user:secret@127.0.0.1:4723', 'http://127.0.0.1:4723/other', 'http://127.0.0.1:4723?token=secret']) {
    expect(() => assertLoopbackEndpoint(endpoint)).toThrow(/loopback/)
  }
})

test('the native session is explicitly bound to QA and isolated empty-state paths', () => {
  const caps = createOfflineSession(fixture()).capabilities.alwaysMatch
  expect(caps).toMatchObject({ platformName: 'mac', 'appium:automationName': 'mac2',
    'appium:bundleId': fixture().bundleId, 'appium:systemHost': '127.0.0.1', 'appium:systemPort': 10100,
    'appium:noReset': false, 'appium:environment': {
      WECHAT_STATE_DIR: `${lab}/state/run-1/daemon`,
      WECHAT_CC_WORKBENCH_STATE_DIR: `${lab}/state/run-1/workbench`, WECHAT_CC_NO_BUNDLE_MIGRATE: '1',
    } })
  expect(Object.keys(caps['appium:environment']).sort()).toEqual(['WECHAT_CC_NO_BUNDLE_MIGRATE', 'WECHAT_CC_WORKBENCH_STATE_DIR', 'WECHAT_STATE_DIR'])
  expect(caps).not.toHaveProperty('appium:prerun')
  expect(caps).not.toHaveProperty('appium:postrun')
})

test('production apps and paths outside the lab fail before any UI session is created', () => {
  for (const input of [
    { ...fixture(), bundleId: 'com.tendhearth.wechat-cc' },
    { ...fixture(), bundleId: 'com.apple.finder' },
    { ...fixture(), appPath: '/Applications/Tendhearth CC.app' },
    { ...fixture(), appPath: `${lab}/../../Applications/QA.app` },
    { ...fixture(), stateRoot: '/Users/home/.claude/channels/wechat' },
  ]) expect(() => createOfflineSession(input)).toThrow(/QA|lab/)
})

test('even the native input control remains an isolated test app', () => {
  const caps = createOfflineSession({ ...fixture(), bundleId: 'com.tendhearth.cc-native-control-20261030', appPath: `${lab}/Native Input Control.app` }).capabilities.alwaysMatch
  expect(caps['appium:bundleId']).toBe('com.tendhearth.cc-native-control-20261030')
})

test('the local entry transports a bounded request through strict SSH, with no desktop fallback', () => {
  const request = sshInvocation('native-smoke')
  expect(request.file).toBe('ssh')
  expect(request.args).toContain('homes-mac-mini')
  expect(request.args).toContain('BatchMode=yes')
  expect(request.args).toContain('StrictHostKeyChecking=yes')
  expect(request.args).toContain('ForwardAgent=no')
  expect(request.args).toContain('ForwardX11=no')
  expect(request.args).toContain('PermitLocalCommand=no')
  expect(request.args).toContain('ClearAllForwardings=yes')
  expect(request.args.at(-1)).toContain('/Users/home/cc-ui-lab/run.mjs')
  expect(JSON.parse(request.input)).toEqual({ command: 'native-smoke' })
  for (const command of ['osascript', 'native-smoke; touch /tmp/unsafe', 'shell', '']) {
    expect(() => sshInvocation(command)).toThrow(/command/)
  }
})
