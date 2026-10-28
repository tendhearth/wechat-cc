import type { MatterDetailT } from '../backend/types'
import type { SubmitResult } from '../state/store'
import { t, type Lang } from '../i18n'

/**
 * 工作区脚本(2026-10-20,仓库根 tendhearth.json):任务页独立工作区那块下面一行状态 + 一个按钮。
 * 批准只在电脑上(主人要逐字看过脚本):没批 ⇒ 没有按钮,只说「请先在电脑上确认」。
 * 状态是 daemon 给的字符串;认不得的不说成「好了」。
 */
type Worktree = NonNullable<NonNullable<MatterDetailT['task']>['worktree']>
export type ScriptsBlock = {
  status: string
  /** run = 运行;stop = 停下;null = 不给按钮(没批 / 没有 run 脚本 / 认不得的状态)。 */
  button: 'run' | 'stop' | null
  /** 没批时那一句(不给按钮)。 */
  note: string | null
  /** 在跑 / 失败时的最后几行输出(等宽、安静);其余时候空。 */
  lines: string[]
}
export const SCRIPT_LINES_SHOWN = 8

/** 没配脚本 / 工作区删了 / 老电脑不带 ⇒ null(老界面一点不变)。 */
export function scriptsBlock(wt: Worktree | undefined, lang: Lang): ScriptsBlock | null {
  if (!wt || wt.removed || (wt.setup === undefined && wt.run === undefined && wt.approved === undefined)) return null
  const running = wt.run === 'running' || wt.run === 'queued'
  const parts: string[] = []
  if (!wt.approved) parts.push(t(lang, 'scripts.pending'))
  else {
    if (wt.setup === 'running') parts.push(t(lang, 'scripts.setupRunning'))
    else if (wt.setup === 'failed') parts.push(t(lang, 'scripts.setupFailed'))
    else if (wt.setup === 'done' && !running) parts.push(t(lang, 'scripts.ready'))
    if (wt.run === 'running') parts.push(t(lang, 'scripts.running'))
    else if (wt.run === 'queued') parts.push(t(lang, 'scripts.queued'))
  }
  if (typeof wt.port === 'number') parts.push(t(lang, 'scripts.port', { port: wt.port }))
  const status = parts.length ? t(lang, 'scripts.status', { parts: parts.join(' · ') }) : t(lang, 'scripts.label')
  // 停下总是安全的(没批也能停);运行只在批过、run 歇着时给
  const button = running ? 'stop' : wt.approved && wt.run === 'idle' ? 'run' : null
  const showLines = wt.run === 'running' || wt.setup === 'running' || wt.setup === 'failed'
  return { status, button, note: wt.approved ? null : t(lang, 'scripts.needsComputer'), lines: showLines ? (wt.lastLines ?? []).slice(-SCRIPT_LINES_SHOWN) : [] }
}

type ScriptResult = { run?: string }
/**
 * 点完之后那一句。超时(uncertain)⇒ 不说成了也不说没成;成功也只说电脑回的状态,不替它说「在运行」。
 */
export function scriptOutcome(action: 'run' | 'stop', r: SubmitResult, result: ScriptResult | null, lang: Lang): string {
  if (r === 'ok') {
    if (action === 'stop') return t(lang, 'scripts.stopping')
    return t(lang, result?.run === 'running' ? 'scripts.started' : result?.run === 'queued' ? 'scripts.queuedNote' : 'scripts.sent')
  }
  const code = r === 'busy' ? 'busy' : r.error
  if (code === 'uncertain') return t(lang, 'scripts.uncertain')
  if (code === 'scripts_unapproved') return t(lang, 'scripts.needsComputer')
  if (code === 'script_running') return t(lang, 'scripts.alreadyRunning')
  if (code === 'script_queued') return t(lang, 'scripts.queuedNote')
  if (code === 'no_scripts') return t(lang, 'scripts.noRun')
  if (code === 'busy') return t(lang, 'scripts.busy')
  return t(lang, 'progress.wtFailed')
}
