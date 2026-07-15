/**
 * social-echo-store.ts — persisted "postcards" that came back for a seek
 * (觅食台 P1). Masked peer identity until dual-confirm reveal.
 */
import type { Db } from '../lib/db'

export interface EchoRow {
  id: string; seek_id: string; peer_masked: string; degree: number
  content: string; status: 'pending' | 'revealed' | 'declined'; created_at: string
}
export interface EchoStore {
  create(e: { id: string; seekId: string; peerMasked: string; degree: number; content: string }): void
  setStatus(id: string, status: EchoRow['status']): void
  listForSeek(seekId: string): EchoRow[]
  listAll(): EchoRow[]
  get(id: string): EchoRow | null
}

export function makeEchoStore(db: Db): EchoStore {
  const ins = db.query<unknown, [string, string, string, number, string, string]>(
    `INSERT INTO social_echo(id, seek_id, peer_masked, degree, content, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  )
  const selOne = db.query<EchoRow, [string]>('SELECT * FROM social_echo WHERE id = ?')
  const selBySeek = db.query<EchoRow, [string]>(
    'SELECT * FROM social_echo WHERE seek_id = ? ORDER BY created_at DESC, rowid DESC',
  )
  const selAll = db.query<EchoRow, []>('SELECT * FROM social_echo ORDER BY created_at DESC, rowid DESC')
  const updStatus = db.query<unknown, [string, string]>('UPDATE social_echo SET status = ? WHERE id = ?')
  return {
    create(e) { ins.run(e.id, e.seekId, e.peerMasked, e.degree, e.content, new Date().toISOString()) },
    setStatus(id, status) { updStatus.run(status, id) },
    listForSeek(seekId) { return selBySeek.all(seekId) },
    listAll() { return selAll.all() },
    get(id) { return selOne.get(id) ?? null },
  }
}
