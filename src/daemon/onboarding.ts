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
 * State is in-memory only — daemon restart resets the awaiting set, but the
 * user simply re-sends their nickname. No persistent corruption surface.
 */

import type { InboundMsg } from '../core/prompt-format'

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
   *  Read fresh each call: the underlying agentConfig is mutated by /name
   *  outside onboarding, so caching the value would go stale. */
  getBotName(): string | null
  /** Persist the new self-name (null = clear). Disk-first, then in-memory
   *  mutate. Throws on I/O failure; caller catches + replies retry hint. */
  setBotName(name: string | null): Promise<void>
}

export interface OnboardingHandler {
  /**
   * Returns true if the message was consumed by the onboarding flow
   * (caller MUST NOT route to Claude). Returns false to continue normal
   * routing (already-known user, or user out of awaiting window).
   */
  handle(msg: InboundMsg): Promise<boolean>
}

const NICKNAME_MAX_LEN = 24
const NICKNAME_MIN_LEN = 1
// Hyphen ESCAPED because inside a character class, an unescaped `-`
// between two range endpoints would be interpreted as a range (here
// between ` ` (0x20) and the implicit class terminator). Today the
// pattern still parses safely because ` -` is at the end, but a future
// edit reordering chars could silently widen the allowed set.
const NICKNAME_RE = /^[一-鿿_a-zA-Z0-9 \-]+$/
const AWAIT_TIMEOUT_MS = 30 * 60_000  // 30 min
const DEDUP_WINDOW_MS = 1500  // ilink re-delivery / user double-tap window — see #16

const BOT_NAME_SKIP_WORDS = new Set(['跳过', '不用', '没有', 'skip', 'clear', '清除'])

type AwaitPhase = 'awaiting_user_name' | 'awaiting_bot_name'

export function makeOnboardingHandler(deps: OnboardingDeps): OnboardingHandler {
  const awaiting = new Map<string, {
    since: number
    triggerText: string
    fromMessage: InboundMsg
    phase: AwaitPhase
  }>()
  const now = deps.now ?? (() => Date.now())

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
      awaiting.set(msg.chatId, { ...aw, phase: 'awaiting_bot_name', since: now(), triggerText: proposed })
      await deps.sendMessage(
        msg.chatId,
        `好的 ${proposed}。那你想怎么叫我?比如「小希」「助理」（中文 / 英文都行，回「跳过」用默认）。`,
      )
      return true
    }

    awaiting.delete(msg.chatId)
    await deps.sendMessage(
      msg.chatId,
      `好的 ${proposed}, 刚才你说「${aw.triggerText}」, 回答下：`,
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
    // /name (or any other code path) may have set bot_name out of band.
    // Exit awaiting cleanly + redispatch the original trigger.
    if (deps.getBotName()?.trim()) {
      awaiting.delete(msg.chatId)
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
        await deps.sendMessage(msg.chatId, '我没记住，稍后再试 /name')
        return true
      }
      awaiting.delete(msg.chatId)
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
      await deps.sendMessage(msg.chatId, '我没记住，稍后再试 /name')
      return true
    }
    awaiting.delete(msg.chatId)
    deps.log('ONBOARDING', `bot_name set chat=${msg.chatId} → "${proposed}"`)
    await deps.sendMessage(
      msg.chatId,
      `好的。刚才你说「${aw.fromMessage.text}」, 回答下：`,
    )
    void deps.dispatchInbound(aw.fromMessage).catch(err => {
      deps.log('ONBOARDING', `echo dispatch failed chat=${msg.chatId}: ${err}`)
    })
    return true
  }

  return {
    async handle(msg) {
      const aw = awaiting.get(msg.chatId)
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
      awaiting.set(msg.chatId, {
        since: now(),
        triggerText: msg.text,
        fromMessage: msg,
        phase: 'awaiting_user_name',
      })
      deps.log('ONBOARDING', `start chat=${msg.chatId} userId=${msg.userId}`)
      await deps.sendMessage(
        msg.chatId,
        `你好呀！我是 ${deps.botName(msg.chatId)}，先问一下我应该怎么称呼你?比如「Nate」「丸子」（中文 / 英文都行）。`,
      )
      return true
    },
  }
}
