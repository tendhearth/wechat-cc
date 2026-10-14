import { PHONE_SAY_MAX_CHARS } from '@wechat-cc/protocol'
import { t, type Lang } from '../i18n'
import { providerName } from './continue'

/**
 * 说一句 / 交办新事项的正文上限。daemon 两处都是 20 000:POST /m/api/matter/say 用 PHONE_SAY_MAX_CHARS;
 * 交办走 parseEntryInput(ENTRY_LIMITS.text,超了回 invalid_text)。两者今天相等,手机统一用协议包常量。
 */
export const COMPOSE_MAX_CHARS = PHONE_SAY_MAX_CHARS

/** 超了就在手机上拦下,不发(发了也必然被拒,不是「稍后再试」)。 */
export const composeTooLong = (text: string): boolean => text.length > COMPOSE_MAX_CHARS

/** 提交失败码 ⇒ 页内提示。revoked 单列:手机已不再配对,「稍后再试」是错的(横幅由 ConnectionNotice 讲)。
 *  后面几个是接着做电脑会话细分出来的(spec 2026-10-01-tendhearth-continue-sessions D11;会话刚变 / 没内容见裁决 R5)。
 *  「没有送到电脑上」(failed)只给真没送到的:离线 / daemon 那一块没接上。电脑那边答了、但没接下的 ⇒ refused,说中性的一句
 *  (与 continueErrorText 同一条规矩,final fix I1)。 */
export function composeOutcome(error: string): Exclude<ComposeOutcome, 'busy' | 'tooLong'> {
  switch (error) {
    case 'uncertain': return 'uncertain'
    case 'busy': return 'ccBusy'
    case 'revoked': return 'revoked'
    case 'session_busy': return 'sessionBusy'
    case 'folder_busy': return 'folderBusy'
    case 'provider_missing': return 'providerMissing'
    case 'folder_missing': return 'folderMissing'
    case 'quota': return 'quota'
    case 'session_changed': return 'sessionChanged'
    case 'session_empty': return 'sessionEmpty'
    case 'offline': case 'unavailable': return 'failed'
    case 'images_gone': return 'imagesGone'
    case 'images_unsupported': return 'imagesUnsupported'
    case 'worktree_not_git': return 'notGit'
    case 'worktree_base_missing': return 'baseMissing'
    default: return 'refused'
  }
}

export type ComposeOutcome = 'failed' | 'refused' | 'uncertain' | 'busy' | 'ccBusy' | 'tooLong' | 'revoked'
  | 'sessionBusy' | 'folderBusy' | 'providerMissing' | 'folderMissing' | 'quota' | 'sessionChanged' | 'sessionEmpty'
  | 'imagesGone' | 'imagesUnsupported' | 'notGit' | 'baseMissing'

/** 页内提示前面的状态点:没送到 / 送不了 ⇒ 红;不知道送没送到 ⇒ 灰;只是要等一等 ⇒ 琥珀。文字本身一律 inkSoft。 */
export function composeOutcomeDot(o: ComposeOutcome): 'bad' | 'unknown' | 'warn' {
  if (o === 'uncertain') return 'unknown'
  if (o === 'busy' || o === 'ccBusy' || o === 'sessionBusy' || o === 'folderBusy' || o === 'quota' || o === 'sessionChanged') return 'warn'
  return 'bad'
}

/** 页内提示那一句。provider:说的是哪个执行者(一件事的 task.providerId / 交办时选的);不知道 ⇒ 说「这个执行者」。
 *  onMatter:在一件事上说一句(true)还是交办新事项(false)。交办时没有「会话」:CC 在那个文件夹里忙 daemon 也回
 *  native_session_busy(createTask 用 nativeId=null 问冲突),invalid_path 说的是项目文件夹(final fix I2)。 */
export function composeOutcomeText(o: ComposeOutcome, lang: Lang, provider: string | null, onMatter: boolean): string {
  switch (o) {
    case 'uncertain': return t(lang, 'compose.uncertain')
    case 'busy': return t(lang, 'compose.busy')
    case 'ccBusy': return t(lang, 'common.ccBusy')
    case 'tooLong': return t(lang, 'compose.tooLong')
    case 'revoked': return t(lang, 'conn.revokedTitle')
    case 'sessionBusy': return t(lang, onMatter ? 'continue.busySession' : 'continue.busyFolder')
    case 'folderBusy': return t(lang, 'continue.busyFolder')
    case 'providerMissing': return provider ? t(lang, 'continue.providerMissing', { provider: providerName(provider, lang) }) : t(lang, 'continue.providerMissingAny')
    case 'folderMissing': return t(lang, onMatter ? 'continue.folderMissing' : 'compose.projectFolderMissing')
    case 'quota': return t(lang, 'continue.quota')
    case 'sessionChanged': return t(lang, 'continue.changed')
    case 'sessionEmpty': return t(lang, 'continue.emptyNow')
    case 'refused': return t(lang, 'compose.notTaken')
    case 'failed': return t(lang, 'compose.failed')
    case 'imagesGone': return t(lang, 'chat.imagesGone')
    case 'imagesUnsupported': return t(lang, 'chat.imagesUnsupported')
    case 'notGit': return t(lang, 'compose.notGit')
    case 'baseMissing': return t(lang, 'compose.baseMissing')
  }
}
