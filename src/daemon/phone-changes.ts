/**
 * 手机上看改动(spec 2026-09-30-tendhearth-app-v1 §5.3):取一件事最近一轮的改动快照(桌面「改动」面板同一数据源),
 * 裁剪到能放进中继一帧 —— 单文件 diff ≤ 24 KiB、累计 ≤ 200 KiB、至多 100 个文件;超出的只给路径与种类。只读。
 */
export const CHANGES_FILE_DIFF_MAX = 24 * 1024
export const CHANGES_TOTAL_DIFF_MAX = 200 * 1024
export const CHANGES_MAX_FILES = 100

type Kind = 'added' | 'deleted' | 'modified' | 'not_reviewed'
export interface ReviewTurnLike { createdAt: number; status: 'complete' | 'partial' | 'unavailable'; files: ReadonlyArray<{ path: string; kind: Kind; diff?: string }> }
export interface PhoneChangeFile { path: string; kind: Kind; diff?: string; truncated: boolean }
export interface PhoneChangesTurn { createdAt: number; status: 'complete' | 'partial' | 'unavailable'; files: PhoneChangeFile[]; omittedFiles: number }

const enc = new TextEncoder()

export function latestChanges(turns: readonly ReviewTurnLike[]): PhoneChangesTurn | null {
  if (turns.length === 0) return null
  const t = turns.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
  let total = 0
  const files: PhoneChangeFile[] = []
  for (const f of t.files.slice(0, CHANGES_MAX_FILES)) {
    if (f.kind === 'not_reviewed' || typeof f.diff !== 'string') { files.push({ path: f.path, kind: f.kind, truncated: false }); continue }
    const bytes = enc.encode(f.diff).byteLength
    if (bytes > CHANGES_FILE_DIFF_MAX || total + bytes > CHANGES_TOTAL_DIFF_MAX) { files.push({ path: f.path, kind: f.kind, truncated: true }); continue }
    total += bytes
    files.push({ path: f.path, kind: f.kind, diff: f.diff, truncated: false })
  }
  return { createdAt: t.createdAt, status: t.status, files, omittedFiles: Math.max(0, t.files.length - CHANGES_MAX_FILES) }
}
