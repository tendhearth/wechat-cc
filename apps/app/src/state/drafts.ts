import { uuid } from '../net/uuid'

// 交办草稿只存内存,按 matter 参数分开('new' = 新事项)。
const drafts = new Map<string, string>()
const requestIds = new Map<string, { text: string; id: string }>()
export const getDraft = (key: string) => drafts.get(key) ?? ''
export const setDraft = (key: string, v: string) => { drafts.set(key, v) }
export const deleteDraft = (key: string) => { drafts.delete(key); requestIds.delete(key) }
export const clearDrafts = () => { drafts.clear(); requestIds.clear(); replied.clear() }

// 已知 daemon 回复过的 requestId(对话页):永不再拿它重发 —— daemon 的去重表会过期,过期后同一个 id 会再说一遍。
const replied = new Set<string>()
const REPLIED_MAX = 200
export const isReplied = (id: string) => replied.has(id)
export function markReplied(id: string): void {
  replied.delete(id); replied.add(id)
  if (replied.size > REPLIED_MAX) replied.delete(replied.values().next().value!)
}

/** 同一份草稿、同样正文重发 ⇒ 同一个 requestId(daemon 去重、超时后查回执);正文改了、或那个 id 已知有回复 ⇒ 换新的。 */
export function requestIdFor(key: string, text: string, mk: () => string = () => uuid()): string {
  const hit = requestIds.get(key)
  if (hit && hit.text === text && !replied.has(hit.id)) return hit.id
  const id = mk()
  requestIds.set(key, { text, id })
  return id
}
