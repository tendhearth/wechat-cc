/**
 * 每晚整理的改动清单:模型只报「新增 / 修改 / 仍成立 / 删除」,这里逐条校验后执行,
 * 再做程序自己的新陈代谢(承诺过期、近况淡出、超长)。任何一条不合法 → 整批作废,不做半截。
 */
import { SECTIONS, MEMORY_CAP_CHARS, docChars, parseDue, type MemoryDoc, type MemoryEntry, type Section } from './curated-doc'

export interface NightlyOps {
  add: Array<{ section: Section; text: string }>
  update: Array<{ id: string; text: string; reversal: boolean }>
  confirm: string[]
  remove: Array<{ id: string; reason: string }>
}
export type ExpireReason = 'commitment_past_due' | 'recent_stale' | 'over_cap'
export type AppliedOp =
  | { kind: 'add'; id: string; section: Section; text: string }
  | { kind: 'update'; id: string; section: Section; text: string; before: string; reversal: boolean }
  | { kind: 'remove'; id: string; section: Section; text: string; reason: string }
  | { kind: 'expire'; id: string; section: Section; text: string; reason: ExpireReason }

export const MAX_ENTRY_CHARS = 200
const COMMITMENT_GRACE_DAYS = 7
const RECENT_STALE_DAYS = 14

const isStr = (v: unknown): v is string => typeof v === 'string'
const isSection = (v: unknown): v is Section => isStr(v) && (SECTIONS as readonly string[]).includes(v)

export function parseOps(raw: string): NightlyOps | null {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return null
  let j: unknown
  try { j = JSON.parse(m[0]) } catch { return null }
  if (!j || typeof j !== 'object') return null
  const o = j as Record<string, unknown>
  if (!Array.isArray(o.add) || !Array.isArray(o.update) || !Array.isArray(o.confirm) || !Array.isArray(o.remove)) return null
  const add: NightlyOps['add'] = []
  for (const a of o.add as unknown[]) {
    const x = a as Record<string, unknown>
    if (!x || !isSection(x.section) || !isStr(x.text)) return null
    add.push({ section: x.section, text: x.text.trim() })
  }
  const update: NightlyOps['update'] = []
  for (const u of o.update as unknown[]) {
    const x = u as Record<string, unknown>
    if (!x || !isStr(x.id) || !isStr(x.text)) return null
    update.push({ id: x.id, text: x.text.trim(), reversal: x.reversal === true })
  }
  if (!(o.confirm as unknown[]).every(isStr)) return null
  const remove: NightlyOps['remove'] = []
  for (const r of o.remove as unknown[]) {
    const x = r as Record<string, unknown>
    if (!x || !isStr(x.id)) return null
    remove.push({ id: x.id, reason: isStr(x.reason) ? x.reason : '' })
  }
  return { add, update, confirm: o.confirm as string[], remove }
}

export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000)
}

export function applyNightly(
  input: MemoryDoc,
  ops: NightlyOps,
  o: { today: string; newId: () => string },
): { ok: true; doc: MemoryDoc; applied: AppliedOp[] } | { ok: false; reason: string } {
  const doc = structuredClone(input)
  const index = new Map<string, { section: Section; entry: MemoryEntry }>()
  for (const s of SECTIONS) for (const e of doc.sections[s]) if (e.id) index.set(e.id, { section: s, entry: e })
  for (const id of [...ops.confirm, ...ops.update.map(u => u.id), ...ops.remove.map(r => r.id)]) {
    if (!index.has(id)) return { ok: false, reason: `unknown_id:${id}` }
  }
  for (const t of [...ops.add.map(a => a.text), ...ops.update.map(u => u.text)]) {
    if (!t || t.length > MAX_ENTRY_CHARS) return { ok: false, reason: 'bad_text' }
  }
  if (ops.remove.length > Math.max(2, Math.floor(index.size * 0.3))) return { ok: false, reason: 'too_many_removals' }

  const applied: AppliedOp[] = []
  for (const id of ops.confirm) index.get(id)!.entry.seen = o.today
  for (const u of ops.update) {
    const hit = index.get(u.id)!
    applied.push({ kind: 'update', id: u.id, section: hit.section, text: u.text, before: hit.entry.text, reversal: u.reversal })
    hit.entry.text = u.text
    hit.entry.seen = o.today
  }
  for (const r of ops.remove) {
    const hit = index.get(r.id)!
    doc.sections[hit.section] = doc.sections[hit.section].filter(e => e !== hit.entry)
    applied.push({ kind: 'remove', id: r.id, section: hit.section, text: hit.entry.text, reason: r.reason })
  }
  for (const a of ops.add) {
    const id = o.newId()
    doc.sections[a.section].push({ id, text: a.text, seen: o.today })
    applied.push({ kind: 'add', id, section: a.section, text: a.text })
  }

  const expire = (s: Section, e: MemoryEntry, reason: ExpireReason) => {
    doc.sections[s] = doc.sections[s].filter(x => x !== e)
    applied.push({ kind: 'expire', id: e.id ?? '', section: s, text: e.text, reason })
  }
  for (const e of [...doc.sections['承诺']]) {
    const due = parseDue(e.text)
    if (due && daysBetween(due, o.today) > COMMITMENT_GRACE_DAYS) expire('承诺', e, 'commitment_past_due')
  }
  for (const e of [...doc.sections['近况']]) {
    if (e.seen && daysBetween(e.seen, o.today) > RECENT_STALE_DAYS) expire('近况', e, 'recent_stale')
  }
  while (docChars(doc) > MEMORY_CAP_CHARS && doc.sections['近况'].length) {
    const oldest = [...doc.sections['近况']].sort((a, b) => (a.seen ?? '').localeCompare(b.seen ?? ''))[0]!
    expire('近况', oldest, 'over_cap')
  }
  if (docChars(doc) > MEMORY_CAP_CHARS) return { ok: false, reason: 'over_cap' }
  return { ok: true, doc, applied }
}
