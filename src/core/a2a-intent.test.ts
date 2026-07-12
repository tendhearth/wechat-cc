import { describe, expect, it } from 'vitest'
import { IntentCardSchema, MatchReceiptSchema, newIntentId } from './a2a-intent'

describe('a2a-intent schemas', () => {
  it('accepts a valid seek Intent Card', () => {
    const card = { intent_id: newIntentId(), kind: 'seek', topic: '找周末拍照搭子', city: '南京', expires_at: new Date(0).toISOString() }
    expect(IntentCardSchema.parse(card)).toMatchObject({ kind: 'seek', topic: '找周末拍照搭子' })
  })
  it('rejects an Intent Card with an empty topic', () => {
    const card = { intent_id: newIntentId(), kind: 'seek', topic: '', expires_at: new Date(0).toISOString() }
    expect(() => IntentCardSchema.parse(card)).toThrow()
  })
  it('accepts a yes Match Receipt with a blurb and a no Receipt without', () => {
    const id = newIntentId()
    expect(MatchReceiptSchema.parse({ intent_id: id, match: 'yes', blurb: '我主人也爱摄影' }).match).toBe('yes')
    expect(MatchReceiptSchema.parse({ intent_id: id, match: 'no' }).match).toBe('no')
  })
  it('newIntentId returns a non-empty unique-ish string', () => {
    expect(newIntentId()).not.toBe(newIntentId())
  })
})
