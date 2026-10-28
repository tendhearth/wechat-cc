/**
 * 笔友信道的纯规则(架构终态 E5,从 adapters/store/penpal-channel-store.ts 搬来):store 的 list()
 * 交进来的行怎么收敛。不碰库、不碰 node。
 */

/**
 * 「一个对方一条信道」的那一条 —— 每个 `peer_agent_id` 只留**最新的那条 open
 * 行**,其余(旧的、pending 的)全滤掉。
 *
 * WHY:重新配对总是按 initiator nonce 建新行(两侧才对称),所以同一个对端
 * 完全可能有好几条 open 行。不收敛的话,一条心愿会往同一个人那儿投 N 次
 * (他的主人被打扰 N 次),关系视图里同一个朋友也会出现 N 遍。
 *
 * `peer_agent_id` 为空(经介绍人的匿名信道)一律保留 —— 它们没有「同一个人」
 * 可言,各是各的。同 `created_at` 时保留**先出现的那条**:store 的 list() 是
 * `created_at DESC, rowid DESC`,先出现的就是新的。
 */
export function primaryChannels<T extends { peer_agent_id?: string | null; status: string; created_at?: string }>(rows: readonly T[]): T[] {
  const newest = new Map<string, T>()
  for (const r of rows) {
    const pid = r.peer_agent_id
    if (r.status !== 'open' || pid === null || pid === undefined) continue
    const cur = newest.get(pid)
    if (!cur || (r.created_at ?? '') > (cur.created_at ?? '')) newest.set(pid, r)
  }
  const pid = (r: T): string | null | undefined => r.peer_agent_id
  return rows.filter(r => r.status === 'open' && (pid(r) === null || pid(r) === undefined || newest.get(pid(r)!) === r))
}
