import { createHash } from 'node:crypto'

/**
 * 按块看 / 按块撤回的纯代码(行评论设计稿 2026-10-21)。不碰盘、不碰 git。
 * 输入的 diff 是 finishGitReview 存下的那种(从第一个 `@@` 起,3 行上下文,块互不重叠)。
 * **一律原始内容比对,不做 CRLF 归一**:快照的 sha 是盘上原始字节的 sha,diff 也是从同一份字节算的
 * (CRLF 文件的 diff 行里带着 \r)。调用方给的字符串必须是那份字节按 UTF-8(fatal、不吃 BOM)解出来的 ——
 * 快照里有 diff 的文件本来就只有这种(非 UTF-8 / 二进制不展开),于是字符串 ⇄ 字节一一对应。
 */

export type HunkRowKind = 'context' | 'add' | 'del'
/** 块体里的一行(`\ No newline` 标记行不算一行);text 不含正负号、不含 \n(可能带 \r)。 */
export interface HunkRow { kind: HunkRowKind; text: string; oldLine?: number; newLine?: number }
export interface Hunk {
  index: number; sha256: string; header: string
  oldStart: number; oldCount: number; newStart: number; newCount: number
  rows: HunkRow[]
  /** 这一块之前、上一块之后,两侧共有的不变行数(第一块 = 文件开头到它)。 */
  gap: number
  /** 两侧的整行(带各自的换行符;那一侧没有末尾换行时最后一行不带)。 */
  oldLines: string[]; newLines: string[]
  oldNoEol: boolean; newNoEol: boolean
}
export type HunkSide = 'old' | 'new'

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
/** 同 reverseApplyDiff:按行切,每行带着自己的换行符,最后一行可能没有。 */
export const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

/**
 * diff ⇒ 块。切法同 reverseApplyDiff(`^(?=@@ )`);起点规则 count===0 ? start : start-1;
 * 计数要和块体对上、两侧每段间隔要相等、`\ No newline` 只能落在最后一块那一侧的最后一行 —— 任何一条不对 ⇒ null。
 * 空 diff(只改了权限 / 空文件)也是 null:没有块可评。
 */
export function parseHunks(diff: string): Hunk[] | null {
  const parts = diff.split(/^(?=@@ )/m)
  // 第一个 `@@` 之前不该有东西(存下来的 diff 就是从 `@@` 起的)
  if (parts[0] !== undefined && !parts[0].startsWith('@@ ') && parts[0] !== '') return null
  const raw = parts.filter(p => p.startsWith('@@ '))
  if (!raw.length) return null
  const hunks: Hunk[] = []
  let oldEnd = 0, newEnd = 0
  for (const [index, text] of raw.entries()) {
    const head = /^(@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*)\n/.exec(text)
    if (!head) return null
    const oldStart = Number(head[2]), oldCount = head[3] === undefined ? 1 : Number(head[3])
    const newStart = Number(head[4]), newCount = head[5] === undefined ? 1 : Number(head[5])
    const oldBegin = oldCount === 0 ? oldStart : oldStart - 1, newBegin = newCount === 0 ? newStart : newStart - 1
    const gapOld = oldBegin - oldEnd, gapNew = newBegin - newEnd
    if (gapOld < 0 || gapOld !== gapNew) return null
    const body = text.slice(head[0].length).split('\n')
    if (body.at(-1) === '') body.pop()
    const rows: HunkRow[] = [], oldLines: string[] = [], newLines: string[] = []
    let oldNoEol = false, newNoEol = false, last: HunkRowKind | null = null, o = oldBegin, n = newBegin
    for (const line of body) {
      if (line.startsWith('\\')) {
        // 标记前一行在它那一侧没有换行;标记只能跟在一行后面、每侧至多一次
        if (last === null) return null
        if (last !== 'add') { if (oldNoEol) return null; oldNoEol = true; oldLines[oldLines.length - 1] = oldLines.at(-1)!.slice(0, -1) }
        if (last !== 'del') { if (newNoEol) return null; newNoEol = true; newLines[newLines.length - 1] = newLines.at(-1)!.slice(0, -1) }
        last = null
        continue
      }
      // 带 noEol 的那一侧后面不能再有行
      const sign = line[0], value = line.slice(1)
      if (sign === ' ') {
        if (oldNoEol || newNoEol) return null
        rows.push({ kind: 'context', text: value, oldLine: ++o, newLine: ++n }); oldLines.push(`${value}\n`); newLines.push(`${value}\n`); last = 'context'
      } else if (sign === '-') {
        if (oldNoEol) return null
        rows.push({ kind: 'del', text: value, oldLine: ++o }); oldLines.push(`${value}\n`); last = 'del'
      } else if (sign === '+') {
        if (newNoEol) return null
        rows.push({ kind: 'add', text: value, newLine: ++n }); newLines.push(`${value}\n`); last = 'add'
      } else return null
    }
    if (oldLines.length !== oldCount || newLines.length !== newCount || !rows.length) return null
    hunks.push({ index, sha256: sha(text), header: head[1]!, oldStart, oldCount, newStart, newCount, rows, gap: gapOld, oldLines, newLines, oldNoEol, newNoEol })
    oldEnd = oldBegin + oldCount; newEnd = newBegin + newCount
  }
  // 末尾没换行只能出现在最后一块
  if (hunks.slice(0, -1).some(h => h.oldNoEol || h.newNoEol)) return null
  return hunks
}

const sideLines = (hunk: Hunk, side: HunkSide) => side === 'old' ? hunk.oldLines : hunk.newLines
const matchesAt = (current: readonly string[], pos: number, lines: readonly string[]) => {
  if (pos + lines.length > current.length) return false
  for (let i = 0; i < lines.length; i++) if (current[pos + i] !== lines[i]) return false
  return true
}

/**
 * 无状态检测:现在的内容里每块是旧的一侧还是新的一侧。按行走,第 i 块在「上一块末尾 + gap_i」处精确比对。
 * 两侧都对上(一侧是另一侧的前缀这类重复内容)⇒ 回溯:先试新的一侧,由后面的块确认;
 * `accept` 给调用方再确认一道(服务端传「翻成全新后 sha === afterSha256」)。找不到 ⇒ null。
 * 回溯有步数上限,超了当找不到(只会拒绝,不会写错)。
 */
export function locateHunks(current: string, hunks: readonly Hunk[], accept: (state: HunkSide[]) => boolean = () => true): HunkSide[] | null {
  const lines = splitLines(current), state: HunkSide[] = []
  let budget = 4096
  const walk = (i: number, at: number): boolean => {
    if (--budget < 0) return false
    if (i === hunks.length) {
      const last = hunks.at(-1)
      // 最后一块那一侧没末尾换行 ⇒ 它就是文件的最后一行
      if (last && (state[i - 1] === 'old' ? last.oldNoEol : last.newNoEol) && at !== lines.length) return false
      return accept([...state])
    }
    const hunk = hunks[i]!, pos = at + hunk.gap
    for (const side of ['new', 'old'] as const) {
      const want = sideLines(hunk, side)
      if (!matchesAt(lines, pos, want)) continue
      state[i] = side
      if (walk(i + 1, pos + want.length)) return true
    }
    state.length = i
    return false
  }
  return walk(0, 0) ? state : null
}

/**
 * 按目标侧重拼:现在第 i 块是 `state[i]` 那一侧,拼成 `target[i]` 那一侧,块外的内容原样搬。
 * 现在的内容和 state 对不上、或拼出来会出现「没末尾换行的行后面还有内容」⇒ null。
 * 性质(测试钉住):switchHunks(after, 全新, 全旧) === reverseApplyDiff(after, diff)。
 */
export function switchHunks(current: string, hunks: readonly Hunk[], state: readonly HunkSide[], target: readonly HunkSide[]): string | null {
  if (state.length !== hunks.length || target.length !== hunks.length) return null
  const lines = splitLines(current), out: string[] = []
  let at = 0
  for (const [i, hunk] of hunks.entries()) {
    const pos = at + hunk.gap, have = sideLines(hunk, state[i]!)
    if (!matchesAt(lines, pos, have)) return null
    out.push(...lines.slice(at, pos), ...sideLines(hunk, target[i]!))
    at = pos + have.length
  }
  const last = hunks.at(-1)
  if (last && at < lines.length && (target.at(-1) === 'old' ? last.oldNoEol : last.newNoEol)) return null
  if (last && at !== lines.length && (state.at(-1) === 'old' ? last.oldNoEol : last.newNoEol)) return null
  out.push(...lines.slice(at))
  return out.join('')
}

/** 一条行评论在块里的落点(切片 2 的写入路由用;服务端从快照算,客户端不给引用)。 */
export interface CommentAnchor { side: HunkSide; lineStart: number; lineEnd: number; quote: string }
export const MAX_COMMENT_ROWS = 40
/** 整块评论存下的引用至多这么多行(发出时再按 12 行裁)。 */
export const MAX_QUOTE_ROWS = 40

/**
 * 块内 [rowStart, rowEnd](0 起、跳过 `\ No newline` 标记行;两端都空 = 整块)⇒ 侧、行号、引用。
 * 只要范围里有新的一侧的行(上下文 / 新增)就按新侧行号;全是删掉的行 ⇒ 旧侧(「原第 n 行(已删)」)。
 * 引用是 diff 形状(带正负号),原样不裁 CR。范围不对 ⇒ 抛 invalid_review_reference。
 */
export function deriveCommentAnchor(hunk: Hunk, rowStart?: number, rowEnd?: number): CommentAnchor {
  const whole = rowStart === undefined && rowEnd === undefined
  if (!whole) {
    if (!Number.isInteger(rowStart) || !Number.isInteger(rowEnd)) throw new Error('invalid_review_reference')
    if (rowStart! < 0 || rowEnd! < rowStart! || rowEnd! >= hunk.rows.length || rowEnd! - rowStart! + 1 > MAX_COMMENT_ROWS) throw new Error('invalid_review_reference')
  }
  const rows = whole ? hunk.rows : hunk.rows.slice(rowStart, rowEnd! + 1)
  const fresh = rows.filter(r => r.newLine !== undefined)
  const side: HunkSide = fresh.length ? 'new' : 'old'
  const numbers = (fresh.length ? fresh.map(r => r.newLine!) : rows.map(r => r.oldLine!))
  const sign = { context: ' ', add: '+', del: '-' } as const
  const quote = rows.slice(0, MAX_QUOTE_ROWS).map(r => `${sign[r.kind]}${r.text}`).join('\n')
  return { side, lineStart: Math.min(...numbers), lineEnd: Math.max(...numbers), quote }
}

/**
 * 写入路由用(切片 2):快照里这个文件的 diff + 客户端说的块 ⇒ 落点。diff 解析不了 / 块越界 ⇒ invalid_review_reference;
 * 块 sha 对不上(客户端切法不一致或拿的是别的快照)⇒ review_hunk_stale —— 不去别处找新位置(评审 ④)。
 */
export function anchorFromDiff(diff: string | undefined, hunkIndex: number, hunkSha256: string, rowStart?: number, rowEnd?: number): CommentAnchor & { hunk: Hunk } {
  const hunks = diff ? parseHunks(diff) : null
  if (!hunks || !Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= hunks.length) throw new Error('invalid_review_reference')
  const hunk = hunks[hunkIndex]!
  if (hunk.sha256 !== hunkSha256) throw new Error('review_hunk_stale')
  return { ...deriveCommentAnchor(hunk, rowStart, rowEnd), hunk }
}
