import { posix, win32 } from 'node:path'
import { test, expect } from 'vitest'
import { assertMiniIdentity, assertLoopbackEndpoint, assertEmbeddedEndpoint, createOfflineSession, sshInvocation } from './macmini-ui-protocol.mjs'
import * as protocol from './macmini-ui-protocol.mjs'

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

test('the secondary test Mini is allowed only with its exact machine and user pair', () => {
  expect(() => assertMiniIdentity({ computerName: 'Homebot’s Mac mini', homeDir: '/Users/homebot', platformName: 'darwin' })).not.toThrow()
  for (const identity of [
    { computerName: 'Homebot’s Mac mini', homeDir: '/Users/home', platformName: 'darwin' },
    { computerName: 'Home’s Mac mini', homeDir: '/Users/homebot', platformName: 'darwin' },
    { computerName: 'Homebot’s Mac mini', homeDir: '/Users/homebot', platformName: 'linux' },
  ]) expect(() => assertMiniIdentity(identity)).toThrow(/Mac mini/)
})

test('each allowed Mini has a fixed isolated lab configuration', () => {
  expect(protocol.miniConfiguration({ computerName: 'Homebot’s Mac mini', homeDir: '/Users/homebot', platformName: 'darwin' })).toMatchObject({
    labHome: '/Users/homebot/ci/cc-ui-lab', root: '/Users/homebot/ci/cc-ui-lab/cc-pet-feel-20261101',
    sharedLock: '/Users/homebot/ci/lock',
  })
  expect(protocol.miniConfiguration({ computerName: 'Home’s Mac mini', homeDir: '/Users/home', platformName: 'darwin' })).toMatchObject({
    labHome: '/Users/home/cc-ui-lab', root: '/Users/home/cc-ui-lab/cc-motion-drag-20261030',
  })
})

test('secondary sessions remain inside their own QA lab without crossing machine roots', () => {
  const secondary = '/Users/homebot/ci/cc-ui-lab/cc-pet-feel-20261101'
  const input = { ...fixture(), appPath: `${secondary}/QA.app`, stateRoot: `${secondary}/artifacts/test/state` }
  expect(createOfflineSession(input).capabilities.alwaysMatch['appium:environment'].WECHAT_STATE_DIR).toBe(`${input.stateRoot}/daemon`)
  for (const invalid of [
    { ...input, stateRoot: `${lab}/state` },
    { ...input, appPath: '/Users/homebot/ci/other/QA.app' },
    { ...input, stateRoot: `${secondary}/../../outside` },
  ]) expect(() => createOfflineSession(invalid)).toThrow(/QA|lab/)
})

test('secondary SSH execution requires an explicit known target and never falls back locally', () => {
  const request = sshInvocation('embedded', 'homebot')
  expect(request.file).toBe('ssh')
  expect(request.args).toContain('homebot-mac-mini')
  expect(request.args.at(-1)).toContain('/Users/homebot/ci/cc-ui-lab/run.mjs')
  expect(request.args).toContain('StrictHostKeyChecking=yes')
  for (const target of ['localhost', 'primary', 'unknown', 'homebot; touch /tmp/unsafe']) expect(() => sshInvocation('embedded', target)).toThrow(/target/)
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

test('App commands share the strict SSH transport and reject arbitrary flows and fields at both boundaries', () => {
  expect(sshInvocation('app-status').args.at(-1)).toContain('/cc-ui-lab/app-run.mjs')
  expect(JSON.parse(sshInvocation('app-status').input)).toEqual({ command: 'app-status' })
  expect(JSON.parse(sshInvocation('app-build').input)).toEqual({ command: 'app-build' })
  for (const flow of ['all', 'terminal-sessions', 'push-open', 'cc-acts']) {
    const request = { command: 'app-maestro', flow }
    expect(JSON.parse(sshInvocation('app-maestro', 'home', undefined, flow).input)).toEqual(request)
    expect(protocol.validateRequest(request)).toEqual(request)
  }
  for (const flow of ['../private', 'push-open.yaml', 'x; touch /tmp/x', '', null, {}, ['all']]) {
    expect(() => sshInvocation('app-maestro', 'home', undefined, flow)).toThrow(/flow/)
    expect(() => protocol.validateRequest({ command: 'app-maestro', flow })).toThrow(/flow/)
  }
  for (const request of [{ command: 'app-status', flow: 'all' }, { command: 'app-maestro', file: '/tmp/x' }, { command: 'shell' }, null]) {
    expect(() => protocol.validateRequest(request)).toThrow()
  }
})

for (const [flavour, paths, root, cases] of [
  ['posix', posix, '/tmp/lab', [
    ['/tmp/lab/snapshot', true], ['/tmp/lab/./snapshot/../build', true],
    ['/tmp/lab', false], ['/tmp/lab/', false], ['/tmp/lab/..', false],
    ['/tmp/lab/../outside', false], ['/tmp/lab-other/snapshot', false],
    ['/tmp/LAB/snapshot', false], ['/elsewhere', false], ['/tmp/lab/..cache', true],
  ]],
  ['win32', win32, 'C:/Temp/Lab', [
    ['C:/Temp/Lab/snapshot', true], [String.raw`c:\temp\LAB\snapshot`, true],
    ['C:/Temp/Lab/./snapshot/../build', true], ['C:/Temp/Lab', false],
    ['C:/Temp/Lab/', false], ['C:/Temp/Lab/..', false],
    [String.raw`C:\Temp\Lab\..\outside`, false], ['C:/Temp/Lab-other/snapshot', false],
    ['D:/Temp/Lab/snapshot', false], ['//server/share/Lab/snapshot', false],
    ['C:/Temp/Lab/..cache', true],
  ]],
  ['win32 UNC', win32, '//server/share/Lab', [
    [String.raw`\\SERVER\SHARE\lab\snapshot`, true],
    ['//server/share/Lab/../outside', false], ['//server/other/Lab/snapshot', false],
    ['//other/share/Lab/snapshot', false], ['//server/share/Lab', false],
  ]],
]) {
  test.each(cases)(`${flavour} lab containment: %s => %s`, (candidate, expected) => {
    expect(protocol.isInsideLab(root, candidate, paths)).toBe(expected)
  })
}
