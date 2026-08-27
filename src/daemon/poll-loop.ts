/**
 * poll-loop.ts — per-account ilink long-poll loop + inbound message normalization.
 *
 * parseUpdates: pure function, no I/O. Converts raw WeixinMessage items into
 * InboundMsg. Media is emitted as an opaque CDN reference in
 * attachments[].caption — the compose step materializes it via media.ts.
 *
 * startLongPollLoops: runs one getUpdates loop per account. Backoff 2s on
 * transient errors. stop() flips a shared flag and awaits all in-flight loops.
 */

import type { InboundMsg } from '../core/prompt-format'
import type { Account } from './ilink-glue'
import { nextBackoffMs } from './health/backoff'

// ── RawUpdate: subset of ilink WeixinMessage that we care about ─────────────
// Mirrors the real ilink WeixinMessage shape (item_list-based, ms timestamps).

export interface RawMediaItem {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

export interface RawMessageItem {
  type?: number           // 1=text, 2=image, 3=voice, 4=file, 5=video
  msg_id?: string
  create_time_ms?: number
  text_item?: { text?: string }
  voice_item?: { text?: string; media?: RawMediaItem }
  image_item?: { media?: RawMediaItem; aeskey?: string }
  file_item?: { media?: RawMediaItem; file_name?: string }
  video_item?: { media?: RawMediaItem }
  ref_msg?: {
    title?: string
    message_item?: {
      type?: number
      text_item?: { text?: string }
      unsupported_item?: { text?: string }
    }
  }
}

export interface RawUpdate {
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  message_type?: number   // 1=user message, 2=bot message
  message_state?: number  // 0=new, 1=generating, 2=finish
  item_list?: RawMessageItem[]
  context_token?: string
  session_id?: string
}

export interface ParseDeps {
  accountId: string
  resolveUserName: (chatId: string) => string | undefined
}

/** Map an ilink item `type` (1=text … 5=video) to a human label for <quote>. */
function quotedTypeLabel(type?: number): string {
  switch (type) {
    case 1: return 'text'
    case 2: return 'image'
    case 3: return 'voice'
    case 4: return 'file'
    case 5: return 'video'
    default: return 'unknown'
  }
}

/**
 * Parse a raw ilink WeixinMessage list into normalized InboundMsg entries.
 * Pure function — no I/O. Media references are returned un-downloaded; the
 * caller materializes them via src/daemon/media.ts.
 */
export function parseUpdates(
  updates: RawUpdate[],
  deps: ParseDeps,
): InboundMsg[] {
  const results: InboundMsg[] = []

  for (const msg of updates) {
    // Only process user messages (type=1) that are finished (state=2)
    if (msg.message_type !== 1) continue
    if (msg.message_state !== undefined && msg.message_state !== 2) continue

    const fromUserId = msg.from_user_id ?? ''
    if (!fromUserId) continue

    const textParts: string[] = []
    const attachments: InboundMsg['attachments'] = []
    let quote: InboundMsg['quote']

    let msgType = 'unknown'
    for (const item of msg.item_list ?? []) {
      // Capture the first quoted message as structured content. ilink inlines
      // the quoted text in ref_msg (no stable id), richest field first. A
      // degenerate ref_msg with neither a known type nor any text is skipped
      // so we don't emit an empty <quote>.
      if (item.ref_msg && !quote) {
        const ri = item.ref_msg.message_item
        const text = ri?.text_item?.text
          ?? ri?.unsupported_item?.text
          ?? item.ref_msg.title
          ?? ''
        const type = quotedTypeLabel(ri?.type)
        if (text !== '' || type !== 'unknown') {
          quote = { type, text }
        }
      }

      if (item.type === 1) {
        const text = item.text_item?.text
        if (text) {
          if (msgType === 'unknown') msgType = 'text'
          textParts.push(text)
        }
      } else if (item.type === 2) {
        if (!item.image_item?.media && !item.image_item?.aeskey) continue
        if (msgType === 'unknown') msgType = 'image'
        // Image item — emit opaque CDN reference; caller downloads via media.ts
        const media = item.image_item?.media
        attachments.push({
          kind: 'image',
          path: '<pending-cdn-ref>',
          caption: JSON.stringify(media ?? {}),
        })
      } else if (item.type === 3) {
        // Voice item
        if (item.voice_item?.text) {
          if (msgType === 'unknown') msgType = 'voice'
          textParts.push(`[语音] ${item.voice_item.text}`)
        } else if (item.voice_item?.media) {
          if (msgType === 'unknown') msgType = 'voice'
          attachments.push({
            kind: 'voice',
            path: '<pending-cdn-ref>',
            caption: JSON.stringify(item.voice_item.media),
          })
        }
      } else if (item.type === 4) {
        if (!item.file_item?.media && !item.file_item?.file_name) continue
        if (msgType === 'unknown') msgType = 'file'
        // File item
        const media = item.file_item?.media
        const fileName = item.file_item?.file_name ?? 'file.bin'
        attachments.push({
          kind: 'file',
          path: '<pending-cdn-ref>',
          caption: JSON.stringify({ media: media ?? {}, file_name: fileName }),
        })
      } else if (item.type === 5) {
        if (!item.video_item?.media) continue
        if (msgType === 'unknown') msgType = 'video'
        // Video item
        const media = item.video_item?.media
        attachments.push({
          kind: 'file',
          path: '<pending-cdn-ref>',
          caption: JSON.stringify(media ?? {}),
        })
      }
    }

    const rawMsgId = msg.message_id ?? (msg.item_list ?? []).find(i => i.msg_id)?.msg_id
    const firstMsgId = rawMsgId !== undefined && rawMsgId !== null ? String(rawMsgId) : undefined
    const inbound: InboundMsg = {
      chatId: fromUserId,
      userId: fromUserId,
      userName: deps.resolveUserName(fromUserId),
      text: textParts.join('\n') || '(non-text message)',
      msgType,
      createTimeMs: msg.create_time_ms ?? 0,
      accountId: deps.accountId,
      ...(firstMsgId ? { msgId: firstMsgId } : {}),
      ...(quote !== undefined ? { quote } : {}),
      // ilink puts context_token on every inbound message; threading it
      // through to onInbound lets the daemon persist it before replying.
      // See InboundMsg.contextToken docstring for the regression history.
      ...(msg.context_token ? { contextToken: msg.context_token } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    }

    results.push(inbound)
  }

  return results
}

// ── PollLoopOptions ──────────────────────────────────────────────────────────

export interface PollLoopOptions {
  accounts: Account[]
  onInbound: (msg: InboundMsg) => Promise<void>
  ilink: {
    /**
     * Returns { updates?, sync_buf?, expired? } — mapped from GetUpdatesResp.
     * When ilink reports errcode=-14 (session timeout), the adapter sets
     * `expired: true` so the loop can self-terminate and flag the bot in
     * SessionStateStore for the /health admin command.
     */
    getUpdates: (accountId: string, baseUrl: string, token: string, syncBuf: string, signal?: AbortSignal) => Promise<{
      updates?: RawUpdate[]
      sync_buf?: string
      expired?: boolean
      standby?: boolean
      /** Client-side long-poll timeout (server never answered) — see the
       *  zombie guard in runLoop. Not a healthy empty poll. */
      timed_out?: boolean
    }>
  }
  parse: (updates: RawUpdate[], deps: ParseDeps) => InboundMsg[]
  resolveUserName?: (chatId: string) => string | undefined
  /**
   * Persist the advanced ilink poll cursor. Called AFTER a batch's onInbound
   * handlers have all run (so a crash mid-batch still redelivers — at-least-once
   * within a batch), and only when the cursor actually changed (no disk churn on
   * idle long-polls). Without this the on-disk sync_buf is frozen at first boot
   * and every restart replays ilink's unacked backlog → duplicate fallback sends.
   */
  onSyncBuf?: (accountId: string, syncBuf: string) => void
  /**
   * Fired after every successful `getUpdates` round-trip (any account). This
   * is the daemon's "I am actually serving" signal — main.ts stamps the
   * heartbeat file the instance lock reads. A daemon whose poll loop stalls
   * or never starts stops firing this, the heartbeat goes stale, and a fresh
   * daemon may take over the lock instead of being refused by a dead
   * placeholder. Best-effort; must never throw into the loop.
   */
  onPollCycle?: () => void
  log?: (tag: string, line: string) => void
  /**
   * Called on each successful (non-expired, non-error) getUpdates response
   * with the account id and the current ISO timestamp. Used to record
   * heartbeats for the doctor report and the dashboard "上次活动" display.
   * Optional — omitting it disables heartbeat recording (e.g. in tests
   * that don't care about it).
   */
  recordHeartbeat?: (accountId: string, iso: string) => void
  /**
   * Drop a stale expired marker on a successful poll — self-heals the
   * dashboard's terminal `taken_over` state after a daemon restart on a
   * machine that has re-acquired the connection. A non-owner never reaches
   * this branch (it gets errcode=-14 and breaks the loop), so this only
   * fires when the poll genuinely succeeds.
   */
  clearExpired?: (accountId: string) => void
  /**
   * Report each getUpdates round-trip's outcome. Drives the degraded
   * determination and the outbound gate — the real call is the most
   * accurate probe, no separate health-check needed. Optional: omit to
   * skip health tracking.
   */
  health?: {
    recordSuccess(dep: 'wechat'): void
    recordFailure(dep: 'wechat', err: unknown): void
  }
  /** Test injection point; defaults to this file's sleep(). */
  sleepFn?: (ms: number, signal: AbortSignal) => Promise<void>
  /** 停止宽限:abort 后最多等这么久让 loop 自然退出,超时也返回(见 stop()）。 */
  stopGraceMs?: number
}

function sleepImpl(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    let t: ReturnType<typeof setTimeout>
    const onAbort = () => { clearTimeout(t); resolve() }
    // Remove the listener when the timer fires normally — `{once:true}` only
    // auto-removes it if abort actually fires, so without this a long-lived
    // signal (the per-account loop's) accumulates one listener per retry sleep.
    t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export { sleepImpl as sleep }

/**
 * Handle returned by startLongPollLoops. Exposes `addAccount` for on-the-fly
 * registration so `wechat-cc setup` can signal the daemon via SIGUSR1 to pick
 * up a freshly-bound bot without a restart; `stopAccount` so individual loops
 * can be shut down (e.g. admin cleaning up a dead bot or getUpdates reporting
 * errcode=-14 session timeout).
 */
export interface PollLoopHandle {
  /** Register a new account; idempotent (re-adding an already-running id is a no-op). */
  addAccount(account: Account): void
  /** Stop the loop for one account (idempotent; no-op if not running). */
  stopAccount(accountId: string): void
  /**
   * Stop the loop for one account AND await its full unwind. Use when
   * the caller needs to know the loop has released any in-flight
   * resources (sockets, file handles) before proceeding — e.g. admin
   * cleanup deletes the account dir and relies on the loop having
   * closed its long-poll fetch first. Resolves immediately if the
   * account isn't running.
   */
  stopAccountAndWait(accountId: string): Promise<void>
  /** Signal all loops to exit and await them. */
  stop(): Promise<void>
  /** Read-only snapshot of currently-polling account ids. */
  running(): string[]
}

/** Consecutive client-timeout long-poll rounds before wechat health is
 *  flipped to failing (~3 min at the 35s client timeout). */
export const ZOMBIE_TIMEOUT_STREAK = 5

interface LoopRecord {
  abort: AbortController
  promise: Promise<void>
}

/**
 * Start one long-poll loop per account. Returns a handle that permits adding
 * more accounts later (for hot-reload after setup) or shutting down a single
 * one (for cleanup).
 */
export function startLongPollLoops(opts: PollLoopOptions): PollLoopHandle {
  const {
    onInbound,
    ilink,
    parse,
    onSyncBuf,
    onPollCycle,
    log = () => {},
    recordHeartbeat,
    clearExpired,
    health,
  } = opts
  const resolveUserName = opts.resolveUserName ?? (() => undefined)
  const sleep = opts.sleepFn ?? sleepImpl
  const stopGraceMs = opts.stopGraceMs ?? 2_000

  const loops = new Map<string, LoopRecord>()

  async function runLoop(account: Account, sig: AbortSignal): Promise<void> {
    let syncBuf = account.syncBuf
    let failStreak = 0
    let timeoutStreak = 0

    log('POLL', `loop started for ${account.id}`)

    while (!sig.aborted) {
      try {
        const resp = await ilink.getUpdates(account.id, account.baseUrl, account.token, syncBuf, sig)

        if (sig.aborted) break

        // Round-trip completed (answered OR client-timeout) — stamp the
        // daemon-health heartbeat: the process is alive and the loop is
        // turning, which is all the instance lock cares about. Guarded so a
        // bad callback can't kill the poll loop.
        try { onPollCycle?.() } catch { /* never throw into the loop */ }

        // Zombie long-poll guard (2026-08-25, 「新好友消息没反应,自检才好」
        // root-cause): a CLIENT-side timeout is not a healthy empty poll —
        // a live ilink long-poll answers within its own server window; a
        // round our own AbortController had to kill means the server never
        // responded. One is transient; a STREAK means the session is a
        // zombie: no error is thrown, no message ever arrives (strangers
        // who scan the QR get dead silence), and before this guard each
        // such round even stamped the connection heartbeat + wechat health
        // as SUCCESS — the outage was invisible until someone complained
        // and the owner ran 自检. Now: timed-out rounds stamp nothing, and
        // a streak flips wechat health to degraded so the existing
        // health-notify machinery tells the owner proactively.
        if (resp.timed_out) {
          timeoutStreak++
          if (timeoutStreak === ZOMBIE_TIMEOUT_STREAK || (timeoutStreak > ZOMBIE_TIMEOUT_STREAK && timeoutStreak % 20 === 0)) {
            log('POLL', `long-poll client-timeout x${timeoutStreak} in a row for ${account.id} — server not answering; inbound delivery may be stalled (zombie session)`)
            health?.recordFailure('wechat', new Error(`ilink long-poll client-timeout x${timeoutStreak}`))
          }
          continue
        }
        if (timeoutStreak > 0) {
          if (timeoutStreak >= ZOMBIE_TIMEOUT_STREAK) log('POLL', `long-poll answering again for ${account.id} after ${timeoutStreak} timed-out round(s)`)
          timeoutStreak = 0
        }

        // Adapter has marked the bot session expired — self-terminate. The
        // ilink-glue wrapper has already written to SessionStateStore, so
        // /health admin command will show this bot as expired.
        if (resp.expired) {
          if (resp.standby) {
            log('SESSION_STANDBY', `bot ${account.id} — handed off to another device; loop stopped, re-activate to take back`)
          } else {
            log('SESSION_EXPIRED', `bot ${account.id} — stopping loop (/health to view, "清理 ${account.id}" to remove)`)
          }
          break
        }

        const rawUpdates = resp.updates ?? []

        if (rawUpdates.length > 0) {
          const msgs = parse(rawUpdates, {
            accountId: account.id,
            resolveUserName,
          })
          // Arrival evidence INDEPENDENT of pipeline completion — mw-trace
          // only logs [INBOUND] when the middleware chain finishes, so a
          // hung turn used to leave zero trace that a message ever arrived.
          if (msgs.length > 0) {
            log('POLL', `inbound ${msgs.length} message(s) from ${[...new Set(msgs.map(m => m.chatId))].join(',')}`)
          }
          for (const msg of msgs) {
            try {
              await onInbound(msg)
            } catch (err) {
              log('ERROR', `onInbound threw: ${err}`)
            }
            // Stamp the heartbeat after EACH message too, not just per
            // getUpdates round-trip. onInbound runs the full agent turn inline,
            // so a batch of slow turns would otherwise hold the loop (and the
            // heartbeat) for sum-of-turns — long enough for the instance lock
            // to look stale and be stolen by a second daemon. Per-message
            // stamping bounds the gap to a single turn. Guarded; never throws.
            try { onPollCycle?.() } catch { /* never throw into the loop */ }
          }
        }

        // Persist AFTER the onInbound loop above, so a crash mid-batch
        // redelivers; only on an actual change to avoid disk churn on the
        // idle long-poll returns that echo the same cursor.
        if (resp.sync_buf !== undefined && resp.sync_buf !== syncBuf) {
          syncBuf = resp.sync_buf
          onSyncBuf?.(account.id, syncBuf)
        }

        // Record a heartbeat for every successful (non-expired) poll.
        // Placed after sync_buf update so the timestamp reflects a completed
        // poll cycle. Omitted on expired/error branches.
        recordHeartbeat?.(account.id, new Date().toISOString())
        // Self-heal: a successful poll proves we hold the connection, so drop
        // any stale expired marker left by a prior -14 (idempotent no-op when
        // there's nothing to clear).
        clearExpired?.(account.id)
        // 成功即清零 —— 时长与退避都从下一轮的第一次失败重新起算。
        if (failStreak > 0) {
          log('POLL', `recovered for ${account.id} after ${failStreak} consecutive failures`)
          failStreak = 0
        }
        health?.recordSuccess('wechat')
      } catch (err) {
        if (sig.aborted) break
        health?.recordFailure('wechat', err)
        // 日志折叠:前 3 次逐条,之后每 20 次一条汇总。2026-08-02 那次
        // 4211 行 ERROR 把 10MB 日志刷爆触发轮转,故障起点的上下文因此永久丢失。
        if (failStreak < 3 || failStreak % 20 === 0) {
          log('ERROR', `getUpdates failed (${failStreak + 1}x): ${err}`)
        }
        const delay = nextBackoffMs(failStreak)
        failStreak += 1
        await sleep(delay, sig)
      }
    }

    log('POLL', `loop stopped for ${account.id}`)
  }

  function addAccount(account: Account): void {
    if (loops.has(account.id)) return
    const abort = new AbortController()
    const promise = runLoop(account, abort.signal).finally(() => {
      // Remove self on natural exit so addAccount can re-add under same id.
      if (loops.get(account.id)?.abort === abort) loops.delete(account.id)
    })
    loops.set(account.id, { abort, promise })
  }

  function stopAccount(accountId: string): void {
    const record = loops.get(accountId)
    if (!record) return
    record.abort.abort()
    // Leave entry in map; runLoop.finally cleans up once it exits.
  }

  async function stopAccountAndWait(accountId: string): Promise<void> {
    const record = loops.get(accountId)
    if (!record) return
    record.abort.abort()
    // Swallow throws: the loop's own try/catch already logs; the caller
    // here only cares that the promise has SETTLED (so any in-flight
    // sockets are closed), not how it ended.
    try { await record.promise } catch { /* logged inside runLoop */ }
  }

  for (const account of opts.accounts) addAccount(account)

  return {
    addAccount,
    stopAccount,
    stopAccountAndWait,
    running: () => Array.from(loops.keys()),
    async stop(): Promise<void> {
      for (const record of loops.values()) record.abort.abort()
      // abort 已发出;进程正在退出,socket 会随进程销毁。Bun 的 fetch-abort
      // 传播偶有延迟(网络坏态下可 >5s),不该让它拖住 lifecycle 的停止预算
      // —— 给一个有界宽限,loop 正常退出就走,拖太久也返回(不再 stop
      // timeout 刷屏)。宽限用不可 abort 的裸计时,不受同一停止信号影响。
      const allExited = Promise.all(Array.from(loops.values()).map(r => r.promise))
      await Promise.race([
        allExited,
        new Promise<void>(res => setTimeout(res, stopGraceMs)),
      ])
    },
  }
}
