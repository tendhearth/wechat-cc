/**
 * First-time onboarding — daemon-level deterministic nickname capture.
 *
 * Why this exists alongside Claude's `set_user_name` MCP tool: Claude's
 * version is *advisory* (it asks for the name only when it feels like it,
 * and may skip if the user's first message is task-relevant). For a fresh
 * binding we want a deterministic two-step exchange BEFORE any message
 * reaches Claude:
 *
 *   1. inbound from unknown user → bot replies with greeting + ask for name
 *   2. user's reply → validated, persisted to user_names.json, ack reply +
 *      original first message re-dispatched through the normal pipeline so
 *      the provider answers it
 *   3. subsequent messages route normally to Claude
 *
 * For admins only, step 2 gains a sub-step: after user_name is captured,
 * if no bot_name is set yet, ask "你想怎么叫我?" and persist the reply.
 * This extends the state machine with an `awaiting_bot_name` phase.
 *
 * The `awaiting` set is state-store backed (write-through, debounceMs:0 —
 * repo convention, see chat-prefs.ts / incident-store.ts) so a daemon
 * restart mid-flow doesn't force a re-greet: the in-progress nickname
 * exchange picks up where it left off on the next inbound. The 30-min
 * timeout travels with each entry (`since`); `getAwaiting()` itself is a
 * plain lookup (no filtering), and `handle()` applies the timeout via its
 * own `stillWaiting` check on the returned entry. Expired entries ARE
 * pruned from disk, but lazily — on the next `setAwaiting()` call for ANY
 * chat, not on every read.
 * The 1.5s dedup window (DEDUP_WINDOW_MS) stays process-local semantics —
 * it happens to piggyback on the persisted `since`/`triggerText` fields,
 * but there's no separate durable dedup ledger: an ilink re-delivery that
 * lands within 1.5s of a daemon restart is not a scenario worth guarding.
 */

import { join } from 'node:path'
import type { InboundMsg } from '../core/prompt-format'
// Nickname constraint lives in one place (./nickname) — shared with /name and
// /botname so the allowed set can't silently drift between them.
import { NICKNAME_MAX_LEN, NICKNAME_MIN_LEN, NICKNAME_RE } from './nickname'
import { makeStateStore, type StateStore } from './state-store'

export interface OnboardingDeps {
  isKnownUser(userId: string): boolean
  setUserName(chatId: string, name: string): Promise<void>
  sendMessage(chatId: string, text: string): Promise<void>
  /** Bot's user-facing self-name for the greeting (mode-aware in production). */
  botName(chatId: string): string
  /** Re-dispatch the user's first message through the normal pipeline AFTER
   *  the nickname is captured so the provider answers it. Fire-and-forget
   *  from onboarding's POV — failures are logged here, recovery is the
   *  pipeline's job. */
  dispatchInbound(msg: InboundMsg): Promise<void>
  log(tag: string, line: string): void
  now?: () => number
  /** True when this user is an admin per access.json. Only admins are
   *  asked "你想怎么叫我?" — non-admins inherit whatever name admin set
   *  (or the mode fallback if unset). */
  isAdmin(userId: string): boolean
  /** Current global bot self-name override. Null/empty = use fallback.
   *  Read fresh each call: the underlying agentConfig is mutated by /botname
   *  outside onboarding, so caching the value would go stale. */
  getBotName(): string | null
  /** Persist the new self-name (null = clear). Disk-first, then in-memory
   *  mutate. Throws on I/O failure; caller catches + replies retry hint. */
  setBotName(name: string | null): Promise<void>
  /** stateDir for constructing the persistent awaiting-state store
   *  (production wiring: `<stateDir>/onboarding-pending.json`). Ignored
   *  when `store` is injected directly. */
  stateDir: string
  /** Test seam — inject a pre-built StateStore instead of constructing one
   *  from `stateDir`. Lets tests simulate a daemon restart by building a
   *  fresh handler + fresh StateStore instance against the SAME on-disk
   *  file. */
  store?: StateStore
}

export interface OnboardingHandler {
  /**
   * Returns true if the message was consumed by the onboarding flow
   * (caller MUST NOT route to Claude). Returns false to continue normal
   * routing (already-known user, or user out of awaiting window).
   */
  handle(msg: InboundMsg): Promise<boolean>
}

const AWAIT_TIMEOUT_MS = 30 * 60_000  // 30 min
const DEDUP_WINDOW_MS = 1500  // ilink re-delivery / user double-tap window — see #16

const BOT_NAME_SKIP_WORDS = new Set(['跳过', '不用', '没有', 'skip', 'clear', '清除'])

type AwaitPhase = 'awaiting_user_name' | 'awaiting_bot_name'

interface AwaitEntry {
  since: number
  triggerText: string
  fromMessage: InboundMsg
  phase: AwaitPhase
}

// Single state-store key holding the WHOLE awaiting map (repo convention —
// see incident-store.ts / chat-prefs.ts: one KEY, JSON-stringified payload —
// rather than one state-store key per chatId).
const AWAITING_KEY = 'awaiting'

export function makeOnboardingHandler(deps: OnboardingDeps): OnboardingHandler {
  const store = deps.store ?? makeStateStore(join(deps.stateDir, 'onboarding-pending.json'), { debounceMs: 0 })
  const now = deps.now ?? (() => Date.now())

  function readAll(): Record<string, AwaitEntry> {
    const raw = store.get(AWAITING_KEY)
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, AwaitEntry>
        : {}
    } catch {
      return {}   // corrupt JSON — start empty, same posture as state-store itself
    }
  }

  function writeAll(all: Record<string, AwaitEntry>): void {
    store.set(AWAITING_KEY, JSON.stringify(all))
  }

  /** Drop any chat's awaiting entry once it's past AWAIT_TIMEOUT_MS — keeps
   *  the on-disk map from accumulating abandoned flows across many users. */
  function pruneExpired(all: Record<string, AwaitEntry>): Record<string, AwaitEntry> {
    const t = now()
    const out: Record<string, AwaitEntry> = {}
    for (const [chatId, entry] of Object.entries(all)) {
      if (t - entry.since < AWAIT_TIMEOUT_MS) out[chatId] = entry
    }
    return out
  }

  function getAwaiting(chatId: string): AwaitEntry | undefined {
    return readAll()[chatId]
  }

  function setAwaiting(chatId: string, entry: AwaitEntry): void {
    const all = pruneExpired(readAll())
    all[chatId] = entry
    writeAll(all)
  }

  function deleteAwaiting(chatId: string): void {
    const all = readAll()
    if (!(chatId in all)) return
    delete all[chatId]
    writeAll(all)
  }

  async function handleUserName(
    msg: InboundMsg,
    aw: { since: number; triggerText: string; fromMessage: InboundMsg; phase: AwaitPhase },
  ): Promise<boolean> {
    const proposed = msg.text.trim()
    if (proposed.length < NICKNAME_MIN_LEN) {
      await deps.sendMessage(msg.chatId, '请发一个昵称（不能为空）。')
      return true
    }
    if (proposed.length > NICKNAME_MAX_LEN) {
      await deps.sendMessage(msg.chatId, `昵称太长（最多 ${NICKNAME_MAX_LEN} 字符）。再发一次?`)
      return true
    }
    if (!NICKNAME_RE.test(proposed)) {
      await deps.sendMessage(msg.chatId, '昵称只支持中文 / 字母 / 数字 / 空格 / _ / -。再发一次?')
      return true
    }
    await deps.setUserName(msg.chatId, proposed)
    deps.log('ONBOARDING', `name set chat=${msg.chatId} → "${proposed}"`)

    const askBotName = deps.isAdmin(msg.userId) && !(deps.getBotName()?.trim())
    if (askBotName) {
      setAwaiting(msg.chatId, { ...aw, phase: 'awaiting_bot_name', since: now(), triggerText: proposed })
      await deps.sendMessage(
        msg.chatId,
        `好的 ${proposed}。那你想怎么叫我?比如「小希」「助理」（中文 / 英文都行，回「跳过」用默认）。`,
      )
      return true
    }

    deleteAwaiting(msg.chatId)
    await deps.sendMessage(
      msg.chatId,
      `好的 ${proposed}!想看我全部玩法,随时发 /help。刚才你说「${aw.triggerText}」,回答下:`,
    )
    void deps.dispatchInbound(aw.fromMessage).catch(err => {
      deps.log('ONBOARDING', `echo dispatch failed chat=${msg.chatId}: ${err}`)
    })
    return true
  }

  async function handleBotName(
    msg: InboundMsg,
    aw: { since: number; triggerText: string; fromMessage: InboundMsg; phase: AwaitPhase },
  ): Promise<boolean> {
    // I2 defensive check: tier may have changed between turn 2 (when the
    // admin gate was evaluated) and turn 3. Re-checking isAdmin prevents
    // a demoted-but-still-allowed user from globally renaming the bot.
    // On false, exit awaiting cleanly + redispatch (same as the
    // already-set-elsewhere path below).
    if (!deps.isAdmin(msg.userId)) {
      deleteAwaiting(msg.chatId)
      await deps.sendMessage(
        msg.chatId,
        `好的。刚才你说「${aw.fromMessage.text}」, 回答下：`,
      )
      void deps.dispatchInbound(aw.fromMessage).catch(err => {
        deps.log('ONBOARDING', `echo dispatch failed chat=${msg.chatId}: ${err}`)
      })
      return true
    }

    // /botname (or any other code path) may have set bot_name out of band.
    // Exit awaiting cleanly + redispatch the original trigger.
    if (deps.getBotName()?.trim()) {
      deleteAwaiting(msg.chatId)
      await deps.sendMessage(
        msg.chatId,
        `好的。刚才你说「${aw.fromMessage.text}」, 回答下：`,
      )
      void deps.dispatchInbound(aw.fromMessage).catch(err => {
        deps.log('ONBOARDING', `echo dispatch failed chat=${msg.chatId}: ${err}`)
      })
      return true
    }

    const proposed = msg.text.trim()
    // Skip word → clear bot_name (null) + fallback ack.
    if (BOT_NAME_SKIP_WORDS.has(proposed.toLowerCase())) {
      try { await deps.setBotName(null) }
      catch (err) {
        deps.log('ONBOARDING', `setBotName(null) failed chat=${msg.chatId}: ${err}`)
        await deps.sendMessage(msg.chatId, '我没记住，稍后再试 /botname')
        return true
      }
      deleteAwaiting(msg.chatId)
      await deps.sendMessage(
        msg.chatId,
        `好的，继续用默认「${deps.botName(msg.chatId)}」。刚才你说「${aw.fromMessage.text}」, 回答下：`,
      )
      void deps.dispatchInbound(aw.fromMessage).catch(err => {
        deps.log('ONBOARDING', `echo dispatch failed chat=${msg.chatId}: ${err}`)
      })
      return true
    }

    // Validate + store.
    if (proposed.length < NICKNAME_MIN_LEN) {
      await deps.sendMessage(msg.chatId, '请发一个昵称（不能为空），或回「跳过」用默认。')
      return true
    }
    if (proposed.length > NICKNAME_MAX_LEN) {
      await deps.sendMessage(msg.chatId, `昵称太长（最多 ${NICKNAME_MAX_LEN} 字符）。再发一次?`)
      return true
    }
    if (!NICKNAME_RE.test(proposed)) {
      await deps.sendMessage(msg.chatId, '昵称只支持中文 / 字母 / 数字 / 空格 / _ / -。再发一次?')
      return true
    }
    try { await deps.setBotName(proposed) }
    catch (err) {
      deps.log('ONBOARDING', `setBotName failed chat=${msg.chatId}: ${err}`)
      await deps.sendMessage(msg.chatId, '我没记住，稍后再试 /botname')
      return true
    }
    deleteAwaiting(msg.chatId)
    deps.log('ONBOARDING', `bot_name set chat=${msg.chatId} → "${proposed}"`)
    // 给我起名是陪伴关系里一个有分量的时刻 —— 暖一点地认下这个名字,别只回
    // 平淡的「好的」(跟给用户起昵称时的「好的 大人!」保持同样的温度)。
    await deps.sendMessage(
      msg.chatId,
      `好嘞,以后你就叫我「${proposed}」🐻 刚才你说「${aw.fromMessage.text}」, 回答下：`,
    )
    void deps.dispatchInbound(aw.fromMessage).catch(err => {
      deps.log('ONBOARDING', `echo dispatch failed chat=${msg.chatId}: ${err}`)
    })
    return true
  }

  return {
    async handle(msg) {
      const aw = getAwaiting(msg.chatId)
      const stillWaiting = aw !== undefined && (now() - aw.since) < AWAIT_TIMEOUT_MS

      // If we're in the bot_name phase, the user is already known (nickname
      // was saved in the previous turn). Handle before the isKnownUser gate.
      if (stillWaiting && aw.phase === 'awaiting_bot_name') {
        // Dedup: ilink re-delivery / user double-tap within DEDUP window.
        if (now() - aw.since < DEDUP_WINDOW_MS && msg.text === aw.triggerText) {
          deps.log('ONBOARDING', `dedup chat=${msg.chatId} phase=${aw.phase} (${now() - aw.since}ms)`)
          return true
        }
        return await handleBotName(msg, aw)
      }

      // Already-known users skip onboarding entirely (unless in bot_name phase above).
      if (deps.isKnownUser(msg.userId)) return false

      if (stillWaiting) {
        // Dedup: ilink re-delivery / user double-tap within DEDUP window
        // — compare phase + text so a second-turn echo doesn't get matched
        // against the first-turn trigger.
        if (now() - aw.since < DEDUP_WINDOW_MS && msg.text === aw.triggerText) {
          deps.log('ONBOARDING', `dedup chat=${msg.chatId} phase=${aw.phase} (${now() - aw.since}ms)`)
          return true
        }

        if (aw.phase === 'awaiting_user_name') {
          return await handleUserName(msg, aw)
        }
      }

      // First contact (or stale awaiting state past timeout): greet + start the clock.
      setAwaiting(msg.chatId, {
        since: now(),
        triggerText: msg.text,
        fromMessage: msg,
        phase: 'awaiting_user_name',
      })
      deps.log('ONBOARDING', `start chat=${msg.chatId} userId=${msg.userId}`)
      await deps.sendMessage(
        msg.chatId,
        `你好呀!我是 ${deps.botName(msg.chatId)}——住在你微信里的 AI 伙伴,能聊天、帮你干活、记得你说过的事。先问一下,我应该怎么称呼你?比如「Nate」「丸子」(中文/英文都行)`,
      )
      return true
    },
  }
}
