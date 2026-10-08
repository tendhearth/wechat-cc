import type { Backend } from '../backend/types'
import type { PickedImage } from './image-upload'
import type { PairingRecord } from '../net/pairing'
import { uuid } from '../net/uuid'

// 交办草稿只存内存,按 matter 参数分开('new' = 新事项)。
const drafts = new Map<string, string>()
const revisions = new Map<string, number>()
let revision = 0
let draftOwner: string | undefined
export type DraftStamp = { owner: string; revision: number }
/** A process-owned revision distinguishes retyped identical text from the submitted draft. */
export const getDraftStamp = (key: string): DraftStamp => ({ owner: draftOwner ??= uuid(), revision: revisions.get(key) ?? revision })
export const sameDraftStamp = (a: DraftStamp | undefined, b: DraftStamp) => !!a && a.owner === b.owner && a.revision === b.revision
export type EntrySettings={projectId:string|null;providerId:string|null;executionMode:'auto'|'isolated'|'project';modelId?:string;effort?:string;base?:string;forkProviderPending?:boolean}
const entrySettings=new Map<string,EntrySettings>()
export const getEntrySettings=(key:string,fallback:EntrySettings={projectId:null,providerId:null,executionMode:'auto'}):EntrySettings=>({...entrySettings.get(key)??fallback})
export const setEntrySettings=(key:string,value:EntrySettings)=>{
  if(JSON.stringify(getEntrySettings(key))!==JSON.stringify(value))revisions.set(key,++revision)
  entrySettings.set(key,{...value})
}
// Selected materials stay with the same process-owned draft across screen remounts.
const draftImages=new Map<string,PickedImage[]>()
export const getDraftImages=(key:string):PickedImage[]=>[...draftImages.get(key)??[]]
export const setDraftImages=(key:string,images:PickedImage[])=>{
  if(JSON.stringify(getDraftImages(key).map(i=>i.id))!==JSON.stringify(images.map(i=>i.id)))revisions.set(key,++revision)
  if(images.length)draftImages.set(key,[...images]);else draftImages.delete(key)
}
type CreationInput = Parameters<Backend['create']>[0]
const creationAttempts = new Map<string, { signature: string; stamp: DraftStamp; input: CreationInput }>()
/** Freeze the effective creation payload until the user edits this process-owned draft. */
export function creationInputFor(key: string, signature: string, input: Omit<CreationInput, 'requestId'>): CreationInput {
  const stamp = getDraftStamp(key), prior = creationAttempts.get(key)
  if (prior?.signature === signature && sameDraftStamp(prior.stamp, stamp)) return prior.input
  const frozen: CreationInput = {
    ...input, requestId: uuid(),
    ...(input.execution ? { execution: { ...input.execution } } : {}),
    ...(input.attachmentIds ? { attachmentIds: [...input.attachmentIds] } : {}),
  }
  if (frozen.execution) Object.freeze(frozen.execution)
  if (frozen.attachmentIds) Object.freeze(frozen.attachmentIds)
  Object.freeze(frozen)
  creationAttempts.set(key, { signature, stamp, input: frozen })
  return frozen
}
const requestIds = new Map<string, { text: string; id: string }>()
// 带图时那份草稿的材料草稿 id(2026-10-06):选图起就定下,发成功(deleteDraft)才换 —— 重发 / 续传都落在同一个草稿下。
const materialDrafts = new Map<string, string>()
export const materialDraftId = (key: string): string => { let id = materialDrafts.get(key); if (!id) { id = uuid(); materialDrafts.set(key, id) } return id }
export const getDraft = (key: string) => drafts.get(key) ?? ''
export const setDraft = (key: string, v: string) => { drafts.set(key, v); revisions.set(key, ++revision) }
export const deleteDraft = (key: string) => { drafts.delete(key); entrySettings.delete(key); draftImages.delete(key); requestIds.delete(key); creationAttempts.delete(key); materialDrafts.delete(key); revisions.set(key, ++revision) }
export const clearDrafts = () => { gen++; revision++; drafts.clear(); entrySettings.clear(); draftImages.clear(); revisions.clear(); requestIds.clear(); creationAttempts.clear(); materialDrafts.clear(); replied.clear(); clearReceipts() }

/**
 * 这些都只对「当前这台电脑」有意义(复评):换配对(配上 / 解除 / 换电脑 / 演示↔真连)⇒ 全清,配对代 +1。
 * 换配对前发出、之后才回来的 putReceipt / markReplied 带着旧代 ⇒ 不落 —— A 电脑的「可能没送到」不能带到 B 上重试。
 */
let gen = 0
let scope: string | undefined
export const pairingGen = () => gen
/** 配对身份(不含令牌):同一台电脑、同一台设备 ⇒ 同一个键。 */
export const pairingScopeKey = (p: PairingRecord | null): string => (p ? `live:${p.daemonId}:${p.deviceId}` : 'none')
/** BackendProvider 在建后端时同步调用(可能在 render 里):清是同步的,通知订阅者推到微任务,不在别人 render 中途 setState。 */
export function setPairingScope(key: string): void {
  if (scope === key) return
  const first = scope === undefined
  scope = key
  if (first) return
  gen++
  revision++; revisions.clear()
  drafts.clear(); entrySettings.clear(); draftImages.clear(); requestIds.clear(); creationAttempts.clear(); materialDrafts.clear(); replied.clear()
  if (receipts.length) { receipts = []; queueMicrotask(notifyReceipts) }
}

// 已知 daemon 回复过的 requestId(对话页):永不再拿它重发 —— daemon 的去重表会过期,过期后同一个 id 会再说一遍。
const replied = new Set<string>()
const REPLIED_MAX = 200
export const isReplied = (id: string) => replied.has(id)
export function markReplied(id: string, atGen: number = gen): void {
  if (atGen !== gen) return
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
/** materials:这句带的图(重试要原样带上同一组 id,电脑才认得是同一句)。带图时 text 是电脑会记下的样子(「…\n[图片 ×N]」,
 *  用来显示和认「已落地」),sent 是真正说出去的原文(重试用它)。 */
export type Receipt = { requestId: string; text: string; at: number; localAt: number; materials?: { draftId: string; attachmentIds: string[] }; sent?: string }
export const RECEIPTS_MAX = 20
let receipts: readonly Receipt[] = []
const receiptListeners = new Set<() => void>()
const notifyReceipts = () => { for (const l of [...receiptListeners]) l() }
const setReceipts = (next: readonly Receipt[]) => { receipts = next; notifyReceipts() }
/** 快照:引用只在内容变时换(useSyncExternalStore 要求)。 */
export const listReceipts = (): readonly Receipt[] => receipts
export function subscribeReceipts(l: () => void): () => void {
  receiptListeners.add(l)
  return () => { receiptListeners.delete(l) }
}
export function putReceipt(r: Receipt, atGen: number = gen): void {
  if (atGen !== gen) return
  const next = [...receipts.filter(x => x.requestId !== r.requestId), r]
  setReceipts(next.length > RECEIPTS_MAX ? next.slice(next.length - RECEIPTS_MAX) : next)
}
export function dropReceipt(requestId: string): void {
  if (receipts.some(x => x.requestId === requestId)) setReceipts(receipts.filter(x => x.requestId !== requestId))
}
function clearReceipts(): void { if (receipts.length) setReceipts([]) }
