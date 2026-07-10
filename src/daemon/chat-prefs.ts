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
}

export interface ChatPrefsStore {
  get(chatId: string): ChatPrefs
  set(chatId: string, patch: Partial<ChatPrefs>): ChatPrefs
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
  }
}
