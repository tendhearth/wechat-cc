import { isMatterArchived } from './status'
// 「CC 最近在忙」(M5c,设计稿 2026-11-04-m5-cc-acts-design.md):主页最末一组(默认折叠)与 act 那件事的详情页。纯 TS,不碰 react / expo。
// 主人 10-31 定:CC 自己做的事不混进「一件事」列表(home.ts 把 act 挡在外面),只在这里。
// 一句话从发起方(act.who)+ 那一轮的状态 / 原因码 / 步的 payload 推出来;认不出的发起方、状态、步都有通用的说法,不让新 daemon 的新值把页面弄坏。
import type { MatterActTurnT } from '@wechat-cc/protocol'
import type { MatterDetailT, MatterT } from '../backend/types'
import { t, type Lang, type MessageKey } from '../i18n'
import { activityDayLabel } from './activity'
import { relAgo } from './terminal'

/** 六个发起方各一件(信 / 早报 / 记忆整理 / 打猎 / 画室 / 贴纸)。 */
export const CC_ACTS_MAX = 6
const WHO = ['letters', 'brief', 'memory', 'hunt', 'atelier', 'stickers'] as const
type Who = typeof WHO[number]
const known = (who: string | undefined): Who | null => (WHO as readonly string[]).includes(who ?? '') ? who as Who : null

type Step = MatterActTurnT['steps'][number]
export type CcActRow = { id: string; href: string; title: string; line: string | null; when: string; at: number }
export type CcActsView = { rows: CcActRow[] }

const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
/** 记忆整理那一步的 applied 是「种类 → 条数」的表;加起来。 */
const appliedOf = (p: Record<string, unknown> | undefined): number | null => {
  const a = p?.applied
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null
  return Object.values(a as Record<string, unknown>).reduce<number>((n, v) => n + (num(v) ?? 0), 0)
}
const turnAt = (x: Pick<MatterActTurnT, 'startedAt' | 'endedAt'>) => x.endedAt ?? x.startedAt

/** 同一天:刚刚 / N 分钟前 / N 小时前;前一天:昨天;更早:月日(同「CC 做过的事」)。 */
export function actWhen(ts: number, now: number, lang: Lang): string {
  const d = new Date(ts), n = new Date(now)
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? relAgo(ts, now, lang) : activityDayLabel(ts, now, lang)
}

/** 最近一轮那一句(「写了一封信」「整理了 3 条记忆」)。 */
export function actLine(who: string | undefined, turn: MatterActTurnT, lang: Lang): string {
  const w = known(who)
  const ns = w ?? 'other'
  const key = (k: string) => `ccActs.${ns}.${k}` as MessageKey
  if (turn.status === 'interrupted' || turn.status === 'cancelled') return t(lang, 'ccActs.interrupted')
  if (turn.status === 'running') return t(lang, key('running'))
  const err = turn.errorCode ?? null
  if (turn.status === 'completed') {
    if (w === 'memory') { const n = turn.steps.map(s => appliedOf(s.payload)).find(x => x !== null); return n ? t(lang, 'ccActs.memory.done', { n }) : t(lang, 'ccActs.memory.doneNone') }
    if (w === 'hunt') { const n = turn.steps.map(s => num(s.payload?.caught)).find(x => x !== null); return n ? t(lang, 'ccActs.hunt.done', { n }) : t(lang, 'ccActs.hunt.doneNone') }
    return t(lang, key('done'))
  }
  // 没做成的几种:信等着窗口 / 被挡下(写好了,下次续寄)、没写成;记忆整理是主人刚改过
  if (w === 'letters' && (err === 'waiting' || err === 'blocked')) return t(lang, 'ccActs.letters.waiting')
  if (w === 'letters' && (err === 'skipped' || err === 'compose_failed')) return t(lang, 'ccActs.letters.skipped')
  if (w === 'memory' && err === 'owner_edited') return t(lang, 'ccActs.memory.ownerEdited')
  return t(lang, key('failed'))
}

/** 一步一句;认不出的步 ⇒ null(不画)。 */
export function actStepLine(who: string | undefined, step: Step, lang: Lang): string | null {
  const p = step.payload
  const w = known(who)
  switch (step.kind) {
    case 'artifact': {
      if (w === 'letters') { const chars = num(p?.chars) ?? 0, pages = num(p?.pages) ?? 0; return pages > 0 ? t(lang, 'ccActs.step.letterPages', { chars, pages }) : t(lang, 'ccActs.step.letter', { chars }) }
      if (w === 'stickers') return t(lang, 'ccActs.step.sticker')
      if (w === 'atelier') return t(lang, 'ccActs.step.work')
      if (w === 'hunt') { const n = num(p?.caught) ?? num(p?.messages); if (n !== null) return t(lang, 'ccActs.step.caught', { n }) }
      return t(lang, 'ccActs.step.artifact')
    }
    case 'delivery': return t(lang, step.status === 'completed' ? 'ccActs.step.delivered' : 'ccActs.step.notDelivered')
    case 'system': { const n = appliedOf(p); return n !== null ? t(lang, 'ccActs.step.applied', { n }) : t(lang, 'ccActs.step.skipped') }
    case 'agent_message': return t(lang, 'ccActs.step.message')
    case 'error': return t(lang, 'ccActs.step.error')
    default: return null
  }
}

/** 发起方的名字按语言给(daemon 的标题是中文名);认不出的发起方 ⇒ daemon 给的标题。 */
export function actTitle(m: Pick<MatterT, 'title' | 'act'>, lang: Lang): string {
  const w = known(m.act?.who)
  return w ? t(lang, `ccActs.${w}.title` as MessageKey) : m.title
}

/** 主页那一组:只认 act、不要归档的;按最近一轮的时间排(没有轮 ⇒ updatedAt),至多六行。没有行 ⇒ 这一组不出现。 */
export function ccActsView(matters: readonly MatterT[], now: number, lang: Lang): CcActsView {
  const rows = matters
    .filter(m => m.kind === 'act' && !isMatterArchived(m))
    .map(m => {
      const latest = m.act?.latest
      const at = latest ? turnAt(latest) : m.updatedAt
      return { id: m.id, href: `/matter/${encodeURIComponent(m.id)}`, title: actTitle(m, lang), line: latest ? actLine(m.act?.who, latest, lang) : null, when: actWhen(at, now, lang), at }
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, CC_ACTS_MAX)
  return { rows }
}

export type ActTimelineTurn = { id: string; line: string; when: string; steps: string[] }
export type ActTimeline = { turns: ActTimelineTurn[]; empty: string | null; note: string | null }

/** 详情页:一轮一段(新的在前),每段 = 那一句 + 时间(主人叫的标出来)+ 步。老 daemon 不带 actTurns ⇒ 只有列表那一轮,外加一句说明。 */
export function actTimeline(d: MatterDetailT, now: number, lang: Lang): ActTimeline {
  const who = d.matter.act?.who
  const fromList = d.matter.act?.latest
  const turns = d.actTurns ?? (fromList ? [fromList] : [])
  const out = turns.map(tr => ({
    id: tr.id,
    line: actLine(who, tr, lang),
    when: [actWhen(turnAt(tr), now, lang), tr.trigger === 'owner' ? t(lang, 'ccActs.trigger.owner') : null].filter(Boolean).join(' · '),
    steps: tr.steps.map(s => actStepLine(who, s, lang)).filter((x): x is string => x !== null),
  }))
  return {
    turns: out,
    empty: out.length === 0 ? t(lang, 'ccActs.empty') : null,
    note: d.actTurns === undefined && out.length > 0 ? t(lang, 'ccActs.noSteps') : null,
  }
}
