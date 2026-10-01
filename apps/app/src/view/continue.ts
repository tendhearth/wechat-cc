import type { SessionContinueT } from '../backend/types'
import { t, type Lang } from '../i18n'

/**
 * 在手机上接着做电脑上的会话(spec 2026-10-01-tendhearth-continue-sessions §4.4 / §4.5):读页底部那一块、确认卡、
 * 提交失败的那一句、接过来的事「第一句会怎样」。纯函数;页面只照着画。
 */

/** {provider} 填的名字:与会话页的分段同名;别的执行者原样(这一版只有 claude / codex 会走到这里)。 */
export const providerName = (p: string, lang: Lang): string =>
  p === 'claude' ? t(lang, 'sessions.claude') : p === 'codex' ? t(lang, 'sessions.codex') : p

/**
 * CC 看不看得见这个执行者在电脑上跑没跑(spec D3):Codex 的会话状态 daemon 读得到(在跑 ⇒ 预览就是 busy_session);
 * Claude Code 普通终端里的会话 CC 看不见,只能靠主人自己声明「已经停了」。
 */
const runSeen = (provider: string): boolean => provider === 'codex'

/** 「先让原来那个停下」那一句:看不见的说 CC 没法确认;看得见的如实说「没看到在跑」,再提醒一句。 */
const stopLine = (provider: string, lang: Lang): string =>
  t(lang, runSeen(provider) ? 'continue.notSeenRunning' : 'continue.stopFirst', { provider: providerName(provider, lang) })

export type ContinueBlock =
  | { kind: 'none' }
  | { kind: 'continue'; label: string }
  | { kind: 'open'; label: string }
  | { kind: 'note'; text: string; retry: boolean }

type Refusal = Exclude<SessionContinueT['state'], 'ready' | 'managed'>
function refusalText(state: Refusal, provider: string, lang: Lang): string {
  switch (state) {
    case 'busy_session': return t(lang, 'continue.busySession')
    case 'busy_folder': return t(lang, 'continue.busyFolder')
    case 'provider_missing': return t(lang, 'continue.providerMissing', { provider: providerName(provider, lang) })
    case 'folder_missing': return t(lang, 'continue.folderMissing')
    case 'quota': return t(lang, 'continue.quota')
    case 'empty': return t(lang, 'continue.empty')
  }
}

/** 还在问 ⇒ 不画;能接 ⇒ 唯一的强调按钮;接过了 ⇒ 打开那件事;不能接 ⇒ 一句灰字说为什么(问不到才给「再试一次」)。 */
export function continueBlock(p: SessionContinueT | 'loading' | 'failed', lang: Lang): ContinueBlock {
  if (p === 'loading') return { kind: 'none' }
  if (p === 'failed') return { kind: 'note', text: t(lang, 'continue.unknown'), retry: true }
  if (p.state === 'ready') return { kind: 'continue', label: t(lang, 'continue.action') }
  if (p.state === 'managed') return { kind: 'open', label: t(lang, 'continue.open') }
  return { kind: 'note', text: refusalText(p.state, p.provider, lang), retry: false }
}

/** 确认卡:在哪台电脑、用谁、哪个文件夹;接原会话还是带记录新开(从不让人选,spec D2);会用额度;先让原来那个停下(spec D3)。 */
export function continueSheetLines(p: SessionContinueT, lang: Lang): string[] {
  const provider = providerName(p.provider, lang)
  return [
    t(lang, 'continue.runsOn', { provider, project: p.project ?? t(lang, 'continue.unknownFolder') }),
    t(lang, p.mode === 'fresh_context' ? 'continue.modeFresh' : 'continue.modeResume'),
    t(lang, 'continue.quotaNote', { provider }),
    stopLine(p.provider, lang),
  ]
}

/** 确认卡主按钮:CC 看不见的(Claude Code)这一下就是主人的声明 ⇒「已经停了，接着做」;看得见的就是「接着做」。 */
export const continueConfirmLabel = (p: SessionContinueT, lang: Lang): string =>
  t(lang, runSeen(p.provider) ? 'continue.action' : 'continue.confirm')

/** 这几种失败说明电脑那边的状态变了:失败后重问一次预览,让底部按钮 / 灰字跟上。 */
export const CONTINUE_RECHECK: ReadonlySet<string> = new Set(['session_busy', 'folder_busy', 'provider_missing', 'folder_missing', 'quota', 'session_changed', 'session_empty'])

/**
 * 「接着做」/「打开这件事」提交失败 ⇒ 一句话。code 是 BackendCode 或 store 的 'uncertain'。
 * provider 来自预览或会话行;都没有 ⇒ null,说「这个执行者」。只有真没送到(离线 / 那一块没接上)才说「没有送到电脑上」;
 * 电脑那边答了、但没接上的(裁决 R5)说中性的一句。
 */
export function continueErrorText(code: string, provider: string | null, lang: Lang): string {
  switch (code) {
    case 'session_busy': return t(lang, 'continue.busySession')
    case 'folder_busy': return t(lang, 'continue.busyFolder')
    case 'provider_missing': return provider ? t(lang, 'continue.providerMissing', { provider: providerName(provider, lang) }) : t(lang, 'continue.providerMissingAny')
    case 'folder_missing': return t(lang, 'continue.folderMissing')
    case 'quota': return t(lang, 'continue.quota')
    case 'session_changed': return t(lang, 'continue.changed')
    case 'session_empty': return t(lang, 'continue.emptyNow')
    case 'uncertain': return t(lang, 'continue.uncertain')
    case 'revoked': return t(lang, 'conn.revokedTitle')
    case 'offline': case 'unavailable': return t(lang, 'compose.failed')
    default: return t(lang, 'continue.failed')
  }
}

/** 那一句前面的点(状态色只上点):不知道收没收到 ⇒ 灰;等一等 / 再看一眼就好 ⇒ 琥珀;做不了 ⇒ 红。 */
export function continueErrorDot(code: string): 'bad' | 'warn' | 'unknown' {
  if (code === 'uncertain') return 'unknown'
  if (code === 'session_busy' || code === 'folder_busy' || code === 'quota' || code === 'session_changed') return 'warn'
  return 'bad'
}

/** 接过来、还没发第一句的那件事(进展页 / 说一句页顶上):第一句会怎样 + 先让原来那个停下。 */
export function nativeStartLines(n: { mode: 'native_resume' | 'fresh_context'; providerId: string }, lang: Lang): string[] {
  const provider = providerName(n.providerId, lang)
  return [
    t(lang, n.mode === 'fresh_context' ? 'continue.firstFresh' : 'continue.firstResume', { provider }),
    stopLine(n.providerId, lang),
  ]
}
