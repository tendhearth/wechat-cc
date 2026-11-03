// Runs ONLY inside the mini's isolated process; no system pointer APIs.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { miniConfiguration, assertEmbeddedEndpoint, createOfflineSession } from './macmini-ui-protocol.mjs'

const mini = miniConfiguration({ computerName: execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim(),
  homeDir: homedir(), platformName: process.platform })
const endpoint = assertEmbeddedEndpoint('http://127.0.0.1:4199')
const lab = mini.root
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
  input: 'synthetic WebKit DOM events and HTMLElement.click(); no hardware hit testing or global mouse input', checks: [] }

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
  await execute('document.activeElement?.blur();return true')
  await until('Idle native toolbar hidden', async () => await execute('return getComputedStyle(document.querySelector(".pet-controls")).opacity') === '0')
  const focusedCompanion = await invoke('open_companion_window')
  assert.equal(focusedCompanion.ok, true, focusedCompanion.error)
  const locked = /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(execFileSync('/usr/sbin/ioreg', ['-n','Root','-d1'], {encoding:'utf8'}))
  report.keyboardFocus = { consoleLocked: locked, nativeDocumentFocused: await execute('return document.hasFocus()'),
    coverage: locked ? 'Locked console prevents native keyboard focus; browser keyboard and synthetic activation are separate coverage' : 'native focus required' }
  if (!locked) {
    await until('Owned companion receives native focus', () => execute('return document.hasFocus()'))
    await execute('document.getElementById("pet-stage").focus();return true')
    await until('Keyboard native toolbar revealed', async () => await execute('return getComputedStyle(document.querySelector(".pet-controls")).opacity') === '1')
    report.checks.push('actual WebKit keyboard focus reveals controls')
  }
  assert.equal(await execute('return document.getElementById("pet-stage").getAttribute("role")'),'button')
  await click('.pet-settings summary')
  report.menuReveal = await execute('const el=document.querySelector(".pet-controls");const before=getComputedStyle(el).opacity;const animations=el.getAnimations();if(arguments[0])for(const animation of animations)animation.finish();return {open:document.querySelector(".pet-settings").open,before,after:getComputedStyle(el).opacity,animations:animations.length,finishedForLockedConsole:arguments[0]}',[locked])
  await until('Open settings reveals toolbar', async () => await execute('return getComputedStyle(document.querySelector(".pet-controls")).opacity') === '1')
  assert.equal(report.menuReveal.open,true)
  assert.equal(await execute('return getComputedStyle(document.querySelector(".pet-controls")).pointerEvents'),'auto')
  await click('.pet-settings summary')
  if(locked)await execute('const el=document.querySelector(".pet-controls");getComputedStyle(el).opacity;for(const a of el.getAnimations())a.finish();return true')
  if(locked){assert.equal(await execute('return getComputedStyle(document.querySelector(".pet-controls")).opacity'),'0');assert.equal(await execute('return getComputedStyle(document.querySelector(".pet-controls")).pointerEvents'),'none')}
  report.checks.push('actual WebKit idle toolbar hides and open settings keeps controls visible')
  await screenshot('companion-idle')
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
  const navigationCount = () => execute('return window.__ccMotionQACalls.filter(value=>value.command==="show_main_window").length')
  const beforeDragNavigation = await navigationCount()
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
  assert.equal(await navigationCount(), beforeDragNavigation, 'A drag opened the conversation')
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
    await nativeSettled('show_main_window', sequence)
  }
  await execute('document.getElementById("pet-stage").dispatchEvent(new MouseEvent("dblclick",{bubbles:true,button:0,detail:2}));return true')
  assert(sameFrame((await nativeRead()).frame, settled), 'Stationary clicks changed native geometry')
  report.checks.push('stationary WebKit click and double-click keep native geometry')
  await switchWindow('main')
  await until('Actual native conversation navigation', async () => await execute('return window.__ccQANavigations?.at(-1)') === 'converse')
  await switchWindow('companion')
  const keyboardSequence = await nativeSequence()
  await execute('const stage=document.getElementById("pet-stage");stage.focus();stage.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));return true')
  await nativeSettled('show_main_window', keyboardSequence)
  report.checks.push('stationary clicks and keyboard activation request the existing conversation route')

  // Task UI is production renderer; this QA main proves real Rust/WebKit
  // transport. Production workbench selection/drafts/no-send are browser coverage.
  const scenario=async value=>{
    const receipt=await command('/execute/async',{script:'const done=arguments[arguments.length-1];window.__TAURI__.event.emit("cc-motion-qa-scenario",arguments[0]).then(()=>done(true)).catch(error=>done({error:String(error)}))',args:[value]})
    assert.equal(receipt,true)
  }
  const taskTarget={page:'workbench',taskId:'deadbeef'},otherTarget={page:'workbench',taskId:'bbbb2222'}
  const assertMainTarget=async target=>{
    await switchWindow('main')
    await until('Exact native task destination',async()=>JSON.stringify(await execute('return window.__ccQANavigations?.at(-1)'))===JSON.stringify(target))
    await switchWindow('companion')
  }
  report.taskObservation = { ...await execute('return {documentHidden:document.hidden,visibilityState:document.visibilityState,nativeDocumentFocused:document.hasFocus()}'),
    explicitSyntheticFixtureRefresh: true,
    coverage: 'Explicit offline fixture observation in real WebKit; production visibility/wake is covered separately in browser, not by a locked console' }
  await scenario('tasks')
  await until('Factual native task entry',()=>execute('return !document.getElementById("pet-tasks").hidden && document.getElementById("pet-task-primary").textContent.includes("修好本地排版")'))
  let taskSequence=await nativeSequence()
  await click('#pet-stage')
  assert.deepEqual((await nativeSettled('show_main_window',taskSequence)).destination,taskTarget)
  await assertMainTarget(taskTarget)
  taskSequence=await nativeSequence();await click('#pet-task-primary')
  assert.deepEqual((await nativeSettled('show_main_window',taskSequence)).destination,taskTarget)
  await assertMainTarget(taskTarget)
  await click('#pet-task-toggle')
  taskSequence=await nativeSequence();await click('#pet-task-list [data-task-id="bbbb2222"]')
  assert.deepEqual((await nativeSettled('show_main_window',taskSequence)).destination,otherTarget)
  await assertMainTarget(otherTarget)
  await screenshot('companion-tasks')
  report.checks.push('production task entry, virtual click and chooser carry exact IDs through real native transport')
  await scenario('tasks-away')
  await until('Disconnected task targets cleared',()=>execute('return document.getElementById("pet-tasks").hidden'))
  const hiddenCount=await navigationCount()
  await click('#pet-task-primary')
  assert.equal(await navigationCount(),hiddenCount,'Hidden stale task dispatched a target')
  await scenario('tasks')
  await until('Task targets restored from current facts',()=>execute('return !document.getElementById("pet-tasks").hidden'))
  report.checks.push('disconnect clears task targets without inventing unread or completion')

  // Hold the new renderer before listen; the native inbox must retain B whole.
  await execute('localStorage.setItem("cc-motion-qa-navigation-gate","hold");return true')
  const closeMain=await command('/execute/async',{script:'const done=arguments[arguments.length-1];window.__TAURI__.window.Window.getByLabel("main").then(main=>main.close()).then(()=>done(true)).catch(error=>done({error:String(error)}))',args:[]})
  assert.equal(closeMain,true)
  await until('QA main destroyed',async()=>!(await command('/window/handles')).includes('main'))
  let requested=await invoke('show_main_window',taskTarget);assert.equal(requested.ok,true,requested.error)
  await until('QA main recreated',async()=>(await command('/window/handles')).includes('main'))
  await switchWindow('main')
  await until('Cold renderer waits before listener',()=>execute('return window.__ccQANavigationWaiting===true'))
  await switchWindow('companion')
  requested=await invoke('show_main_window',otherTarget);assert.equal(requested.ok,true,requested.error)
  await execute('localStorage.removeItem("cc-motion-qa-navigation-gate");return true')
  await assertMainTarget(otherTarget)
  await switchWindow('main')
  report.taskNavigation={cold:await execute('return window.__ccQANavigations'),coverage:'real WebKit and Rust native target transport; production workbench route separately covered in browser'}
  assert.deepEqual(report.taskNavigation.cold,[otherTarget])
  await switchWindow('companion');requested=await invoke('show_main_window',taskTarget);assert.equal(requested.ok,true,requested.error)
  await assertMainTarget(taskTarget)
  await switchWindow('main');report.taskNavigation.warm=await execute('return window.__ccQANavigations')
  assert.deepEqual(report.taskNavigation.warm,[otherTarget,taskTarget])
  await switchWindow('companion')
  report.checks.push('cold-created main keeps newest complete task until listener ready; warm navigation is not replayed')
  await scenario('idle')
  await until('Native task entry hidden after tasks finish',()=>execute('return document.getElementById("pet-tasks").hidden'))

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
  // Direct IPC + independent AppKit reads. No hardware input or visibility override.
  await execute('const q=window.__ccMotionQAControl;q.stopPolling();q.pet.setLifeAvailable(false);return true')
  let motionResult=await invoke('stop_companion_motion')
  assert.equal(motionResult.ok,true,motionResult.error)
  const motionAnchor=(await nativeRead()).frame
  const motionSavedText=await readFile(placementPath,'utf8')
  const motionContextResult=await invoke('companion_motion_context')
  assert.equal(motionContextResult.ok,true,motionContextResult.error)
  const motionContext=motionContextResult.value
  assert(motionContext,'Reset bottom-edge placement did not permit native motion')
  assert(motionContext.minOffset<=-24&&motionContext.maxOffset>=-24)
  motionResult=await invoke('step_companion_motion',{token:motionContext.token,offset:-24})
  assert.equal(motionResult.ok,true,motionResult.error)
  const motionMoved=await until('Actual AppKit temporary displacement',async()=>{
    const frame=(await nativeRead()).frame
    return sameFrame(frame,{...motionAnchor,x:motionAnchor.x-24})?frame:null
  },5000)
  motionResult=await invoke('stop_companion_motion')
  assert.equal(motionResult.ok,true,motionResult.error)
  const motionLate=await invoke('step_companion_motion',{token:motionContext.token,offset:0})
  assert.equal(motionLate.ok,false,'Stopped motion accepted an expired token')
  assert.match(motionLate.error,/expired|outside bounds/)
  await new Promise(resolve=>setTimeout(resolve,700))
  assert(sameFrame((await nativeRead()).frame,motionMoved),'Expired motion changed the AppKit frame')
  assert.equal(await readFile(placementPath,'utf8'),motionSavedText,'Temporary motion overwrote user anchor')
  await switchWindow('main');await click('#close')
  await until('Temporary-motion companion closed',async()=>!(await command('/window/handles')).includes('companion'))
  assert.equal(await readFile(placementPath,'utf8'),motionSavedText,'Closing at a temporary position overwrote user anchor')
  await click('#open')
  await until('Temporary-motion companion reopened',async()=>(await command('/window/handles')).includes('companion'))
  await until('Motion reopen command returned',()=>execute('return !document.getElementById("open").disabled'))
  await switchWindow('companion');await ready('companion')
  const motionReopened=await until('Original AppKit anchor restored',async()=>{
    const frame=(await nativeRead()).frame;return sameFrame(frame,motionAnchor)?frame:null
  },5000)
  assert.equal(await readFile(placementPath,'utf8'),motionSavedText)
  report.motion={anchor:motionAnchor,context:motionContext,moved:motionMoved,expiredTokenRejected:true,
    persistenceWaitMs:700,placementUnchangedAfterStopAndClose:true,reopened:motionReopened,
    coverage:'Direct native IPC and actual AppKit geometry; idle scheduling/interaction gates covered separately in browser'}
  report.checks.push('bounded native motion changes AppKit position, rejects expired tokens, preserves saved placement and restores user anchor')
  // Native SetWindowRect exercises Resized events, not our explicit zoom IPC.
  // A user resize during a stroll accepts the size, never the temporary offset.
  const resizeBase=await command('/window/rect')
  const resizeSaved=JSON.parse(await readFile(placementPath,'utf8'))
  const resizeContext=await invoke('companion_motion_context')
  assert.equal(resizeContext.ok,true,resizeContext.error);assert(resizeContext.value)
  const edgeMoved=await invoke('step_companion_motion',{token:resizeContext.value.token,offset:-24})
  assert.equal(edgeMoved.ok,true,edgeMoved.error)
  await until('Temporary position before native resize',async()=>sameFrame((await nativeRead()).frame,{...motionAnchor,x:motionAnchor.x-24}))
  await command('/window/rect',{...await command('/window/rect'),width:resizeBase.width+20,height:resizeBase.height+25})
  await until('Native edge size observed',async()=>{
    const frame=(await nativeRead()).frame;return frame.width===resizeBase.width+20&&frame.height===resizeBase.height+25
  })
  const lateResizeMove=await invoke('step_companion_motion',{token:resizeContext.value.token,offset:0})
  assert.equal(lateResizeMove.ok,false,'Native resize did not invalidate an active stroll')
  const resizedPreference=await until('Native edge size persisted',async()=>{
    const saved=JSON.parse(await readFile(placementPath,'utf8'))
    return saved.width===resizeBase.width+20&&saved.height===resizeBase.height+25?saved:null
  })
  assert.equal(resizedPreference.left,Math.min(resizeSaved.left,resizeSaved.screen.width/resizeSaved.screen.scale-resizedPreference.width))
  assert.equal(resizedPreference.top,Math.min(resizeSaved.top,resizeSaved.screen.height/resizeSaved.screen.scale-resizedPreference.height))
  await switchWindow('main');await click('#close')
  await until('Edge-resized companion closed',async()=>!(await command('/window/handles')).includes('companion'))
  await click('#open');await until('Edge-resized companion reopened',async()=>(await command('/window/handles')).includes('companion'))
  await until('Edge resize reopen command returned',()=>execute('return !document.getElementById("open").disabled'))
  await switchWindow('companion');await ready('companion')
  const resizedReopened=await until('User edge size restored',async()=>{
    const frame=(await nativeRead()).frame;return frame.width===resizedPreference.width&&frame.height===resizedPreference.height?frame:null
  })
  report.edgeResize={expiredTokenRejected:true,saved:resizedPreference,reopened:resizedReopened,temporaryOffsetNotSaved:true}
  report.checks.push('native edge resize invalidates a stroll, saves user size without temporary offset and survives reopening')
  // Exercise production pet/prop code inside actual WebKit. This handle exists
  // only in the isolated staged QA source; normal app assets never export it.
  await execute('const {pet,stopPolling}=window.__ccMotionQAControl;stopPolling();pet.setQuiet(false);pet.setReducedMotion(false);pet.setPaused(false);pet.machine.notifyAnimationEnded();pet.applyIntent({form:"lit",behavior:"working",props:[],badge:0,hint:null,oneShots:[]})')
  const activeProps = () => execute('return [...document.querySelectorAll("#pet-props [data-prop-leaving=false]")].map(node=>node.getAttribute("data-prop"))')
  await until('Native working laptop', async () => JSON.stringify(await activeProps()) === '["laptop"]')
  await execute('window.__ccMotionQAControl.pet.setState("thinking")')
  await until('Native thinking props', async () => {
    const names=await activeProps();return names.includes('thought-bubble')&&names.includes('mug')&&!names.includes('laptop')
  })
  await execute('window.__ccMotionQAControl.pet.applyIntent({form:"lit",behavior:"permission",props:["envelope"],badge:5,hint:null,oneShots:[]})')
  await until('Native factual badge and permission prop', async () => JSON.stringify(await activeProps()) === '["envelope","exclamation"]')
  assert.equal(await execute('return document.querySelector("#pet-props .pet-badge").textContent'),'5')
  assert.equal(await execute('window.__savedQAEnvelope=document.querySelector("#pet-props [data-prop=envelope]");window.__ccMotionQAControl.pet.setProps(["envelope"],6);return window.__savedQAEnvelope===document.querySelector("#pet-props [data-prop=envelope]")&&window.__savedQAEnvelope.querySelector(".pet-badge").textContent==="6"'),true)
  await execute('const pet=window.__ccMotionQAControl.pet;pet.setProps([],0);pet.setState("idle");pet.setState("receive");pet.setState("working")')
  assert.equal(await execute('return window.__ccMotionQAControl.pet.machine.snapshot().behavior'),'receive')
  assert(!(await activeProps()).includes('laptop'),'Queued working laptop appeared before receive finished')
  await until('Native queued working resolved',async()=>JSON.stringify(await activeProps())==='["laptop"]')
  for(const control of ['setPaused','setReducedMotion']){
    const restored=await execute('const pet=window.__ccMotionQAControl.pet,key=arguments[0];pet.setProps(["micro-light","envelope"],2);pet[key](true);pet.setProps(["micro-light","envelope"],7);pet[key](false);return {props:pet.machine.snapshot().props,badge:pet.machine.snapshot().badge,light:document.querySelectorAll("#pet-props [data-prop=micro-light]").length}',[control])
    assert.deepEqual(restored,{props:['envelope'],badge:7,light:0},`Native old light survived ${control}`)
  }
  await execute('const pet=window.__ccMotionQAControl.pet;pet.setReducedMotion(true);pet.setProps([],0);pet.setState("thinking")')
  assert.equal(await execute('return document.querySelectorAll("#pet-props [data-prop-leaving=true]").length'),0)
  assert.equal(await execute('return getComputedStyle(document.querySelector("#pet-props [data-prop=mug]")).transitionDuration'),'0s')
  report.checks.push('actual WebKit prop recipes, queued behavior, stable unread badge and reduced-motion convergence')
  await execute('const pet=window.__ccMotionQAControl.pet;pet.setReducedMotion(false);pet.setQuiet(false);pet.setPaused(false);pet.setProps([],0);pet.setState("idle");pet.machine.notifyAnimationEnded()')
  const attentionForm = await execute('return window.__ccMotionQAControl.pet.machine.snapshot().form')
  await until('Native nearby attention after cooldown', () => execute('return window.__ccMotionQAControl.pet.acknowledgeAttention()'))
  assert.equal(await execute('return window.__ccMotionQAControl.pet.machine.snapshot().behavior'),'look')
  assert.equal(await execute('return window.__ccMotionQAControl.pet.machine.snapshot().form'),attentionForm)
  assert.equal(await execute('return window.__ccMotionQAControl.pet.acknowledgeAttention()'),false)
  await until('Native attention naturally settles', async () => await execute('return window.__ccMotionQAControl.pet.machine.snapshot().behavior') === 'idle')
  await execute('window.__ccMotionQAControl.pet.setQuiet(true)')
  assert.equal(await execute('return window.__ccMotionQAControl.pet.acknowledgeAttention()'),false)
  await execute('window.__ccMotionQAControl.pet.setQuiet(false)')
  assert.equal(await execute('return window.__ccMotionQAControl.pet.machine.snapshot().behavior'),'idle')
  report.checks.push('nearby attention preserves connection, observes cooldown and never replays after quiet')
  report.cadence = []
  const cadenceKit=JSON.parse(await readFile(join(process.cwd(),'apps/desktop/src/assets/pet/cc-v1/manifest.json'),'utf8'))
  for (const behavior of ['working','thinking']) {
    const form=await execute('return window.__ccMotionQAControl.pet.machine.snapshot().form')
    const frames=cadenceKit.forms[form].states[behavior].frames
    const initial = await execute('const pet=window.__ccMotionQAControl.pet;pet.setState(arguments[0]);window.__ccQAFrameChanges=0;window.__ccQASawLastFrame=false;const last=new URL("./assets/pet/cc-v1/"+arguments[2],location.href).href;window.__ccQAFrameObserver?.disconnect();window.__ccQAFrameObserver=new MutationObserver(records=>{window.__ccQAFrameChanges+=records.length;if(document.getElementById("pet-sprite").src===last)window.__ccQASawLastFrame=true});window.__ccQAFrameObserver.observe(document.getElementById("pet-sprite"),{attributes:true,attributeFilter:["src"]});return new URL("./assets/pet/cc-v1/"+arguments[1],location.href).href',[behavior,frames[0],frames.at(-1)])
    await until('Native work pose advances', async () => await execute('return document.getElementById("pet-sprite").src') !== initial)
    // Locked consoles may throttle WebKit timers. Observe a completed cycle
    // rather than assuming wall time equals the nominal frame duration.
    // Preparation may restart the sprite at 350ms. That is not a completed
    // cycle: require the manifest's actual last frame before the resting first.
    await until('Native work cycle returns to its resting first frame', () => execute('return document.getElementById("pet-sprite").src===arguments[0] && window.__ccQAFrameChanges>1 && window.__ccQASawLastFrame',[initial]))
    const hold = await execute('return {frame:document.getElementById("pet-sprite").src,behavior:window.__ccMotionQAControl.pet.machine.snapshot().behavior,changes:window.__ccQAFrameChanges}')
    assert.equal(hold.frame,initial);assert.equal(hold.behavior,behavior)
    await new Promise(resolve=>setTimeout(resolve,500))
    assert.equal(await execute('return document.getElementById("pet-sprite").src'),initial)
    assert.equal(await execute('return window.__ccQAFrameChanges'),hold.changes)
    report.cadence.push({behavior,changesPerCycle:hold.changes,holdSampleMs:500,frameUpdatesDuringHold:0})
  }
  await execute('window.__ccQAFrameObserver?.disconnect();window.__ccMotionQAControl.pet.setReducedMotion(true)')
  report.checks.push('actual WebKit work cycles hold a stable pose without changing activity or advancing sprite frames')
  const benchmark = await command('/execute/async', {
    script: `const done=arguments[arguments.length-1];(async()=>{
      const pet=window.__ccMotionQAControl.pet;pet.setPaused(true);
      const {createSpriteRenderer}=await import(new URL('./pet/renderer/sprite-renderer.js',location.href).href);
      const manifest=await(await fetch('./assets/pet/cc-v1/manifest.json')).json();
      const a=manifest.forms.lit.states.working;
      const animation={...a,frames:a.frames.map(path=>new URL('./assets/pet/cc-v1/'+path,location.href).href)};
      const samples=[],cleanups=[];const started=performance.now();
      for(const restMs of [0,6000]){
        const stage=document.createElement('div'),img=document.createElement('img');
        stage.style.cssText='position:absolute;width:48px;height:48px;visibility:hidden;pointer-events:none';stage.append(img);document.body.append(stage);
        const renderer=createSpriteRenderer({stage,img});const sample={restMs,frameUpdates:0};samples.push(sample);
        const observer=new MutationObserver(records=>sample.frameUpdates+=records.length);observer.observe(img,{attributes:true,attributeFilter:['src']});
        renderer.play(animation,{restMs});cleanups.push(()=>{renderer.stop();observer.disconnect();stage.remove()});
      }
      window.__ccQACadenceBenchmark={samples,frames:animation.frames.length,started,stop:()=>{for(const cleanup of cleanups)cleanup();pet.setPaused(false)}};
      return true;
    })().then(value=>done({ok:true,value})).catch(error=>done({ok:false,error:String(error)}));`, args: [],
  })
  assert.equal(benchmark.ok,true,benchmark.error)
  // Concurrent samples share one WebKit clock. Locked consoles throttle timers,
  // so measure three observed baseline cycles instead of assuming nominal FPS.
  try {
    await until('Three concurrent baseline work cycles', () => execute('const b=window.__ccQACadenceBenchmark;return b.samples[0].frameUpdates>=b.frames*3'),90000)
    report.cadenceResource = await execute('const b=window.__ccQACadenceBenchmark;b.stop();return {metric:"concurrent sprite src mutations in the same real WebKit, not whole-app CPU or energy",durationMs:performance.now()-b.started,samples:b.samples}')
  } finally { await execute('window.__ccQACadenceBenchmark?.stop();delete window.__ccQACadenceBenchmark;return true') }
  const [continuous, paced] = report.cadenceResource.samples
  assert(paced.frameUpdates < continuous.frameUpdates * .9, 'Work cadence did not reduce repeated frame updates by at least ten percent')
  report.checks.push('same-WebKit concurrent comparison reduces sprite frame updates against continuous playback')
  report.transparentInput = { enabled: false, coverage: 'Cross-application hardware hit delivery is not covered by synthetic DOM events; production input routing remains unchanged' }
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
