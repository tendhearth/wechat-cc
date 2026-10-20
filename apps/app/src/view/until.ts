import type { MatterDetailT } from '../backend/types'
import { t, type Lang } from '../i18n'

/**
 * 做到条件成立为止(spec 2026-10-20-workbench-until-design)。
 * 上限与 daemon 的 src/core/workbench/until.ts 同一份:命令一行、1–300 字(按字符数,不按 UTF-16),轮数 1–10、默认 3。
 * 只在开了独立工作区的交办上带(daemon 没开就回 until_requires_worktree)。
 */
export const UNTIL_COMMAND_MAX = 300
export const UNTIL_DEFAULT_ROUNDS = 3
export const UNTIL_MAX_ROUNDS = 10

export type UntilSpec = { command: string; maxRounds: number }
export type UntilDraft = { command: string; maxRounds: number }
export type UntilDraftError = 'multiline' | 'tooLong'

/** 输入框里的命令有没有毛病;空 = 没填(不是错)。daemon 先 trim 再判,这里同样。 */
export function untilDraftError(command: string): UntilDraftError | null {
  const c = command.trim()
  if (!c) return null
  if (/[\r\n]/.test(c)) return 'multiline'
  if ([...c].length > UNTIL_COMMAND_MAX) return 'tooLong'
  return null
}

export const clampRounds = (n: number): number => Math.min(UNTIL_MAX_ROUNDS, Math.max(1, Math.round(n)))

/**
 * 要不要随交办带 until。只在:开了独立工作区、命令填了且没毛病、执行者不是免审的。
 * 带出去的命令 = trim 后的原文 —— 这正是 daemon 存下、之后每轮去跑的那一份。
 */
export function untilRequest(d: UntilDraft, ctx: { isolated: boolean; unattended: boolean }): UntilSpec | undefined {
  if (!ctx.isolated || ctx.unattended) return undefined
  const command = d.command.trim()
  if (!command || untilDraftError(command)) return undefined
  return { command, maxRounds: clampRounds(d.maxRounds) }
}

/**
 * 提交前的确认块(安全 6):命令原文整条给出,不截断;界面用等宽、不设 numberOfLines。
 * 返回的 command 必须与 untilRequest 带出去的那一份逐字相同。
 */
export function untilConfirmation(spec: UntilSpec, lang: Lang): { heading: string; command: string; rounds: string; note: string; accessibilityLabel: string } {
  const heading = t(lang, 'until.confirmHeading')
  const rounds = t(lang, 'until.confirmRounds', { n: spec.maxRounds })
  return { heading, command: spec.command, rounds, note: t(lang, 'until.note'), accessibilityLabel: `${heading} ${spec.command} · ${rounds}` }
}

/** 交办失败码里 until 那三条(net/errors.ts 映射后的 BackendCode)。 */
export type UntilRejection = 'until_invalid' | 'until_requires_worktree' | 'until_unattended'

type UntilState = NonNullable<NonNullable<MatterDetailT['task']>['until']>

/** 任务详情顶上那一行:「直到 `cmd` 通过 · 第 n/m 轮 · 没过 / 通过 / 停了(原因)」。命令单独给,页面用等宽画。 */
export function untilLine(u: UntilState, lang: Lang): { before: string; command: string; after: string; accessibilityLabel: string } {
  // 进行中 ⇒ 正在做的那一轮(已查过的轮数 + 1);结束了 ⇒ 实际查过的轮数
  const n = u.status === 'active' ? Math.min(u.rounds + 1, u.maxRounds) : u.rounds
  const round = n > 0 ? t(lang, 'until.round', { n, m: u.maxRounds }) : null
  const state = u.status === 'passed' ? t(lang, 'until.passed')
    : u.status === 'exhausted' ? t(lang, 'until.exhausted')
    : u.status === 'stopped' ? (u.stopReason ? t(lang, 'until.stoppedWhy', { why: u.stopReason }) : t(lang, 'until.stopped'))
    : u.rounds > 0 ? t(lang, 'until.notYet') : t(lang, 'until.pending')
  // 中英文都在命令两边留一个空格:命令是拉丁字,贴着中文不好认
  const before = `${t(lang, 'until.lineBefore')} `
  const after = ` ${[t(lang, 'until.lineAfter'), round, state].filter(Boolean).join(' · ')}`
  return { before, command: u.command, after, accessibilityLabel: `${before}${u.command}${after}` }
}
