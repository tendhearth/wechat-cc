import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isProactiveWindowClosed } from './ilink/outbound-health'
import { readJsonFile } from '../lib/read-json-file'
import type { PreviousRunEvidence } from '../lib/restart-markers'

/**
 * 启动通知:daemon 每次开机决定要不要在微信里说一句话。
 *
 * 规矩(2026-10-04 主人反馈后重定,见 lib/restart-markers.ts 的说明):
 *
 *   - **计划内的重启永远不说话。** self deploy / 回滚、daemon 自己重启(空闲
 *     加载新代码、换后端…)、App 自动更新、CLI 升级、运维命令 —— 都是有人
 *     故意做的,微信里再播一次只是噪声。判据是证据(planned / clean-shutdown
 *     纸条),不是理由白名单。
 *   - **意外重启只说一次、说人话**:「CC 刚才意外重启了一次(大约 3 分钟没在线),
 *     现在已经恢复。」不带 pid / accounts / unattended —— 技术细节留在日志和桌面。
 *     而且只在「主人会感觉到」时说:停机超过阈值,或者短时间里反复意外重启。
 *   - **不补发。** 短窗口(约 90 秒)内发不出去就放弃、只记日志。以前存成
 *     pending-notify.json 等主人下次说话再补,结果读起来像「我一说话它就重启」。
 *   - **限频**:两条重启通知之间至少隔 N 小时。
 *
 * 第一次开机(装好后的第一次)仍然发一句温暖的问候,那是「初次见面」,不是重启通知。
 */

const FILE = 'last-startup.json'
/** 上一次真的发出去的启动类通知({ ts })。兼作「装好后打过招呼了」的标记与限频依据。 */
const NOTIFIED_MARKER_FILE = 'startup-notified.json'
/** 意外重启的时间戳流水(只留最近 24h),用来认出「反复意外重启」。 */
const UNPLANNED_HISTORY_FILE = 'unplanned-restarts.json'
/** 老版本的「补发」队列。新规矩不补发,开机见到就删。 */
const LEGACY_PENDING_FILE = 'pending-notify.json'

export const WARM_FIRST_STARTUP_TEXT = '我上线啦 👋 直接跟我说话就行;想看我能干嘛,发 /help。'

export interface RestartNoticeSettings {
  /** false ⇒ 意外重启也不说(首次问候不受影响)。 */
  enabled: boolean
  /** 停机至少这么久才值得告诉主人(ms)。 */
  minDowntimeMs: number
  /** 两条重启通知之间的最短间隔(ms)。 */
  minIntervalMs: number
  /** 窗口内意外重启达到这么多次 ⇒ 不管单次停机多短都说一次。 */
  crashLoopCount: number
  crashLoopWindowMs: number
}

export const DEFAULT_RESTART_NOTICE: RestartNoticeSettings = {
  enabled: true,
  minDowntimeMs: 2 * 60_000,
  minIntervalMs: 6 * 3600_000,
  crashLoopCount: 3,
  crashLoopWindowMs: 3600_000,
}

/** agent-config.json 的 `restart_notice` 块 → 设置。坏值落回缺省。 */
export function resolveRestartNoticeSettings(raw?: { enabled?: boolean; min_downtime_s?: number; min_interval_h?: number } | null): RestartNoticeSettings {
  const s = { ...DEFAULT_RESTART_NOTICE }
  if (!raw) return s
  if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled
  if (typeof raw.min_downtime_s === 'number' && Number.isFinite(raw.min_downtime_s) && raw.min_downtime_s >= 0) s.minDowntimeMs = raw.min_downtime_s * 1000
  if (typeof raw.min_interval_h === 'number' && Number.isFinite(raw.min_interval_h) && raw.min_interval_h >= 0) s.minIntervalMs = raw.min_interval_h * 3600_000
  return s
}

export type RestartClass =
  | { kind: 'first-boot' }
  | { kind: 'planned'; reason: string }
  | { kind: 'unplanned'; downtimeMs: number | null }

/** 纯函数:上一个进程是怎么没的。 */
export function classifyRestart(input: { prevStartTs: number | null; evidence: PreviousRunEvidence; now: number }): RestartClass {
  const { prevStartTs, evidence, now } = input
  if (prevStartTs === null) return { kind: 'first-boot' }
  if (evidence.planned) return { kind: 'planned', reason: evidence.planned.reason }
  // 优雅退出纸条必须是上一个进程写的(它开机之后),不是更早某次留下的。
  if (evidence.cleanShutdown && evidence.cleanShutdown.ts >= prevStartTs) {
    return { kind: 'planned', reason: `shutdown:${evidence.cleanShutdown.cause}` }
  }
  const downtimeMs = evidence.lastHeartbeatAt !== null ? Math.max(0, now - evidence.lastHeartbeatAt) : null
  return { kind: 'unplanned', downtimeMs }
}

export function describeDowntime(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${Math.max(1, s)} 秒`
  const m = Math.round(ms / 60_000)
  if (m < 90) return `${m} 分钟`
  return `${(ms / 3600_000).toFixed(1)} 小时`
}

/** 给主人看的那一句。只有人话,没有 pid / accounts / 模式。 */
export function renderUnplannedRestartText(input: { downtimeMs: number | null; recentCount: number; crashLoop: boolean }): string {
  if (input.crashLoop) {
    return `CC 这一小时里意外重启了 ${input.recentCount} 次,现在已经恢复。要是还反复出现,桌面 app 里能看到原因。`
  }
  const gone = input.downtimeMs !== null ? `(大约 ${describeDowntime(input.downtimeMs)}没在线)` : ''
  return `CC 刚才意外重启了一次${gone},现在已经恢复。`
}

export interface StartupContext {
  pid: number
}

export interface StartupNotifyDeps {
  stateDir: string
  loadAccess: () => { allowFrom: string[]; admins?: string[] }
  send: (chatId: string, text: string) => Promise<unknown>
  log: (tag: string, line: string) => void
  /** 开机最早时 consumePreviousRunEvidence 的结果。缺省 ⇒ 当作没有任何证据。 */
  evidence?: PreviousRunEvidence
  settings?: RestartNoticeSettings
  now?: () => number
  /** 发送窗口里重试的基准间隔(缺省 15s ⇒ 15/30/45s,约 90s 后放弃)。测试传 0/1。 */
  retryDelayMs?: number
}

export type StartupNotifySkip =
  | 'planned-restart'
  | 'quick-recovery'
  | 'rate-limited'
  | 'disabled'
  | 'no-recipients'
  | 'send-failed-all'

export interface StartupNotifyResult {
  notified: boolean
  kind: RestartClass['kind']
  reason?: StartupNotifySkip
  recipients: string[]
  /** 意外重启时估出来的停机时长;其它情况 null。 */
  downtimeMs: number | null
}

function readTs(path: string): number | null {
  try {
    const ts = readJsonFile<{ ts?: unknown }>(path).ts
    return typeof ts === 'number' && Number.isFinite(ts) ? ts : null
  } catch { return null }
}

function recordUnplanned(stateDir: string, now: number, windowMs: number): number {
  const path = join(stateDir, UNPLANNED_HISTORY_FILE)
  let list: number[] = []
  try {
    const raw = readJsonFile<{ ts?: unknown }>(path)
    if (Array.isArray(raw.ts)) list = raw.ts.filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
  } catch { /* 第一次或坏了 */ }
  list = list.filter(t => now - t >= 0 && now - t <= 24 * 3600_000)
  list.push(now)
  try { writeFileSync(path, JSON.stringify({ ts: list.slice(-50) }) + '\n', { mode: 0o600 }) } catch { /* best effort */ }
  return list.filter(t => now - t <= windowMs).length
}

export async function notifyStartup(deps: StartupNotifyDeps, ctx: StartupContext): Promise<StartupNotifyResult> {
  const now = deps.now ? deps.now() : Date.now()
  const settings = deps.settings ?? DEFAULT_RESTART_NOTICE
  const evidence: PreviousRunEvidence = deps.evidence ?? { planned: null, cleanShutdown: null, lastHeartbeatAt: null }
  const lastFile = join(deps.stateDir, FILE)
  const notifiedMarkerPath = join(deps.stateDir, NOTIFIED_MARKER_FILE)

  const prevStartTs = readTs(lastFile)
  try {
    mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(lastFile, JSON.stringify({ ts: now, pid: ctx.pid }) + '\n', { mode: 0o600 })
  } catch (err) {
    deps.log('NOTIFY', `failed to write ${FILE}: ${err instanceof Error ? err.message : String(err)}`)
  }
  // 老版本留下的「补发」队列:新规矩不补发,见到就删(只记一行)。
  if (existsSync(join(deps.stateDir, LEGACY_PENDING_FILE))) {
    rmSync(join(deps.stateDir, LEGACY_PENDING_FILE), { force: true })
    deps.log('NOTIFY', 'dropped legacy pending-notify.json (restart notices are never re-sent later)')
  }

  const alreadyGreeted = existsSync(notifiedMarkerPath)
  // 真正的第一次:之前既没开过机、也没打过招呼。升级上来的老安装有 last-startup.json,不算。
  const cls: RestartClass = prevStartTs === null && !alreadyGreeted
    ? { kind: 'first-boot' }
    : classifyRestart({ prevStartTs: prevStartTs ?? 0, evidence, now })
  const base = { kind: cls.kind, downtimeMs: cls.kind === 'unplanned' ? cls.downtimeMs : null }

  let text: string
  if (cls.kind === 'first-boot') {
    text = WARM_FIRST_STARTUP_TEXT
  } else if (cls.kind === 'planned') {
    deps.log('NOTIFY', `skip startup notify: planned restart (${cls.reason})`)
    return { ...base, notified: false, reason: 'planned-restart', recipients: [] }
  } else {
    const recentCount = recordUnplanned(deps.stateDir, now, settings.crashLoopWindowMs)
    const crashLoop = recentCount >= settings.crashLoopCount
    const dt = cls.downtimeMs
    deps.log('NOTIFY', `unplanned restart detected: downtime=${dt === null ? 'unknown' : `${Math.round(dt / 1000)}s`} recent=${recentCount}/${Math.round(settings.crashLoopWindowMs / 60_000)}min pid=${ctx.pid}`)
    if (!settings.enabled) {
      deps.log('NOTIFY', 'skip startup notify: restart_notice disabled')
      return { ...base, notified: false, reason: 'disabled', recipients: [] }
    }
    if (!crashLoop && (dt === null || dt < settings.minDowntimeMs)) {
      deps.log('NOTIFY', `skip startup notify: recovered quickly (< ${Math.round(settings.minDowntimeMs / 1000)}s) — owner unaffected`)
      return { ...base, notified: false, reason: 'quick-recovery', recipients: [] }
    }
    const lastNotice = readTs(notifiedMarkerPath)
    if (lastNotice !== null && now - lastNotice >= 0 && now - lastNotice < settings.minIntervalMs) {
      deps.log('NOTIFY', `skip startup notify: rate-limited (last notice ${Math.round((now - lastNotice) / 60_000)}min ago)`)
      return { ...base, notified: false, reason: 'rate-limited', recipients: [] }
    }
    text = renderUnplannedRestartText({ downtimeMs: dt, recentCount, crashLoop })
  }

  const access = deps.loadAccess()
  const recipients = (access.admins?.length ? access.admins : access.allowFrom).slice()
  if (recipients.length === 0) {
    deps.log('NOTIFY', 'skip startup notify: access has no admins/allowFrom — bind owner first')
    return { ...base, notified: false, reason: 'no-recipients', recipients: [] }
  }

  // ilink-glue 的 sendMessage 不抛错,失败是 resolve 出 `{ error }` —— 两种形状都要认。
  const trySend = async (chatId: string): Promise<boolean> => {
    let msg: string | null = null
    try {
      const res = await deps.send(chatId, text)
      msg = (res as { error?: string } | null | undefined)?.error ?? null
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err)
    }
    if (msg === null) return true
    // errcode=-2 是「通道还没就绪 / 推送票据过期」的预期态,平静地记。
    if (isProactiveWindowClosed(msg)) deps.log('NOTIFY', `to ${chatId} 暂不可推送(通道未就绪/票据待刷新):${msg}`)
    else deps.log('NOTIFY', `send to ${chatId} failed: ${msg}`)
    return false
  }
  // 短窗口:立即 + 15s + 30s + 45s ≈ 90s。开机后 ilink prepare 常要 30-60s 才就绪。
  let okCount = 0
  let pending = recipients.slice()
  for (let round = 0; round < 4 && pending.length > 0; round++) {
    if (round > 0) {
      const delay = (deps.retryDelayMs ?? 15_000) * round
      deps.log('NOTIFY', `channel not ready — retrying ${pending.length} recipient(s) in ${Math.round(delay / 1000)}s`)
      await new Promise(r => setTimeout(r, delay))
    }
    const stillFailing: string[] = []
    for (const chatId of pending) {
      if (await trySend(chatId)) okCount++
      else stillFailing.push(chatId)
    }
    pending = stillFailing
  }
  if (okCount === 0) {
    // 不补发:状态迟到了就不是「刚刚」了。只记日志。
    deps.log('NOTIFY', `startup notice dropped — channel not ready within the send window (${pending.length} recipient(s)); not queued`)
    return { ...base, notified: false, reason: 'send-failed-all', recipients }
  }
  try {
    writeFileSync(notifiedMarkerPath, JSON.stringify({ ts: now }) + '\n', { mode: 0o600 })
  } catch (err) {
    deps.log('NOTIFY', `failed to write ${NOTIFIED_MARKER_FILE}: ${err instanceof Error ? err.message : String(err)}`)
  }
  deps.log('NOTIFY', `startup notify (${cls.kind}) sent to ${okCount}/${recipients.length} recipient(s)`)
  return { ...base, notified: true, recipients }
}
