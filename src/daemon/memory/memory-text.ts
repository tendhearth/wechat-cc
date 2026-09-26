/**
 * 记忆的「给人看」派生(spec 2026-09-26-memory-view-design):显示顺序、期限标签、身边的人两列、
 * 口语时间、昨晚变化、微信文案。纯函数;手机页与微信共用,手机脚本只渲染这里算好的结果。
 */
import { SECTIONS, parseDue, type MemoryDoc, type Section } from './curated-doc'
import { daysBetween, type AppliedOp } from './nightly-ops'
import { localParts } from './nightly-schedule'

export const DISPLAY_ORDER: readonly Section[] = ['承诺', '关于你', '偏好', '身边的人', '近况']
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function stripDue(text: string): string {
  return text.replace(/\s*[((]期限 \d{4}-\d{2}-\d{2}[))]/, '').trim()
}

export function dueLabel(due: string, today: string): string {
  const d = daysBetween(today, due)
  if (d === 0) return '今天'
  if (d === 1) return '明天'
  if (d >= 2 && d <= 6) return WEEK[new Date(`${due}T00:00:00Z`).getUTCDay()]!
  const [, m, day] = due.split('-')
  return `${Number(m)}月${Number(day)}日`
}

export function splitPerson(text: string): { name: string; rel: string } | null {
  const i = text.indexOf('——')
  let name: string, rel: string
  if (i >= 0) { name = text.slice(0, i); rel = text.slice(i + 2) }
  else {
    const m = /[::]/.exec(text)
    if (!m) return null
    name = text.slice(0, m.index); rel = text.slice(m.index + 1)
  }
  name = name.trim(); rel = rel.trim()
  if (!name || name.length > 12 || !rel) return null
  return { name, rel }
}

export function spokenTime(ms: number, tz: string, nowMs: number): string {
  const at = localParts(ms, tz), now = localParts(nowMs, tz)
  const gap = daysBetween(at.day, now.day)
  const [, m, d] = at.day.split('-')
  const dayWord = gap === 0 ? '今天' : gap === 1 ? '昨天' : `${Number(m)}月${Number(d)}日`
  const h = Number(at.hhmm.slice(0, 2))
  const period = h <= 5 ? '凌晨' : h <= 10 ? '早上' : h <= 12 ? '中午' : h <= 17 ? '下午' : '晚上'
  const hh = period === '凌晨' || h <= 12 ? h : h - 12
  return `${dayWord}${period} ${hh} 点`
}

export type ChangeLabel = '新记下' | '记下' | '改了' | '删了'
export interface ViewChange { kind: 'add' | 'update' | 'remove'; label: ChangeLabel; section: Section; text: string; before?: string; reason?: string }

export function viewChanges(applied: readonly AppliedOp[]): ViewChange[] {
  // 值得说的按类别排(新记下 → 改了 → 删了),其余 add / update 在后;各组内保持日志顺序。
  const newCommit: ViewChange[] = [], reversed: ViewChange[] = [], removed: ViewChange[] = [], rest: ViewChange[] = []
  for (const op of applied) {
    if (op.kind === 'add') {
      if (op.section === '承诺') newCommit.push({ kind: 'add', label: '新记下', section: op.section, text: op.text })
      else rest.push({ kind: 'add', label: '记下', section: op.section, text: op.text })
    } else if (op.kind === 'update') {
      const v: ViewChange = { kind: 'update', label: '改了', section: op.section, text: op.text, before: op.before }
      if (op.reversal && (op.section === '偏好' || op.section === '关于你')) reversed.push(v)
      else rest.push(v)
    } else if (op.kind === 'remove') removed.push({ kind: 'remove', label: '删了', section: op.section, text: op.text, reason: op.reason })
  }
  return [...newCommit, ...reversed, ...removed, ...rest]
}

function changeLine(c: ViewChange): string {
  const text = stripDue(c.text)
  if (c.kind === 'update') return `· 改了:${text}${c.before ? `(原来是${stripDue(c.before)})` : ''}`
  if (c.kind === 'remove') return `· 删了:${text}${c.reason ? `(${c.reason})` : ''}`
  return `· ${c.label}:${text}`
}

function itemLine(section: Section, text: string, today: string): string {
  if (section === '承诺') {
    const due = parseDue(text.replace(/[((]/, '(').replace(/[))]/, ')'))
    return `· ${stripDue(text)}${due ? `(${dueLabel(due, today)})` : ''}`
  }
  if (section === '身边的人') {
    const p = splitPerson(text)
    if (p) return `· ${p.name} —— ${p.rel}`
  }
  return `· ${text}`
}

export function formatWeChatMemory(o: { doc: MemoryDoc; whenLabel: string | null; changes: readonly ViewChange[]; failures: number; today: string }): string {
  const out: string[] = []
  if (o.failures >= 3) out.push(`⚠️ 最近 ${o.failures} 次整理都没成功,下面可能是旧的。`)
  else {
    out.push('这是我眼中的你 🌙')
    const tail = o.changes.length ? `改了 ${o.changes.length} 处。` : '最近没有新变化。'
    out.push(o.whenLabel ? `${o.whenLabel}整理的,${tail}` : tail)
  }
  if (o.failures < 3 && o.changes.length) {
    out.push('', '【昨晚】', ...o.changes.slice(0, 3).map(changeLine))
    if (o.changes.length > 3) out.push(`· 还有 ${o.changes.length - 3} 处`)
  }
  for (const s of DISPLAY_ORDER) {
    const items = o.doc.sections[s]
    if (!items.length) continue
    out.push('', `【${s}】`, ...items.map(e => itemLine(s, e.text, o.today)))
  }
  if (o.doc.extra.length) out.push('', '【其它】', ...o.doc.extra)
  out.push('', '不对的地方直接跟我说。在「随身 CC」点一下我,能看到更好看的版本。')
  return out.join('\n')
}

export { SECTIONS }
