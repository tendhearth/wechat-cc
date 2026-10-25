/**
 * 定时任务的一轮(从 tick-bodies.ts 原样搬出;spec 2026-10-20-scheduled-jobs-design):独立会话 `job:<id>`、只读档、strict,
 * 经 CC 开口那道门(say)开一轮;跑完 forget。
 */
import { JOB_PROFILE, REVIEW_PROFILE } from '../../domain/user-tier'
import { replyTextStrategyFor } from '../../domain/capability-matrix'
import { collectTurn, TURN_TIMEOUT_CODE } from '../../core/agent-provider'
import { isNetworkUnprotectedError } from '../../lib/network-gate'
import type { TickDeps } from './tick-deps'
import type { TickDispatch } from './tick-dispatch'
import { buildJobText, type TickTextStyle } from './tick-texts'
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

/** skipped:quiet / skipped:care_off:SpeechPolicy 的判定(晨报、周报是 initiative —— 赶上免打扰当天记 skipped:quiet,别烦我 ⇒ skipped:care_off)。 */
export type JobTurnResult = 'sent' | 'silent' | 'skipped:executor' | 'skipped:busy' | 'skipped:degraded' | 'skipped:network' | 'skipped:quiet' | 'skipped:care_off' | `failed:${string}`

/** 定时那一轮用谁:装着 claude 就 claude,没有再 codex —— 不跟主人对话的执行者走(真机核对 10-20:对话用 openai 的主人,
 *  定时天天 skipped:executor)。只有这两家的只读档靠得住(Claude 走 profileGate,Codex 走只读沙箱)。 */
export const JOB_PROVIDERS = ['claude', 'codex'] as const
export function pickJobExecutor(has: (id: string) => boolean): (typeof JOB_PROVIDERS)[number] | null {
  return JOB_PROVIDERS.find(id => { try { return has(id) } catch { return false } }) ?? null
}
/** 定时那一轮最多跑多久(比 runner 的 5 分钟兜底短):不说话超过它 ⇒ turn_timeout;一直在说也到点就 cancel。 */
export const JOB_TURN_MAX_MS = 4 * 60_000

export function makeRunJobTurn(deps: TickDeps, dispatch: TickDispatch) {
  const { resolveDispatch } = dispatch

  async function runJobTurn(args: { chatId: string; jobId: string; text: string; nowIso: string; buildText?: (style: TickTextStyle) => string; /** 交付之前改一下模型写好的最后那段(早报接上要主人拍板的候选,§4.8);NO_REPLY 由调用方自己判。 */ transformFinal?: (finalText: string) => string; /** 主人点名哪家(换一家来审,10-20);只认 JOB_PROVIDERS,没装 ⇒ skipped:executor,不换人。 */ provider?: (typeof JOB_PROVIDERS)[number]; /** 'review' ⇒ REVIEW_PROFILE(不给网,评审 #460);缺省 JOB_PROFILE */ profile?: 'job' | 'review'; /** 这是哪一种话(SpeechPolicy)—— **必填,没有缺省**:缺省往放行的方向兜底,忘了传就悄悄成了「主人要的」(整合者评审 #524)。主人建的定时 = job、换一家来审 = review(都是 requested);晨报 = brief、周报 = recap(initiative)。 */ kind: 'job' | 'review' | 'brief' | 'recap'; /** 定时触发的(赶上免打扰的 initiative 当天记 skipped:quiet,不往后推);换一家来审不是。 */ scheduled: boolean }): Promise<JobTurnResult> {
    const { chatId, jobId } = args
    const gate = resolveDispatch(chatId)
    if (gate.blocked === 'wechat_degraded') return 'skipped:degraded'
    // provider_denied 不挡这里:定时自己挑执行者(JOB_PROVIDERS)、用 JOB_PROFILE,不用这个对话的 mode provider。
    const { proj } = gate
    const registry = deps.boot.registry as { has?: (id: string) => boolean }
    const providerId = args.provider ? ((JOB_PROVIDERS as readonly string[]).includes(args.provider) && (registry.has?.(args.provider) ?? false) ? args.provider : null) : pickJobExecutor(id => registry.has?.(id) ?? false)
    if (!providerId) return 'skipped:executor'
    if (gate.blocked === 'session_in_flight') return 'skipped:busy'
    // 能不能开口交给 SpeechPolicy(第三批 3a):主人建的定时是 requested(免打扰 / 别烦我照发);晨报、周报是
    // initiative(内容是 CC 挑的)⇒ 别烦我不发、赶上免打扰当天记 skipped:quiet(运行器只有 10 分钟窗口,不往后推)。
    // 模型这一轮放在 say 的生产者里:被拒的那一拍一个 token 都不花。这一轮的出口就是 say 开的那一轮。
    if (!deps.speech) { deps.log('JOBS', `job ${jobId} not run: speech policy not wired`); return 'failed:speech_not_wired' }
    const speech = deps.speech
    const key = { alias: `job:${jobId}`, providerId, chatId }
    const sm = deps.boot.sessionManager as typeof deps.boot.sessionManager & { forget?: (k: typeof key) => Promise<void> }
    let result: JobTurnResult = 'failed:error'
    try {
      const nowMs = Date.parse(args.nowIso)
      const said = await speech.say({ kind: args.kind, chatId, scheduled: args.scheduled, ...(Number.isFinite(nowMs) ? { nowMs } : {}) }, async (outbound) => {
      // 回复交付按 chatId 记账 ⇒ 与主人的对话串行,不然两轮的回复会混在一起。
      await deps.boot.coordinator.runExclusive(chatId, async () => {
        // 先忘一次:上次若崩在半路(没走到 finally),留下的续接记录会让这次接着上次的对话(终审 minor)。
        try { await sm.forget?.(key) } catch { /* 没有就没有 */ }
        const handle = await deps.boot.sessionManager.acquire({ alias: key.alias, path: proj.path, providerId, chatId, tierProfile: args.profile === 'review' ? REVIEW_PROFILE : JOB_PROFILE, permissionMode: 'strict' })
        const style: TickTextStyle = { allSegments: replyTextStrategyFor(providerId) === 'all_segments' }
        // 早报(对标 #7)自己拼好信封(素材 + 写法);其余定时用主人的原话包一层。
        const text = args.buildText ? args.buildText(style) : buildJobText({ jobId, nowIso: args.nowIso, text: args.text }, style)
        const turn = deps.replyDelivery.begin(chatId, { context: 'tick', providerId, textStrategy: replyTextStrategyFor(providerId), outbound })
        // 到点就 cancel(终审 I3):不然一轮卡住就一直占着主人那条对话的锁,晚到的回复还会照发。
        const deadline = setTimeout(() => { void handle.cancel?.().catch(() => {}) }, JOB_TURN_MAX_MS)
        ;(deadline as { unref?: () => void }).unref?.()
        try {
          const summary = await collectTurn(handle.dispatch(text), { timeoutMs: JOB_TURN_MAX_MS })
          if (summary.error) {
            if (summary.errorCode === TURN_TIMEOUT_CODE) { try { await handle.cancel?.() } catch { /* 已经停了 */ } }
            turn.abandon(summary.errorCode ?? 'error')
            result = `failed:${summary.errorCode ?? 'error'}`
            return
          }
          const raw = summary.finalText ?? ''
          let finalText = raw
          if (args.transformFinal) { try { finalText = args.transformFinal(raw) } catch (e) { deps.log('JOBS', `job ${jobId} transformFinal threw: ${errMsg(e)}`) } }
          const report = await turn.deliver({ finalText, narration: summary.narration ?? [] })
          outbound.finish()
          if (report.delivery === 'silent' || report.delivery === 'empty') result = report.failures.length ? `failed:${report.failures[0]}` : 'silent'
          else result = report.failures.length && report.bubbles === 0 && report.attachmentsSent === 0 ? `failed:${report.failures[0]}` : 'sent'
        } catch (err) {
          turn.abandon('threw')
          throw err
        } finally {
          clearTimeout(deadline)
        }
      })
      })
      if ('drop' in said) result = said.reason === 'skipped:quiet' ? 'skipped:quiet' : said.reason === 'care_off' ? 'skipped:care_off' : `failed:${said.reason}`
      else if ('defer' in said) result = said.reason === 'undeliverable' ? 'skipped:degraded' : `failed:${said.reason}`
    } catch (err) {
      result = isNetworkUnprotectedError(err) ? 'skipped:network' : `failed:${errMsg(err).slice(0, 60)}`
    } finally {
      try { await sm.forget?.(key) } catch (e) { deps.log('JOBS', `forget ${key.alias} failed: ${errMsg(e)}`) }
    }
    deps.log('JOBS', `job ${jobId} → ${result}`)
    return result
  }

  return runJobTurn
}
