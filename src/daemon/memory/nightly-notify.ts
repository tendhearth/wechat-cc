/** 整理完什么值得告诉主人、怎么说。纯函数:规则由程序定,不看模型心情。 */
import type { AppliedOp } from './nightly-ops'

export type NightlyRunResult =
  | { status: 'written'; applied: AppliedOp[]; notice: string | null }
  | { status: 'skipped'; reason: 'disabled' | 'no_owner' | 'not_due' | 'failed_today' | 'owner_busy' | 'no_new_material' | 'owner_edited' }
  | { status: 'failed'; reason: string }

export interface NoticeItem { label: '新记下' | '改了' | '删了'; text: string; before?: string; reason?: string }

export const FIRST_RUN_NOTICE = '我把对你的理解整理成了一份记忆,以后每晚更新。发「查看记忆」就能看,不对的地方直接跟我说。'

export function noticeItems(applied: readonly AppliedOp[]): NoticeItem[] {
  const out: NoticeItem[] = []
  for (const op of applied) {
    if (op.kind === 'add' && op.section === '承诺') out.push({ label: '新记下', text: op.text })
    else if (op.kind === 'update' && op.reversal && (op.section === '偏好' || op.section === '关于你')) out.push({ label: '改了', text: op.text, before: op.before })
    else if (op.kind === 'remove') out.push({ label: '删了', text: op.text, reason: op.reason })
  }
  return out
}

function line(i: NoticeItem): string {
  if (i.label === '改了') return `· 改了:${i.text}(原来是:${i.before ?? ''})`
  if (i.label === '删了') return `· 删了:${i.text}${i.reason ? `(${i.reason})` : ''}`
  return `· 新记下:${i.text}`
}

export function composeNotice(items: readonly NoticeItem[], firstRun: boolean): string | null {
  if (firstRun) return FIRST_RUN_NOTICE
  if (!items.length) return null
  const out = ['昨晚整理记忆,有几件想跟你对一下:', ...items.slice(0, 3).map(line)]
  if (items.length > 3) out.push(`还有 ${items.length - 3} 条,发「查看记忆」看全部。`)
  out.push('不对的话直接跟我说。')
  return out.join('\n')
}

export function formatNightlyReply(r: NightlyRunResult): string {
  if (r.status === 'written') return r.notice ?? '整理好了,没有需要特别跟你说的变化。发「查看记忆」看全部。'
  if (r.status === 'failed') return `这次没整理成(${r.reason}),记忆保持原样。`
  if (r.reason === 'no_new_material') return '没有新东西要整理,记忆保持原样。'
  if (r.reason === 'owner_edited') return '你刚好在改记忆,我先不动,稍后再整理。'
  if (r.reason === 'no_owner') return '还没认出主人,没法整理。'
  return `这次没有整理(${r.reason})。`
}
