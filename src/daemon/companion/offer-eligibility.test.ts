import { describe, expect, it } from 'vitest'
import { companionOfferEligible } from './offer-eligibility'
import { defaultCompanionConfig } from './config'
import { NEW_RELATIONSHIP_MSG_COUNT } from '../../lib/messages-store'
import type { Access } from '../../lib/access'

function access(admins: string[]): Access {
  return { dmPolicy: 'allowlist', allowFrom: [], admins }
}

describe('companionOfferEligible', () => {
  it('is eligible on a FRESH INSTALL — admins set but default_chat_id still null — for the owner chat (breaks the enable-first deadlock)', () => {
    const eligible = companionOfferEligible({
      chatId: 'owner1',
      access: access(['owner1']),
      companion: { ...defaultCompanionConfig(), default_chat_id: null, enabled: false },
      inboundCount: NEW_RELATIONSHIP_MSG_COUNT,
    })
    expect(eligible).toBe(true)
  })

  it('is NOT eligible on a fresh install for any chat that is not an admin', () => {
    const eligible = companionOfferEligible({
      chatId: 'some-other-chat',
      access: access(['owner1']),
      companion: { ...defaultCompanionConfig(), default_chat_id: null, enabled: false },
      inboundCount: NEW_RELATIONSHIP_MSG_COUNT,
    })
    expect(eligible).toBe(false)
  })

  it('is NOT eligible when companion is already enabled', () => {
    const eligible = companionOfferEligible({
      chatId: 'owner1',
      access: access(['owner1']),
      companion: { ...defaultCompanionConfig(), default_chat_id: null, enabled: true },
      inboundCount: NEW_RELATIONSHIP_MSG_COUNT,
    })
    expect(eligible).toBe(false)
  })

  it('is NOT eligible when the inbound count is below NEW_RELATIONSHIP_MSG_COUNT', () => {
    const eligible = companionOfferEligible({
      chatId: 'owner1',
      access: access(['owner1']),
      companion: { ...defaultCompanionConfig(), default_chat_id: null, enabled: false },
      inboundCount: NEW_RELATIONSHIP_MSG_COUNT - 1,
    })
    expect(eligible).toBe(false)
  })

  it('is eligible right AT the threshold (boundary — mirrors newRelationshipFor\'s `<` on the opposite side)', () => {
    const eligible = companionOfferEligible({
      chatId: 'owner1',
      access: access(['owner1']),
      companion: { ...defaultCompanionConfig(), default_chat_id: null, enabled: false },
      inboundCount: NEW_RELATIONSHIP_MSG_COUNT,
    })
    expect(eligible).toBe(true)
  })

  it('guest-safety: a chat that set companion.default_chat_id to itself via the ungated companion_enable-then-disable path is NEVER eligible when it is not an admin — only the real admin is, even with that stale default_chat_id present', () => {
    const companion = { ...defaultCompanionConfig(), default_chat_id: 'guest-chat', enabled: false }
    const guestEligible = companionOfferEligible({
      chatId: 'guest-chat',
      access: access(['owner1']),
      companion,
      inboundCount: NEW_RELATIONSHIP_MSG_COUNT,
    })
    expect(guestEligible).toBe(false)

    const ownerEligible = companionOfferEligible({
      chatId: 'owner1',
      access: access(['owner1']),
      companion,
      inboundCount: NEW_RELATIONSHIP_MSG_COUNT,
    })
    expect(ownerEligible).toBe(true)
  })

  it('is NOT eligible for anyone when access has no admins at all', () => {
    const eligible = companionOfferEligible({
      chatId: 'owner1',
      access: access([]),
      companion: { ...defaultCompanionConfig(), default_chat_id: null, enabled: false },
      inboundCount: NEW_RELATIONSHIP_MSG_COUNT,
    })
    expect(eligible).toBe(false)
  })

  it('trusts a valid default_chat_id that IS an admin (multi-admin: operator explicitly directed the offer at their preferred admin chat)', () => {
    const eligible = companionOfferEligible({
      chatId: 'owner2',
      access: access(['owner1', 'owner2']),
      companion: { ...defaultCompanionConfig(), default_chat_id: 'owner2', enabled: false },
      inboundCount: NEW_RELATIONSHIP_MSG_COUNT,
    })
    expect(eligible).toBe(true)
    // The other admin, not the resolved owner chat, is not eligible.
    const otherAdminEligible = companionOfferEligible({
      chatId: 'owner1',
      access: access(['owner1', 'owner2']),
      companion: { ...defaultCompanionConfig(), default_chat_id: 'owner2', enabled: false },
      inboundCount: NEW_RELATIONSHIP_MSG_COUNT,
    })
    expect(otherAdminEligible).toBe(false)
  })
})
