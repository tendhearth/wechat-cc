/**
 * chat-prefs — per-chat preference store, the settings substrate liveness
 * features read (first key: reply splitting; later: sticker frequency,
 * proactive level, persona…). Write-through (debounceMs:0) per
 * architecture-conventions #5: low-frequency critical state survives kill -9.
 */
import { join } from 'node:path'
import { makeStateStore, type StateStore } from './state-store'
import type { AvoidTopic } from '../domain/companion-topics'

export interface ChatPrefs {
  /** Reply splitting (活人感 bubbles). undefined ⇒ ON (default); false ⇒ off. */
  split?: boolean
  /**
   * 主动关心档位 (proactive care level). undefined ⇒ unresolved here — the
   * owner-default resolution happens in calibration's careLevel, NOT in this
   * store (chat-prefs doesn't know about owner/default_chat_id).
   */
  care?: 'off' | 'low' | 'high'
  /** 表情包开关 (sticker replies). undefined ⇒ ON (default); false ⇒ off. */
  stickers?: boolean
  /** 每日打猎开关。**undefined ⇒ 关**(2026-10-21 起,收敛清单 ②;以前是开)。true ⇒ 开。老装机主人的「没设过」开机时写成了显式 true(features/hunt/default-off.ts)。 */
  hunt?: boolean
  /** 每日串门开关。undefined ⇒ ON;false ⇒ off。 */
  visit?: boolean
  /** 主人不希望 CC 主动提起的话题(core/companion-topics);空 / undefined ⇒ 都可以。 */
  avoid?: AvoidTopic[]
  /** 免打扰时段(core/quiet-hours):这段时间 CC 不主动找他;undefined ⇒ 没设(默认不拦)。 */
  quiet?: import('../domain/quiet-hours').QuietWindow
}

export interface ChatPrefsStore {
  get(chatId: string): ChatPrefs
  set(chatId: string, patch: Partial<ChatPrefs>): ChatPrefs
  /** Chat ids present in the underlying store (i.e. that have ever been set()). */
  list(): string[]
}

export function makeChatPrefs(stateDir: string, deps?: { store?: StateStore }): ChatPrefsStore {
  const store = deps?.store ?? makeStateStore(join(stateDir, 'chat_prefs.json'), { debounceMs: 0 })
  const read = (chatId: string): ChatPrefs => {
    const raw = store.get(chatId)
    if (!raw) return {}
    try {
      const p = JSON.parse(raw) as unknown
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as ChatPrefs) : {}
    } catch {
      return {}
    }
  }
  return {
    get: read,
    set(chatId, patch) {
      const next = { ...read(chatId), ...patch }
      store.set(chatId, JSON.stringify(next))
      return next
    },
    list() {
      return Object.keys(store.all())
    },
  }
}
