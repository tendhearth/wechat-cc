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
 * A redispatch guard runs FIRST, ahead of every guest-branch step:
 * `ctx.redispatch` messages are dropped here unconditionally (hardening
 * round, controller-mandated). The 允许 command seam re-fires an
 * already-approved guest's original message with `redispatch:true` set
 * (pipeline-deps.ts's "guest approve redispatch") — the primary fix is
 * access.ts's appendAllowFrom busting the loadAccess() cache so `allowed`
 * above is already true by the time that redispatch reaches this
 * middleware, so normally it never even gets here. But any residual
 * stale-cache window that lands it here anyway must NOT fall through to
 * the steps below: `guestRequests.resolve()` already DELETED the pending
 * record for this guest (see guest-requests.ts's `resolve`), so
 * `upsertRequest` would silently treat the redispatch as a brand-new
 * request and re-notify the owner about a guest they already approved
 * seconds ago. A redispatched message must never create a new
 * request/notify.
 *
 * Guest branch proper (spec §2 AS AMENDED — fix round 1 reordered steps
 * 2/3; fix-wave ruling (Important 2) added a gate BEFORE step 1: a real,
 * non-empty `access.admins` list — see the guard just above the redispatch
 * check for why. See the spec's own bracketed annotation — five steps,
 * deterministic, no model participation anywhere in this file):
 *   1. message-id dedup (at-least-once redelivery guard, since this runs
 *      before mw-dedup).
 *   2. bare 6-digit text that consumes a live invite code → allowlist +
 *      welcome (a WRONG 6-digit code falls through to step 5, deliberately
 *      indistinguishable from an ordinary first message — no code-probing
 *      oracle). Deliberately BEFORE the denied check (step 3): an
 *      owner-issued invite code overrides a prior denial — a mis-typed
 *      「拒绝」 followed by 「邀请码」 must still work.
 *   3. `wasDenied` → silent drop
 *   4. forward-budget check → silent drop when exhausted, EXCEPT an
 *      existing pending request whose owner-notify never actually landed
 *      still retries regardless of budget state (a transient send outage
 *      must not permanently silence the owner behind the guest's own
 *      budget — that's not a new forwarded intent, it's finishing the one
 *      already accounted for)
 *   5. upsert the pending request; notify the owner (retrying whenever
 *      `fresh` or the stored `notifiedAt` is still null — see
 *      GuestRequestStore.upsertRequest's NOTIFY-RETRY CONTRACT doc
 *      comment) and give the guest ONE neutral reply on the fresh path only
 *
 * `AccessMwDeps`'s guest fields are all optional so this middleware is a
 * byte-identical silent drop wherever they're absent (unit tests, any
 * minimal pipeline embed) — the real daemon wiring
 * (src/daemon/wiring/pipeline-deps.ts) supplies all six together.
 */
import type { Middleware } from './types'
import type { InboundMsg } from '../../core/prompt-format'
import type { Access } from '../../lib/access'
import type { GuestRequestStore } from '../guest-requests'
import type { ForwardBudget } from '../../core/forward-budget'
import { inboundMessageId, inboundFallbackMessageId } from '../../lib/messages-store'

const INVITE_CODE_RE = /^\d{6}$/
const INVITE_WELCOME_TEXT = '主人邀请你来的吧,欢迎!直接跟我说话就行~'
const NEUTRAL_REPLY_TEXT = '我需要主人确认一下,稍等哦~'
const PREVIEW_MAX_LEN = 60

/**
 * ≤60 CODEPOINTS (not UTF-16 units — Array.from splits on codepoints, so
 * an astral character/emoji never gets its surrogate pair cut in half).
 * Line-break-shaped codepoints → space: `\n`, `\r`, U+2028 (LINE
 * SEPARATOR), U+2029 (PARAGRAPH SEPARATOR) — one character class (fold 3;
 * the latter two are the other "renders as a line break" codepoints that
 * `\n`-only handling misses, and this text is about to be wrapped in a
 * single-line owner notification). `"` → `\"` (backslash-escaped — picked
 * over a corner-bracket substitution since the wrapping quotes in
 * `ownerNotifyText`/the 待批准 listing are plain ASCII `"`; an unescaped
 * `"` in the guest's own text could otherwise visually close the quote
 * early and splice fake-looking content — e.g. a fabricated
 * `回「允许 000000」` line — into the owner's rendered message). Guest text
 * NEVER reaches a prompt; this is purely for owner-facing display (the
 * owner notify line here, and the 「待批准」 listing rendered by the T5
 * owner-command seam in pipeline-deps.ts — spec §0 red line, shared by
 * both call sites).
 */
export function previewText(text: string): string {
  const escaped = text.replace(/[\n\r\u2028\u2029]/g, ' ').replace(/"/g, '\\"')
  return Array.from(escaped).slice(0, PREVIEW_MAX_LEN).join('')
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
  /**
   * Injected (fix round 1, DI-convention fold #10) rather than imported
   * directly — this file's every other side effect already comes through
   * AccessMwDeps, and a bare module import of a mutating function was an
   * inconsistency worth fixing. Real wiring: src/lib/access.ts's
   * appendAllowFrom (see its own doc comment for the security red line —
   * allowFrom ONLY, never admins/trusted).
   */
  appendAllowFrom?: (chatId: string) => boolean
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

    const { guestRequests, hydrateChatRoute, sendMessage, notifyOwner, budget, appendAllowFrom } = deps
    if (!guestRequests || !hydrateChatRoute || !sendMessage || !notifyOwner || !budget || !appendAllowFrom) {
      // Guest path not wired (or a test/minimal embed didn't supply it) —
      // byte-identical legacy behavior: silent drop, log only.
      deps.log(
        'ACCESS',
        `drop chat=${ctx.msg.chatId} reason=not_in_allowlist allowFrom_count=${access.allowFrom.length}`,
      )
      ctx.consumedBy = 'access'
      return
    }

    // [fix-wave ruling, CONTROLLER — Important 2] The entire guest machinery
    // requires a REAL admins list. On a legacy install where access.json has
    // never had `admins` set, `isAdmin()` (src/lib/access.ts) falls back to
    // treating allowFrom membership as admin membership. Approving even one
    // guest through this very branch appends them to allowFrom — which,
    // on such an install, would ALSO make `isAdmin(guestChatId)` true,
    // handing that guest the owner-command seam (pipeline-deps.ts: mint
    // 邀请码, run 允许/拒绝, and every other admin-gated in-chat command).
    // Gating on `admins?.length` here (mirrored in pipeline-deps.ts's guest
    // command seam) closes that escalation chain at its root instead of
    // trying to patch isAdmin() itself. This degrades to the SAME legacy
    // silent drop as the deps-missing branch above — coherent, since
    // `resolveAdminChatId` also returns null with no admins configured, so
    // an owner notify could never have been delivered anyway.
    if (!access.admins?.length) {
      deps.log('ACCESS', `guest path inactive: admins empty — run doctor (chat=${ctx.msg.chatId})`)
      ctx.consumedBy = 'access'
      return
    }

    const msg = ctx.msg
    ctx.consumedBy = 'access'   // every exit below this line is a guest-branch consume, never a normal turn

    // Redispatch guard (hardening round, controller-mandated) — see this
    // file's top doc comment. A stale-cache corner can land an
    // already-approved redispatch back in this branch; it must never
    // create a new request or re-notify the owner. Return here, BEFORE
    // touching guestRequests at all (including the seenMessage dedup
    // below — this message id was already recorded seen on its first,
    // non-redispatch pass through this middleware).
    if (ctx.redispatch) {
      deps.log('ACCESS', `guest drop chat=${msg.chatId} reason=redispatch_stale_cache`)
      return
    }

    // Step 1 — at-least-once redelivery guard (mw-dedup hasn't run yet;
    // this middleware sits upstream of it). seenMessage() still records
    // the id either way (so a genuine at-least-once redelivery later is
    // caught normally).
    const msgId = msg.createTimeMs
      ? inboundMessageId(msg.userId, msg.createTimeMs)
      : inboundFallbackMessageId(msg.userId, msg.text)
    const alreadySeen = guestRequests.seenMessage(msgId)
    if (alreadySeen) {
      deps.log('ACCESS', `guest drop chat=${msg.chatId} reason=redelivered_message id=${msgId}`)
      return
    }

    // Step 2 — bare 6-digit text that consumes a LIVE invite code jumps
    // straight to allowlisted, BEFORE the denied check (spec §2 bracketed
    // amendment, fix round 1 ruling #8): an owner-issued invite code
    // overrides a prior denial. A wrong-but-6-digit code deliberately
    // falls through to step 5 (treated as an ordinary first message) so a
    // code-guessing attempt is indistinguishable from a normal stranger.
    const trimmed = msg.text.trim()
    if (INVITE_CODE_RE.test(trimmed) && guestRequests.consumeInvite(trimmed)) {
      appendAllowFrom(msg.chatId)
      hydrateChatRoute(msg)
      const r = await sendMessage(msg.chatId, INVITE_WELCOME_TEXT)
      deps.log('ACCESS', `guest invite-accept chat=${msg.chatId}${r.error ? ` send_error=${r.error}` : ''}`)
      return
    }

    // Step 3 — a previously-denied chat goes back to plain silence.
    if (guestRequests.wasDenied(msg.chatId)) {
      deps.log('ACCESS', `guest drop chat=${msg.chatId} reason=denied`)
      return
    }

    // Step 4 — forward budget bounds NEW guest-initiated forwards. An
    // existing pending request whose owner-notify never actually landed
    // (notifiedAt still null) retries regardless of budget state — a
    // transient send failure must not permanently silence the owner
    // behind the guest's own budget (fix round 1 fold #7); this is not a
    // new forward, it's finishing the one already accounted for.
    if (!budget.withinBudget(msg.chatId)) {
      const stuck = guestRequests.listPending().find(r => r.chatId === msg.chatId && r.notifiedAt === null)
      if (stuck) {
        const text = ownerNotifyText(msg.chatId, stuck.code, previewText(msg.text))
        const r = await notifyOwner(text)
        if (!r.error) {
          guestRequests.markNotified(msg.chatId)
        } else {
          deps.log('ACCESS', `guest owner-notify retry failed chat=${msg.chatId} error=${r.error} — will retry next message`)
        }
        return
      }
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
