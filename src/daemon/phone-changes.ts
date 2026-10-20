/**
 * 手机上看改动(spec 2026-09-30-tendhearth-app-v1 §5.3):取一件事最近一轮的改动快照(桌面「改动」面板同一数据源),
 * 裁剪到能放进中继一帧 —— 单文件 diff ≤ 24 KiB、累计 ≤ 200 KiB、至多 100 个文件;超出的只给路径与种类。只读。
 * 每个文件的 reason(为什么没审 / 被截)与本轮 notes 也带上:没有 diff 时手机至少能说清原因。各裁到 200 字、notes 至多 10 条。
 * 逐文件审阅(2026-10-17):带上轮次的 artifactId 与每个文件已有的标记,手机才能逐个「没问题 / 退回」(同桌面 review-mark / review-return)。
 * 该多看一眼的原因(B6,review-risk.ts):每个文件的 risk 原样带上(至多 6 条、各裁到 200 字);没有就不带。
 * 撤掉这一轮(回退切片 4):已撤掉的轮不给;这一轮能撤 ⇒ rewindable;比它新、已撤掉的有几轮 ⇒ discardedAfter。
 */
export const CHANGES_FILE_DIFF_MAX = 24 * 1024
export const CHANGES_TOTAL_DIFF_MAX = 200 * 1024
export const CHANGES_MAX_FILES = 100
export const CHANGES_PATH_MAX = 512
export const CHANGES_TEXT_MAX = 200
export const CHANGES_MAX_NOTES = 10
export const CHANGES_MAX_RISKS = 6

type Kind = 'added' | 'deleted' | 'modified' | 'not_reviewed'
type Mark = { mark: 'accepted' | 'returned'; comment: string; createdAt: number }
export interface ReviewTurnLike { artifactId?: string; createdAt: number; discarded?: boolean; rewindable?: { start: boolean; end: boolean }; status: 'complete' | 'partial' | 'unavailable'; notes?: readonly string[]; files: ReadonlyArray<{ path: string; kind: Kind; diff?: string; reason?: string; mark?: Mark; risk?: readonly string[] }> }
export interface PhoneChangeFile { path: string; kind: Kind; diff?: string; reason?: string; truncated: boolean; mark?: Mark; risk?: string[] }
/** rewindable:这一轮能「撤掉」(有开始前的回退点);discardedAfter:比这一轮新、已撤掉的轮数(手机灰着说一句)。都只在为真 / >0 时带。 */
export interface PhoneChangesTurn { artifactId?: string; createdAt: number; rewindable?: true; discardedAfter?: number; status: 'complete' | 'partial' | 'unavailable'; files: PhoneChangeFile[]; omittedFiles: number; notes: string[] }

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

function riskOf(risk: unknown): { risk?: string[] } {
  const list = Array.isArray(risk) ? risk.filter((r): r is string => typeof r === 'string' && r !== '').slice(0, CHANGES_MAX_RISKS).map(clipText) : []
  return list.length ? { risk: list } : {}
}

export function latestChanges(all: readonly ReviewTurnLike[]): PhoneChangesTurn | null {
  // 回退撤掉的轮不算(v81)
  const turns = all.filter(t => !t.discarded)
  if (turns.length === 0) return null
  const t = turns.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
  let total = 0
  const files: PhoneChangeFile[] = []
  for (const f of t.files.slice(0, CHANGES_MAX_FILES)) {
    const path = clipPath(f.path)
    const reason = {
      ...(typeof f.reason === 'string' && f.reason ? { reason: clipText(f.reason) } : {}),
      ...(f.mark ? { mark: { mark: f.mark.mark, comment: clipText(f.mark.comment), createdAt: f.mark.createdAt } } : {}),
      ...riskOf(f.risk),
    }
    if (f.kind === 'not_reviewed' || typeof f.diff !== 'string') { files.push({ path, kind: f.kind, ...reason, truncated: false }); continue }
    // 按 JSON 序列化后的字节计(引号/换行/控制字符会膨胀),而不是原始字节
    const bytes = enc.encode(JSON.stringify(f.diff)).byteLength
    if (bytes > CHANGES_FILE_DIFF_MAX || total + bytes > CHANGES_TOTAL_DIFF_MAX) { files.push({ path, kind: f.kind, ...reason, truncated: true }); continue }
    total += bytes
    files.push({ path, kind: f.kind, diff: f.diff, ...reason, truncated: false })
  }
  const notes = (Array.isArray(t.notes) ? t.notes : []).filter((n): n is string => typeof n === 'string').slice(0, CHANGES_MAX_NOTES).map(clipText)
  const discardedAfter = all.filter(x => x.discarded && x.createdAt > t.createdAt).length
  return { ...(typeof t.artifactId === 'string' ? { artifactId: t.artifactId } : {}), createdAt: t.createdAt, ...(t.rewindable?.start === true && typeof t.artifactId === 'string' ? { rewindable: true as const } : {}), ...(discardedAfter ? { discardedAfter } : {}), status: t.status, files, omittedFiles: Math.max(0, t.files.length - CHANGES_MAX_FILES), notes }
}
