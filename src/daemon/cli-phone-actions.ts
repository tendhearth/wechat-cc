/**
 * cli-phone-actions.ts — 手机上对终端会话做的两件事(2026-10-14):拍板等批准的那一项、接着说一句。
 *
 * 不另起一套:拍板走微信「y/n 码」同一条路(ilink 的 PendingPermissions,consume 之后中继
 * 自己 settle、登记处自己回 running);说一句走微信「@码」同一个 makeCliReplyCore(同样的
 * 网络闸门、工作台冲突、busy 登记、10 分钟上限)。结果不回推,而是成为这条会话的下一句
 * last_summary(core 自己记 running → idle)。
 */
import type { CliSessionInfo } from '../core/cli-events'
import type { CliSessionView } from '../core/cli-session-store'
import type { CliReplyCore } from './cli-reply-handler'

/** 手机上说一句最多这么长(终端那头是一句 prompt,不是贴文件)。 */
export const PHONE_CLI_SAY_MAX = 4000

export type CliPhonePermissionResult = { ok: true } | { ok: false; error: 'not_found' | 'cli_not_actionable' | 'cli_permission_stale' }
export type CliPhoneSayResult = { ok: true } | { ok: false; error: 'not_found' | 'cli_session_busy' | 'cli_session_ended' | 'cli_session_remote' }

export interface CliPhoneActions {
  /** 这条会话挂着的、手机能拍的码(中继开出去的那个);没有 ⇒ null。 */
  pendingHash(sessionId: string): string | null
  permission(target: { hash?: string; session_id?: string }, decision: 'allow' | 'deny'): CliPhonePermissionResult
  say(sessionId: string, text: string): CliPhoneSayResult
}

export interface CliPhoneActionsDeps {
  hub: { lookup(code: string): CliSessionInfo | null; list(opts?: { includeEnded?: boolean; limit?: number }): CliSessionView[] }
  relay: { pendingHash(sessionId: string): string | null; owns(hash: string): boolean }
  /** = ilink.resolvePermission(微信「y/n 码」、桌宠权限卡用的同一个)。 */
  resolve(hash: string, decision: 'allow' | 'deny'): boolean
  core: Pick<CliReplyCore, 'resume'>
  localMachine?: string
  log: (tag: string, line: string) => void
}

export function makeCliPhoneActions(deps: CliPhoneActionsDeps): CliPhoneActions {
  const view = (sessionId: string): CliSessionView | null =>
    deps.hub.list({ includeEnded: true }).find(v => v.session_id === sessionId) ?? null

  return {
    pendingHash: (sessionId) => deps.relay.pendingHash(sessionId),
    permission(target, decision) {
      const hash = target.hash ?? (target.session_id ? deps.relay.pendingHash(target.session_id) : null)
      if (!hash) {
        // 会话在等批准、可这台 daemon 没开码(主人在场,终端自己问;或转给了脑)⇒ 手机拍不了。
        const v = target.session_id ? view(target.session_id) : null
        return { ok: false, error: v?.status === 'waiting' ? 'cli_not_actionable' : 'not_found' }
      }
      // 只认终端中继开的码:手机这一口不能顺手批掉自改流水线 / 工作台的待批。
      if (!deps.relay.owns(hash)) return { ok: false, error: 'cli_permission_stale' }
      if (target.session_id && deps.relay.pendingHash(target.session_id) !== hash) return { ok: false, error: 'cli_permission_stale' }
      if (!deps.resolve(hash, decision)) return { ok: false, error: 'cli_permission_stale' }
      deps.log('CLI_PERMISSION', `${decision} from phone hash=${hash}`)
      return { ok: true }
    },
    say(sessionId, text) {
      const v = view(sessionId)
      if (!v) return { ok: false, error: 'not_found' }
      if (v.status === 'ended') return { ok: false, error: 'cli_session_ended' }
      // 在跑或在等批准:终端那头这一轮还没完,再起一个 resume 会和它抢同一条会话。
      if (v.status === 'running' || v.status === 'waiting') return { ok: false, error: 'cli_session_busy' }
      // 30 分钟没事件被折算成 idle 的(stale):可能只是一步长构建 / 长工具调用还在跑,
      // 这时 resume 会和终端那一轮抢同一条会话 —— 宁可拒(评审 10-15 #2)。
      if (v.stale) return { ok: false, error: 'cli_session_busy' }
      const s = deps.hub.lookup(sessionId)
      if (!s || s.session_id !== sessionId) return { ok: false, error: 'not_found' }
      // 那边(别的机器)的会话:微信「@码」转给那只手,结果回微信;手机这一口 v1 不转。
      if (s.origin_agent || (s.machine && deps.localMachine && s.machine !== deps.localMachine)) return { ok: false, error: 'cli_session_remote' }
      deps.log('CLI_REPLY', `phone say → ${s.source}/${sessionId.slice(0, 6)}`)
      void deps.core.resume(s, text).catch(err => deps.log('CLI_REPLY', `phone resume failed: ${err instanceof Error ? err.message : String(err)}`))
      return { ok: true }
    },
  }
}
