/**
 * self-agent-id.ts — resolve this daemon's stable-unique self slug (spec §2).
 *
 * Fixes the dogfood gap where every daemon self-reported `wechat-cc`, so two
 * peers collided on the registry key. Precedence:
 *   1. WECHAT_A2A_SELF_ID env (back-compat with the manual escape hatch)
 *   2. config.self_agent_id (already generated + persisted)
 *   3. GRANDFATHER: config already has a2a_agents → persist+return 'wechat-cc'
 *      (freeze the id existing peers filed this daemon under — flipping to a
 *      unique slug would silently 401 every established edge; spec §2)
 *   4. mailbox configured + NO pre-existing peers (fresh daemon) → mint
 *      `cc-` + sha256(mailbox_addr)[:8hex], persist to agent-config.json
 *   5. legacy `wechat-cc` when NO mailbox is configured
 *
 * Step 4 only runs when mailbox_relays is configured AND there are no peers yet —
 * pairing (the sole caller that needs a real unique slug) requires a relay anyway,
 * and loadMailboxIdentity is side-effectful (writes mailbox-key.json), so neither a
 * push-only nor a grandfathered daemon may trip it.
 *
 * Persistence MERGES (read-modify-write of the raw config file, mirroring
 * a2a-registry.persistAll) — it sets ONLY self_agent_id and never touches
 * a2a_agents or unmodeled/legacy disk keys. This is load-bearing: callers may
 * pass a boot-snapshot config whose a2a_agents predates post-boot registry
 * writes; a full-object saveAgentConfig would wipe those peers off disk.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadMailboxIdentity } from './mailbox-crypto'
import type { AgentConfig } from '../lib/agent-config'

export interface ResolveSelfAgentIdDeps {
  env?: Record<string, string | undefined>
  loadIdentity?: (stateDir: string) => { addr: string }
  /** MERGE-persist: set only self_agent_id in the raw config file. Stubbable. */
  persist?: (stateDir: string, selfAgentId: string) => void
}

/** Read-modify-write the raw agent-config.json, setting ONLY self_agent_id.
 *  Preserves a2a_agents + every unmodeled key; atomic tmp+rename (0600). */
function persistSelfAgentId(stateDir: string, selfAgentId: string): void {
  const path = join(stateDir, 'agent-config.json')
  let raw: Record<string, unknown> = {}
  if (existsSync(path)) {
    try { raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> } catch { raw = {} }
  }
  raw.self_agent_id = selfAgentId
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function resolveSelfAgentId(config: AgentConfig, stateDir: string, deps: ResolveSelfAgentIdDeps = {}): string {
  const env = deps.env ?? process.env
  const fromEnv = env.WECHAT_A2A_SELF_ID
  if (fromEnv) return fromEnv
  if (config.self_agent_id) return config.self_agent_id
  const persist = deps.persist ?? persistSelfAgentId
  if (config.mailbox_relays?.length) {
    // Grandfather: keep the legacy shared id if this daemon already has edges.
    if (config.a2a_agents?.length) {
      persist(stateDir, 'wechat-cc')
      return 'wechat-cc'
    }
    const load = deps.loadIdentity ?? loadMailboxIdentity
    const addr = load(stateDir).addr
    const slug = 'cc-' + createHash('sha256').update(addr).digest('hex').slice(0, 8)
    persist(stateDir, slug)
    return slug
  }
  return 'wechat-cc'
}
