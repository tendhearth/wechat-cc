import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
  reason?: 'too-soon' | 'no-recipients' | 'send-failed-all'
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
    prevTs = JSON.parse(readFileSync(lastFile, 'utf8')).ts ?? null
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
        deps.log('NOTIFY', `send to ${chatId} failed: ${err}`)
        return false
      }
      return true
    } catch (err) {
      deps.log('NOTIFY', `send to ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`)
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

export function renderStartupText(ctx: StartupContext, sinceLastMs: number | null): string {
  const mode = ctx.dangerously ? '✅ unattended' : '⚠️ strict (工具调用会 hang)'
  if (sinceLastMs == null) {
    return `🤖 wechat-cc daemon 已启动\npid=${ctx.pid} accounts=${ctx.accounts} ${mode}`
  }
  const m = Math.round(sinceLastMs / 60_000)
  const ago = m < 60 ? `${m} 分钟前` : `${(m / 60).toFixed(1)} 小时前`
  return `🔄 wechat-cc daemon 已重启\npid=${ctx.pid} accounts=${ctx.accounts} 上次启动 ${ago} ${mode}`
}
