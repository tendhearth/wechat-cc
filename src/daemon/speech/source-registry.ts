import type { SpeechProposal, SpeechSource, SpeechSourceAdapter } from './proposal'
import { validateProposal } from './proposal'

/** Only adapters registered by daemon wiring can produce an outbound turn. */
export function makeSpeechSourceRegistry() {
  const adapters = new Map<SpeechSource, SpeechSourceAdapter>()
  return {
    register(source: SpeechSource, adapter: SpeechSourceAdapter): void {
      if (adapters.has(source)) throw new Error(`speech source already registered: ${source}`)
      adapters.set(source, adapter)
    },
    get(proposal: SpeechProposal): SpeechSourceAdapter | null {
      return validateProposal(proposal) ? adapters.get(proposal.source) ?? null : null
    },
  }
}
export type SpeechSourceRegistry = ReturnType<typeof makeSpeechSourceRegistry>
