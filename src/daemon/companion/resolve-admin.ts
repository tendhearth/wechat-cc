/**
 * resolveAdminChatId — the single source of truth for "which chat is the
 * owner/admin" given access.json + companion config. Originally lived
 * inline in bootstrap/index.ts; extracted (fix round 1, owner-onboarding
 * design §C1 review) so leaf modules that need the SAME owner-resolution
 * rule (companion/offer-eligibility.ts) don't have to import the whole
 * bootstrap composition graph just to reach a 5-line pure function.
 * bootstrap/index.ts re-exports this so its existing callers (main.ts,
 * bootstrap.test.ts importing `resolveAdminChatId` from './bootstrap')
 * keep working unchanged.
 */
import type { Access } from '../../lib/access'
import type { CompanionConfig } from './config'

/**
 * Resolve which chat receives permission-relay prompts (and, since
 * owner-onboarding §C1, is treated as "the owner chat" for prompt-injection
 * eligibility). Pre-Task-13 the relay routed to `lastActiveChatId` — a
 * security hole, since a guest who could trigger a tool call could then
 * approve their own request. The relay target is now an admin chat, but we
 * still prefer the INITIATING chat when that chat itself is in
 * `access.admins`:
 *
 *   1. If `initiatingChatId` is itself an admin, prompt that admin.
 *      Closes the multi-admin gap where admin[1+] never sees prompts for
 *      their own tool calls. Admin self-approval is fine — the original
 *      security hole was specifically guest self-approval.
 *   2. Else if companion.default_chat_id is set AND admin, use it
 *      (operator can explicitly direct prompts to their preferred chat).
 *   3. Otherwise fall back to `access.admins[0]` — first admin in config.
 *   4. If no admins exist at all, return null (relay denies the request).
 *
 * The admins-membership check at step 2 is load-bearing beyond permission
 * prompts: it's what keeps a guest chat from masquerading as "the owner"
 * after the enable-then-disable path (`companion_enable` is ungated by
 * tier, so ANY chat can set `companion.default_chat_id` to itself, then a
 * later `companion_disable` leaves that stale value sitting in config). A
 * `default_chat_id` that isn't in `access.admins` is never trusted — it
 * falls through to `admins[0]` instead.
 *
 * Called per-tool-call inside the makeCanUseTool closure (bootstrap/index.ts),
 * so changes to either access.json or companion config take effect within
 * one read TTL (5s for access; instant for companion).
 */
export function resolveAdminChatId(
  access: Access,
  companion: CompanionConfig,
  initiatingChatId?: string | null,
): string | null {
  if (initiatingChatId && access.admins?.includes(initiatingChatId)) {
    return initiatingChatId
  }
  if (companion.default_chat_id && access.admins?.includes(companion.default_chat_id)) {
    return companion.default_chat_id
  }
  return access.admins?.[0] ?? null
}
