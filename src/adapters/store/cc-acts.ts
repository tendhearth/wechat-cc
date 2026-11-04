import { createHash } from 'node:crypto'
import type { Db } from '../../lib/db'
import type { MatterLog, MatterStore } from '../../ports/matters'
import { CC_ACT_TITLES, type CcActs, type CcActTurn, type CcActWho } from '../../ports/cc-acts'

/**
 * cc-acts.ts —— CC 自己做的事 → 每个发起方一件 kind='act' 的事(M5a)。只经 MatterLog 写。
 * id 由发起方名字定(sha1('cc-act:<who>') 前 8 位):不用绑定表(它的 surface 有 CHECK,协议里也是封闭枚举)。
 * 写不上一律吞掉 —— 原来的事(写信、整理记忆…)照做,只少一轮记录。
 */
const NOOP: CcActTurn = { step() {}, finish() {} }
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
        step(kind, payload, o = {}) {
          // key 只在这一轮里认(一个发起方所有的轮都在同一件事里,MatterLog 的 key 按整件事认 ⇒ 带上轮 id,别把上一轮的步改掉;Codex 评审)
          try { log.writeItem({ matterId, turnId, kind, status: o.status ?? 'completed', ...(o.key ? { key: `${turnId}:${o.key}` } : {}), payload }) } catch (err) { fail(`step ${who} ${kind}`, err) }
        },
        finish(status, o = {}) {
          if (finished) return
          finished = true
          try { log.finishTurn(turnId, { status, ...(o.endedAt !== undefined ? { endedAt: o.endedAt } : {}), ...(o.errorCode ? { errorCode: o.errorCode } : {}) }) } catch (err) { fail(`finish ${who}`, err) }
        },
      }
    },
    interruptAll() {
      for (const t of db.query<{ id: string }, []>("SELECT t.id FROM matter_turns t JOIN matters m ON m.id=t.matter_id WHERE m.kind='act' AND t.status='running' ORDER BY t.cursor").all())
        log.finishTurn(t.id, { status: 'interrupted', errorCode: 'daemon_restarted' })
    },
  }
}
