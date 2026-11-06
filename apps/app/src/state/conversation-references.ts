import { useSyncExternalStore } from 'react'
import type { Backend } from '../backend/types'
// Device-local navigational references, scoped to the backend identity. Never execution authority.
const states = new WeakMap<Backend, { ids: readonly string[]; fresh: readonly string[]; listeners: Set<() => void> }>()
function state(backend: Backend) {
  let s = states.get(backend)
  if (!s) { s = { ids: [], fresh: [], listeners: new Set() }; states.set(backend, s) }
  return s
}
export function rememberReference(backend: Backend, id: string, source = 'matter', fresh = false) {
  const s = state(backend), key = `${source}:${id}`
  if (fresh && !s.fresh.includes(key)) s.fresh = [...s.fresh, key]
  if (s.ids.includes(key)) return
  s.ids = [...s.ids, key]
  s.listeners.forEach(f => f())
}
export function useReferences(backend: Backend) {
  const s = state(backend)
  return useSyncExternalStore(f => { s.listeners.add(f); return () => { s.listeners.delete(f) } }, () => s.ids, () => s.ids)
}

export const newReferences = (backend: Backend) => state(backend).fresh

export function clearReferences(backend: Backend) { const s = state(backend); s.ids = []; s.fresh = []; s.listeners.forEach(f => f()) }
