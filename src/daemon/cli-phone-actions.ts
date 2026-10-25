/**
 * cli-phone-actions.ts — 手机上对终端会话做的两件事(2026-10-14):拍板等批准的那一项、接着说一句。
 *
 * 不另起一套:拍板走微信「y/n 码」同一条路(ilink 的 PendingPermissions,consume 之后中继
 * 自己 settle、登记处自己回 running);说一句走微信「@码」同一个 makeCliReplyCore(同样的
 * 网络闸门、工作台冲突、busy 登记、10 分钟上限)。结果不回推,而是成为这条会话的下一句
 * last_summary(core 自己记 running → idle)。
 */
import { randomBytes } from 'node:crypto'
import type { CliEventHub, CliSessionInfo } from '../core/cli-events'
import type { CliSessionView } from '../adapters/store/cli-session-store'
import { readTail, type CliReplyCore } from './cli-reply-handler'
import { parseActivity, type CliActivityItem } from '../core/cli-activity'

/** 手机上说一句最多这么长(终端那头是一句 prompt,不是贴文件)。 */
export const PHONE_CLI_SAY_MAX = 4000

export type CliPhonePermissionResult = { ok: true } | { ok: false; error: 'not_found' | 'cli_not_actionable' | 'cli_permission_stale' }
export type CliPhoneActivityResult = { ok: true; items: CliActivityItem[] } | { ok: false; error: 'not_found' | 'cli_session_remote' | 'no_transcript' }
/** 「现在在干什么」只读记录尾巴这么多(一屏 40 步用不了更多;每 4 秒读一次,别读几 MB)。 */
export const PHONE_ACTIVITY_READ_MAX = 256 * 1024
/** 列表里每条在跑的会话只读这么多尾巴(列表 15 秒一拉,一次可能好几条)。 */
export const PHONE_NOW_READ_MAX = 64 * 1024
/** 送进开着的窗口那一句的结果(10-20 真机:手机先说「已送进」,其实 relay 在后台、失败了也没人告诉它)。只记每条会话最近一句。 */
export interface CliPhoneSayState { id: string; state: 'sending' | 'sent' | 'failed'; error?: string; at: number }
/** say_id 只在送进开着的窗口时给(那条路是后台的,要回头看结果);resume 那条路收下就是开跑了。 */
export type CliPhoneSayResult = { ok: true; say_id?: string } | { ok: false; error: 'not_found' | 'cli_session_busy' | 'cli_session_ended' | 'cli_session_remote' }

export interface CliPhoneActions {
  /** 这条会话挂着的、手机能拍的码(中继开出去的那个);没有 ⇒ null。 */
  pendingHash(sessionId: string): string | null
  permission(target: { hash?: string; session_id?: string }, decision: 'allow' | 'deny'): CliPhonePermissionResult
  say(sessionId: string, text: string): CliPhoneSayResult
  /** 这条会话最近一句送进窗口的结果;没有 ⇒ null。 */
  lastSay?(sessionId: string): CliPhoneSayState | null
  /** 最近几步(跑了什么、改了哪、说了什么)—— 从会话记录尾巴读,手机上看着它跑(2026-10-17)。 */
  activity(sessionId: string): CliPhoneActivityResult
  /** 列表一眼(2026-10-17):在跑的会话此刻在做的那一步;读记录尾巴 64KB。读不到 / 没有步骤 ⇒ null。 */
  currentStep(sessionId: string): CliActivityItem | null
  /** 开在电脑窗口里的 Claude 会话 id(2026-10-18);没接 ⇒ 空。 */
  liveWindows(): Set<string>
}

export interface CliPhoneActionsDeps {
  hub: { lookup(code: string): CliSessionInfo | null; list(opts?: { includeEnded?: boolean; limit?: number }): CliSessionView[] } & Partial<Pick<CliEventHub, 'observe'>>
  relay: { pendingHash(sessionId: string): string | null; owns(hash: string): boolean }
  /** = ilink.resolvePermission(微信「y/n 码」、桌宠权限卡用的同一个)。 */
  resolve(hash: string, decision: 'allow' | 'deny'): boolean
  core: Pick<CliReplyCore, 'resume'> & Partial<Pick<CliReplyCore, 'live'>>
  localMachine?: string
  log: (tag: string, line: string) => void
  /** 测试替身;默认读真文件尾巴。 */
  readTail?: (path: string, max: number) => string
  /** 开着窗口的会话 id(claude-live-window.ts liveSessionIds);缺席 ⇒ 空。 */
  liveIds?: () => Set<string>
}

export function makeCliPhoneActions(deps: CliPhoneActionsDeps): CliPhoneActions {
  const lastSays = new Map<string, CliPhoneSayState>()
  const settleSay = (sessionId: string, id: string, next: Omit<CliPhoneSayState, 'id' | 'at'>) => {
    // 同一条会话又说了一句:旧的那句的结果不覆盖新的
    if (lastSays.get(sessionId)?.id === id) lastSays.set(sessionId, { id, at: Date.now(), ...next })
  }
  const view = (sessionId: string): CliSessionView | null =>
    deps.hub.list({ includeEnded: true }).find(v => v.session_id === sessionId) ?? null

  return {
    pendingHash: (sessionId) => deps.relay.pendingHash(sessionId),
    liveWindows() { try { return deps.liveIds?.() ?? new Set() } catch { return new Set() } },
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
      // 开在电脑的窗口里(2026-10-18):话送进那个窗口 —— 在跑也能说(它下一步就读到),
      // 登记处说 ended 也以窗口还开着为准。
      const s0 = deps.hub.lookup(sessionId)
      const local0 = !!s0 && s0.session_id === sessionId && !s0.origin_agent && !(s0.machine && deps.localMachine && s0.machine !== deps.localMachine)
      const w = local0 ? deps.core.live?.(s0!) ?? null : null
      if (w) {
        deps.log('CLI_REPLY', `phone say → live window ${w.name} for ${s0!.source}/${sessionId.slice(0, 6)}`)
        const sayId = randomBytes(6).toString('hex')
        lastSays.set(sessionId, { id: sayId, state: 'sending', at: Date.now() })
        if (lastSays.size > 200) lastSays.delete(lastSays.keys().next().value!)
        // 已经回了「收下」:没送进去(网络闸门 / 超时 / 窗口名失效)不能只进日志 —— 会话歇着就记成这条会话的下一句,
        // 手机列表上看得见(同非窗口那条路的「没跑起来」);在跑 / 在等批准就不记,免得把它说成歇着(评审 10-19 #3)。
        void deps.core.resume(s0!, text).then(r => {
          if (r.kind !== 'failed') { settleSay(sessionId, sayId, { state: 'sent' }); return }
          settleSay(sessionId, sayId, { state: 'failed', error: r.text })
          deps.log('CLI_REPLY', `phone relay failed for ${s0!.source}/${sessionId.slice(0, 6)}: ${r.text}`)
          const now = view(sessionId)
          if (!now || now.status === 'running' || now.status === 'waiting') return
          try { deps.hub.observe?.({ source: s0!.source, session_id: s0!.session_id, cwd: s0!.cwd, ...(s0!.machine ? { machine: s0!.machine } : {}), kind: 'stop', text: `手机上那句没送到:${r.text}` }) } catch { /* 登记处出错只少一行提示 */ }
        }, err => {
          settleSay(sessionId, sayId, { state: 'failed', error: '没送进电脑上开着的窗口' })
          deps.log('CLI_REPLY', `phone relay failed: ${err instanceof Error ? err.message : String(err)}`)
        })
        return { ok: true, say_id: sayId }
      }
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
    lastSay(sessionId) { return lastSays.get(sessionId) ?? null },
    activity(sessionId) {
      const s = deps.hub.lookup(sessionId)
      if (!s || s.session_id !== sessionId) return { ok: false, error: 'not_found' }
      // 那边的会话:记录在那台机器上,这里读不到(微信「看 码」会转过去;手机 v1 不转)。
      if (s.origin_agent || (s.machine && deps.localMachine && s.machine !== deps.localMachine)) return { ok: false, error: 'cli_session_remote' }
      if (!s.transcript_path) return { ok: false, error: 'no_transcript' }
      let jsonl: string
      try { jsonl = (deps.readTail ?? readTail)(s.transcript_path, PHONE_ACTIVITY_READ_MAX) }
      catch { return { ok: false, error: 'no_transcript' } }
      return { ok: true, items: parseActivity(jsonl, s.source) }
    },
    currentStep(sessionId) {
      const s = deps.hub.lookup(sessionId)
      if (!s || s.session_id !== sessionId) return null
      return currentStepOf(s, { localMachine: deps.localMachine, readTail: deps.readTail })
    },
  }
}

/**
 * 这条会话此刻在做的那一步(读记录尾巴 64KB)。手机列表与 CC 的 terminal_sessions(2026-10-24)共用这一份判法。
 * 那边的会话 / 没报记录路径 / 读不到 / 主人刚说完还没动手 ⇒ null。
 */
export function currentStepOf(s: CliSessionInfo, opts: { localMachine?: string | undefined; readTail?: ((path: string, max: number) => string) | undefined } = {}): CliActivityItem | null {
  if (!s.transcript_path) return null
  if (s.origin_agent || (s.machine && opts.localMachine && s.machine !== opts.localMachine)) return null
  try {
    const items = parseActivity((opts.readTail ?? readTail)(s.transcript_path, PHONE_NOW_READ_MAX), s.source, 20)
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if (it.kind === 'you') return null   // 主人刚说完、还没动手
      if (it.kind === 'step') { const { detail: _d, ...rest } = it; return rest }
    }
    return null
  } catch { return null }
}
