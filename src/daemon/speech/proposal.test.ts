import { expect, it } from 'vitest'
import { makeSpeechSourceRegistry } from './source-registry'
import { fallbackProposal, validateProposal, type SpeechProposal } from './proposal'
const proposal = (overrides: Partial<SpeechProposal> = {}): SpeechProposal => ({ id: 'a', ref: 'letter:a', source: 'letter', kind: 'letter', recipient: 'owner', createdAt: 100, notBefore: 100, summary: 'A letter is due', payloadRef: { letterId: 'a', version: 1 }, ...overrides })
it('accepts bounded source data and rejects caller-chosen authority or executable payload', () => {
  expect(validateProposal(proposal())).toBe(true)
  expect(validateProposal(proposal({ kind: 'letter_asked' }))).toBe(false)
  expect(validateProposal(proposal({ source: 'invented' as SpeechProposal['source'] }))).toBe(false)
  expect(validateProposal(proposal({ payloadRef: { run: (() => {}) as never } }))).toBe(false)
  expect(validateProposal(proposal({ expiresAt: 99 }))).toBe(false)
  expect(validateProposal(proposal({ summary: 'x'.repeat(1001) }))).toBe(false)
})
it('fallback C picks exactly one by expiry, creation and stable id', () => {
  const noDeadline = proposal({ id: 'old', createdAt: 0 })
  const a = proposal({ id: 'a', createdAt: 100, expiresAt: 200 })
  const b = proposal({ id: 'b', createdAt: 100, expiresAt: 200 })
  expect(fallbackProposal([noDeadline, b, a])).toEqual(a)
  expect(fallbackProposal([a, proposal({ id: 'earlier', expiresAt: 199 })])?.id).toBe('earlier')
  expect(fallbackProposal([noDeadline, proposal({ id: 'newer' })])).toEqual(noDeadline)
  expect(fallbackProposal([])).toBeUndefined()
})

it('only a registered source with its central kind can obtain an adapter', () => {
  const registry = makeSpeechSourceRegistry()
  const adapter = { validate: () => true, produce: async () => 'silent' as const }
  expect(registry.get(proposal())).toBeNull()
  registry.register('letter', adapter)
  expect(registry.get(proposal())).toBe(adapter)
  expect(registry.get(proposal({ kind: 'letter_asked' }))).toBeNull()
  expect(() => registry.register('letter', adapter)).toThrow('already registered')
})
