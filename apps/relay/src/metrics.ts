/** 只记计数、不带任何 id(spec §7)。没绑 Analytics Engine(本地 / 测试)⇒ 空操作。 */
export function count(env: Env, event: string): void {
  try { env.METRICS?.writeDataPoint({ blobs: [event], doubles: [1] }) } catch { /* 指标丢了不影响转发 */ }
}
