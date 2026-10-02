import type { MatterQuotaHandoffT } from '@wechat-cc/protocol'
import { t, type Lang } from '../i18n'
import { providerName } from './continue'

/**
 * 执行者额度用完 ⇒ 交给另一位继续(spec 2026-10-01-tendhearth-continue-sessions §7-3;微信「交给 X 继续？」的手机版)。
 * 进展页底部那一块、确认卡几行、提交失败那一句。纯函数;页面只照着画。所有状态都来自电脑(详情的 quotaHandoff),手机不猜。
 */

export type HandoffBlock =
  | { kind: 'none' }
  | { kind: 'offer'; note: string; action: string }
  | { kind: 'note'; lines: string[] }
  | { kind: 'handed'; note: string; open: string; matterId: string }

/** 约几分钟后恢复:向上取整,至少 1(过了点还没清掉也不说「0 分钟」)。 */
const minutesLeft = (resetAt: number, now: number) => Math.max(1, Math.ceil((resetAt - now) / 60_000))

function reason(h: { from: string; kind: 'quota' | 'rate_limit'; resetAt: number }, lang: Lang, now: number): string {
  return t(lang, h.kind === 'rate_limit' ? 'handoff.rateNote' : 'handoff.quotaNote', { from: providerName(h.from, lang), minutes: String(minutesLeft(h.resetAt, now)) })
}

/** 没有 ⇒ 不画;能交 ⇒ 一句灰字 + 唯一的强调按钮;没人能接 ⇒ 两句灰字;交过了 ⇒ 说交给谁 + 打开那件事。 */
export function handoffBlock(h: MatterQuotaHandoffT | undefined, lang: Lang, now: number): HandoffBlock {
  if (!h) return { kind: 'none' }
  if (h.state === 'handed') return { kind: 'handed', note: t(lang, 'handoff.handed', { to: providerName(h.to, lang) }), open: t(lang, 'handoff.open'), matterId: h.matterId }
  if (h.state === 'none') return { kind: 'note', lines: [reason(h, lang, now), t(lang, 'handoff.noneNote')] }
  return { kind: 'offer', note: reason(h, lang, now), action: t(lang, 'handoff.action', { to: providerName(h.to, lang) }) }
}

/** 确认卡:为什么(整句带句号)/ 在哪、原来那件不动 / 接手的看不到之前的对话(说实话)/ 会用谁的额度。 */
export function handoffSheetLines(h: Extract<MatterQuotaHandoffT, { state: 'offer' }>, lang: Lang, now: number): string[] {
  const from = providerName(h.from, lang), to = providerName(h.to, lang)
  return [
    reason(h, lang, now) + (lang === 'zh-Hans' ? '。' : '.'),
    t(lang, 'handoff.where', { to }),
    t(lang, 'handoff.context', { to, from }),
    t(lang, 'continue.quotaNote', { provider: to }),
  ]
}

/** 这几种失败说明电脑那边变了(额度恢复 / 接手人变了 / 这件又跑起来 / 文件夹忙或没了):失败后重读详情,让底部跟上。 */
export const HANDOFF_RECHECK: ReadonlySet<string> = new Set(['handoff_changed', 'busy', 'quota', 'session_busy', 'folder_busy', 'folder_missing', 'provider_missing'])

/** 提交失败 ⇒ 卡里一句。只有真没送到(离线 / 那一块没接上)才说「没有送到电脑上」;电脑答了、没交出去 ⇒ 中性的一句。 */
export function handoffErrorText(code: string, lang: Lang): string {
  switch (code) {
    case 'handoff_changed': case 'busy': case 'quota': return t(lang, 'handoff.changed')
    case 'session_busy': case 'folder_busy': return t(lang, 'continue.busyFolder')
    case 'folder_missing': return t(lang, 'compose.projectFolderMissing')
    case 'provider_missing': return t(lang, 'continue.providerMissingAny')
    case 'uncertain': return t(lang, 'continue.uncertain')
    case 'revoked': return t(lang, 'conn.revokedTitle')
    case 'offline': case 'unavailable': return t(lang, 'compose.failed')
    default: return t(lang, 'handoff.failed')
  }
}

/** 那一句前面的点:不知道收没收到 ⇒ 灰;再看一眼 / 等一等 ⇒ 琥珀;做不了 ⇒ 红。 */
export function handoffErrorDot(code: string): 'bad' | 'warn' | 'unknown' {
  if (code === 'uncertain') return 'unknown'
  if (['handoff_changed', 'busy', 'quota', 'session_busy', 'folder_busy'].includes(code)) return 'warn'
  return 'bad'
}
