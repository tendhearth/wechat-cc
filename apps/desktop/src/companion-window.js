// @ts-check
// companion-window.js — CC 桌宠窗的胶水:组装 pet,接 presence 主题(订阅,S5)与权限卡片,窗口拖动 / 缩放 / 关闭。
// 只调 pet 的语义接口;这里不出现任何帧文件名。
import { createPet } from './pet/pet.js'
import { createPresenceFeed } from './pet/bridge/presence-feed.js'
import { createPetBridge } from './pet/bridge/pet-bridge.js'
import { createPermissionCard } from './pet/permission/permission-card.js'
import { invokeApi, invokeWorkbenchApi } from './api.js'
import { openSeenMatter } from './matter-seen.js'
import { invoke } from './ipc.js'
import { createCompanionPreferences } from './companion-preferences.js'
import { formatCompanionStatus } from './companion-status.js'
import { createCompanionDrag } from './companion-drag.js'
import { createCompanionMotion } from './companion-motion.js'
import { mountPetActivities, normalizePetActivities } from './pet-activities.js'

const $ = (/** @type {string} */ id) => document.getElementById(id)
// 浏览器预览(没有 Tauri 运行时)里窗口命令无处可去 —— 用它决定要不要发。
const mock = !(/** @type {any} */ (window).__TAURI__?.core?.invoke)
const stage = $('pet-stage'), img = $('pet-sprite'), props = $('pet-props'), hint = $('pet-hint')
const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
/** @type {Storage | null} */ let storage = null
try { storage = window.localStorage } catch { /* controls still work without persistence */ }

let lifeFactsAvailable=false,pointerInShell=false,focusInShell=false,holding=false,walking=false
const motion=mock?null:createCompanionMotion({context:()=>invoke('companion_motion_context'),step:p=>invoke('step_companion_motion',p),stop:()=>invoke('stop_companion_motion'),onError:e=>console.warn('companion motion stopped',e)})
const pet = await createPet({ stage, img, props, hint, body:$('pet-body') }, { manifestUrl: './assets/pet/cc-v1/manifest.json', reducedMotion: motionQuery?.matches === true,life:true,
  // Planted-foot artwork steps in place. Translating its canvas would skate the
  // support foot; keep the previous native stroll only for fallback choreography.
  onLifeAction:pose=>{const travel=pose.action==='walk'&&pose.authored!==true&&!document.hidden;if(travel)void motion?.play(pose.direction);else if(walking)void motion?.stop();walking=travel},
})
if (new URLSearchParams(location.search).has('lab')) /** @type {any} */ (window).__pet = pet

let quiet = false, reducedMotion = false
function syncLifeAvailability(){
  const settings=document.querySelector('.pet-settings')
  const available=lifeFactsAvailable&&!pointerInShell&&!focusInShell&&!holding&&!quiet&&!reducedMotion&&!document.hidden&&!(settings instanceof HTMLDetailsElement&&settings.open)
  pet.setLifeAvailable(available)
  if(!available&&walking){walking=false;void motion?.stop()}
}
const shell=document.querySelector('.pet-shell')
shell?.addEventListener('pointerenter',()=>{pointerInShell=true;syncLifeAvailability()})
shell?.addEventListener('pointerleave',()=>{pointerInShell=false;syncLifeAvailability()})
shell?.addEventListener('focusin',()=>{focusInShell=true;syncLifeAvailability()})
shell?.addEventListener('focusout',()=>queueMicrotask(()=>{focusInShell=Boolean(shell?.contains(document.activeElement));syncLifeAvailability()}))
const reobserve = new Set()
/** @param {import('./companion-preferences.js').MotionPreferences} s */
const applyPreferences = s => {
  // 安静 / 减少动作刚结束:要观察一次「当下」把这段时间的变化吞掉(不补演)。以前靠下一次轮询;订阅只在有变化时才来,
  // 所以这里主动要一份 —— 否则这两个标记会留到下一次真变化,把那次真的「做完了」也吞掉。
  if ((quiet && !s.quiet) || (reducedMotion && !s.reducedMotion)) { reobserve.add('presence'); reobserve.add('turn'); queueMicrotask(observeNow) }
  quiet = s.quiet; reducedMotion = s.reducedMotion
  pet.setReducedMotion(s.reducedMotion)
  pet.setQuiet(s.quiet)
  syncLifeAvailability()
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

// presence(处境)+ pet(在做什么)→ 一个意图(spec §5)。两样从同一个 presence 主题来(S5,daemon 那边变了才推);
// 有状态的合并在 pet-bridge.js 里(那儿有测试),这里只做接线。
const feed = createPresenceFeed({ invokeApi })
/** @type {import('./pet/bridge/presence-feed.js').PetTurn | null} */ let petTurn = null
// 窗口看不见时不观察(停订期间本来就不画);回来时 start() 会先要一份。
function observeNow() { if (!document.hidden) void feed.refresh() }
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
    // 不管成没成:立刻要一份,让卡片的去留由 daemon 的列表说了算(微信那端也可能刚点过)。
    finally { void feed.refresh() }
  },
})

const tasksHost=$('pet-tasks'),taskPrimary=$('pet-task-primary'),taskToggle=$('pet-task-toggle'),taskList=$('pet-task-list')
const taskView=tasksHost&&taskPrimary&&taskToggle&&taskList?mountPetActivities({host:tasksHost,primary:taskPrimary,toggle:taskToggle,list:taskList,onOpen:target=>openDestination(target),onExpand:()=>closeSettings()}):null
const closeSettings=()=>{const settings=document.querySelector('.pet-settings');if(settings instanceof HTMLDetailsElement)settings.open=false}
document.querySelector('.pet-settings')?.addEventListener('toggle',event=>{if(event.target instanceof HTMLDetailsElement&&event.target.open)taskView?.closeList();syncLifeAvailability()})
const bridge = createPetBridge()
const apply = (freshTurn = false) => {
  const stream = freshTurn ? 'turn' : 'presence'
  const turn = petTurn
  const r = bridge.tick(turn, { freshTurn })
  // A presence response only observes the cached turn. The next fresh turn
  // still has to consume its own suppressed completion/contact baseline.
  if (reobserve.has(stream)) r.intent = { ...r.intent, props: r.intent.props.filter(p => p !== 'micro-light'), oneShots: r.intent.oneShots.filter(b => b === 'error') }
  // Current facts remain readable when motion is reduced or quiet. Dark hides stale activity.
  const taskRows=normalizePetActivities(turn?.activities)
  const tasksAvailable=r.intent.form==='lit'&&!r.intent.hint&&!r.permission&&r.permissionCount===0&&!r.intent.props.includes('exclamation')
  taskView?.update(taskRows,tasksAvailable)
  const selected=tasksAvailable?taskRows[0]:null
  if(selected)r.intent={...r.intent,behavior:selected.phase==='needs_input'?'permission':selected.phase==='working'?'working':'idle'}
  // A different completed task must never celebrate over current work.
  if(taskRows.some(row=>row.phase==='working')||['working','thinking'].includes(r.intent.behavior))r.intent={...r.intent,oneShots:r.intent.oneShots.filter(b=>b!=='done')}
  lifeFactsAvailable=tasksAvailable&&taskRows.length===0&&['idle','companion'].includes(r.intent.behavior)&&r.intent.badge===0
  syncLifeAvailability()
  const activity = formatCompanionStatus(r.intent, r.permissionCount)
  if(selected)activity.ariaLabel=`CC，${taskPrimary?.getAttribute('aria-label')??selected.title}，打开任务`
  if (stage && stage.getAttribute('aria-label') !== activity.ariaLabel) stage.setAttribute('aria-label', activity.ariaLabel)
  const status = $('pet-connection')
  if (status && status.textContent !== activity.text) status.textContent = activity.text
  const activityLabel = $('pet-activity')
  if (activityLabel) {
    if (activityLabel.textContent !== activity.text) activityLabel.textContent = activity.text
    // Permission and connection hints already have their own readable surface.
    activityLabel.hidden = Boolean(selected || r.permission || r.intent.hint) || activity.text === '已连接' || activity.text === '已连接 · 陪伴中'
  }
  pet.applyIntent({ ...r.intent, hint: r.intent.hint === 'daemon 没起' ? '暂时联系不上 CC' : r.intent.hint })
  // 初次观察不播转场(spec §5.2):开窗时 CC 本来就亮着,那是既成事实,不是「主人
  // 刚到」。applyIntent 已经按事实把 form 设过去了,这里立刻把转场判为播完,
  // 状态机直接落到目标形态 —— 省掉那 8 帧点火,而不用改 Phase A 的接口。
  // 哪一拍算「初次」由 bridge 说(开窗第一拍 + 第一次拿到端点回答那拍,见 pet-bridge.js)。
  if (r.first && pet.machine.snapshot().transition) pet.machine.notifyAnimationEnded()
  if (r.permission) card.show(r.permission, r.permissionCount); else card.hide()
  // Consume this snapshot under the previous quiet flag before wake-time expiry
  // enables motion; completion during suspend must not become a celebration.
  preferences.refresh()
  if (!freshTurn || turn) reobserve.delete(stream)
}
// 安静到点也可能是墙上时钟跳过去的(合盖睡了一觉,WebKit 的计时器跟着睡)。以前每 2 秒一次的轮询顺手在 apply 里
// preferences.refresh() 就发现了;订阅只在有变化时才来,所以安静期间每秒看一眼本地时钟(不碰 daemon)。
const quietWatch = setInterval(() => { if (quiet && !document.hidden) preferences.refresh() }, 1_000)
// 每一份都按以前两个轮询的顺序观察:先是处境(拿着上一份的 turn),再是新的 turn。
feed.subscribe(f => { bridge.notePresence(f.presence); apply(); petTurn = f.pet; apply(true) })
pet.setPaused(document.hidden)
if (!document.hidden) feed.start()
// start() 自己会先要一份,这里不用再补 refresh()。
// 窗口不可见 → 停订(spec §5.3);回来时 start() 先补一份。
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { drag.cancel(); pet.setLifeAvailable(false);void motion?.stop();pet.setPaused(true); feed.stop(); return }
  preferences.refresh()
  bridge.resume()
  pet.setPaused(false)
  syncLifeAvailability()
  feed.start()
})

const drag = createCompanionDrag({
  start: async () => {await motion?.stop();return mock?null:invoke('start_companion_drag')},
  move: position => invoke('move_companion_window', position),
  finish: () => invoke('finish_companion_drag'),
  onBegin: () => {holding=true;syncLifeAvailability();pet.beginDrag()}, onEnd: () => {holding=false;pet.endDrag();syncLifeAvailability()},
  onVelocity:speed=>pet.setDragVelocity(speed),onLanding:()=>pet.land(),
  onClick: () => { void openCharacter() },
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

/** @type {Map<string,Promise<void>>} */ const opening=new Map()
/** @param {{page:'converse'}|import('./pet-activities.js').TaskDestination} target */
function openDestination(target) {
  const key=JSON.stringify(target),existing=opening.get(key)
  if(existing)return existing
  const action=(async()=>{
    pet.setLifeAvailable(false);await motion?.stop()
    await drag.cancel()
    if(mock){location.assign('./index.html');return}
    try {await openSeenMatter(target, destination => invoke('show_main_window', destination), invokeWorkbenchApi)}
    catch(err){console.warn('show_main_window failed',err);pet.setHint('没能打开 CC，请再试一次')}
  })().finally(()=>opening.delete(key))
  opening.set(key,action);return action
}
function openConversation(){return openDestination({page:'converse'})}
function openCharacter(){return openDestination(taskView?.current()??{page:'converse'})}
$('pet-open-main')?.addEventListener('click', openConversation)
stage?.addEventListener('keydown', event => {
  if (!(event instanceof KeyboardEvent) || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  void openCharacter()
})
// Real mouse clicks were already handled by the release/drag discriminator.
// Accessibility Press and HTMLElement.click carry detail=0 without mouse down/up.
stage?.addEventListener('click', event => {
  if (event instanceof MouseEvent && event.detail === 0) void openCharacter()
})
let pointerNear = false, keyboardNear = false
const releaseNearby = () => { if (!pointerNear && !keyboardNear) pet.releaseAttention() }
stage?.addEventListener('pointerenter', () => { pointerNear = true; pet.acknowledgeAttention() })
stage?.addEventListener('pointerleave', () => { pointerNear = false; releaseNearby() })
stage?.addEventListener('focus', () => { keyboardNear = true; pet.acknowledgeAttention() })
stage?.addEventListener('blur', () => { keyboardNear = false; releaseNearby() })
window.addEventListener('blur', () => { pointerNear = false; keyboardNear = false;pointerInShell=false;focusInShell=false;pet.setLifeAvailable(false);void motion?.stop();syncLifeAvailability();pet.releaseAttention(); taskView?.closeList(); closeSettings() })
window.addEventListener('pagehide',()=>{pet.setLifeAvailable(false);void motion?.destroy();pet.destroy();feed.stop();clearInterval(quietWatch);preferences.destroy()})

$('pet-reset-position')?.addEventListener('click', async () => {
  await motion?.stop()
  await drag.cancel()
  if (mock) { pet.setHint('请在桌面应用中调整位置'); return }
  const button = /** @type {HTMLButtonElement | null} */ ($('pet-reset-position'))
  if (button) button.disabled = true
  try { await invoke('reset_companion_position') }
  catch (err) { console.warn('reset_companion_position failed', err); pet.setHint('没能调整位置，请再试一次') }
  finally { if (button) button.disabled = false }
})

$('companion-window-close')?.addEventListener('click', async () => {
  await motion?.stop()
  await drag.cancel()
  if (mock) { window.close(); return }
  invoke('close_companion_window').catch(() => window.close())
})
$('pet-zoom-out')?.addEventListener('click', async () => { await motion?.stop();await drag.cancel(); if (!mock) invoke('resize_companion_window', { direction: 'out' }).catch(console.warn) })
$('pet-zoom-in')?.addEventListener('click', async () => { await motion?.stop();await drag.cancel(); if (!mock) invoke('resize_companion_window', { direction: 'in' }).catch(console.warn) })
window.addEventListener('keydown', event => {
  if(event.key!=='Escape'||event.defaultPrevented)return
  if(taskView?.closeList(true)){event.preventDefault();return}
  const settings=document.querySelector('.pet-settings')
  if(settings instanceof HTMLDetailsElement&&settings.open){settings.open=false;event.preventDefault();settings.querySelector('summary')?.focus();return}
  $('companion-window-close')?.click()
})
