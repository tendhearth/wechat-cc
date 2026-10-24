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
} from './owner-asks'

export const OWNER_ASKS_FILE = 'owner-asks.json'

function coerce(raw: Record<string, unknown>): OwnerAsksState {
  const items = Array.isArray(raw.items) ? (raw.items as OwnerAsk[]).filter(a => a && typeof a.id === 'string' && typeof a.key === 'string') : []
  const b = raw.batch as OwnerAsksState['batch']
  return { items, batch: b && typeof b.at === 'string' && b.nos && typeof b.nos === 'object' ? b : null }
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

export function makeOwnerAsksStore(path: string, o: { newId?: () => string } = {}): OwnerAsksStore {
  const newId = o.newId ?? (() => sha256Hex(`${Date.now()}:${Math.random()}`).slice(0, 6))
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
