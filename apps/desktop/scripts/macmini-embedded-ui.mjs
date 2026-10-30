// Runs ONLY inside the mini's isolated process; no system pointer APIs.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
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
  report.sessionCapabilities = created.capabilities
  // Recovery-aware native WebKit evaluation is safe to redispatch only for
  // these read-only readiness probes. Never retry a gesture or native mutation.
  const ready = label => until(`${label} initialized WebKit`, () => api('/wdio/eval', {
    window_label: label, timeout_ms: 5000,
    script: label === 'main'
      ? 'arguments[arguments.length-1]({ok:true,value:document.readyState==="complete" && Boolean(window.__TAURI__) && document.getElementById("native-state")?.textContent.includes("native QA ready")});'
      : 'arguments[arguments.length-1]({ok:true,value:window.__ccMotionQAReady===true && document.getElementById("pet-sprite")?.naturalWidth>0});',
  }))
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
  const nativeSequence = () => execute('return window.__ccMotionQACalls?.at(-1)?.sequence ?? 0')
  const nativeSettled = async (name, after) => {
    const receipt = await until(`Native ${name} acknowledgement`, () => execute('return window.__ccMotionQACalls?.find(value=>value.command===arguments[0] && value.sequence>arguments[1]) ?? null', [name, after]))
    assert.equal(receipt.ok, true, receipt.error)
    return receipt
  }
  const nativeClick = async (selector, name) => {
    const sequence = await nativeSequence(); await click(selector); await nativeSettled(name, sequence)
  }
  const screenshot = async name => {
    const path = join(output, name + '.png')
    await writeFile(path, Buffer.from(await command('/screenshot'), 'base64'))
    return path
  }
  await ready('main')
  report.startupRect = await command('/window/rect')
  await screenshot('startup')
  report.initialDocument = await execute('return {url:location.href,readyState:document.readyState,tauri:Boolean(window.__TAURI__),state:document.getElementById("native-state")?.textContent,body:document.body?.innerText?.slice(0,500)}')
  await writeFile(join(output, 'startup.json'), JSON.stringify(report.initialDocument, null, 2))
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
  await until('Open command returned', () => execute('return !document.getElementById("open").disabled'))
  await click('#reset')
  await until('Initial placement reset returned', () => execute('return !document.getElementById("reset").disabled'))
  await switchWindow('companion')
  await ready('companion')
  const before = await command('/window/rect')
  await nativeClick('#pet-zoom-in', 'resize_companion_window')
  const enlarged = await until('Native resize', async () => {
    const rect = await command('/window/rect'); return rect.width > before.width && rect.height > before.height ? rect : null
  })
  await nativeClick('#pet-zoom-out', 'resize_companion_window')
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
  await ready('companion')
  const reopened = await command('/window/rect')
  const restored = report.nativeResize.restored
  assert(['x', 'y', 'width', 'height'].every(key => Math.abs(reopened[key] - restored[key]) <= 1), 'Reopened native placement differs')
  report.nativeResize.reopened = reopened
  report.checks.push('native placement restored after closing and reopening')
  const nativeRead = async () => {
    const nonce = crypto.randomUUID()
    const receipt = await command('/execute/async', {
      script: 'const nonce=arguments[0],done=arguments[arguments.length-1]; let stop; window.__TAURI__.event.listen("cc-motion-qa-native-read-result",({payload})=>{if(payload.nonce===nonce){stop();done(payload)}}).then(unlisten=>{stop=unlisten;return window.__TAURI__.event.emit("cc-motion-qa-native-read",{label:"companion",nonce})}).catch(error=>done({ok:false,error:String(error)}));', args: [nonce],
    })
    assert.equal(receipt.ok, true, receipt.error)
    return receipt.native
  }
  const nativeBefore = await nativeRead()
  const dragSequence = await nativeSequence()
  let start
  const beginGesture = async () => {
    const center = await execute('const r=document.getElementById("pet-stage").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}')
    const rect = await command('/window/rect')
    start = { x: rect.x + center.x, y: rect.y + center.y }
  }
  const input = async (type, dx, dy, buttons) => {
    const rect = await command('/window/rect')
    await execute('const [type,screenX,screenY,clientX,clientY,buttons]=arguments;const el=document.getElementById("pet-stage");const init={view:window,bubbles:true,cancelable:true,button:0,buttons,screenX,screenY,clientX,clientY};el.dispatchEvent(new PointerEvent(type.replace("mouse","pointer"),{...init,pointerId:1,pointerType:"mouse",isPrimary:true}));el.dispatchEvent(new MouseEvent(type,init));return true',
      [type, start.x + dx, start.y + dy, start.x + dx - rect.x, start.y + dy - rect.y, buttons])
  }
  await beginGesture()
  await input('mousedown', 0, 0, 1)
  await input('mousemove', -40, -20, 1)
  await input('mousemove', -80, -40, 1)
  await input('mouseup', -80, -40, 0)
  await nativeSettled('finish_companion_drag', dragSequence)
  const nativeAfter = await nativeRead()
  report.drag = { before: nativeBefore, after: nativeAfter, expectedDelta: { x: -80, y: 40 } }
  assert.equal(nativeBefore.acceptsFirstMouse, true, 'Native companion rejects the first click while inactive')
  await until('Actual native drag displacement', async () => {
    const value = await nativeRead(); report.drag.after = value
    return Math.abs(value.frame.x - nativeBefore.frame.x + 80) <= 1 && Math.abs(value.frame.y - nativeBefore.frame.y - 40) <= 1
  }, 5000)
  assert.equal(report.drag.after.frame.width, nativeBefore.frame.width)
  assert.equal(report.drag.after.frame.height, nativeBefore.frame.height)
  report.checks.push('WebKit gesture moves the actual AppKit window without resizing')
  const sameFrame = (actual, expected) => ['x', 'y', 'width', 'height'].every(key => Math.abs(actual[key] - expected[key]) <= 1)
  const settled = report.drag.after.frame
  const releasedSequence = await nativeSequence()
  await input('mousemove', 400, 400, 0)
  await input('mousemove', 500, 500, 1)
  assert(sameFrame((await nativeRead()).frame, settled), 'Released pointer motion moved the native window')
  assert.equal(await nativeSequence(), releasedSequence, 'Released motion invoked a native operation')
  report.checks.push('released pointer motion cannot continue a drag')

  for (let index = 0; index < 2; index++) {
    await beginGesture()
    const sequence = await nativeSequence()
    await input('mousedown', 0, 0, 1); await input('mouseup', 0, 0, 0)
    await nativeSettled('start_companion_drag', sequence)
  }
  await execute('document.getElementById("pet-stage").dispatchEvent(new MouseEvent("dblclick",{bubbles:true,button:0,detail:2}));return true')
  assert(sameFrame((await nativeRead()).frame, settled), 'Stationary clicks changed native geometry')
  report.checks.push('stationary WebKit click and double-click keep native geometry')

  await beginGesture()
  let sequence = await nativeSequence()
  await input('mousedown', 0, 0, 1); await input('mousemove', 20, 10, 1)
  await nativeSettled('move_companion_window', sequence)
  await execute('window.dispatchEvent(new Event("blur"));return true')
  await nativeSettled('finish_companion_drag', sequence)
  const cancelled = (await nativeRead()).frame
  assert(Math.abs(cancelled.x - settled.x - 20) <= 1 && Math.abs(cancelled.y - settled.y + 10) <= 1)
  sequence = await nativeSequence()
  await input('mousemove', 300, 300, 1)
  assert(sameFrame((await nativeRead()).frame, cancelled), 'Cancelled gesture kept moving')
  assert.equal(await nativeSequence(), sequence)
  // A new gesture must work after cancellation and use the last confirmed origin.
  await beginGesture()
  await input('mousedown', 0, 0, 1); await input('mousemove', -10, 15, 1); await input('mouseup', -10, 15, 0)
  await nativeSettled('finish_companion_drag', sequence)
  const continued = (await nativeRead()).frame
  assert(Math.abs(continued.x - cancelled.x + 10) <= 1 && Math.abs(continued.y - cancelled.y + 15) <= 1)
  report.checks.push('cancel stops movement and the next drag starts from confirmed native position')

  const draggedRect = await command('/window/rect')
  const placementPath = join(homedir(), 'Library/Application Support/com.tendhearth.cc-motion-qa-20261029/ui/companion-placement-v1.json')
  const saved = JSON.parse(await readFile(placementPath, 'utf8'))
  const savedRect = { x: saved.screen.x / saved.screen.scale + saved.left, y: saved.screen.y / saved.screen.scale + saved.top, width: saved.width, height: saved.height }
  assert(sameFrame(savedRect, draggedRect), 'Drag endpoint was not saved before the window closed')
  report.drag.savedBeforeClose = savedRect
  await click('#pet-quiet')
  assert.equal(await execute('return document.getElementById("pet-quiet").getAttribute("aria-pressed")'), 'true')
  await click('#pet-quiet')
  assert.equal(await execute('return document.getElementById("pet-quiet").getAttribute("aria-pressed")'), 'false')
  await nativeClick('#pet-zoom-in', 'resize_companion_window')
  await nativeClick('#pet-zoom-out', 'resize_companion_window')
  report.checks.push('quiet and zoom controls remain usable after dragging')
  // Zoom can adjust its anchor; verify the persisted drag endpoint before zoom,
  // then restore exactly that proven QA-only file for the reopen check.
  await switchWindow('main'); await click('#close')
  await until('Dragged companion closed', async () => !(await command('/window/handles')).includes('companion'))
  await writeFile(placementPath, JSON.stringify(saved))
  await click('#open')
  await until('Dragged companion reopened', async () => (await command('/window/handles')).includes('companion'))
  await until('Reopen command returned', () => execute('return !document.getElementById("open").disabled'))
  await switchWindow('companion')
  await ready('companion')
  report.drag.reopened = await command('/window/rect')
  assert(sameFrame(report.drag.reopened, draggedRect), 'Saved drag endpoint did not restore')
  report.checks.push('drag endpoint is saved before close and restored when reopened')
  await nativeClick('#pet-reset-position', 'reset_companion_position')
  const reset = await command('/window/rect')
  assert.equal(reset.width, draggedRect.width); assert.equal(reset.height, draggedRect.height)
  assert(!sameFrame(reset, draggedRect), 'Reset did not return the dragged window to the screen edge')
  report.checks.push('reset restores edge placement without changing size')
  await click('#companion-window-close')
  await until('Companion close control', async () => !(await command('/window/handles')).includes('companion'))
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
