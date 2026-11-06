import { randomUUID } from 'node:crypto'
import { SPEECH_SOURCES, type SpeechProposal, type SpeechSource, type ProductionResult } from './proposal'
import { makeSpeechSourceRegistry } from './source-registry'
import type { SpeechPicker } from './picker'
import type { SpeechPolicy, SpeechProposalRequest } from './policy'
import type { ProactiveTurn } from '../../ports/proactive-turn'

/** A producer is an in-memory delivery adapter, never serialized into pending.
 * Durable source content remains in its archive; only its bounded reference is
 * persisted in a reservation. After restart sources resubmit their own state.
 */
export function makeProposalSubmissions(
  build: (sources: ReturnType<typeof makeSpeechSourceRegistry>, context: (candidates: readonly SpeechProposal[]) => Promise<object[]>) => SpeechPicker,
  now: () => number = Date.now,
): SpeechPolicy['propose'] {
  const sources = makeSpeechSourceRegistry()
  const pending = new Map<string, { req: SpeechProposalRequest; produce: (turn: ProactiveTurn, target?: string) => Promise<void | ProductionResult> }>()
  for (const source of Object.keys(SPEECH_SOURCES) as SpeechSource[]) {
    sources.register(source, {
      async validate(p, nowMs) {
        const entry = pending.get(p.id)
        if (entry?.req.getTargets && p.targets && JSON.stringify(entry.req.getTargets()) !== JSON.stringify(p.targets)) return false
        return !!entry && (!entry.req.perKind || entry.req.perKind.ok) && (!entry.req.validate || await entry.req.validate(nowMs))
      },
      async produce(p, turn, target) {
        const entry = pending.get(p.id)
        if (!entry) return 'blocked'
        return await entry.produce(turn, target) ?? 'completed'
      },
    })
  }
  const picker = build(sources, candidates => Promise.all(candidates.map(p => {
    const req = pending.get(p.id)?.req
    if (req?.getTargets) p.targets = [...req.getTargets()]
    return req?.context?.() ?? Promise.resolve({})
  })))
  return async (req, produce) => {
    if (req.source === 'requested') return { drop: true, reason: 'invalid_source' }
    const ref = req.ref ?? `${req.source}:${randomUUID()}`
    const id = ref
    if (pending.has(id)) return { defer: true, reason: 'duplicate' }
    const createdAt = req.createdAt ?? req.nowMs ?? now()
    const p: SpeechProposal = {
      id, ref, source: req.source, kind: req.kind, recipient: req.chatId,
      createdAt, notBefore: createdAt, summary: req.summary,
      payloadRef: req.payloadRef ?? {},
      ...(req.expiresAt === undefined ? {} : { expiresAt: req.expiresAt }),
      ...(req.targets ? { targets: [...req.targets] } : {}),
    }
    pending.set(id, { req, produce })
    try { return await picker.submit(p) } finally { pending.delete(id) }
  }
}
