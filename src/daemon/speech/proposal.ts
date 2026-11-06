import type { SpeechKind } from '../../domain/speech/kinds'
import type { ProactiveTurn } from '../companion/proactive-channel'

/** Authority comes from this registry, never from model output or payload. */
export const SPEECH_SOURCES = {
  agenda: { kind: 'companion' },
  gap: { kind: 'companion' },
  hunt: { kind: 'companion' },
  visit: { kind: 'companion', outing: true },
  guest: { kind: 'guest_visit' },
  letter: { kind: 'letter' },
  brief: { kind: 'brief', scheduled: true },
  recap: { kind: 'recap', scheduled: true },
  memory: { kind: 'memory_notice' },
  sticker: { kind: 'sticker' },
  social: { kind: 'social_story' },
} as const satisfies Record<string, { kind: SpeechKind; scheduled?: true; outing?: true }>
export type SpeechSource = keyof typeof SPEECH_SOURCES
export type ProposalValue = null | boolean | number | string | ProposalValue[] | { [key: string]: ProposalValue }
export interface SpeechProposal {
  id: string
  ref: string
  kind: SpeechKind
  recipient: string
  source: SpeechSource
  matterId?: string
  turnId?: string
  createdAt: number
  notBefore: number
  expiresAt?: number
  summary: string
  payloadRef: { [key: string]: ProposalValue }
  /** Model may select only one of these source-provided targets. */
  targets?: readonly string[]
}
export type ProductionResult = 'silent' | 'blocked' | 'failed' | 'unknown' | 'completed'
export interface SpeechSourceAdapter {
  /** Re-evaluate live source eligibility, including version/inbound changes. */
  validate(proposal: SpeechProposal): boolean | Promise<boolean>
  produce(proposal: SpeechProposal, outbound: ProactiveTurn, target?: string): Promise<ProductionResult>
}
export function sourceRules(p: SpeechProposal): { kind: SpeechKind; scheduled?: true; outing?: true } { return SPEECH_SOURCES[p.source] }
export function validateProposal(p: SpeechProposal): boolean {
  if (!Object.hasOwn(SPEECH_SOURCES, p.source) || sourceRules(p).kind !== p.kind) return false
  if (![p.id, p.ref, p.recipient].every(s => typeof s === 'string' && s.length > 0 && s.length <= 512)) return false
  if (typeof p.summary !== 'string' || p.summary.length > 1000) return false
  if (!Number.isFinite(p.createdAt) || !Number.isFinite(p.notBefore) || (p.expiresAt !== undefined && (!Number.isFinite(p.expiresAt) || p.expiresAt < p.createdAt))) return false
  const seen = new Set<object>()
  const data = (value: unknown, depth: number): boolean => {
    if (depth > 12) return false
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value !== 'object' || seen.has(value)) return false
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false
    seen.add(value)
    const ok = Object.values(value).every(v => data(v, depth + 1))
    seen.delete(value)
    return ok
  }
  return data(p.payloadRef, 0) && JSON.stringify(p.payloadRef).length <= 16_384
}

/** Approved C: earliest expiry, then creation, then id; no deadline last. */
export function fallbackProposal(proposals: readonly SpeechProposal[]): SpeechProposal | undefined {
  return [...proposals].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
}
