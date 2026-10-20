/**
 * sources.ts — 记忆每一条的出处(对标 Claude「答案链回原对话」,2026-10-20)。
 *
 * 出处不写进 memory.md(那份每轮都进提示词,多一个字都是钱),另存 `memory-sources.json`:
 * { 条目 id: [{ id: 消息 id, ts, excerpt }] }。每晚整理时,模型在 add / update 上标素材记号(c3 = 聊天第 3 行),
 * 这里换成真消息;删掉 / 过期的条目同时清掉出处。记号对不上的直接丢,出处缺了不影响记忆本身。
 */
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { readJsonFile } from '../../lib/read-json-file'
import { join } from 'node:path'
import type { AppliedOp, NightlyOps } from './nightly-ops'

export const SOURCES_FILE = 'memory-sources.json'
export const SOURCE_EXCERPT_MAX = 80
export const SOURCES_PER_ENTRY = 3

export interface SourceRef { id: string; ts: string; excerpt: string; /** 'import' = 主人从别的助手导入的(2026-10-20);缺省 = 聊天里来的。 */ kind?: 'import' }
export type SourceMap = Record<string, SourceRef[]>

export function readSources(root: string): SourceMap {
  const p = join(root, SOURCES_FILE)
  if (!existsSync(p)) return {}
  try {
    const v = readJsonFile<unknown>(p)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as SourceMap : {}
  } catch { return {} }
}

export function writeSources(root: string, map: SourceMap): void {
  const p = join(root, SOURCES_FILE)
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(map, null, 1) + '\n')
  renameSync(tmp, p)
}

/** 这一晚的改动 → 新的出处表。add 的 id 按 ops.add 的顺序对上 applied 里的 add。 */
export function nextSources(prev: SourceMap, ops: NightlyOps, applied: readonly AppliedOp[], refs: Record<string, SourceRef>): SourceMap {
  const out: SourceMap = { ...prev }
  const resolve = (tokens: readonly string[] | undefined) => (tokens ?? []).map(t => refs[t]).filter((r): r is SourceRef => !!r)
  const added = applied.filter(a => a.kind === 'add')
  ops.add.forEach((a, i) => {
    const id = added[i]?.id
    const got = resolve(a.src)
    if (id && got.length) out[id] = got.slice(0, SOURCES_PER_ENTRY)
  })
  for (const u of ops.update) {
    const got = resolve(u.src)
    if (!got.length) continue
    const merged = [...got, ...(out[u.id] ?? [])].filter((r, i, all) => all.findIndex(x => x.id === r.id) === i)
    out[u.id] = merged.slice(0, SOURCES_PER_ENTRY)
  }
  for (const a of applied) if (a.kind === 'remove' || a.kind === 'expire') delete out[a.id]
  return out
}
