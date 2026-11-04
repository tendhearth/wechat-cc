/**
 * presence-pulse.ts —— 「在场变了」的内存信号(S5)。只给没有自己 feed 的内存写口用:pet-signals 的几个时间戳、
 * 待决权限登记处。一件事的变化走 MatterLog 的 feed、入站消息走 messages-store 的落库回调,不经这里。
 * 不带内容、不补发:收到的人自己重算(GET /v1/subscribe/presence 的 presence 主题)。
 */
export interface PresencePulse {
  poke(): void
  /** 返回退订。一个回调抛错不影响别的。 */
  on(cb: () => void): () => void
}

export function makePresencePulse(): PresencePulse {
  const listeners = new Set<() => void>()
  return {
    poke() { for (const cb of [...listeners]) { try { cb() } catch { /* 读的人自己的事 */ } } },
    on(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
}
