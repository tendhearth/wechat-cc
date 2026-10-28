// 这件事用了多少额度(#437,v82):详情里一行安静的合计。只用执行者自己报的数;某项没报 ⇒「不报」,从不写 0;没有 usage ⇒ 不画。
import type { MatterDetailT } from '../backend/types'
import { t, type Lang } from '../i18n'

type Usage = NonNullable<NonNullable<MatterDetailT['task']>['usage']>

/** 12345 ⇒ 中文「1.2 万」/ 英文「12.3k」;一万 / 一千以下原样。 */
export function compactTokens(n: number, lang: Lang): string {
  const v = Math.max(0, Math.round(n))
  if (lang === 'zh-Hans') return v < 10_000 ? String(v) : `${trim((v / 10_000).toFixed(1))} 万`
  return v < 1_000 ? String(v) : v < 1_000_000 ? `${trim((v / 1_000).toFixed(1))}k` : `${trim((v / 1_000_000).toFixed(1))}M`
}
const trim = (s: string) => s.replace(/\.0$/, '')

export function usageLine(usage: Usage | undefined, lang: Lang): string | null {
  if (!usage || !(usage.turns > 0)) return null
  const one = usage.turns === 1
  if (usage.input === null && usage.output === null) return t(lang, one ? 'usage.lineNoneOne' : 'usage.lineNone', { turns: usage.turns })
  const show = (n: number | null) => (n === null ? t(lang, 'usage.notReported') : compactTokens(n, lang))
  return t(lang, one ? 'usage.lineOne' : 'usage.line', { turns: usage.turns, input: show(usage.input), output: show(usage.output) })
}
