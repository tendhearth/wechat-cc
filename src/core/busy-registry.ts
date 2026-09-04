/**
 * busy-registry — "有工作在跑"的统一登记处(spec 2026-08-11 §1)。
 *
 * 自我重启的空闲判定原本只看 SessionManager 的会话 —— 它建模的是"用户
 * 在不在",而该建模的是"工作在不在"。所有不经 SessionManager 的长任务
 * (A2A 委派、ingest/introspect tick、客户回顾、觅食扇出)干活时在这里
 * 各持一个 token,空闲判定读 busy() 即可,一个概念覆盖整类。
 *
 * 永不抛;release 幂等。label 由 `labels()` 暴露给桌宠状态推导(spec 2026-09-03-companion-presence)。
 */
export interface BusyRegistry {
  /** 拿一个 token;返回 release。release 幂等,多次调用无害。 */
  hold(label: string): () => void
  busy(): boolean
  /** 当前持有者的 label 快照(spec 2026-09-03-companion-presence §2.2)。 */
  labels(): string[]
}

export function makeBusyRegistry(): BusyRegistry {
  const holders = new Map<symbol, string>()
  return {
    hold(label) {
      const key = Symbol(label)
      holders.set(key, label)
      return () => { holders.delete(key) }
    },
    busy() {
      return holders.size > 0
    },
    labels() {
      return Array.from(holders.values())
    },
  }
}
