import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isProactiveWindowClosed } from './ilink/outbound-health'
import { readJsonFile } from '../lib/read-json-file'

const FILE = 'last-startup.json'
const NOTIFIED_MARKER_FILE = 'startup-notified.json'

// First-ever startup notice: a warm, human hello instead of the technical
// pid/accounts line — the owner hasn't met the bot yet. Every later restart
// keeps the technical copy (owner is technical; restart info has ops value).
export const WARM_FIRST_STARTUP_TEXT = '我上线啦 👋 直接跟我说话就行;想看我能干嘛,发 /help。'

// Floor on rapid restarts: KeepAlive=true means a crashing daemon will
// re-launch within seconds. Don't notify the owner each loop — only the
// first time and any future "real" restart (≥ this many ms since last).
const RESTART_FLOOR_MS = 60_000

/** 计划内重启的面包屑 —— 关机侧写,下次开机侧读一次就删。 */
export const PLANNED_RESTART_FILE = 'planned-restart.json'

/**
 * 只有这一种重启对主人是「无事发生」:daemon 空闲时发现 git HEAD 动了,
 * 自己重启去加载新代码(self-restart-stale-code)。**是主人自己 commit
 * 触发的**,微信里再播报一次纯属噪声 —— dogfood 的日子里一天能撞好几回,
 * 而且因为推送票据常常过期,它会攒成 pending-notify,在主人下次说话之后
 * 才补发:读起来就像「我一说话它就重启了」(真机 2026-09-08)。
 *
 * 其余每一种都照旧通知:崩溃后 KeepAlive 拉起(根本没有面包屑)、
 * 操作员 POST /v1/daemon/restart(是主人主动要的,回一句「我回来了」有用)。
 */
const SILENT_RESTART_REASONS: ReadonlySet<string> = new Set(['self-restart-stale-code'])

/** 面包屑的有效期。正常路径是「写完 500ms 后退出、KeepAlive 秒级拉起」,
 *  所以几分钟足够宽松。设上限是为了:万一某次开机在 notifyStartup 之前
 *  就崩了、面包屑没被吃掉,它也不会一直静默后面真正的意外重启。 */
const PLANNED_RESTART_TTL_MS = 5 * 60_000

/** 关机侧调用(main.ts requestRestart):留下「这次是计划内的」。
 *  best-effort —— 写不成最多是多发一条通知,不能因此挡住重启。 */
export function markPlannedRestart(stateDir: string, reason: string): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDir, PLANNED_RESTART_FILE), JSON.stringify({ reason, ts: Date.now() }) + '\n', { mode: 0o600 })
  } catch { /* best effort */ }
}

/** 开机侧:读一次并**总是**删掉,返回是否该静默这次启动通知。 */
function consumePlannedRestart(stateDir: string, now: number): { silent: boolean; reason?: string } {
  const path = join(stateDir, PLANNED_RESTART_FILE)
  if (!existsSync(path)) return { silent: false }
  let parsed: { reason?: string; ts?: number } = {}
  try { parsed = readJsonFile<{ reason?: string; ts?: number }>(path) } catch { /* 坏了就当没有 */ }
  rmSync(path, { force: true })
  const fresh = typeof parsed.ts === 'number' && now - parsed.ts >= 0 && now - parsed.ts <= PLANNED_RESTART_TTL_MS
  const silent = fresh && typeof parsed.reason === 'string' && SILENT_RESTART_REASONS.has(parsed.reason)
  return { silent, reason: parsed.reason }
}

export interface StartupContext {
  pid: number
  accounts: number
  dangerously: boolean
}

export interface StartupNotifyDeps {
  stateDir: string
  loadAccess: () => { allowFrom: string[]; admins?: string[] }
  send: (chatId: string, text: string) => Promise<unknown>
  log: (tag: string, line: string) => void
  now?: () => number
  /** Delay before the one not-ready retry (default 15s; tests pass 1). */
  retryDelayMs?: number
}

export interface StartupNotifyResult {
  notified: boolean
  reason?: 'too-soon' | 'no-recipients' | 'send-failed-all' | 'planned-restart'
  recipients: string[]
  sinceLastMs: number | null
}

export async function notifyStartup(
  deps: StartupNotifyDeps,
  ctx: StartupContext
): Promise<StartupNotifyResult> {
  const now = deps.now ? deps.now() : Date.now()
  const lastFile = join(deps.stateDir, FILE)

  let prevTs: number | null = null
  try {
    prevTs = readJsonFile<{ ts?: number }>(lastFile).ts ?? null
  } catch {
    // First run or corrupt — treat as no prior startup.
  }

  // Always persist current startup so the next restart can compare.
  try {
    mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(lastFile, JSON.stringify({ ts: now, pid: ctx.pid }) + '\n', { mode: 0o600 })
  } catch (err) {
    deps.log('NOTIFY', `failed to write ${FILE}: ${err instanceof Error ? err.message : String(err)}`)
  }

  const sinceLast = prevTs == null ? null : now - prevTs

  if (sinceLast !== null && sinceLast < RESTART_FLOOR_MS) {
    deps.log('NOTIFY', `skip startup notify: restarted ${(sinceLast / 1000).toFixed(1)}s after previous (within ${RESTART_FLOOR_MS / 1000}s floor — likely KeepAlive crash-loop)`)
    return { notified: false, reason: 'too-soon', recipients: [], sinceLastMs: sinceLast }
  }

  // 计划内自愈重启:面包屑总要消费(读完即删),但只有它才让这次启动闭嘴。
  const planned = consumePlannedRestart(deps.stateDir, now)
  if (planned.silent) {
    deps.log('NOTIFY', `skip startup notify: planned restart (${planned.reason}) — 主人自己 commit 触发的,不用播报`)
    return { notified: false, reason: 'planned-restart', recipients: [], sinceLastMs: sinceLast }
  }

  const access = deps.loadAccess()
  const recipients = (access.admins?.length ? access.admins : access.allowFrom).slice()
  if (recipients.length === 0) {
    deps.log('NOTIFY', `skip startup notify: access has no admins/allowFrom — bind owner first`)
    return { notified: false, reason: 'no-recipients', recipients: [], sinceLastMs: sinceLast }
  }

  const notifiedMarkerPath = join(deps.stateDir, NOTIFIED_MARKER_FILE)
  const alreadyNotified = existsSync(notifiedMarkerPath)
  // `prevTs !== null` means last-startup.json existed BEFORE this call (read
  // above, prior to this boot's overwrite) — i.e. the daemon has
  // demonstrably started before, even if the marker file itself is missing
  // (an existing install upgrading onto this feature for the first time:
  // notify-startup.ts didn't write startup-notified.json in any earlier
  // version). Without this check, every existing install's first restart
  // after upgrading would wrongly get the "初次见面" warm hello — AND that
  // boot's technical pid/accounts/mode line (which has real ops value for a
  // technical owner) would be swallowed. Only a truly fresh state dir (no
  // prior last-startup.json AND no marker) is first-ever.
  const isFirstEverNotify = !alreadyNotified && prevTs === null

  const text = isFirstEverNotify ? WARM_FIRST_STARTUP_TEXT : renderStartupText(ctx, sinceLast)
  // ilink-glue's sendMessage NEVER throws — failures come back as a resolved
  // `{ error }` (see ilink-glue.ts). The old try/catch-only accounting
  // counted every one of those as delivered ("sent to 1/1") while the boot
  // log right above it said RETRY_FAIL. Check the resolved shape too, and
  // give the channel one patient retry: at boot the WeChat session isn't
  // prepared yet (errcode=-2), and the transport's own 3×1s retries are all
  // spent before it comes up.
  const trySend = async (chatId: string): Promise<boolean> => {
    try {
      const res = await deps.send(chatId, text)
      const err = (res as { error?: string } | null | undefined)?.error
      if (err) {
        // errcode=-2「prepare failed」是预期态,不是链路坏了:要么通道刚
        // 重启还没就绪(下一轮重试就好),要么推送票据过期(下面会转存
        // pending,用户一说话就补发)。用平静措辞记,别在日志里喊「failed」
        // 让技术主人误以为出事(循环巡检里这条曾累计上百条噪声)。
        if (isProactiveWindowClosed(err)) deps.log('NOTIFY', `to ${chatId} 暂不可推送(通道未就绪/票据待刷新):${err}`)
        else deps.log('NOTIFY', `send to ${chatId} failed: ${err}`)
        return false
      }
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isProactiveWindowClosed(msg)) deps.log('NOTIFY', `to ${chatId} 暂不可推送(通道未就绪/票据待刷新):${msg}`)
      else deps.log('NOTIFY', `send to ${chatId} failed: ${msg}`)
      return false
    }
  }
  let okCount = 0
  let pending = recipients.slice()
  // 4 rounds, 15s→30s→60s backoff (2026-08-26 循环巡检发现:自愈重启后
  // ilink prepare 常要 30-60s 才 ready,旧的 2 轮×15s 两枪都落在就绪前,
  // 恢复通知每次自愈重启都丢 —— 日志里连续三次 send-failed-all)。
  for (let round = 0; round < 4 && pending.length > 0; round++) {
    if (round > 0) {
      const delay = (deps.retryDelayMs ?? 15_000) * Math.pow(2, round - 1)
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
    // 微信 ilink 约束(2026-08-26 巡检定案):bot 主动推送需要近期用户
    // 交互票据,票据过期时 prepare 必败、重试无用 —— 用户一说话票据
    // 即刷新。把通知存为待发,inbound 侧(side-effects flushPendingNotify)
    // 在用户下条消息后补发。
    try {
      writeFileSync(join(deps.stateDir, 'pending-notify.json'), JSON.stringify({ text, recipients: pending, ts: now }) + '\n', { mode: 0o600 })
      deps.log('NOTIFY', `queued for next inbound (ticket likely expired) — ${pending.length} recipient(s)`)
    } catch { /* best effort */ }
    return { notified: false, reason: 'send-failed-all', recipients, sinceLastMs: sinceLast }
  }
  // Backfill the marker on the upgrade path too (alreadyNotified=false,
  // isFirstEverNotify=false because prevTs!==null) — not just on the
  // genuinely-first-ever path — so this boot's technical send is recorded
  // and no LATER boot can mistake this install for fresh.
  if (!alreadyNotified) {
    try {
      writeFileSync(notifiedMarkerPath, JSON.stringify({ ts: now }) + '\n', { mode: 0o600 })
    } catch (err) {
      deps.log('NOTIFY', `failed to write ${NOTIFIED_MARKER_FILE}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  deps.log('NOTIFY', `startup notify sent to ${okCount}/${recipients.length} recipient(s)`)
  return { notified: true, recipients, sinceLastMs: sinceLast }
}

/**
 * 补发时给正文加一句「这是补发的」。
 *
 * WHY(真机 2026-09-08):启动通知发不出去时会存进 pending-notify.json,
 * 等主人下次说话、ilink 票据刷新了再补发(见上面 send-failed-all 分支)。
 * 但正文写的是「🔄 已重启 …… 上次启动 9 分钟前」—— 主人在自己发完一句话
 * 之后收到它,读起来就是「我一说话它就重启了」。实测那次重启发生在 56
 * 分钟前,和这条消息毫无因果。
 *
 * 状态可以迟到,但不能假装是刚发生的 —— 补发时把真实时差说出来。
 * 5 分钟以内不加(pending 最快也要重试 ~105s 才落盘,这个区间里「刚重启」
 * 本来就是真话,加了反而啰嗦)。
 */
export const LATE_NOTIFY_FLOOR_MS = 5 * 60_000

export function lateNotifyText(text: string, ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < LATE_NOTIFY_FLOOR_MS) return text
  const m = Math.round(ageMs / 60_000)
  const ago = m < 60 ? `${m} 分钟前` : `${(m / 60).toFixed(1)} 小时前`
  return `${text}\n(这条是补发的:事情发生在${ago},当时推送通道没打开,你一说话才发得出来 —— 跟你刚才这句没关系。)`
}

export function renderStartupText(ctx: StartupContext, sinceLastMs: number | null): string {
  const mode = ctx.dangerously ? '✅ unattended' : '⚠️ strict (工具调用会 hang)'
  if (sinceLastMs == null) {
    return `🤖 wechat-cc daemon 已启动\npid=${ctx.pid} accounts=${ctx.accounts} ${mode}`
  }
  const m = Math.round(sinceLastMs / 60_000)
  const ago = m < 60 ? `${m} 分钟前` : `${(m / 60).toFixed(1)} 小时前`
  return `🔄 wechat-cc daemon 已重启\npid=${ctx.pid} accounts=${ctx.accounts} 上次启动 ${ago} ${mode}`
}
