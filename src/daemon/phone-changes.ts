/**
 * 手机上看改动(spec 2026-09-30-tendhearth-app-v1 §5.3):取一件事最近一轮的改动快照(桌面「改动」面板同一数据源),
 * 裁剪到能放进中继一帧 —— 单文件 diff ≤ 24 KiB、累计 ≤ 200 KiB、至多 100 个文件;超出的只给路径与种类。只读。
 * 每个文件的 reason(为什么没审 / 被截)与本轮 notes 也带上:没有 diff 时手机至少能说清原因。各裁到 200 字、notes 至多 10 条。
 */
export const CHANGES_FILE_DIFF_MAX = 24 * 1024
export const CHANGES_TOTAL_DIFF_MAX = 200 * 1024
export const CHANGES_MAX_FILES = 100
export const CHANGES_PATH_MAX = 512
export const CHANGES_TEXT_MAX = 200
export const CHANGES_MAX_NOTES = 10

type Kind = 'added' | 'deleted' | 'modified' | 'not_reviewed'
export interface ReviewTurnLike { createdAt: number; status: 'complete' | 'partial' | 'unavailable'; notes?: readonly string[]; files: ReadonlyArray<{ path: string; kind: Kind; diff?: string; reason?: string }> }
export interface PhoneChangeFile { path: string; kind: Kind; diff?: string; reason?: string; truncated: boolean }
export interface PhoneChangesTurn { createdAt: number; status: 'complete' | 'partial' | 'unavailable'; files: PhoneChangeFile[]; omittedFiles: number; notes: string[] }

const enc = new TextEncoder()

/** 路径过长 ⇒ 留尾巴(文件名在末尾),前面补 …,总长 ≤ CHANGES_PATH_MAX。 */
function clipPath(p: string): string {
  return p.length <= CHANGES_PATH_MAX ? p : '…' + p.slice(p.length - (CHANGES_PATH_MAX - 1))
}

/** 按码点裁,超出补 …(总长 ≤ CHANGES_TEXT_MAX)。 */
function clipText(s: string): string {
  const cps = [...s]
  return cps.length <= CHANGES_TEXT_MAX ? s : cps.slice(0, CHANGES_TEXT_MAX - 1).join('') + '…'
}

export function latestChanges(turns: readonly ReviewTurnLike[]): PhoneChangesTurn | null {
  if (turns.length === 0) return null
  const t = turns.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
  let total = 0
  const files: PhoneChangeFile[] = []
  for (const f of t.files.slice(0, CHANGES_MAX_FILES)) {
    const path = clipPath(f.path)
    const reason = typeof f.reason === 'string' && f.reason ? { reason: clipText(f.reason) } : {}
    if (f.kind === 'not_reviewed' || typeof f.diff !== 'string') { files.push({ path, kind: f.kind, ...reason, truncated: false }); continue }
    // 按 JSON 序列化后的字节计(引号/换行/控制字符会膨胀),而不是原始字节
    const bytes = enc.encode(JSON.stringify(f.diff)).byteLength
    if (bytes > CHANGES_FILE_DIFF_MAX || total + bytes > CHANGES_TOTAL_DIFF_MAX) { files.push({ path, kind: f.kind, ...reason, truncated: true }); continue }
    total += bytes
    files.push({ path, kind: f.kind, diff: f.diff, ...reason, truncated: false })
  }
  const notes = (Array.isArray(t.notes) ? t.notes : []).filter((n): n is string => typeof n === 'string').slice(0, CHANGES_MAX_NOTES).map(clipText)
  return { createdAt: t.createdAt, status: t.status, files, omittedFiles: Math.max(0, t.files.length - CHANGES_MAX_FILES), notes }
}
