import { uuid } from '../net/uuid'

// 交办草稿只存内存,按 matter 参数分开('new' = 新事项)。
const drafts = new Map<string, string>()
const requestIds = new Map<string, { text: string; id: string }>()
export const getDraft = (key: string) => drafts.get(key) ?? ''
export const setDraft = (key: string, v: string) => { drafts.set(key, v) }
export const deleteDraft = (key: string) => { drafts.delete(key); requestIds.delete(key) }
export const clearDrafts = () => { drafts.clear(); requestIds.clear() }

/** 同一份草稿、同样正文重发 ⇒ 同一个 requestId(daemon 去重、超时后查回执);正文改了就换新的。 */
export function requestIdFor(key: string, text: string, mk: () => string = () => uuid()): string {
  const hit = requestIds.get(key)
  if (hit && hit.text === text) return hit.id
  const id = mk()
  requestIds.set(key, { text, id })
  return id
}
