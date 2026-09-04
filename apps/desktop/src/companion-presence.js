// @ts-check
// companion-presence.js — 把桌宠状态接到鱼缸(spec 2026-09-03-companion-presence §3)。
// 主界面首页和浮窗各调一次;它们挂的是同一个 animation-lab,所以两处自动一致。
import { invokeApi as defaultInvokeApi } from './api.js'
import { createPresencePoller } from './presence-poller.js'
import { sceneStateFrom } from './companion-scene-state.js'

/**
 * @param {{
 *   onOpenJournal: () => void,
 *   intervalMs?: number,
 *   invokeApi?: typeof defaultInvokeApi,
 *   scene?: { setState(s: unknown): void, onPropClick: (() => void) | null } | null,
 * }} opts  scene 缺省读 window.__companionScene(每次轮询时读,animation-lab 可能晚于本模块就绪)
 */
export function startCompanionPresence({ onOpenJournal, intervalMs = 20_000, invokeApi = defaultInvokeApi, scene }) {
  const poller = createPresencePoller({ invokeApi, intervalMs })
  const resolveScene = () => scene === undefined ? /** @type {any} */ (globalThis).__companionScene ?? null : scene
  poller.subscribe(p => {
    const s = resolveScene()
    if (!s) return
    s.onPropClick = onOpenJournal
    s.setState(sceneStateFrom(p))
  })
  poller.start()
  return poller
}
