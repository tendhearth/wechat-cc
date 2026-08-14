/**
 * memory-llm-ops.ts — the daemon's LLM-backed memory operations (overview
 * synthesis + profile generation), wired with the daemon's OWN provider
 * cheapEval (claude path resolved correctly). Shared by BOTH the WeChat
 * admin-command path (pipeline-deps synthesizeMemory) and the internal-api
 * routes the desktop calls (routes-memory). This is the single place LLM
 * memory ops run — NEVER the compiled CLI sidecar (spec §1).
 */
import type { Db } from '../lib/db'

export interface MemoryLlmOpsDeps {
  stateDir: string
  db: Db
  getMode: (chatId: string) => { kind: string; provider?: string } | undefined
  registry: {
    get(id: string): { provider: { cheapEval?: (p: string) => Promise<string> } } | null | undefined
    getCheapEval(): ((p: string) => Promise<string>) | null
  }
}

export interface MemoryLlmOps {
  synthesize(adminChatId: string): Promise<import('../lib/memory-synthesis').SynthesizeResult>
  generateProfile(adminChatId: string): Promise<import('../lib/memory-synthesis').SynthesizeProfileResult>
}

export function makeMemoryLlmOps(deps: MemoryLlmOpsDeps): MemoryLlmOps {
  // Follow the admin conversation's provider; fall back to the registry's
  // cheapest eval. (Lifted verbatim from pipeline-deps synthesizeMemory.)
  const resolveCheapEval = (adminChatId: string) => {
    const mode = deps.getMode(adminChatId)
    const provider = mode && mode.kind === 'solo' ? mode.provider : undefined
    const cheapEval = (provider ? deps.registry.get(provider)?.provider.cheapEval : null) ?? deps.registry.getCheapEval()
    if (!cheapEval) throw new Error('no LLM provider available for synthesis')
    return cheapEval
  }
  return {
    async synthesize(adminChatId) {
      const { synthesizeOverview } = await import('../lib/memory-synthesis')
      const { makeLifeStoresReader } = await import('./life-stores')
      const cheapEval = resolveCheapEval(adminChatId)
      return synthesizeOverview({ stateDir: deps.stateDir, adminChatId, sdkEval: (p) => cheapEval(p), lifeStores: makeLifeStoresReader(deps.db, deps.stateDir), includeFileSurvey: true })
    },
    async generateProfile(adminChatId) {
      const { synthesizeProfile } = await import('../lib/memory-synthesis')
      const { makeLifeStoresReader } = await import('./life-stores')
      const mode = deps.getMode(adminChatId)
      const modelProvider = mode && mode.kind === 'solo' ? (mode.provider ?? 'claude') : 'claude'
      const cheapEval = resolveCheapEval(adminChatId)
      return synthesizeProfile({ stateDir: deps.stateDir, adminChatId, sdkEval: (p) => cheapEval(p), lifeStores: makeLifeStoresReader(deps.db, deps.stateDir), generatedBy: 'manual', modelProvider })
    },
  }
}
