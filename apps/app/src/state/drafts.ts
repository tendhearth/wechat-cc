import { uuid } from '../net/uuid'

// 交办草稿只存内存,按 matter 参数分开('new' = 新事项)。
const drafts = new Map<string, string>()
const requestIds = new Map<string, { text: string; id: string }>()
export const getDraft = (key: string) => drafts.get(key) ?? ''
export const setDraft = (key: string, v: string) => { drafts.set(key, v) }
export const deleteDraft = (key: string) => { drafts.delete(key); requestIds.delete(key) }
export const clearDrafts = () => { drafts.clear(); requestIds.clear(); replied.clear(); clearReceipts() }

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

/**
 * 对话页的本机回执(终审 I1):收下过、还没看到落地的那几句。放模块里,不放屏幕的 state ——
 * 主人说完一句就退回「此刻」很常见,屏幕一卸载回执就丢,daemon 这时重启,那句就悄无声息地没了。
 * at 是 daemon 的钟(job.since),localAt 是本机收到回执的时刻。只在落地 / 已知回复 / 「不管它」时清;有上限。
 */
export type Receipt = { requestId: string; text: string; at: number; localAt: number }
export const RECEIPTS_MAX = 20
let receipts: readonly Receipt[] = []
const receiptListeners = new Set<() => void>()
const setReceipts = (next: readonly Receipt[]) => { receipts = next; for (const l of [...receiptListeners]) l() }
/** 快照:引用只在内容变时换(useSyncExternalStore 要求)。 */
export const listReceipts = (): readonly Receipt[] => receipts
export function subscribeReceipts(l: () => void): () => void {
  receiptListeners.add(l)
  return () => { receiptListeners.delete(l) }
}
export function putReceipt(r: Receipt): void {
  const next = [...receipts.filter(x => x.requestId !== r.requestId), r]
  setReceipts(next.length > RECEIPTS_MAX ? next.slice(next.length - RECEIPTS_MAX) : next)
}
export function dropReceipt(requestId: string): void {
  if (receipts.some(x => x.requestId === requestId)) setReceipts(receipts.filter(x => x.requestId !== requestId))
}
function clearReceipts(): void { if (receipts.length) setReceipts([]) }
