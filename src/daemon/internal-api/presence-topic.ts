/**
 * presence-topic.ts —— 桌宠订的 `presence` 主题(骨架设计稿 2026-10-31 §3.3 / S5)。
 *
 * 一份内容 = 桌宠要的两样:处境(`computePresence`,和 GET /v1/companion/presence 同一个函数)+ 在做什么
 * (`petTurn`,和 GET /v1/companion/pet 同一个闭包)。桌面按 `since=<cursor>` 长轮询(和一起做详情同一种传输):
 * 内容变了 cursor 才加一,读的人手里的 cursor 和现在的不一样就马上回,一样就挂着等。
 *
 * 什么时候重算:
 *  - 有人戳(`poke`):在场的几个单一写口 —— pet-signals(回合起落 / 工具调用 / 主人拍板)、待决权限的开与了结、
 *    一件事的变化(MatterLog 的 feed)、不进游标的写(lib/write-hints:新消息、matters 行、觅食台、看到哪了的水位)。戳了之后合并一小会儿(debounceMs)再算一次;
 *  - 到点:「在干活」只在最后一次工具调用后 5 秒内成立(pet-turn.ts WORKING_WINDOW_MS),到点那一刻重算一次;
 *  - 兜底:有人在等时,桌宠在忙(有回合 / 待批 / 在跑的任务)每 fastMs 算一次,闲着每 slowMs 一次 ——
 *    和以前桌面轮询的快慢两档一样,所以没戳到的变化最多也就晚到以前那么久;没人在等就一次都不算。
 * 处境那一半(要扫每个会话的入站时间)只在被戳过或者旧了 slowMs 才重算,在做什么那一半每次都算。
 *
 * 红线(在场设计稿):不撒谎。算不出来的那一半给 null(桌面按「联系不上 / 端点没接」画),不拿旧值顶。
 * cursor 从开机那一刻的毫秒数起跳:daemon 重启后,桌面手里旧的 cursor 一定对不上,马上拿到新内容。
 */
import type { Presence } from '../../domain/companion-presence'
import { WORKING_WINDOW_MS, type PetTurnPayload } from '../../domain/pet-turn'

export interface PresenceTopicPayload {
  cursor: number
  presence: Presence | null
  pet: PetTurnPayload | null
}

export interface PresenceTopic {
  /** 在场的某个写口变了。 */
  poke(): void
  /**
   * since 为 null ⇒ 马上回(先确保内容是新算的);否则 cursor 和 since 不一样就马上回,一样就等到变化、maxMs 或 signal 中止。
   */
  wait(since: number | null, maxMs: number, signal?: AbortSignal): Promise<PresenceTopicPayload>
  /** 叫醒所有等着的、停掉计时器(daemon 关机)。 */
  dispose(): void
}

export interface PresenceTopicDeps {
  computePresence: () => Promise<Presence | null>
  computePet: () => Promise<PetTurnPayload | null>
  now?: () => number
  fastMs?: number
  slowMs?: number
  debounceMs?: number
}

const TASK_ACTIVE = new Set(['needs_input', 'working', 'queued', 'paused', 'stopping'])

/** 桌宠此刻在忙吗(兜底重算走快档)。和以前桌面 setFast 的判法同源:有回合、有待批、有在跑的任务。 */
export function petBusy(pet: PetTurnPayload | null): boolean {
  if (!pet) return false
  return pet.turn.phase !== 'idle' || pet.pending_permissions.length > 0 || (pet.activities ?? []).some(a => TASK_ACTIVE.has(a.phase))
}

export function makePresenceTopic(d: PresenceTopicDeps): PresenceTopic {
  const now = d.now ?? (() => Date.now())
  const fastMs = d.fastMs ?? 2_000
  const slowMs = d.slowMs ?? 10_000
  const debounceMs = d.debounceMs ?? 30
  let cursor = now()
  let key: string | null = null
  let presence: Presence | null = null
  let pet: PetTurnPayload | null = null
  let presenceAt: number | null = null
  let presenceDirty = true
  let evaluatedAt: number | null = null
  let inflight: Promise<void> | null = null
  let again = false
  let disposed = false
  type Waiter = { since: number; finish: () => void }
  const waiters = new Set<Waiter>()
  let debounce: ReturnType<typeof setTimeout> | null = null
  let recheck: ReturnType<typeof setTimeout> | null = null
  const unref = (t: ReturnType<typeof setTimeout>) => { (t as { unref?: () => void }).unref?.() }

  const payload = (): PresenceTopicPayload => ({ cursor, presence, pet })

  async function computeOnce(): Promise<void> {
    const t = now()
    if (presenceDirty || presenceAt === null || t - presenceAt >= slowMs) {
      presenceDirty = false
      try { presence = await d.computePresence() } catch { presence = null }
      presenceAt = t
    }
    try { pet = await d.computePet() } catch { pet = null }
    evaluatedAt = now()
    const next = JSON.stringify([presence, pet])
    if (next !== key) {
      key = next
      cursor++
      for (const w of [...waiters]) if (w.since !== cursor) w.finish()
    }
  }

  /** 单飞:算的时候又被戳,算完再算一次(不并发、不丢)。 */
  function evaluate(): Promise<void> {
    if (inflight) { again = true; return inflight }
    inflight = (async () => {
      do { again = false; await computeOnce() } while (again && !disposed)
    })().finally(() => { inflight = null; arm() })
    return inflight
  }

  /** 有人在等才排下一次重算:到点(working 退成 thinking)和兜底,取早的那个。 */
  function arm(): void {
    if (recheck) { clearTimeout(recheck); recheck = null }
    if (disposed || waiters.size === 0) return
    let delay = petBusy(pet) ? fastMs : slowMs
    if (pet?.turn.phase === 'working' && pet.turn.since) {
      const flip = Date.parse(pet.turn.since) + WORKING_WINDOW_MS + 20 - now()
      if (Number.isFinite(flip)) delay = Math.max(0, Math.min(delay, flip))
    }
    recheck = setTimeout(() => { recheck = null; void evaluate() }, delay)
    unref(recheck)
  }

  return {
    poke() {
      if (disposed) return
      presenceDirty = true
      // 没人在等就只记一笔「脏了」:下一个来问的人会先重算。
      if (waiters.size === 0 || debounce) return
      debounce = setTimeout(() => { debounce = null; void evaluate() }, debounceMs)
      unref(debounce)
    },
    async wait(since, maxMs, signal) {
      // 内容旧了(没人等的时候不重算)或被戳过 ⇒ 先算一次再判断。
      if (evaluatedAt === null || presenceDirty || now() - evaluatedAt >= fastMs) await evaluate()
      if (since === null || since !== cursor || maxMs <= 0 || disposed || signal?.aborted) return payload()
      return new Promise<PresenceTopicPayload>(resolve => {
        let done = false
        const waiter: Waiter = {
          since,
          finish: () => {
            if (done) return
            done = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', waiter.finish)
            waiters.delete(waiter)
            if (waiters.size === 0) arm()
            resolve(payload())
          },
        }
        const timer = setTimeout(waiter.finish, maxMs)
        unref(timer)
        signal?.addEventListener('abort', waiter.finish, { once: true })
        waiters.add(waiter)
        if (!recheck && !inflight) arm()
      })
    },
    dispose() {
      disposed = true
      if (debounce) { clearTimeout(debounce); debounce = null }
      if (recheck) { clearTimeout(recheck); recheck = null }
      for (const w of [...waiters]) w.finish()
    },
  }
}
