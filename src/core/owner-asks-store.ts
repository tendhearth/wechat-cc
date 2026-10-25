/**
 * 要主人拍板的候选 —— 落盘(规矩与判法在 owner-asks.ts)。
 *
 * 一个 JSON 文件 `<stateDir>/owner-asks.json`(跟 speech/pending-notices.json 一样是小队列,不进 SQLite):
 * CLI(`wechat-cc self ask`、`self plan --ask`)往里排,daemon(早报那一轮、微信回「2」)改状态 —— 两个进程都写,
 * 所以写一律走 updateJsonFile(读-改-写,中途被别人改了就重读一次)。读不出来 ⇒ 当没有、写入照拒(不把手改坏的冲掉)。
 * 路径由调用方给(core 不碰 node:path,见 scripts/core-no-node.guard.test.ts)。
 */
import { readJsonObject, updateJsonFile } from '../lib/json-file'
import { sha256Hex } from '../lib/content-hash'
import {
  EMPTY_ASKS, answerAsk, askHashInput, commitAsked, enqueue, expireStale, pickForBrief,
  type AnswerResult, type EnqueueInput, type EnqueueResult, type OwnerAsk, type OwnerAsksState, type PickedAsk,
} from '../domain/owner-asks'

export const OWNER_ASKS_FILE = 'owner-asks.json'

const STATUSES = new Set(['queued', 'asked', 'approved', 'declined', 'unanswered'])
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * 读进来的每一条都核一遍形状(整合者评审 #659):手改坏 / 老版本留下的一条要是缺了 `asks`,早报挑的时候会抛,
 * 而早报把抛当「没有候选」吞掉 —— 从此一条都不再问,也没人知道。能补的补(`asks` 缺 ⇒ []、问过却一天都没记 ⇒ 当排着),
 * 补不了的(缺 id / key / 问题 / 推荐 / hash / 状态不认识)丢掉。修过 ⇒ `repaired` 非 0,由调用方记一行日志。
 */
export function coerceAsks(raw: Record<string, unknown>): { state: OwnerAsksState; repaired: number } {
  let repaired = 0
  const items: OwnerAsk[] = []
  for (const v of Array.isArray(raw.items) ? raw.items : []) {
    const a = v as Partial<OwnerAsk> | null
    if (!a || typeof a !== 'object' || !str(a.id) || !str(a.key) || !str(a.question) || !str(a.recommend) || !str(a.hash) || !STATUSES.has(a.status as string)) { repaired++; continue }
    const asks = Array.isArray(a.asks) ? a.asks.filter(str) : []
    let status = a.status as OwnerAsk['status']
    if (status === 'asked' && asks.length === 0) status = 'queued'
    const createdAt = str(a.createdAt) ? a.createdAt : (asks[0] ?? new Date(0).toISOString())
    const priority = typeof a.priority === 'number' && Number.isFinite(a.priority) ? a.priority : 0
    const source = a.source === 'plan' || a.source === 'discover' ? a.source : 'manual'
    const fixed: OwnerAsk = { ...(a as OwnerAsk), status, asks, createdAt, priority, source }
    if (status !== a.status || asks.length !== (Array.isArray(a.asks) ? a.asks.length : -1) || createdAt !== a.createdAt || priority !== a.priority || source !== a.source) repaired++
    items.push(fixed)
  }
  const b = raw.batch as OwnerAsksState['batch']
  const batch = b && typeof b === 'object' && str(b.at) && b.nos && typeof b.nos === 'object' ? b : null
  return { state: { items, batch }, repaired }
}

export interface OwnerAsksStore {
  read(): OwnerAsksState
  enqueueVisibleCandidate(i: EnqueueInput): { result: EnqueueResult; item: OwnerAsk }
  /** 早报那一轮:先把问满三天的记成「主人没要」,再挑今天接哪几条(不记成问过)。 */
  pickForBrief(base: number, nowIso: string): PickedAsk[]
  /** 早报发出去了、这一段接上了 ⇒ 记成问过。 */
  commitAsked(picked: readonly PickedAsk[], nowIso: string): void
  answer(a: { no: number; verdict: 'approved' | 'declined'; by: string; nowIso: string }): AnswerResult
}

export function makeOwnerAsksStore(path: string, o: { newId?: () => string; log?: (tag: string, line: string) => void } = {}): OwnerAsksStore {
  const newId = o.newId ?? (() => sha256Hex(`${Date.now()}:${Math.random()}`).slice(0, 6))
  let warned = false
  const coerce = (raw: Record<string, unknown>): OwnerAsksState => {
    const r = coerceAsks(raw)
    // 只记一次:这个文件每条入站「2」都会读,坏条目不该刷屏。下一次写入时会按修好的样子存回去。
    if (r.repaired && !warned) { warned = true; o.log?.('OWNER_ASK', `${OWNER_ASKS_FILE}: ${r.repaired} 条形状不对,已修 / 丢掉`) }
    return r.state
  }
  const read = (): OwnerAsksState => { try { return coerce(readJsonObject(path)) } catch { return EMPTY_ASKS } }
  const update = <T>(fn: (s: OwnerAsksState) => { state: OwnerAsksState; out: T }): T => {
    let out!: T
    updateJsonFile(path, raw => {
      const r = fn(coerce(raw))
      out = r.out
      for (const k of Object.keys(raw)) delete raw[k]
      Object.assign(raw, { version: 1, items: r.state.items, batch: r.state.batch })
    }, { mode: 0o600 })
    return out
  }
  return {
    read,
    enqueueVisibleCandidate(i) {
      const hash = sha256Hex(askHashInput(i))
      const id = newId()
      return update(s => { const r = enqueue(s, i, { nowIso: new Date().toISOString(), hash, id }); return { state: r.state, out: { result: r.result, item: r.item } } })
    },
    pickForBrief(base, nowIso) {
      const s = read()
      const expired = expireStale(s, nowIso)
      if (expired !== s) update(cur => ({ state: expireStale(cur, nowIso), out: null }))
      return pickForBrief(expired, base)
    },
    commitAsked(picked, nowIso) {
      if (!picked.length) return
      update(s => ({ state: commitAsked(s, picked, nowIso), out: null }))
    },
    answer(a) {
      return update(s => { const r = answerAsk(s, a); return { state: r.state, out: r.r } })
    },
  }
}
