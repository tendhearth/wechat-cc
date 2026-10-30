// @ts-check
// companion-window.js — CC 桌宠窗的胶水:组装 pet,接 presence / pet 两个轮询与权限卡片,窗口拖动 / 缩放 / 关闭。
// 只调 pet 的语义接口;这里不出现任何帧文件名。
import { createPet } from './pet/pet.js'
import { createPetPoller } from './pet/bridge/pet-poller.js'
import { createPetBridge } from './pet/bridge/pet-bridge.js'
import { createPermissionCard } from './pet/permission/permission-card.js'
import { createPresencePoller } from './presence-poller.js'
import { invokeApi } from './api.js'
import { invoke } from './ipc.js'
import { createCompanionPreferences } from './companion-preferences.js'
import { formatCompanionStatus } from './companion-status.js'
import { createCompanionDrag } from './companion-drag.js'

const $ = (/** @type {string} */ id) => document.getElementById(id)
// 浏览器预览(没有 Tauri 运行时)里窗口命令无处可去 —— 用它决定要不要发。
const mock = !(/** @type {any} */ (window).__TAURI__?.core?.invoke)
const stage = $('pet-stage'), img = $('pet-sprite'), props = $('pet-props'), hint = $('pet-hint')
const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
/** @type {Storage | null} */ let storage = null
try { storage = window.localStorage } catch { /* controls still work without persistence */ }

const pet = await createPet({ stage, img, props, hint }, { manifestUrl: './assets/pet/cc-v1/manifest.json', reducedMotion: motionQuery?.matches === true })
if (new URLSearchParams(location.search).has('lab')) /** @type {any} */ (window).__pet = pet

let quiet = false, reducedMotion = false
const reobserve = new Set()
/** @param {import('./companion-preferences.js').MotionPreferences} s */
const applyPreferences = s => {
  if ((quiet && !s.quiet) || (reducedMotion && !s.reducedMotion)) { reobserve.add('presence'); reobserve.add('turn') }
  quiet = s.quiet; reducedMotion = s.reducedMotion
  pet.setReducedMotion(s.reducedMotion)
  pet.setQuiet(s.quiet)
  const checkbox = /** @type {HTMLInputElement | null} */ ($('pet-reduced-motion'))
  if (checkbox) { checkbox.checked = s.reducedMotion; checkbox.disabled = s.systemReduced }
  const systemNote = $('pet-system-motion')
  if (systemNote) systemNote.hidden = !s.systemReduced
  const quietButton = $('pet-quiet')
  if (quietButton) { quietButton.textContent = s.quiet ? '恢复动作' : '安静一小时'; quietButton.setAttribute('aria-pressed', String(s.quiet)) }
}
const preferences = createCompanionPreferences({ storage, systemReduced: motionQuery?.matches, onChange: applyPreferences })
applyPreferences(preferences.snapshot())
const systemMotionChanged = () => preferences.setSystemReduced(motionQuery?.matches === true)
motionQuery?.addEventListener('change', systemMotionChanged)
$('pet-reduced-motion')?.addEventListener('change', event => preferences.setUserReduced(/** @type {HTMLInputElement} */ (event.target).checked))
$('pet-quiet')?.addEventListener('click', () => preferences.setQuiet(!preferences.snapshot().quiet))

// presence(处境)+ pet 端点(在做什么)→ 一个意图(spec §5)。两个轮询各拉各的,
// 谁回来都重算一次 —— 有状态的合并在 pet-bridge.js 里(那儿有测试),这里只做接线。
const poller = createPresencePoller({ invokeApi, intervalMs: 20_000 })
const petPoller = createPetPoller({ invokeApi })
// 权限卡片:能不能真的按下去,看的是**有没有 Tauri 运行时**(operator token 只有它拿得到),
// 不能看 invoke 的返回 —— 浏览器预览的 mockInvoke 对任何未知命令都回 {}。
const card = createPermissionCard({ el: $('pet-card'), makeEl: (/** @type {string} */ t) => document.createElement(t) }, {
  canResolve: !mock,
  // 三种结局要分清楚(spec §6):真的拍板了 = resolved;请求通了但这条已经不在了
  // (微信那端刚点过 / 过期)= gone —— 卡片直接收掉,别说「没送出去」;只有请求
  // 本身挂了(没凭据、超时、403)才是 failed,那才该留下重试提示。
  onResolve: async (hash, decision) => {
    try {
      const r = /** @type {any} */ (await invoke('pet_permission_resolve', { hash, decision }))
      return r === true ? 'resolved' : 'gone'
    } catch (err) { console.warn('pet_permission_resolve failed', err); return 'failed' }
    // 不管成没成:立刻重拉一次,让卡片的去留由 daemon 的列表说了算(微信那端也可能刚点过)。
    finally { petPoller.refresh() }
  },
})

const bridge = createPetBridge()
const apply = (freshTurn = false) => {
  const stream = freshTurn ? 'turn' : 'presence'
  const turn = petPoller.current()
  const r = bridge.tick(turn, { freshTurn })
  // A presence response only observes the cached turn. The next fresh turn
  // still has to consume its own suppressed completion/contact baseline.
  if (reobserve.has(stream)) r.intent = { ...r.intent, props: r.intent.props.filter(p => p !== 'micro-light'), oneShots: r.intent.oneShots.filter(b => b === 'error') }
  // Current facts remain readable when motion is reduced or quiet. Dark hides stale activity.
  const activity = formatCompanionStatus(r.intent, r.permissionCount)
  if (stage && stage.getAttribute('aria-label') !== activity.ariaLabel) stage.setAttribute('aria-label', activity.ariaLabel)
  const status = $('pet-connection')
  if (status && status.textContent !== activity.text) status.textContent = activity.text
  pet.applyIntent({ ...r.intent, hint: r.intent.hint === 'daemon 没起' ? '暂时联系不上 CC' : r.intent.hint })
  // 初次观察不播转场(spec §5.2):开窗时 CC 本来就亮着,那是既成事实,不是「主人
  // 刚到」。applyIntent 已经按事实把 form 设过去了,这里立刻把转场判为播完,
  // 状态机直接落到目标形态 —— 省掉那 8 帧点火,而不用改 Phase A 的接口。
  // 哪一拍算「初次」由 bridge 说(开窗第一拍 + 第一次拿到端点回答那拍,见 pet-bridge.js)。
  if (r.first && pet.machine.snapshot().transition) pet.machine.notifyAnimationEnded()
  if (r.permission) card.show(r.permission, r.permissionCount); else card.hide()
  petPoller.setFast(r.fast)
  // Consume this snapshot under the previous quiet flag before wake-time expiry
  // enables motion; completion during suspend must not become a celebration.
  preferences.refresh()
  if (!freshTurn || turn) reobserve.delete(stream)
}
poller.subscribe(p => { bridge.notePresence(p); apply() })
petPoller.subscribe(() => apply(true))
pet.setPaused(document.hidden)
if (!document.hidden) { poller.start(); petPoller.start() }
// start() 自己会先拉一次,这里不用再补 refresh()。
// 窗口不可见 → 两个都停(spec §5.3);回来时 start() 会各自补一拍。
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { drag.cancel(); pet.setPaused(true); poller.stop(); petPoller.stop(); return }
  preferences.refresh()
  bridge.resume()
  pet.setPaused(false)
  poller.start(); petPoller.start()
})

const drag = createCompanionDrag({
  start: () => mock ? Promise.resolve(null) : invoke('start_companion_drag'),
  move: position => invoke('move_companion_window', position),
  finish: () => invoke('finish_companion_drag'),
  onBegin: () => pet.beginDrag(), onEnd: () => pet.endDrag(),
  onError: error => console.warn('companion drag failed', error),
})
/** @type {number | null} */ let capturedPointer = null
const clearPointerCapture = () => {
  const pointer = capturedPointer; capturedPointer = null
  if (pointer !== null && stage?.hasPointerCapture?.(pointer)) stage.releasePointerCapture(pointer)
}
stage?.addEventListener('pointerdown', event => {
  if (typeof PointerEvent !== 'function' || !(event instanceof PointerEvent) || event.button !== 0 || !event.isPrimary) return
  try { stage.setPointerCapture(event.pointerId); capturedPointer = event.pointerId } catch { /* synthetic input has no active OS pointer */ }
})
stage?.addEventListener('mousedown', (event) => {
  if (event instanceof MouseEvent && drag.press(event)) event.preventDefault()
})
/** @param {Event} event */
const endDrag = event => {
  if (!(event instanceof MouseEvent) || event.button !== 0) return
  drag.release(event); clearPointerCapture()
}
const cancelDrag = () => { drag.cancel(); clearPointerCapture() }
window.addEventListener('mouseup', endDrag)
window.addEventListener('pointerup', endDrag)
window.addEventListener('blur', cancelDrag)
window.addEventListener('pagehide', cancelDrag)
stage?.addEventListener('pointercancel', cancelDrag)
stage?.addEventListener('lostpointercapture', cancelDrag)
window.addEventListener('mousemove', event => { if (event instanceof MouseEvent) drag.move(event) })

$('pet-open-main')?.addEventListener('click', async () => {
  await drag.cancel()
  if (mock) { location.assign('./index.html'); return }
  try { await invoke('show_main_window', { page: 'overview' }) }
  catch (err) { console.warn('show_main_window failed', err); pet.setHint('没能打开 CC，请再试一次') }
})

$('pet-reset-position')?.addEventListener('click', async () => {
  await drag.cancel()
  if (mock) { pet.setHint('请在桌面应用中调整位置'); return }
  const button = /** @type {HTMLButtonElement | null} */ ($('pet-reset-position'))
  if (button) button.disabled = true
  try { await invoke('reset_companion_position') }
  catch (err) { console.warn('reset_companion_position failed', err); pet.setHint('没能调整位置，请再试一次') }
  finally { if (button) button.disabled = false }
})

$('companion-window-close')?.addEventListener('click', async () => {
  await drag.cancel()
  if (mock) { window.close(); return }
  invoke('close_companion_window').catch(() => window.close())
})
$('pet-zoom-out')?.addEventListener('click', async () => { await drag.cancel(); if (!mock) invoke('resize_companion_window', { direction: 'out' }).catch(console.warn) })
$('pet-zoom-in')?.addEventListener('click', async () => { await drag.cancel(); if (!mock) invoke('resize_companion_window', { direction: 'in' }).catch(console.warn) })
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') $('companion-window-close')?.click() })
