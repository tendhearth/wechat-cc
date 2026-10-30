// Runs ONLY inside the mini's isolated process; no system pointer APIs.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, writeFile, realpath } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertMiniIdentity, assertEmbeddedEndpoint, createOfflineSession } from './macmini-ui-protocol.mjs'

assertMiniIdentity({ computerName: execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim(),
  homeDir: homedir(), platformName: process.platform })
const endpoint = assertEmbeddedEndpoint('http://127.0.0.1:4199')
const lab = '/Users/home/cc-ui-lab/cc-motion-drag-20261030'
const output = await realpath(process.env.CC_UI_ARTIFACT_DIR)
assert(output.startsWith(lab + '/artifacts/'))
const app = await realpath(join(lab, 'native-target/debug/bundle/macos/Tendhearth CC Motion QA.app'))
const plist = join(app, 'Contents/Info.plist')
const info = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim()
assert.equal(info('CFBundleIdentifier'), 'com.tendhearth.cc-motion-qa-20261029')
const name = info('CFBundleExecutable')
assert(name && !name.includes('/') && name !== '.' && name !== '..')
const executable = await realpath(join(app, 'Contents/MacOS', name))
assert(executable.startsWith(app + '/Contents/MacOS/'))
const stateRoot = join(output, 'app-state')
const environment = { ...process.env, ...createOfflineSession({ bundleId: info('CFBundleIdentifier'), appPath: app, stateRoot }).capabilities.alwaysMatch['appium:environment'] }
for (const folder of ['daemon', 'workbench']) await mkdir(join(stateRoot, folder), { recursive: true, mode: 0o700 })

async function api(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(endpoint + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  if (!response.ok) throw Error(result.value?.message ?? `Embedded WebDriver ${response.status}`)
  return result.value
}
try { await api('/status'); throw Error('The embedded port is already in use; refusing to attach to another run') }
catch (error) { if (!error.message.includes('fetch failed')) throw error }

const log = createWriteStream(join(output, 'qa-app.log'))
const child = spawn(executable, [], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
let exit, spawnError, session
child.once('exit', (code, signal) => { exit = { code, signal } })
child.once('error', error => { spawnError = error })
const report = { sourceCommit: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceDirty: Boolean(execFileSync('/usr/bin/git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
  app, identifier: info('CFBundleIdentifier'), pid: child.pid, endpoint,
  input: 'synthetic WebKit DOM events; no global mouse input', checks: [] }

async function until(label, callback, timeout = 20000) {
  const deadline = Date.now() + timeout
  let failure
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (exit) throw Error(`QA application exited: ${JSON.stringify(exit)}`)
    try { const value = await callback(); if (value) return value } catch (error) { failure = error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error(`${label} timed out${failure ? ': ' + failure.message : ''}`)
}

try {
  await until('Embedded service', async () => (await api('/status')).ready)
  const created = await api('/session', { capabilities: { alwaysMatch: {
    browserName: 'tauri', 'wdio:tauriServiceOptions': { windowLabel: 'main' },
  } } })
  session = created.sessionId
  assert(session)
  const command = (path, body, method) => api(`/session/${session}${path}`, body, method)
  const execute = (script, args = []) => command('/execute/sync', { script, args })
  const invoke = (name, args = {}) => command('/execute/async', {
    script: 'const done=arguments[arguments.length-1]; window.__TAURI__.core.invoke(arguments[0],arguments[1]).then(value=>done({ok:true,value})).catch(error=>done({ok:false,error:String(error)}));', args: [name, args],
  })
  const click = async selector => {
    const element = await command('/element', { using: 'css selector', value: selector })
    const id = element['element-6066-11e4-a52e-4f735466cecf']
    assert(id, `No element for ${selector}`)
    await command(`/element/${id}/click`, {})
  }
  const switchWindow = handle => command('/window', { handle })
  const screenshot = async name => {
    const path = join(output, name + '.png')
    await writeFile(path, Buffer.from(await command('/screenshot'), 'base64'))
    return path
  }
  await until('Real QA WebKit initialization', async () => (await execute('return document.getElementById("native-state").textContent')).includes('native QA ready'))
  assert((await execute('return location.href')).startsWith('tauri:') || (await execute('return location.href')).includes('localhost'))
  report.checks.push('real QA WebKit loaded')
  const first = await screenshot('main-before')
  await execute('document.body.style.backgroundColor="#ff00a5"; document.getElementById("native-state").textContent="embedded WebKit paint checkpoint"; return document.getElementById("native-state").textContent')
  await until('DOM update', async () => (await execute('return document.getElementById("native-state").textContent')) === 'embedded WebKit paint checkpoint')
  const second = await screenshot('main-after')
  const images = JSON.parse(execFileSync('/usr/bin/swift', [join(process.cwd(), 'apps/desktop/scripts/fixtures/qa-image-proof.swift'), first, second], { encoding: 'utf8', timeout: 90000 }))
  assert(images.every(image => image.sampledColors > 4), 'WebKit snapshots are blank or uniform')
  assert.notEqual(images[0].pixelSHA256, images[1].pixelSHA256, 'WebKit paint did not reach the snapshot')
  report.images = images
  report.checks.push('changed nonblank WKWebView snapshots')
  const refused = await invoke('wechat_cli_json', { args: ['status'] })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /CLI and daemon execution are disabled/)
  report.checks.push('native CLI/backend blocked before execution')
  await click('#open')
  await until('Native companion opened', async () => (await command('/window/handles')).includes('companion'))
  await switchWindow('companion')
  await until('Production companion WebKit', () => execute('return Boolean(document.getElementById("pet-stage") && document.getElementById("pet-sprite").naturalWidth > 0)'))
  const before = await command('/window/rect')
  await click('#pet-zoom-in')
  const enlarged = await until('Native resize', async () => {
    const rect = await command('/window/rect'); return rect.width > before.width && rect.height > before.height ? rect : null
  })
  await click('#pet-zoom-out')
  await until('Native size restored', async () => {
    const rect = await command('/window/rect'); return Math.abs(rect.width - before.width) <= 1 && Math.abs(rect.height - before.height) <= 1
  })
  const companionImage = await screenshot('companion')
  const imageProof = JSON.parse(execFileSync('/usr/bin/swift', [join(process.cwd(), 'apps/desktop/scripts/fixtures/qa-image-proof.swift'), companionImage], { encoding: 'utf8', timeout: 90000 }))[0]
  assert(imageProof.sampledColors > 4, 'Companion WebKit snapshot is blank')
  report.images.push(imageProof)
  report.nativeResize = { before, enlarged, restored: await command('/window/rect') }
  report.checks.push('production controls change actual native window dimensions')
  await switchWindow('main'); await click('#close')
  await until('Companion closed', async () => !(await command('/window/handles')).includes('companion'))
  report.checks.push('native companion closed')
  await click('#open')
  await until('Companion reopened', async () => (await command('/window/handles')).includes('companion'))
  await switchWindow('companion')
  const reopened = await command('/window/rect')
  const restored = report.nativeResize.restored
  assert(['x', 'y', 'width', 'height'].every(key => Math.abs(reopened[key] - restored[key]) <= 1), 'Reopened native placement differs')
  report.nativeResize.reopened = reopened
  report.checks.push('native placement restored after closing and reopening')
  await switchWindow('main'); await click('#close')
  report.ok = true
} catch (error) {
  report.ok = false; report.error = error.stack
  throw error
} finally {
  await writeFile(join(output, 'embedded-report.json'), JSON.stringify(report, null, 2))
  if (session && !exit) await api(`/session/${session}`, undefined, 'DELETE').catch(() => {})
  if (!exit) {
    child.kill('SIGTERM')
    await new Promise(resolve => { const timer = setTimeout(() => { if (!exit) child.kill('SIGKILL'); resolve() }, 5000); child.once('exit', () => { clearTimeout(timer); resolve() }) })
  }
  log.end()
  console.log(JSON.stringify(report))
}
