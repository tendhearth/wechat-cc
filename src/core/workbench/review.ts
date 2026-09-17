import type { GitReview, ReviewFile } from './git-review'

/** 一个文件加上它在这一轮里的当前标记(`store.reviewMarks`,按 快照 sha + 路径 键)。 */
export interface ReviewTurnFile extends ReviewFile { mark?: { mark: 'accepted' | 'returned'; comment: string; createdAt: number } }
/** 一轮变更快照 = 一件 `GIT_REVIEW_MIME` 成果。解析不出来的那一轮是 `status:'unavailable'` 加一条说明,不是抛错。 */
export interface ReviewTurn {
  artifactId: string; sha256: string; name: string; createdAt: number
  status: GitReview['status']; headBefore: string | null; headAfter: string | null
  preexistingPaths: string[]; notes: string[]; files: ReviewTurnFile[]
}

const KINDS = new Set<ReviewFile['kind']>(['added', 'deleted', 'modified', 'not_reviewed'])
const STATUSES = new Set<GitReview['status']>(['complete', 'partial', 'unavailable'])
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const head = (value: unknown): string | null => typeof value === 'string' ? value : null
const at = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0

/**
 * 存下来的快照字节 ⇒ `GitReview`。只有能确认是这份格式(version/scope/status/files 与每个文件的
 * path·kind)才认;认不出就返回 null,由调用方标成 `unavailable` —— 快照坏了是「看不见」,不是「没改」。
 * 返回的是重建过的干净对象,存进去的多余字段不会顺着流到桌面。
 */
export function parseGitReviewSnapshot(bytes: Buffer): GitReview | null {
  let raw: unknown
  try { raw = JSON.parse(bytes.toString('utf8')) } catch { return null }
  if (!isRecord(raw)) return null
  if (raw.version !== 1 || raw.scope !== 'working-tree-before-after') return null
  if (typeof raw.status !== 'string' || !STATUSES.has(raw.status as GitReview['status'])) return null
  if (!Array.isArray(raw.files)) return null
  const files: ReviewFile[] = []
  for (const entry of raw.files) {
    if (!isRecord(entry)) return null
    const { path, kind } = entry
    if (typeof path !== 'string' || !path || typeof kind !== 'string' || !KINDS.has(kind as ReviewFile['kind'])) return null
    const file: ReviewFile = { path, preexisting: entry.preexisting === true, kind: kind as ReviewFile['kind'] }
    const before = text(entry.beforeSha256), after = text(entry.afterSha256), diff = text(entry.diff), reason = text(entry.reason)
    if (before !== undefined) file.beforeSha256 = before
    if (after !== undefined) file.afterSha256 = after
    if (diff !== undefined) file.diff = diff
    if (reason !== undefined) file.reason = reason
    files.push(file)
  }
  return {
    version: 1, scope: 'working-tree-before-after', startedAt: at(raw.startedAt), finishedAt: at(raw.finishedAt),
    headBefore: head(raw.headBefore), headAfter: head(raw.headAfter), status: raw.status as GitReview['status'],
    preexistingPaths: stringList(raw.preexistingPaths), notes: stringList(raw.notes), files,
  }
}

const TRUNCATED = '(已截断)'
const MARKER = `\n${TRUNCATED}`

/**
 * 打回的续接文本(spec §2):先是清单与意见,再逐个文件附 diff 节选。
 * 执行者要的是「哪几处、为什么、当时长什么样」,不是整份补丁 —— 每文件默认 60 行、总长默认 6000 字,
 * 砍掉的地方一律留下「(已截断)」,免得对面把截断当成改动的全部。
 */
export function composeReturnText(
  files: Array<{ path: string; diff?: string }>,
  comment: string,
  limits: { maxLinesPerFile?: number; maxTotalChars?: number } = {},
): string {
  const maxLines = limits.maxLinesPerFile ?? 60, maxChars = limits.maxTotalChars ?? 6000
  // 预算比标注本身还小是个荒唐配置,但也不能因此越界 —— 那时连标注都得截。
  const clamp = (value: string) => value.length <= maxChars ? value
    : maxChars <= MARKER.length ? TRUNCATED.slice(0, Math.max(0, maxChars))
      : `${value.slice(0, maxChars - MARKER.length)}${MARKER}`
  const sections = files.flatMap(file => {
    const diff = (file.diff ?? '').trimEnd()
    if (!diff) return []
    const lines = diff.split('\n'), kept = lines.slice(0, maxLines)
    return [`\n\n--- ${file.path} ---\n${kept.join('\n')}${lines.length > kept.length ? MARKER : ''}`]
  })
  let out = ['打回以下改动,请按意见修改:', ...files.map(f => `- ${f.path}`), `意见:${comment}`].join('\n')
  // 清单本身就占满了预算:有 diff 没放进去就得说一声,没 diff 才是「本来就这么多」。
  if (out.length + MARKER.length > maxChars) return sections.length ? clamp(`${out}${MARKER}`) : clamp(out)
  let cut = false
  for (const section of sections) {
    if (out.length + section.length <= maxChars) { out += section; continue }
    const room = maxChars - out.length - MARKER.length
    if (room > 0) out += section.slice(0, room)
    cut = true
    break
  }
  return cut ? clamp(`${out}${MARKER}`) : out
}
