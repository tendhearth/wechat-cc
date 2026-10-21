/**
 * daemon 的收尾(重构第二批步 6a,从 main.ts 抽出来)。
 *
 * **不管启动有没有走完都停已登记的子系统**:以前只在 didStartup 之后才 `lc.stopAll()`,启动到一半失败时
 * internal-api 的 HTTP、cli-events、工作台 …… 都会一直挂着(这个门是 2026-06 e2e 重构时带进来的回退;更早的
 * catch 里本来就会 stopAll)。LifecycleSet 只停登记过的,所以半路失败也只停起来了的那些。
 * 其余顺序与原来一致:心跳 → 各子系统倒序 → bootstrap 自带的几样(a2a、配对、知识库、embedder、agy 的 MCP 配置)→ db → 锁。
 */
export interface ShutdownBoot {
  a2aServer?: { stop(): Promise<void> | void } | null
  pairing?: { stop(): void } | null
  knowledge?: { store: { close(): void }; embedder?: { close?(): Promise<void> | void } | null } | null
  registry?: { has?(id: string): boolean }
}

export function makeDaemonShutdown(deps: {
  log: (tag: string, line: string) => void
  stopHeartbeat: () => void
  lc: { stopAll(): Promise<void> }
  boot: () => ShutdownBoot | null
  /** agy 注册过才清它写的全局 MCP 配置。 */
  removeAgyGlobalMcp?: () => void
  closeDb: () => void
  releaseLock: () => void
}): () => Promise<void> {
  let shuttingDown = false
  const step = async (tag: string, what: string, fn: () => unknown) => {
    try { await fn() } catch (err) { deps.log(tag, `${what} error: ${err instanceof Error ? err.message : String(err)}`) }
  }
  return async () => {
    if (shuttingDown) return
    shuttingDown = true; deps.log('DAEMON', 'shutdown initiated')
    deps.stopHeartbeat()
    try { await deps.lc.stopAll() } catch { /* 逐个已由 lc 记下 */ }
    const boot = deps.boot()
    await step('A2A', 'server stop', () => boot?.a2aServer?.stop())
    await step('PAIR', 'stop', () => boot?.pairing?.stop())
    await step('KNOWLEDGE', 'store close', () => boot?.knowledge?.store.close())
    await step('KNOWLEDGE', 'embedder close', () => boot?.knowledge?.embedder?.close?.())
    await step('AGY', 'mcp config cleanup', () => { if (boot?.registry?.has?.('agy')) deps.removeAgyGlobalMcp?.() })
    try { deps.closeDb() } catch (err) { console.error('db close failed:', err) }
    deps.releaseLock()
  }
}
