/**
 * daemon 的收尾(重构第二批步 6a,从 main.ts 抽出来)。
 *
 * **不管启动有没有走完都停已经起了的**:心跳 → 模块容器(全部模块,严格按开机的倒序;开机途中也只停起了的那些)
 * → agy 的 MCP 配置 → db → 锁。架构终态 A2 起 bootstrap 的那几块也是容器里的模块,不再有单独的收尾清单。
 */
export interface ShutdownBoot {
  registry?: { has?(id: string): boolean }
}

export function makeDaemonShutdown(deps: {
  log: (tag: string, line: string) => void
  stopHeartbeat: () => void
  /** 模块容器(main.ts 的那一个)。 */
  modules: { stopAll(): Promise<void> }
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
    try { await deps.modules.stopAll() } catch { /* 逐个已由容器记下 */ }
    const boot = deps.boot()
    await step('AGY', 'mcp config cleanup', () => { if (boot?.registry?.has?.('agy')) deps.removeAgyGlobalMcp?.() })
    try { deps.closeDb() } catch (err) { console.error('db close failed:', err) }
    deps.releaseLock()
  }
}
