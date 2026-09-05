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

const $ = (/** @type {string} */ id) => document.getElementById(id)
// 浏览器预览(没有 Tauri 运行时)里窗口命令无处可去 —— 用它决定要不要发。
const mock = !(/** @type {any} */ (window).__TAURI__?.core?.invoke)
const stage = $('pet-stage'), img = $('pet-sprite'), props = $('pet-props'), hint = $('pet-hint')
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const pet = await createPet({ stage, img, props, hint }, { manifestUrl: './assets/pet/manifest.json', reducedMotion })
if (new URLSearchParams(location.search).has('lab')) /** @type {any} */ (window).__pet = pet

// presence(处境)+ pet 端点(在做什么)→ 一个意图(spec §5)。两个轮询各拉各的,
// 谁回来都重算一次 —— 有状态的合并在 pet-bridge.js 里(那儿有测试),这里只做接线。
const poller = createPresencePoller({ invokeApi, intervalMs: 20_000 })
const petPoller = createPetPoller({ invokeApi })
// 权限卡片:能不能真的按下去,看的是**有没有 Tauri 运行时**(operator token 只有它拿得到),
// 不能看 invoke 的返回 —— 浏览器预览的 mockInvoke 对任何未知命令都回 {}。
const card = createPermissionCard({ el: $('pet-card'), makeEl: (/** @type {string} */ t) => document.createElement(t) }, {
  canResolve: !mock,
  onResolve: async (hash, decision) => {
    try {
      const r = /** @type {any} */ (await invoke('pet_permission_resolve', { hash, decision }))
      return r === true
    } catch (err) { console.warn('pet_permission_resolve failed', err); return false }
    // 不管成没成:立刻重拉一次,让卡片的去留由 daemon 的列表说了算(微信那端也可能刚点过)。
    finally { petPoller.refresh() }
  },
})

const bridge = createPetBridge()
const apply = () => {
  const r = bridge.tick(petPoller.current())
  pet.applyIntent(r.intent)
  if (r.permission) card.show(r.permission, r.permissionCount); else card.hide()
  petPoller.setFast(r.fast)
}
poller.subscribe(p => { bridge.notePresence(p); apply() })
petPoller.subscribe(() => apply())
poller.start()
petPoller.start()
// start() 自己会先拉一次,这里不用再补 refresh()。
// 窗口不可见 → 两个都停(spec §5.3);回来时 start() 会各自补一拍。
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { poller.stop(); petPoller.stop(); return }
  poller.start(); petPoller.start()
})

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
