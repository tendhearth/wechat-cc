// @ts-check
// companion-window.js — CC 桌宠窗的胶水:组装 pet,接 presence 轮询,窗口拖动 / 缩放 / 关闭。
// 只调 pet 的语义接口;这里不出现任何帧文件名。
import { createPet } from './pet/pet.js'
import { presenceToPet } from './pet/bridge/presence-map.js'
import { createPresencePoller } from './presence-poller.js'
import { invokeApi } from './api.js'
import { invoke } from './ipc.js'

const $ = (/** @type {string} */ id) => document.getElementById(id)
// 浏览器预览(没有 Tauri 运行时)里窗口命令无处可去 —— 用它决定要不要发。
const mock = !(/** @type {any} */ (window).__TAURI__?.core?.invoke)
const stage = $('pet-stage'), img = $('pet-sprite'), props = $('pet-props'), hint = $('pet-hint')
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const pet = await createPet({ stage, img, props, hint }, { manifestUrl: './assets/pet/manifest.json', reducedMotion })
if (new URLSearchParams(location.search).has('lab')) /** @type {any} */ (window).__pet = pet

// presence(处境)→ 意图。Phase B 在这里再叠 turn 端点。
/** @type {import('./presence-poller.js').Presence | null} */
let prev = null
const poller = createPresencePoller({ invokeApi, intervalMs: 20_000 })
// prev 只记**拉到过的真状态**:拉不到时 poller 发 DOWN_PRESENCE(unread 0),
// 拿它当基准会让下一次拉通时凭空播一次「收到信」。
poller.subscribe(p => { pet.applyIntent(presenceToPet(p, prev)); if (p.presence !== 'down') prev = p })
poller.start()
// start() 自己会先拉一次,这里不用再补 refresh()。
document.addEventListener('visibilitychange', () => { if (document.hidden) poller.stop(); else poller.start() })

// 拖动:按下进 drag,交给系统拖窗口。系统拖动结束后不一定有事件回来,所以回落靠
// mouseup / blur 兜底,再加一条 mousemove(按键已松开)的事件型安全网 —— 不用计时器。
stage?.addEventListener('mousedown', (event) => {
  if (!(event instanceof MouseEvent) || event.button !== 0) return
  event.preventDefault()
  pet.beginDrag()
  if (!mock) invoke('start_companion_drag').catch(console.warn)
})
const endDrag = () => pet.endDrag()
window.addEventListener('mouseup', endDrag)
window.addEventListener('blur', endDrag)
window.addEventListener('mousemove', (event) => { if (event instanceof MouseEvent && event.buttons === 0) endDrag() })

$('companion-window-close')?.addEventListener('click', () => {
  if (mock) { window.close(); return }
  invoke('close_companion_window').catch(() => window.close())
})
$('pet-zoom-out')?.addEventListener('click', () => { if (!mock) invoke('resize_companion_window', { direction: 'out' }).catch(console.warn) })
$('pet-zoom-in')?.addEventListener('click', () => { if (!mock) invoke('resize_companion_window', { direction: 'in' }).catch(console.warn) })
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') $('companion-window-close')?.click() })
