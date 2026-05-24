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

export interface A2ARegistry {
  list(): readonly A2AAgentRecord[]
  get(id: string): A2AAgentRecord | null
  verifyBearer(agentId: string, bearer: string): A2AAgentRecord | null
  add(rec: A2AAgentRecord): void
  remove(id: string): void
  setPaused(id: string, paused: boolean): void
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
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
