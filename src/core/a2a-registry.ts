/**
 * A2A registry — source of truth for registered external A2A agents.
 *
 * Loads from agent-config.json:a2a_agents at construction; provides
 * read APIs (list/get/verifyBearer) for the server + client modules
 * and mutation APIs (add/remove/setPaused) for the CLI + dashboard.
 *
 * Mutations write back to agent-config.json synchronously (the file is
 * the source of truth — in-memory cache mirrors disk). Per-mutation
 * file rewrites are fine: a2a_agents changes are operator-driven, not
 * a hot path.
 *
 * See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { A2AAgentRecord } from '../lib/agent-config'

/** Subset of A2AAgentRecord that's safe to patch via update(). `id` is the
 *  primary key and can't be changed; `capabilities` is derived from the
 *  Agent Card; `paused` has its own toggle. */
export type A2AAgentPatch = Partial<Pick<A2AAgentRecord, 'name' | 'url' | 'inbound_api_key' | 'outbound_api_key'>>

export interface A2ARegistry {
  list(): readonly A2AAgentRecord[]
  get(id: string): A2AAgentRecord | null
  verifyBearer(agentId: string, bearer: string): A2AAgentRecord | null
  add(rec: A2AAgentRecord): void
  remove(id: string): void
  setPaused(id: string, paused: boolean): void
  /** Patch one or more fields on an existing agent. Throws if id not found
   *  or if the resulting record fails validation (e.g. empty key). Returns
   *  the updated record. */
  update(id: string, patch: A2AAgentPatch): A2AAgentRecord
}

export interface A2ARegistryOpts {
  stateDir: string
}

export function createA2ARegistry(opts: A2ARegistryOpts): A2ARegistry {
  const configPath = join(opts.stateDir, 'agent-config.json')

  function loadAll(): A2AAgentRecord[] {
    if (!existsSync(configPath)) return []
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { a2a_agents?: A2AAgentRecord[] }
      return raw.a2a_agents ?? []
    } catch {
      return []
    }
  }

  function persistAll(agents: A2AAgentRecord[]): void {
    // Read full config so we don't lose other top-level fields.
    let raw: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      try {
        raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      } catch {
        raw = {}
      }
    }
    raw.a2a_agents = agents
    writeFileSync(configPath, JSON.stringify(raw, null, 2))
  }

  let cache = loadAll()

  return {
    list: () => cache,
    get: (id) => cache.find(a => a.id === id) ?? null,
    verifyBearer: (agentId, bearer) => {
      const agent = cache.find(a => a.id === agentId)
      if (!agent) return null
      // Constant-time string compare to mitigate timing side-channels on key check.
      // For 16-byte hex keys the timing leak is theoretical but cheap to defend.
      if (!constantTimeEquals(agent.inbound_api_key, bearer)) return null
      return agent
    },
    add: (rec) => {
      if (cache.some(a => a.id === rec.id)) throw new Error(`a2a agent '${rec.id}' already exists`)
      cache = [...cache, rec]
      persistAll(cache)
    },
    remove: (id) => {
      if (!cache.some(a => a.id === id)) throw new Error(`a2a agent '${id}' not found`)
      cache = cache.filter(a => a.id !== id)
      persistAll(cache)
    },
    setPaused: (id, paused) => {
      const ix = cache.findIndex(a => a.id === id)
      if (ix < 0) throw new Error(`a2a agent '${id}' not found`)
      cache = cache.map((a, i) => i === ix ? { ...a, paused } : a)
      persistAll(cache)
    },
    update: (id, patch) => {
      const ix = cache.findIndex(a => a.id === id)
      if (ix < 0) throw new Error(`a2a agent '${id}' not found`)
      // Validate before persist — mirrors the rules from A2AAgentRecord schema.
      // inbound_api_key min 16 chars (matches the schema); other strings non-empty.
      if (patch.name !== undefined && patch.name.length === 0) throw new Error(`name must be non-empty`)
      if (patch.url !== undefined && patch.url.length === 0) throw new Error(`url must be non-empty`)
      if (patch.inbound_api_key !== undefined && patch.inbound_api_key.length < 16) {
        throw new Error(`inbound_api_key must be at least 16 chars`)
      }
      if (patch.outbound_api_key !== undefined && patch.outbound_api_key.length === 0) {
        throw new Error(`outbound_api_key must be non-empty`)
      }
      const next = { ...cache[ix]!, ...patch }
      cache = cache.map((a, i) => i === ix ? next : a)
      persistAll(cache)
      return next
    },
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
