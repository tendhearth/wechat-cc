/**
 * 主人更正过的话:一张清单(memory/<chat>/corrections.md),清源头和卡出口共读(第三批 3e 记忆第 3b 步,设计稿
 * docs/superpowers/specs/2026-10-23-memory-source-vs-derived-design.md §6b)。
 *
 * 原则:能用代码确定做到的,不交给模型。被更正的那句从不喂进合成(lib/memory-artifacts 的 synthesisInput: false),
 * 也不写进提示词;这里只做两件确定的事:
 *  - 在别的源文件里找到并删掉含它的行(清源头,nightly-runtime 的 correct 调);
 *  - 合成产出提交前,逐行 / 逐个字符串丢掉含它的部分(卡出口,memory-synthesis 调),并记数。
 *
 * **已知限制**:比对是规范化(空白合一)以后的逐字包含。**换一种说法就漏过去** —— 模型可能从零散素材里重新拼出同一件事。
 * 卡出口的命中计数就是看这件事的数据;命中多了再考虑在提示词里加约束(只描述类别,不给原话)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from './read-json-file'
import { writeFileAtomic } from './json-file'

export const CORRECTIONS_FILE = 'corrections.md'
const COUNT_FILE = 'memory-redactions.json'
/** 被更正的话短于这个(规范化后的字数)就不做跨文件清理 / 出口过滤:一个短词会误删、误挡无关的内容。 */
export const MIN_CORRECTED_CHARS = 6

export const normalizeMemoryText = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** corrections.md 里每一条被更正的正文(规范化后)。格式:`- <日期> <说法>:[<段>] <正文>`;续行不含 `] `,不会被当成一条。 */
export function correctedTexts(memoryRoot: string): Set<string> {
  const texts = new Set<string>()
  let raw = ''
  try { raw = readFileSync(join(memoryRoot, CORRECTIONS_FILE), 'utf8') } catch { return texts }
  for (const line of raw.split('\n')) {
    const m = /\] (.+)$/.exec(line)
    if (m) texts.add(normalizeMemoryText(m[1]!))
  }
  return texts
}

const longEnough = (texts: Iterable<string>) => [...texts].filter(t => [...t].length >= MIN_CORRECTED_CHARS)
const hits = (s: string, needles: readonly string[]) => { const n = normalizeMemoryText(s); return needles.some(t => n.includes(t)) }

/** 去掉含被更正之话的行。返回留下的文本和丢掉的行数。 */
export function dropCorrectedLines(text: string, corrected: Iterable<string>): { text: string; dropped: number } {
  const needles = longEnough(corrected)
  if (!needles.length) return { text, dropped: 0 }
  let dropped = 0
  const kept = text.split('\n').filter(line => { if (line.trim() && hits(line, needles)) { dropped++; return false } return true })
  return { text: kept.join('\n'), dropped }
}

/** 结构化产出(画像 JSON):数组里命中的字符串整项去掉,对象里命中的字符串字段置空。 */
export function dropCorrectedValues<T>(value: T, corrected: Iterable<string>): { value: T; dropped: number } {
  const needles = longEnough(corrected)
  if (!needles.length) return { value, dropped: 0 }
  let dropped = 0
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v.filter(x => { if (typeof x === 'string' && hits(x, needles)) { dropped++; return false } return true }).map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) {
        if (typeof x === 'string' && hits(x, needles)) { dropped++; out[k] = '' } else out[k] = walk(x)
      }
      return out
    }
    return v
  }
  return { value: walk(value) as T, dropped }
}

/** 出口过滤每命中一次记一笔(按对话累计,ledger)。记不上不影响合成。 */
export function recordRedactions(memoryRoot: string, kind: 'overview' | 'profile', n: number, nowIso: string): void {
  if (n <= 0) return
  const p = join(memoryRoot, COUNT_FILE)
  let cur: { total?: number; byKind?: Record<string, number>; last?: string } = {}
  try { if (existsSync(p)) cur = readJsonFile(p) as typeof cur } catch { cur = {} }
  const byKind = { ...(cur.byKind ?? {}), [kind]: (cur.byKind?.[kind] ?? 0) + n }
  try { writeFileAtomic(p, JSON.stringify({ total: (cur.total ?? 0) + n, byKind, last: nowIso }, null, 2) + '\n', { mode: 0o600 }) } catch { /* 计数是附带的 */ }
}

/** 清源头时扫的文件:CC 的笔记、偏好、主人和 CC 的 notes/。memory.md 由更正本身处理;agenda / persona 不是关于主人的事实,不动。 */
function purgeTargets(memoryRoot: string): string[] {
  const out: string[] = []
  for (const f of ['profile.md', 'preferences.md']) if (existsSync(join(memoryRoot, f))) out.push(f)
  const walk = (rel: string) => {
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(join(memoryRoot, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) walk(r)
      else if (e.isFile() && e.name.endsWith('.md') && !/\.deleted-/.test(e.name)) out.push(r)
    }
  }
  walk('notes')
  return out
}

/**
 * 清源头(3b (a)):主人更正一条时,在别的源文件里删掉含那句的行。被更正的话太短(< MIN_CORRECTED_CHARS)就不做,免得误删。
 * 每个要改的文件先整份快照进 `archiveDir`(能找回),再原子写回。返回「哪个文件删了几行」—— 调用方把它记在 corrections.md
 * 那一条底下,主人看得到删了什么(这几个文件里有主人自己在桌面写的)。
 */
export function purgeCorrectedFromSources(memoryRoot: string, correctedText: string, archiveDir: string, stamp: string): Array<{ file: string; lines: number }> {
  const needle = normalizeMemoryText(correctedText)
  if ([...needle].length < MIN_CORRECTED_CHARS) return []
  const removed: Array<{ file: string; lines: number }> = []
  for (const rel of purgeTargets(memoryRoot)) {
    const full = join(memoryRoot, rel)
    let before: string
    try { before = readFileSync(full, 'utf8') } catch { continue }
    const { text, dropped } = dropCorrectedLines(before, [needle])
    if (!dropped) continue
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
    writeFileAtomic(join(archiveDir, `${rel.split('/').join('__')}.${stamp}.md`), before, { mode: 0o600 })
    writeFileAtomic(full, text, { mode: 0o600 })
    removed.push({ file: rel, lines: dropped })
  }
  return removed
}
