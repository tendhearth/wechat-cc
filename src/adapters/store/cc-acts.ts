import { createHash } from 'node:crypto'
import { makeMatterLog } from './matter-log'
import { makeMatterStore } from './matters-store'
import type { Db } from '../../lib/db'
import type { MatterLog, MatterStore } from '../../ports/matters'
import { CC_ACT_TITLES, type CcActRun, type CcActs, type CcActTurn, type CcActWho } from '../../ports/cc-acts'

/**
 * cc-acts.ts —— CC 自己做的事 → 每个发起方一件 kind='act' 的事(M5a)。只经 MatterLog 写。
 * id 由发起方名字定(sha1('cc-act:<who>') 前 8 位):不用绑定表(它的 surface 有 CHECK,协议里也是封闭枚举)。
 * 写不上一律吞掉 —— 原来的事(写信、整理记忆…)照做,只少一轮记录。
 */
const NOOP: CcActTurn = { id: null, step: () => false, finish: () => false }
const RUNS_DEFAULT_LIMIT = 50
const parseObj = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null
  try { const v = JSON.parse(s) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null } catch { return null }
}
export const ccActMatterId = (who: CcActWho): string => createHash('sha1').update(`cc-act:${who}`).digest('hex').slice(0, 8)

export function makeCcActs(deps: { db: Db; log: MatterLog; matters: Pick<MatterStore, 'get' | 'create'>; onError?: (what: string, err: unknown) => void }): CcActs {
  const { db, log, matters } = deps
  const fail = (what: string, err: unknown) => { try { deps.onError?.(what, err) } catch { /* 日志也写不上就算了 */ } }
  const ensure = (who: CcActWho): string => {
    const id = ccActMatterId(who)
    if (!matters.get(id)) matters.create({ id, kind: 'act', initiator: 'cc', title: CC_ACT_TITLES[who], origin: 'companion' })
    return id
  }
  return {
    matterIdOf: ccActMatterId,
    begin(who, opts = {}) {
      let matterId: string, turnId: string
      try {
        matterId = ensure(who)
        turnId = log.startTurn({ matterId, executor: 'cc', ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}), policy: { who, ...(opts.policy ?? {}) } }).id
      } catch (err) { fail(`begin ${who}`, err); return NOOP }
      let finished = false
      return {
        id: turnId,
        step(kind, payload, o = {}) {
          // key 只在这一轮里认(一个发起方所有的轮都在同一件事里,MatterLog 的 key 按整件事认 ⇒ 带上轮 id,别把上一轮的步改掉;Codex 评审)
          try { log.writeItem({ matterId, turnId, kind, status: o.status ?? 'completed', ...(o.key ? { key: `${turnId}:${o.key}` } : {}), payload }); return true } catch (err) { fail(`step ${who} ${kind}`, err); return false }
        },
        finish(status, o = {}) {
          if (finished) return false
          finished = true
          try { log.finishTurn(turnId, { status, ...(o.endedAt !== undefined ? { endedAt: o.endedAt } : {}), ...(o.errorCode ? { errorCode: o.errorCode } : {}) }); return true } catch (err) { fail(`finish ${who}`, err); return false }
        },
      }
    },
    runs(who, o = {}) {
      try {
        const matterId = ccActMatterId(who)
        const limit = Math.max(1, Math.min(1000, Math.floor(o.limit ?? RUNS_DEFAULT_LIMIT)))
        const pick = 'SELECT id FROM matter_turns WHERE matter_id=? AND (? IS NULL OR status=?) ORDER BY started_at DESC, cursor DESC LIMIT ?'
        const args: [string, string | null, string | null, number] = [matterId, o.status ?? null, o.status ?? null, limit]
        const turns = db.query<{ id: string; status: string; errorCode: string | null; startedAt: number; endedAt: number | null; policy: string | null }, typeof args>(
          `SELECT id,status,error_code AS errorCode,started_at AS startedAt,ended_at AS endedAt,policy_json AS policy FROM matter_turns WHERE id IN (${pick}) ORDER BY started_at DESC, cursor DESC`).all(...args)
        const steps = new Map<string, CcActRun['steps'][number][]>()
        if (o.steps !== false) {
          for (const i of db.query<{ turnId: string; kind: string; status: string; payload: string; at: number }, typeof args>(
            `SELECT turn_id AS turnId,kind,status,payload_json AS payload,created_at AS at FROM matter_items WHERE turn_id IN (${pick}) ORDER BY seq`).all(...args)) {
            const list = steps.get(i.turnId) ?? []
            list.push({ kind: i.kind as CcActRun['steps'][number]['kind'], status: i.status as CcActRun['steps'][number]['status'], payload: parseObj(i.payload) ?? {}, at: i.at })
            steps.set(i.turnId, list)
          }
        }
        return turns.map((t): CcActRun => ({
          id: t.id, status: t.status as CcActRun['status'], errorCode: t.errorCode, startedAt: t.startedAt, endedAt: t.endedAt, policy: parseObj(t.policy), steps: steps.get(t.id) ?? [],
        }))
      } catch (err) { fail(`runs ${who}`, err); return [] }
    },
    stepsOf(who, kind) {
      try {
        return db.query<{ turnId: string; kind: string; status: string; payload: string; at: number }, [string, string]>(
          'SELECT turn_id AS turnId,kind,status,payload_json AS payload,created_at AS at FROM matter_items WHERE matter_id=? AND kind=? AND turn_id IS NOT NULL ORDER BY seq DESC').all(ccActMatterId(who), kind)
          .map(i => ({ turnId: i.turnId, kind: i.kind as CcActRun['steps'][number]['kind'], status: i.status as CcActRun['steps'][number]['status'], payload: parseObj(i.payload) ?? {}, at: i.at }))
      } catch (err) { fail(`stepsOf ${who}`, err); return [] }
    },
    toTurn(who, turnId, kind, payload, o = {}) {
      try {
        const matterId = ccActMatterId(who)
        if (!db.query<{ id: string }, [string, string]>('SELECT id FROM matter_turns WHERE id=? AND matter_id=?').get(turnId, matterId)) return
        log.writeItem({ matterId, turnId, kind, status: o.status ?? 'completed', payload })
      } catch (err) { fail(`toTurn ${who} ${kind}`, err) }
    },
    interruptAll() {
      for (const t of db.query<{ id: string }, []>("SELECT t.id FROM matter_turns t JOIN matters m ON m.id=t.matter_id WHERE m.kind='act' AND t.status='running' ORDER BY t.cursor").all())
        log.finishTurn(t.id, { status: 'interrupted', errorCode: 'daemon_restarted' })
    },
  }
}

/** 各个发起方接线用的一份(同一个库;写不上记一行 CC_ACTS)。第一次用时才建:接线时库还没好(测试里的假库)也不掀翻接线。 */
export function ccActsFor(db: Db, log: (tag: string, line: string) => void): CcActs {
  const onError = (what: string, err: unknown) => { try { log('CC_ACTS', `${what} failed: ${err instanceof Error ? err.message : String(err)}`) } catch { /* 日志也写不上 */ } }
  let real: CcActs | null = null
  const get = (): CcActs | null => {
    if (real) return real
    try { real = makeCcActs({ db, log: makeMatterLog(db), matters: makeMatterStore(db), onError }) } catch (err) { onError('open', err) }
    return real
  }
  return {
    begin: (who, o) => get()?.begin(who, o) ?? NOOP,
    toTurn: (who, turnId, kind, payload, o) => { get()?.toTurn(who, turnId, kind, payload, o) },
    runs: (who, o) => get()?.runs(who, o) ?? [],
    stepsOf: (who, kind) => get()?.stepsOf(who, kind) ?? [],
    matterIdOf: ccActMatterId,
    interruptAll: () => { get()?.interruptAll() },
  }
}
