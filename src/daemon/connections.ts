/**
 * connections.ts — 「CC 的连接」卡的快照(spec 2026-10-01 §1.4、§3)。纯函数:IO 全在 deps 里。
 * 永不撒谎:插件快照还没出来 ⇒ unknown;知识库没开 ⇒ 不出现(不是故障)。
 * detail(插件目录、未就绪原因)只给 admin;手机路由一律经 redactConnections。
 */
import type { PluginsHealth } from './plugins/health'

export type SourceState = 'ready' | 'behind' | 'not_loaded' | 'unknown'
export interface ConnectionSource { id: string; kind: 'wechat_history' | 'knowledge' | 'plugin'; name: string; state: SourceState; latestAt: number | null; syncedAt: number | null; detail?: { reason?: string; dir?: string | null } }
export interface ConnectionsSnapshot {
  generatedAt: number
  /** 插件快照还没出来 = daemon 真的还在启动(手机只在这时说「电脑还在启动」;别的 unknown 用中性措辞)。 */
  starting?: boolean
  sources: ConnectionSource[]
  computers: Array<{ id: string; label: string; online: boolean; since: number | null; version: string | null }>
  recent: Array<{ matterId: string; title: string; phase: string; at: number }>
  outputs: Array<{ matterId: string; name: string; mime: string; at: number }>
}
export const WECHAT_SYNC_STALE_MS = 24 * 3_600_000
export const KNOWLEDGE_STALE_MS = 72 * 3_600_000
export interface ConnectionsDeps {
  plugins(): PluginsHealth | null
  wechatSyncedAt(): number | null
  /** latestAt = newest message (informational); syncedAt = last clean ingest pass (what staleness is judged on). */
  knowledge(): { enabled: boolean; built: boolean; latestAt: number | null; syncedAt: number | null }
  computer(): { label: string; since: number | null; version: string | null }
  workbench?: {
    list(q: { archived: 'exclude'; limit: number }): { tasks: Array<{ id: string; title: string; phase?: string; updatedAt: number }> }
    detail(id: string): { artifacts: Array<{ name: string; mime: string; createdAt: number }> }
  }
  /** How many recent matters get a detail() call for outputs (default 5; the wiring caller passes 3 — cost cap). */
  detailLimit?: number
  now?: () => number
}
const WXVAULT = 'wxvault'

export function buildConnections(d: ConnectionsDeps): ConnectionsSnapshot {
  const now = (d.now ?? Date.now)()
  const h = d.plugins()
  const k = d.knowledge()
  const sources: ConnectionSource[] = []

  // 微信历史(wxvault)
  if (!h) sources.push({ id: 'wechat_history', kind: 'wechat_history', name: WXVAULT, state: 'unknown', latestAt: null, syncedAt: null })
  else {
    const vault = h.plugins.find(p => p.name === WXVAULT)
    const latestAt = k.enabled && k.built ? k.latestAt : null
    if (vault?.enabled && vault.ready) {
      const syncedAt = d.wechatSyncedAt()
      sources.push({ id: 'wechat_history', kind: 'wechat_history', name: WXVAULT, state: syncedAt === null ? 'unknown' : now - syncedAt > WECHAT_SYNC_STALE_MS ? 'behind' : 'ready', latestAt, syncedAt })
    } else {
      sources.push({ id: 'wechat_history', kind: 'wechat_history', name: WXVAULT, state: 'not_loaded', latestAt, syncedAt: null, detail: { reason: vault?.reason ?? 'missing', dir: h.bundled_dir } })
    }
  }

  // 知识库(只在开了时出现)
  if (k.enabled) {
    const state: SourceState = !h ? 'unknown' : !k.built ? 'not_loaded' : k.latestAt === null || k.syncedAt === null ? 'unknown' : now - k.syncedAt > KNOWLEDGE_STALE_MS ? 'behind' : 'ready'
    sources.push({ id: 'knowledge', kind: 'knowledge', name: 'knowledge', state, latestAt: k.built ? k.latestAt : null, syncedAt: k.built ? k.syncedAt : null })
  }

  // 其它插件
  if (h) {
    const rows: ConnectionSource[] = []
    for (const p of h.plugins) {
      if (p.name === WXVAULT || !p.enabled) continue
      rows.push({ id: `plugin:${p.name}`, kind: 'plugin', name: p.name, state: p.ready ? 'ready' : 'not_loaded', latestAt: null, syncedAt: null, ...(p.ready ? {} : { detail: { reason: p.reason ?? 'not_ready', dir: h.bundled_dir } }) })
    }
    for (const name of h.expected_missing) {
      if (name === WXVAULT || rows.some(r => r.name === name)) continue
      rows.push({ id: `plugin:${name}`, kind: 'plugin', name, state: 'not_loaded', latestAt: null, syncedAt: null, detail: { reason: 'missing', dir: h.bundled_dir } })
    }
    sources.push(...rows.sort((a, b) => a.name.localeCompare(b.name)))
  }

  let recent: ConnectionsSnapshot['recent'] = [], outputs: ConnectionsSnapshot['outputs'] = []
  if (d.workbench) {
    const tasks = [...d.workbench.list({ archived: 'exclude', limit: 20 }).tasks].sort((a, b) => b.updatedAt - a.updatedAt)
    recent = tasks.slice(0, 3).map(t => ({ matterId: t.id, title: t.title, phase: t.phase ?? 'working', at: t.updatedAt }))
    const all: ConnectionsSnapshot['outputs'] = []
    for (const t of tasks.slice(0, d.detailLimit ?? 5)) {
      try { for (const a of d.workbench.detail(t.id).artifacts) all.push({ matterId: t.id, name: a.name, mime: a.mime, at: a.createdAt }) }
      catch { /* 任务刚被清掉:跳过 */ }
    }
    outputs = all.sort((a, b) => b.at - a.at).slice(0, 3)
  }

  return { generatedAt: now, starting: !h, sources, computers: [{ id: 'home', online: true, ...d.computer() }], recent, outputs }
}

export function redactConnections(s: ConnectionsSnapshot): ConnectionsSnapshot {
  return { ...s, sources: s.sources.map(({ detail: _detail, ...rest }) => rest) }
}

/** 裁定 8:快照缓存 ttlMs(默认 10 s)。抛错不缓存(下一次重算);fn 在 ttl 内只跑一次。 */
export function cacheConnections(fn: () => ConnectionsSnapshot, ttlMs = 10_000, now: () => number = Date.now): () => ConnectionsSnapshot {
  let at = 0, snap: ConnectionsSnapshot | null = null
  return () => {
    const t = now()
    if (snap && t - at < ttlMs) return snap
    snap = fn(); at = t
    return snap
  }
}
