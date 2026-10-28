// 撤掉这一轮(回退切片 4,spec 2026-10-21-workbench-rewind-design「入口」)的纯视图:手机 v1 只给最新那一轮「撤掉这一轮」
// (回到它开始之前)+ 确认页;不给「撤销回退」(只在电脑上)。回退停住 ⇒ 只读一句,没有按钮。纯 TS,不碰 react / expo。
import type { MatterDetailT, PhoneChangesTurnT, RewindPreviewT } from '../backend/types'
import type { SubmitResult } from '../state/store'
import { t, type Lang, type MessageKey } from '../i18n'

/** 确认页最多列这么多个路径(daemon 也只给 50 个)。 */
export const REWIND_MAX_PATHS = 50

/** 这件事被回退停住了 ⇒ 只读一句(请在电脑上处理);没停住 ⇒ null。 */
export function rewindBlockedNotice(task: MatterDetailT['task'], lang: Lang): string | null {
  return task?.rewind?.blocked ? t(lang, 'rewind.blocked') : null
}

/** 改动面板里给不给「撤掉这一轮」:这一轮能撤、没撤掉、这件事没停住。在不在线另算(按钮置灰)。 */
export function canOfferRewind(turn: PhoneChangesTurnT | null | undefined, blocked: boolean): turn is PhoneChangesTurnT & { artifactId: string } {
  return !!turn && turn.rewindable === true && turn.discarded !== true && typeof turn.artifactId === 'string' && !blocked
}

/** 改动面板里灰着的那两句:这一轮已撤掉 / 之后有几轮已撤掉。 */
export function discardedLines(turn: PhoneChangesTurnT | null | undefined, lang: Lang): { discarded: string | null; after: string | null } {
  const n = turn?.discardedAfter ?? 0
  return {
    discarded: turn?.discarded === true ? t(lang, 'rewind.discarded') : null,
    after: n > 0 ? (n === 1 ? t(lang, 'rewind.discardedAfterOne') : t(lang, 'rewind.discardedAfter', { n })) : null,
  }
}

export type RewindSheet = { title: string; what: string; filesHead: string; paths: string[]; more: string | null; notes: string[] }

/** 确认页:撤掉第几轮、多少文件(至多 50 个路径)、额外改动 / 丢掉的提交 / 会话 / 开发服务 / goal 的提醒、先重新构建、先备份。 */
export function rewindSheet(p: RewindPreviewT, lang: Lang): RewindSheet {
  const paths = p.files.paths.slice(0, REWIND_MAX_PATHS).map(f => `${f.status} ${f.path}`)
  const rest = p.files.count - paths.length
  const notes: string[] = []
  if (p.extraChanges && p.extraChanges.count > 0) notes.push(t(lang, 'rewind.extra', { n: p.extraChanges.count }))
  if (p.droppedCommits.count > 0) {
    notes.push(t(lang, 'rewind.commits', { n: p.droppedCommits.count }))
    if (p.droppedCommits.elsewhere) notes.push(t(lang, 'rewind.commitsElsewhere'))
  }
  if (p.session === 'will_close') notes.push(t(lang, 'rewind.session'))
  if (p.devServer) notes.push(t(lang, 'rewind.devServer'))
  if (p.goalWillStop) notes.push(t(lang, 'rewind.goal'))
  // 提醒重新构建:用本机语言那一句(daemon 给的是中文),一定说
  notes.push(t(lang, 'rewind.rebuild'), t(lang, 'rewind.backup'))
  return {
    title: t(lang, 'rewind.title', { n: p.round }),
    what: t(lang, 'rewind.what', { n: p.round }),
    filesHead: p.files.count > 0 ? t(lang, 'rewind.files', { n: p.files.count }) : t(lang, 'rewind.filesNone'),
    paths,
    more: rest > 0 ? t(lang, 'rewind.moreFiles', { n: rest }) : null,
    notes,
  }
}

const ERROR_TEXT: Readonly<Record<string, MessageKey>> = {
  rewind_stale: 'rewind.stale', rewind_needs_owner: 'rewind.blocked', busy: 'rewind.busy', rewind_shared: 'rewind.shared', rewind_merged: 'rewind.merged',
  rewind_ignored: 'rewind.ignored', rewind_unavailable: 'rewind.unavailable', rewind_noop: 'rewind.noop', rewind_failed: 'rewind.failed', uncertain: 'rewind.uncertain',
}

/**
 * 点了「确认撤掉」之后怎么办。
 * - done:关掉确认页,说「已撤掉第 N 轮」,重拉改动与详情;
 * - stale:工作区刚变过 ⇒ 留在确认页、重拉预览、说「请再看一眼」;
 * - uncertain:超时,不说成了也不说没成(同定时页)⇒ 关掉,重拉详情;
 * - blocked:回退停住 ⇒ 关掉,详情顶上那句只读提醒接手;
 * - error:说为什么,留在确认页。
 */
export type RewindOutcome = { kind: 'done' | 'stale' | 'uncertain' | 'blocked' | 'error'; text: string }
export function rewindOutcome(r: SubmitResult, round: number, lang: Lang): RewindOutcome {
  if (r === 'ok') return { kind: 'done', text: t(lang, 'rewind.done', { n: round }) }
  const code = r === 'busy' ? 'busy' : r.error
  const text = t(lang, ERROR_TEXT[code] ?? 'rewind.error')
  if (code === 'rewind_stale') return { kind: 'stale', text }
  if (code === 'uncertain') return { kind: 'uncertain', text }
  if (code === 'rewind_needs_owner' || code === 'rewind_failed') return { kind: 'blocked', text }
  return { kind: 'error', text }
}

/** 拉预览失败的那句(没有「不确定」:预览不改东西,超时就是没拿到)。 */
export function rewindPreviewError(code: string, lang: Lang): string {
  const key = ERROR_TEXT[code]
  return t(lang, key && code !== 'uncertain' && code !== 'rewind_failed' ? key : 'rewind.loadFailed')
}
