/**
 * mw-access — enforces the access.json allowlist gate, PLUS the guest-path
 * request/invite branch for non-allowlisted senders (spec
 * docs/superpowers/specs/2026-08-18-guest-path-design.md §2).
 *
 * The README promises "everyone else is blocked by default" but the gate
 * was previously not wired into the inbound pipeline (gate() in
 * src/lib/access.ts had no production callers). This middleware closes
 * that gap by dropping inbounds from senders not in `access.allowFrom`
 * (or all inbounds when `dmPolicy === 'disabled'`).
 *
 * Sits early in the pipeline — after mw-trace + mw-identity (so the
 * trace records the drop and chatId is already normalized) but BEFORE
 * mw-dedup/mw-capture-ctx/mw-typing/mw-admin/mw-onboarding/mw-welcome.
 * Non-allowlisted senders never trigger those downstream side effects
 * (no typing indicator, no welcome message, no API tokens spent) — the
 * guest branch below runs entirely inline, with its own message-id dedup
 * (mw-dedup hasn't run yet at this point in the chain) and its own
 * targeted ctxStore/account-routing hydrate (mw-capture-ctx hasn't run
 * either).
 *
 * Guest branch (spec §2, five steps, deterministic — no model
 * participation anywhere in this file):
 *   1. message-id dedup (at-least-once redelivery guard, since this runs
 *      before mw-dedup)
 *   2. `wasDenied` → silent drop
 *   3. bare 6-digit text that consumes a live invite code → allowlist +
 *      welcome (a WRONG 6-digit code falls through to step 5, deliberately
 *      indistinguishable from an ordinary first message — no code-probing
 *      oracle)
 *   4. forward-budget check → silent drop when exhausted (indistinguishable
 *      from an ordinary drop — no rate-limit leak)
 *   5. upsert the pending request; notify the owner (retrying whenever
 *      `fresh` or the stored `notifiedAt` is still null — see
 *      GuestRequestStore.upsertRequest's NOTIFY-RETRY CONTRACT doc
 *      comment) and give the guest ONE neutral reply on the fresh path only
 *
 * `AccessMwDeps`'s guest fields are all optional so this middleware is a
 * byte-identical silent drop wherever they're absent (unit tests, any
 * minimal pipeline embed) — the real daemon wiring
 * (src/daemon/wiring/pipeline-deps.ts) supplies all five together.
 */
import type { Middleware } from './types'
import type { InboundMsg } from '../../core/prompt-format'
import type { Access } from '../../lib/access'
import type { GuestRequestStore } from '../guest-requests'
import type { ForwardBudget } from '../../core/forward-budget'
import { inboundMessageId, inboundFallbackMessageId } from '../../lib/messages-store'
import { appendAllowFrom } from '../../lib/access'

const INVITE_CODE_RE = /^\d{6}$/
const INVITE_WELCOME_TEXT = '主人邀请你来的吧,欢迎!直接跟我说话就行~'
const NEUTRAL_REPLY_TEXT = '我需要主人确认一下,稍等哦~'
const PREVIEW_MAX_LEN = 60

/** ≤60 chars, `\n` → space — guest text NEVER reaches a prompt; this is
 *  purely for the owner-facing notification line (spec §0 red line). */
function previewText(text: string): string {
  return text.replace(/\n/g, ' ').slice(0, PREVIEW_MAX_LEN)
}

function ownerNotifyText(chatId: string, code: string, preview: string): string {
  return `👋 ${chatId} 想和我聊天,ta 说:"${preview}"\n回「允许 ${code}」或「拒绝 ${code}」(48 小时内有效)`
}

export interface AccessMwDeps {
  loadAccess: () => Access
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /** Pending-request/invite-code store (src/daemon/guest-requests.ts). */
  guestRequests?: GuestRequestStore
  /**
   * Targeted ctxStore + account-routing hydrate for a chat that is NOT
   * (yet) allowlisted — mirrors mw-capture-ctx's two calls but must NOT
   * touch lastActiveRef (a stranger's first message must never become the
   * operator-relay target). See ilink-glue.ts's `routeChatToAccount`.
   */
  hydrateChatRoute?: (msg: InboundMsg) => void
  /** Direct send to the guest chat (never through a prompt). */
  sendMessage?: (chatId: string, text: string) => Promise<{ error?: string }>
  /** Direct send to the resolved admin chat (resolveAdminChatId — NEVER
   *  resolveOperatorChatId). */
  notifyOwner?: (text: string) => Promise<{ error?: string }>
  /** Per-sender token bucket bounding guest-branch activity. */
  budget?: ForwardBudget
}

export function makeMwAccess(deps: AccessMwDeps): Middleware {
  return async (ctx, next) => {
    const access = deps.loadAccess()
    // Mirror gate()'s logic but inline so we can log per-decision detail.
    if (access.dmPolicy === 'disabled') {
      deps.log('ACCESS', `drop chat=${ctx.msg.chatId} reason=dm_policy_disabled`)
      ctx.consumedBy = 'access'
      return
    }
    // '*' is a match-all wildcard — used by the e2e harness's default
    // allowFrom and by operators who explicitly want an open daemon.
    // Default access from disk is { allowFrom: [] } (no wildcard), so the
    // README's "everyone else is blocked by default" promise is preserved.
    const allowed = access.allowFrom.includes('*') || access.allowFrom.includes(ctx.msg.chatId)
    if (allowed) {
      await next()
      return
    }

    const { guestRequests, hydrateChatRoute, sendMessage, notifyOwner, budget } = deps
    if (!guestRequests || !hydrateChatRoute || !sendMessage || !notifyOwner || !budget) {
      // Guest path not wired (or a test/minimal embed didn't supply it) —
      // byte-identical legacy behavior: silent drop, log only.
      deps.log(
        'ACCESS',
        `drop chat=${ctx.msg.chatId} reason=not_in_allowlist allowFrom_count=${access.allowFrom.length}`,
      )
      ctx.consumedBy = 'access'
      return
    }

    const msg = ctx.msg
    ctx.consumedBy = 'access'   // every exit below this line is a guest-branch consume, never a normal turn

    // Step 1 — at-least-once redelivery guard (mw-dedup hasn't run yet;
    // this middleware sits upstream of it).
    const msgId = msg.createTimeMs
      ? inboundMessageId(msg.userId, msg.createTimeMs)
      : inboundFallbackMessageId(msg.userId, msg.text)
    if (guestRequests.seenMessage(msgId)) {
      deps.log('ACCESS', `guest drop chat=${msg.chatId} reason=redelivered_message id=${msgId}`)
      return
    }

    // Step 2 — a previously-denied chat goes back to plain silence.
    if (guestRequests.wasDenied(msg.chatId)) {
      deps.log('ACCESS', `guest drop chat=${msg.chatId} reason=denied`)
      return
    }

    // Step 3 — bare 6-digit text that consumes a LIVE invite code jumps
    // straight to allowlisted. A wrong-but-6-digit code deliberately falls
    // through to step 5 (treated as an ordinary first message) so a
    // code-guessing attempt is indistinguishable from a normal stranger.
    const trimmed = msg.text.trim()
    if (INVITE_CODE_RE.test(trimmed) && guestRequests.consumeInvite(trimmed)) {
      appendAllowFrom(msg.chatId)
      hydrateChatRoute(msg)
      const r = await sendMessage(msg.chatId, INVITE_WELCOME_TEXT)
      deps.log('ACCESS', `guest invite-accept chat=${msg.chatId}${r.error ? ` send_error=${r.error}` : ''}`)
      return
    }

    // Step 4 — forward budget. Exhausted ⇒ silent drop, indistinguishable
    // from an ordinary drop (no rate-limit leak to a prober).
    if (!budget.withinBudget(msg.chatId)) {
      deps.log('ACCESS', `guest drop chat=${msg.chatId} reason=over_budget`)
      return
    }

    // Step 5 — upsert the pending request. Retry the owner notification
    // whenever this is a brand-new request OR an existing one whose prior
    // notify attempt never actually landed (GuestRequestStore.upsertRequest's
    // NOTIFY-RETRY CONTRACT) — but the guest only ever gets the neutral
    // reply ONCE, on the fresh path (repeats stay silent to the guest, even
    // while a notify retry is quietly in flight to the owner).
    const { request, fresh } = guestRequests.upsertRequest({
      chatId: msg.chatId,
      firstMsg: msg,
      contextToken: msg.contextToken ?? '',
      accountId: msg.accountId,
    })

    if (fresh) {
      hydrateChatRoute(msg)
      await sendMessage(msg.chatId, NEUTRAL_REPLY_TEXT)
    }

    if (fresh || request.notifiedAt === null) {
      const text = ownerNotifyText(msg.chatId, request.code, previewText(msg.text))
      const r = await notifyOwner(text)
      if (!r.error) {
        guestRequests.markNotified(msg.chatId)
      } else {
        deps.log('ACCESS', `guest owner-notify failed chat=${msg.chatId} error=${r.error} — will retry next message`)
      }
    }

    deps.log('ACCESS', `guest request chat=${msg.chatId} fresh=${fresh} code=${request.code}`)
  }
}
