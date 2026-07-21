/**
 * social-seek-store.ts — persisted "wishes" the owner's bot has sown into the
 * peer network (觅食台 P1). Mirrors the makeHeartbeatStore pattern.
 */
import type { Db } from '../lib/db'

export interface SeekRow {
  id: string; kind: 'seek' | 'fun'; topic: string
  status: 'proposed' | 'foraging' | 'echoed' | 'connected' | 'closed' | 'cancelled'
  redacted_topic: string | null; redacted_city: string | null
  hop: number; peers_asked: number; created_at: string; updated_at: string
}
export interface SeekStore {
  create(s: { id: string; kind: 'seek' | 'fun'; topic: string }): void
  propose(s: { id: string; kind: 'seek' | 'fun'; topic: string; redactedTopic: string; redactedCity?: string }): void
  update(id: string, patch: { status?: SeekRow['status']; peersAsked?: number }): void
  list(): SeekRow[]
  get(id: string): SeekRow | null
}

export function makeSeekStore(db: Db): SeekStore {
  const ins = db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO social_seek(id, kind, topic, status, hop, peers_asked, created_at, updated_at)
     VALUES (?, ?, ?, 'foraging', 1, 0, ?, ?)`,
  )
  const insProposed = db.query<unknown, [string, string, string, string, string | null, string, string]>(
    `INSERT INTO social_seek(id, kind, topic, status, redacted_topic, redacted_city, hop, peers_asked, created_at, updated_at)
     VALUES (?, ?, ?, 'proposed', ?, ?, 1, 0, ?, ?)`,
  )
  const selOne = db.query<SeekRow, [string]>('SELECT * FROM social_seek WHERE id = ?')
  const selAll = db.query<SeekRow, []>('SELECT * FROM social_seek ORDER BY created_at DESC, rowid DESC')
  const updStatus = db.query<unknown, [string, string, string]>(
    'UPDATE social_seek SET status = ?, updated_at = ? WHERE id = ?',
  )
  const updPeers = db.query<unknown, [number, string, string]>(
    'UPDATE social_seek SET peers_asked = ?, updated_at = ? WHERE id = ?',
  )
  return {
    create(s) {
      const now = new Date().toISOString()
      ins.run(s.id, s.kind, s.topic, now, now)
    },
    propose(s) {
      const now = new Date().toISOString()
      insProposed.run(s.id, s.kind, s.topic, s.redactedTopic, s.redactedCity ?? null, now, now)
    },
    update(id, patch) {
      const now = new Date().toISOString()
      if (patch.status !== undefined) updStatus.run(patch.status, now, id)
      if (patch.peersAsked !== undefined) updPeers.run(patch.peersAsked, now, id)
    },
    list() { return selAll.all() },
    get(id) { return selOne.get(id) ?? null },
  }
}
