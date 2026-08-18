/**
 * companionOfferEligible — the pure predicate behind the companion-offer
 * prompt section (owner-onboarding design §C1). Extracted out of
 * main.ts's `companionOfferFor` thunk (fix round 1, code review) so the
 * eligibility rule itself is unit-testable without spinning up
 * buildBootstrap — the bootstrap-level tests in bootstrap.test.ts only ever
 * stub this thunk, so a bug INSIDE it (the enable-first deadlock this file
 * fixes) was invisible to that suite.
 *
 * All three conditions (owner chat, companion off, past the "刚认识"
 * threshold) must hold:
 *   - owner chat: resolved via `resolveAdminChatId(access, companion, null)`
 *     — the SAME admins-membership-based rule the permission relay uses
 *     (NOT `companion.default_chat_id` compared directly, which is only
 *     ever set inside `companion_enable` — on a fresh install
 *     `default_chat_id` is null, so gating on it directly would mean the
 *     offer could never fire until companion had already been enabled once
 *     and later disabled: a chicken-and-egg deadlock covering exactly the
 *     fresh-install scenario this design targets). Because
 *     `resolveAdminChatId` falls back to `access.admins[0]` whenever
 *     `default_chat_id` is unset OR set to a chat that isn't an admin, this
 *     is guest-safe by construction: a guest chat can set
 *     `companion.default_chat_id` to itself via the ungated
 *     `companion_enable` tool and later `companion_disable`, but that
 *     stale value is never trusted unless the chat is ALSO in
 *     `access.admins` — see resolve-admin.ts's docstring.
 *   - companion off: `companion.enabled === false`.
 *   - past new-relationship: `inboundCount >= NEW_RELATIONSHIP_MSG_COUNT`
 *     — the SAME threshold `newRelationshipFor` compares on the opposite
 *     side, so the two prompt sections are naturally mutually exclusive.
 */
import type { Access } from '../../lib/access'
import { NEW_RELATIONSHIP_MSG_COUNT } from '../../lib/messages-store'
import type { CompanionConfig } from './config'
import { resolveAdminChatId } from './resolve-admin'

export interface CompanionOfferEligibleArgs {
  chatId: string
  access: Access
  companion: CompanionConfig
  inboundCount: number
}

export function companionOfferEligible(args: CompanionOfferEligibleArgs): boolean {
  const { chatId, access, companion, inboundCount } = args
  if (companion.enabled) return false
  const ownerChatId = resolveAdminChatId(access, companion, null)
  if (!ownerChatId || chatId !== ownerChatId) return false
  return inboundCount >= NEW_RELATIONSHIP_MSG_COUNT
}
