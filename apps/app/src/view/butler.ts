import { t, type Lang } from '../i18n'
import { checkupReview } from '@wechat-cc/protocol'
import type { CheckupView, CheckupEstimate } from '@wechat-cc/protocol'

/** The local UI needs only these non-sensitive result fields. */
export type CheckupViewT = CheckupView
export type CheckupEstimateT = CheckupEstimate

export function butlerActionError(code: string, lang: Lang): string {
  if (code === 'checkup_rate_limited') return t(lang, 'butler.rateLimited')
  if (code === 'stale' || code === 'checkup_target_changed') return t(lang, 'butler.targetChanged')
  if (code === 'busy' || code === 'checkup_busy') return t(lang, 'butler.busy')
  if (code === 'checkup_invalid' || code === 'checkup_invalid_request') return t(lang, 'butler.invalidRequest')
  return t(lang, 'butler.actionFailed')
}

export function butlerView(data: CheckupViewT, lang: Lang) {
  const p = data.profile, review=data.review??checkupReview(data)
  return {
    title:review.title,rows:review.rows,
    memory: t(lang, p ? ({ good: 'butler.good', fair: 'butler.fair', weak: 'butler.weak' } as const)[p.memory] : 'butler.untested'),
    tools: t(lang, p ? p.tools === 'stable' ? 'butler.stable' : 'butler.flaky' : 'butler.untested'),
    note: data.review?.care || (p?.interview?review.care:p?.memory === 'weak' ? t(lang, 'butler.weakNote') : !p ? t(lang, 'butler.guide') : ''),
    tested: p ? t(lang, 'butler.tested', { date: new Date(p.testedAt).toLocaleString(lang === 'zh-Hans' ? 'zh-CN' : 'en-US') }) + (p.short ? ` · ${t(lang, 'butler.short')}` : '') : '',
    attempt: data.review?.status || (data.attempt?.errorCode==='isolated_evaluation_unavailable'?review.status:data.attempt?.status === 'running' ? t(lang, 'butler.running') : data.attempt?.status === 'failed' ? t(lang, 'butler.failed') : data.attempt?.status === 'cancelled' ? t(lang, 'butler.cancelled') : ''),
  }
}
