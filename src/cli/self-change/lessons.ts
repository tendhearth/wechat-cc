/**
 * lessons.ts —— 自改的教训账:每条运行收场时,记下它为什么要修(修复轮的原因)和没做成的结局。
 *
 * 为什么:`docs/maintainer/practices.md` 里那三十来条规矩,是两路会话一次次吃亏、再一条条手写进去的。CC 自己跑开发以后,
 * 吃亏的是它自己 —— 同一种测试红、同一句评审意见、同一种 CI 失败反复出现,就该变成清单里的一条,而不是每次修一遍。
 * 对标 Hermes Agent:任务做完评估结果、记一条结构化的教训、下次照着做。这里不让模型自己改规矩(做法清单「新加一条走 PR」),
 * 只把证据攒下来:`self discover --source lessons` 把出现两次以上的摆出来,规划者 / 人决定要不要写进清单。
 *
 * 只记流水线自己的输出(测试 / 评审 / CI 的那几行、结局码),不记聊天内容:没有主人和联系人的数据,可以交给模型。
 */
import { signatureOf } from '../self-discover'
import type { SelfChangeState } from './state'

export interface LessonRow {
  at: string
  run: string
  /** tests / review / ci = 修复轮;outcome = 没做成的结局。 */
  kind: 'tests' | 'review' | 'ci' | 'outcome'
  /** 结局码(outcome 才有)。 */
  result?: string
  /** 原因的头几行,截断。 */
  detail: string
}

/** 教训账在 `<stateDir>/` 下的文件名。 */
export const SELF_LESSONS_FILE = 'self-lessons.jsonl'

/** 每条原因最多记多长:够认出是哪种失败,不把整段日志塞进账里。 */
export const LESSON_DETAIL_MAX = 300

/** 正常走完、主人说不要、主人作废 —— 不是「吃亏」,不记结局那一条(修复轮照记)。 */
const NOT_A_LESSON = new Set(['done', 'declined', 'abandoned', 'approval_timeout', 'self_change_halted', 'self_change_busy', 'self_change_quota'])

export function lessonsFor(s: SelfChangeState, result: string, detail: string, now: number): LessonRow[] {
  const at = new Date(now).toISOString()
  const fresh = (s.fixLog ?? []).slice(s.lessonsWritten ?? 0)
  const rows: LessonRow[] = fresh.map(f => ({ at: new Date(f.at).toISOString(), run: s.id, kind: f.kind, detail: f.detail }))
  if (!NOT_A_LESSON.has(result)) rows.push({ at, run: s.id, kind: 'outcome', result, detail: detail.slice(0, LESSON_DETAIL_MAX) })
  return rows
}

export interface LessonCandidate {
  kind: LessonRow['kind']
  result?: string
  signature: string
  count: number
  /** 出现在哪几条运行里(去重)。同一条运行里反复修同一处也算,但跨运行才说明是规矩该管的。 */
  runs: string[]
  example: string
  lastSeen: string
}

/** 「第一行」做签名:测试是 FAIL 那行、评审是第一条意见、结局是第一句话。 */
function firstLine(detail: string): string {
  return detail.split('\n').map(l => l.trim()).find(Boolean) ?? ''
}

/** jsonl 读进来分组;出现 ≥ minCount 次的,按跨了几条运行、次数排。坏行跳过。 */
export function lessonCandidates(jsonl: string, minCount = 2): LessonCandidate[] {
  const groups = new Map<string, LessonCandidate>()
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let r: LessonRow
    try { r = JSON.parse(line) as LessonRow } catch { continue }
    if (!r || typeof r.detail !== 'string' || typeof r.kind !== 'string') continue
    const signature = signatureOf(firstLine(r.detail))
    const key = `${r.kind}\u0000${r.result ?? ''}\u0000${signature}`
    const g = groups.get(key)
    if (g) {
      g.count++
      if (!g.runs.includes(r.run)) g.runs.push(r.run)
      if (r.at > g.lastSeen) g.lastSeen = r.at
    } else {
      groups.set(key, { kind: r.kind, ...(r.result ? { result: r.result } : {}), signature, count: 1, runs: [r.run], example: firstLine(r.detail).slice(0, 160), lastSeen: r.at })
    }
  }
  return [...groups.values()].filter(c => c.count >= minCount).sort((a, b) => b.runs.length - a.runs.length || b.count - a.count)
}

const KIND_LABEL: Record<LessonRow['kind'], string> = { tests: '测试红', review: '评审打回', ci: 'CI 红', outcome: '没做成' }

export function formatLessonCandidates(c: LessonCandidate[]): string {
  if (!c.length) return '自改的教训账里还没有反复出现的(或者还没跑过自改)。'
  const out = ['自改里反复吃的亏(候选:该不该写进 docs/maintainer/practices.md,规划者 / 人定):']
  for (const x of c.slice(0, 20)) {
    out.push(`  ${String(x.count).padStart(3)} 次 / ${x.runs.length} 条运行  [${KIND_LABEL[x.kind]}${x.result ? ` ${x.result}` : ''}] ${x.signature}`)
  }
  return out.join('\n')
}
