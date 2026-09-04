/**
 * wish-memory.ts — 心愿的本机索引与收件幂等记录(spec 2026-09-04-wish-postcard §1.2/§1.3)。
 *
 * 发出去的心愿真相在 penpal_letter(direction=out, kind=wish);这里是它的索引
 * + 还没派的草稿。收件方的 wishes-seen 是幂等键:信箱 at-least-once,同一条
 * 心愿可能到两次,判官不能跑两次、主人不能被打扰两次。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import type { WishRecord } from '../../core/wish'

export const WISH_SEEN_TTL_MS = 14 * 24 * 60 * 60_000

const dirOf = (stateDir: string) => join(stateDir, 'companion')
const wishesPath = (stateDir: string) => join(dirOf(stateDir), 'wishes.json')
const seenPath = (stateDir: string) => join(dirOf(stateDir), 'wishes-seen.json')

function writeJson(path: string, dir: string, value: unknown): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

export function readWishes(stateDir: string): WishRecord[] {
  try {
    const raw = readJsonFile<{ wishes?: unknown }>(wishesPath(stateDir))
    return Array.isArray(raw.wishes) ? (raw.wishes as WishRecord[]) : []
  } catch { return [] }
}

export function writeWishes(stateDir: string, list: readonly WishRecord[]): void {
  writeJson(wishesPath(stateDir), dirOf(stateDir), { wishes: list })
}

function readSeen(stateDir: string): Record<string, string> {
  try {
    const raw = readJsonFile<{ seen?: unknown }>(seenPath(stateDir))
    return raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen) ? (raw.seen as Record<string, string>) : {}
  } catch { return {} }
}

export function markWishSeen(stateDir: string, key: string, nowIso: string): boolean {
  const nowMs = Date.parse(nowIso)
  const seen = readSeen(stateDir)
  const kept: Record<string, string> = {}
  for (const [k, at] of Object.entries(seen)) {
    const t = Date.parse(at)
    if (!Number.isNaN(t) && nowMs - t <= WISH_SEEN_TTL_MS) kept[k] = at
  }
  if (kept[key] !== undefined) { writeJson(seenPath(stateDir), dirOf(stateDir), { seen: kept }); return false }
  kept[key] = nowIso
  writeJson(seenPath(stateDir), dirOf(stateDir), { seen: kept })
  return true
}
