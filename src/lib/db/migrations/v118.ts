import type {Migration} from './types'

// v118 — 「坐回来」:记主人上次看这个地方的时刻,那一行先说从那以后变了什么(设计稿 2026-11-18-cc-two-sides-design.md §3)。
export const migration: Migration = db=>{
  if(!db.query<{name:string},[]>('PRAGMA table_info(places)').all().some(c=>c.name==='seen_at'))db.exec('ALTER TABLE places ADD COLUMN seen_at INTEGER')
}
