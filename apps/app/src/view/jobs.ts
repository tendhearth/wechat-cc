// 「定时」(2026-10-20,对标 B7)的纯视图模型:一行 = 什么时候(label,电脑写好、带时区)+ 做什么(早报 / 周报 / 正文)+ 上次结果。
// 新建仍在微信「定时」里说;手机上只看与停 / 开 / 删。纯 TS,不碰 react / expo。
import type { JobsAction, JobsViewT, PhoneJobT } from '../backend/types'
import { t, type Lang, type MessageKey } from '../i18n'

export type JobRow = {
  id: string
  title: string
  body: string
  /** 上次结果那一行;没跑过 ⇒「还没跑过」。 */
  last: string
  /** 停着 ⇒「停着」;在跑的不写。 */
  paused: string | null
  /** 停 / 开 按钮做哪个。 */
  toggle: Extract<JobsAction, 'pause' | 'resume'>
}
export type JobsPage = { notice: string | null; rows: JobRow[]; empty: string | null; hint: string | null }

/** 上次是哪天:中文「10月20日」,英文「10/20」(与 formatSynced 同一写法)。认不出就原样。 */
function lastDay(day: string, lang: Lang): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return day
  const [mo, d] = [Number(m[1]), Number(m[2])]
  return lang === 'zh-Hans' ? `${mo}月${d}日` : `${mo}/${d}`
}

/** 上次结果的人话:中文用电脑给的 label(与微信「定时」列表同一句);英文按 status 译,认不出的新状态退回电脑那句。 */
function lastResult(last: NonNullable<PhoneJobT['last']>, lang: Lang): string {
  if (lang === 'zh-Hans') return last.label
  const s = last.status
  if (s === 'sent') return t(lang, 'jobs.status.sent')
  if (s === 'silent') return t(lang, 'jobs.status.silent')
  if (s.startsWith('skipped')) return t(lang, 'jobs.status.skipped')
  if (s.startsWith('failed')) return t(lang, 'jobs.status.failed')
  return last.label
}

export function jobRow(j: PhoneJobT, lang: Lang): JobRow {
  return {
    id: j.id,
    title: j.label,
    body: j.brief ? t(lang, 'jobs.brief') : j.recap === true ? t(lang, 'jobs.recap') : j.text,
    last: j.last ? t(lang, 'jobs.last', { day: lastDay(j.last.day, lang), result: lastResult(j.last, lang) }) : t(lang, 'jobs.neverRun'),
    paused: j.paused ? t(lang, 'jobs.paused') : null,
    toggle: j.paused ? 'resume' : 'pause',
  }
}

/** 整页:没有执行者 ⇒ 顶上一句(不是错误,不上红);空 ⇒ 告诉主人去微信加;有 ⇒ 列表底下一句怎么加。 */
export function jobsPage(v: JobsViewT, lang: Lang): JobsPage {
  const rows = v.jobs.map(j => jobRow(j, lang))
  return {
    notice: v.executor === null ? t(lang, 'jobs.noExecutor') : null,
    rows,
    empty: rows.length === 0 ? t(lang, 'jobs.empty') : null,
    hint: rows.length > 0 ? t(lang, 'jobs.addHint') : null,
  }
}

/** 点了「删」之后:第一下只是「再点一次」(没在等的这一条 ⇒ armed),第二下才真删;停 / 开 一下就做。 */
export function jobsTap(armed: string | null, id: string, action: JobsAction): 'arm' | 'run' {
  return action === 'remove' && armed !== id ? 'arm' : 'run'
}

/** 动作的结果 → 那一句灰字;ok / busy(同一条正在做)⇒ 不说。
 * 超时(uncertain)不能说「没改成」—— 也许已经改了只是回执丢了(定时页评审 10-20),单独说「不确定」。 */
export function jobsActionNote(r: 'ok' | 'busy' | { error: string }): MessageKey | null {
  if (r === 'ok' || r === 'busy') return null
  if (r.error === 'not_found') return 'jobs.gone'
  if (r.error === 'uncertain') return 'jobs.uncertain'
  return 'jobs.failed'
}
