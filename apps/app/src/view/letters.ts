// 「CC 的信」(2026-10-18)的纯视图模型:列表一行 = 日期 + 开头那句;点开逐页看信纸图(按文字寄的那封显示全文)。
// 被根目录测试 import:纯 TS,不碰 react / expo。
import type { LetterSummaryT } from '../backend/types'
import type { Lang } from '../i18n'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** 信上的日期(写信那天,电脑上的本地日期 YYYY-MM-DD):中文「2026 年 10 月 16 日」,英文「October 16, 2026」。认不出就原样。 */
export function letterDate(day: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return day
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return day
  return lang === 'zh-Hans' ? `${y} 年 ${mo} 月 ${d} 日` : `${MONTHS[mo - 1]} ${d}, ${y}`
}

export type LetterRow = { id: string; date: string; opening: string }

/** 列表:新的在前(daemon 已排好,这里按寄出时间再排一次,不信任顺序)。 */
export function letterRows(list: readonly LetterSummaryT[], lang: Lang): LetterRow[] {
  return [...list].sort((a, b) => b.sentAt - a.sentAt).map(l => ({ id: l.id, date: letterDate(l.day, lang), opening: l.opening }))
}

/** 打开的那封要读几页:1..pages;0 页 ⇒ 空(显示全文)。上限防一个坏数撑爆列表。 */
export function letterPages(l: Pick<LetterSummaryT, 'pages'>): number[] {
  const n = Math.max(0, Math.min(12, Math.floor(l.pages)))
  return Array.from({ length: n }, (_, i) => i + 1)
}
