/**
 * chat-prefs — per-chat preference store, the settings substrate liveness
 * features read (first key: reply splitting; later: sticker frequency,
 * proactive level, persona…). Write-through (debounceMs:0) per
 * architecture-conventions #5: low-frequency critical state survives kill -9.
 */
import { join } from 'node:path'
import { makeStateStore, type StateStore } from './state-store'

export interface ChatPrefs {
  /** Reply splitting (活人感 bubbles). undefined ⇒ ON (default); false ⇒ off. */
  split?: boolean
  /**
   * 主动关心档位 (proactive care level). undefined ⇒ unresolved here — the
   * owner-default resolution happens in calibration's careLevel, NOT in this
   * store (chat-prefs doesn't know about owner/default_chat_id).
   */
  care?: 'off' | 'low' | 'high'
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
