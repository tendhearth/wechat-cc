/**
 * Capability matrix — single source of truth for the runtime semantics of
 * every (mode × provider × permissionMode) combination.
 *
 * Consumed by:
 *   - core/conversation-coordinator.ts  → assertSupported() at dispatch entry
 *   - core/permission-relay.ts          → lookup().askUser to gate per-tool prompts
 *   - core/codex-agent-provider.ts +    → lookup().approvalPolicy at provider build
 *     daemon/bootstrap/index.ts
 *   - daemon/internal-api/routes.ts     → lookup().replyPrefix for [Display] prefixing
 *
 * Boot-time assertion: `assertMatrixComplete(providers)` is called from
 * `buildBootstrap()` with the live `registry.list()` so the set of providers
 * is derived at runtime. If any (mode × provider × permissionMode) row is
 * missing for a registered provider, bootstrap throws — daemon refuses to
 * start. This is intentional: better to fail at startup than route a wrong
 * combination at runtime.
 *
 * Adding a provider: register it on `ProviderRegistry`, then add 8 new rows
 * to MATRIX (4 modes × 2 permission modes). The bootstrap assertion will
 * catch any missing row at the next start.
 */
// src/core/capability-matrix.ts

import type { Mode, ProviderId } from './conversation'
import type { ProviderCapabilities, PermissionMode } from './agent-provider'
import { CLAUDE_CAPABILITIES } from './claude-agent-provider'
import { CODEX_CAPABILITIES } from './codex-agent-provider'
import { CURSOR_CAPABILITIES } from './cursor-agent-provider'

// Backwards-compat re-export: PermissionMode used to live here. Moved
// to agent-provider.ts to break the cycle introduced by Phase 2's
// matrix imports of CAPABILITIES from each provider module.
export type { PermissionMode }

export interface Capability {
  /** 'per-tool' = Claude canUseTool 回调；'never' = 无 per-tool 提示。 */
  askUser: 'per-tool' | 'never'

  /** 'always'=parallel/chatroom；'never'=solo；'on-fallback-only'=primary_tool */
  replyPrefix: 'always' | 'never' | 'on-fallback-only'

  /** Codex SDK approval_policy；non-codex 行为 null。 */
  approvalPolicy: 'untrusted' | 'on-request' | 'never' | null

  /** delegate_<peer> MCP tool 是否加载到本 provider session。 */
  delegate: 'loaded' | 'unloaded'

  /** 显式禁用标志。v1.0 全 false；将来按策略收紧。 */
  forbidden: boolean

  /** 错误消息 + 文档辅助。 */
  notes: string
}

export interface MatrixRow extends Capability {
  mode: Mode['kind']
  provider: ProviderId
  permissionMode: PermissionMode
}

/**
 * Per (mode × permissionMode) trait — invariant across providers. The
 * provider-specific bits (askUser actually realisable? approvalPolicy
 * actually meaningful?) are layered on top inside `deriveCapability`.
 *
 * RFC 05 Phase 2: this replaces the 24-row hand-written CAPABILITY_MATRIX
 * with 8 trait rows + per-provider Capability declarations. Adding a
 * provider (gemini-cli, ...) now means declaring its `ProviderCapabilities`
 * once, not authoring 8 matrix rows.
 */
interface ModeTrait {
  /** Realisable askUser value when the provider has perToolCallback. */
  askUser: 'per-tool' | 'never'
  replyPrefix: 'always' | 'never' | 'on-fallback-only'
  /** Coarse approval-policy value used by SDKs without perToolCallback
   *  AND with a 'read-only' sandbox level (Codex). */
  coarseApproval: 'untrusted' | 'never'
  forbidden: boolean
}

const MODE_TRAITS: Record<Mode['kind'], Record<PermissionMode, ModeTrait>> = {
  solo: {
    strict:      { askUser: 'per-tool', replyPrefix: 'never',           coarseApproval: 'untrusted', forbidden: false },
    dangerously: { askUser: 'never',    replyPrefix: 'never',           coarseApproval: 'never',     forbidden: false },
  },
  parallel: {
    strict:      { askUser: 'per-tool', replyPrefix: 'always',          coarseApproval: 'untrusted', forbidden: false },
    dangerously: { askUser: 'never',    replyPrefix: 'always',          coarseApproval: 'never',     forbidden: false },
  },
  primary_tool: {
    strict:      { askUser: 'per-tool', replyPrefix: 'on-fallback-only', coarseApproval: 'untrusted', forbidden: false },
    dangerously: { askUser: 'never',    replyPrefix: 'on-fallback-only', coarseApproval: 'never',     forbidden: false },
  },
  chatroom: {
    strict:      { askUser: 'per-tool', replyPrefix: 'always',          coarseApproval: 'untrusted', forbidden: false },
    dangerously: { askUser: 'never',    replyPrefix: 'always',          coarseApproval: 'never',     forbidden: false },
  },
}

/**
 * Static registry of provider-id → capabilities. Adding a new provider
 * = one row here + the CAPABILITIES export on the provider module. The
 * `assertMatrixComplete` boot-time check still fails fast if a registered
 * provider has no row.
 */
const CAPABILITIES_BY_PROVIDER: Record<ProviderId, ProviderCapabilities> = {
  claude: CLAUDE_CAPABILITIES,
  codex:  CODEX_CAPABILITIES,
  cursor: CURSOR_CAPABILITIES,
}

/**
 * Look up a provider's capability declaration. Throws on unknown id so
 * `assertMatrixComplete` can surface missing registrations at boot.
 */
export function capabilitiesFor(provider: ProviderId): ProviderCapabilities {
  const cap = CAPABILITIES_BY_PROVIDER[provider]
  if (!cap) {
    throw new Error(`capability-matrix: no ProviderCapabilities registered for provider=${provider}`)
  }
  return cap
}

/**
 * Derive the full Capability for a (provider × mode × permissionMode)
 * combination from the provider's static ProviderCapabilities plus the
 * mode trait. This is the engine `lookup()` is built on; pure function,
 * no I/O, no global state.
 */
export function deriveCapability(
  cap: ProviderCapabilities,
  mode: Mode['kind'],
  pm: PermissionMode,
): Capability {
  const trait = MODE_TRAITS[mode][pm]
  // askUser realisable only on SDKs with per-tool callback. Without it,
  // strict mode still has trait.askUser='per-tool' nominally, but the
  // provider can't honor it — flatten to 'never'.
  const askUser = cap.perToolCallback ? trait.askUser : 'never'
  // approvalPolicy is the codex-shaped coarse gate; meaningful only when
  // the SDK has no per-tool callback AND exposes a read-only sandbox
  // tier (so 'untrusted' has somewhere to land). Cursor lacks read-only
  // and Claude has perToolCallback — both return null.
  const approvalPolicy = !cap.perToolCallback && cap.sandboxLevels.has('read-only')
    ? trait.coarseApproval
    : null
  // delegate-mcp is loaded for every primary_tool session regardless of
  // whether the host provider itself can be a delegate target — the host
  // delegates OUT to others. supportsDelegation controls whether THIS
  // provider can be registered as a peer (consumed by ProviderRegistry,
  // not by the matrix).
  const delegate = mode === 'primary_tool' ? 'loaded' : 'unloaded'
  return {
    askUser,
    replyPrefix: trait.replyPrefix,
    approvalPolicy,
    delegate,
    forbidden: trait.forbidden,
    notes: '',
  }
}

/**
 * Backwards-compatible flat view of the matrix — computed from
 * `deriveCapability` over every registered provider × all modes × both
 * permissionModes. Pre-Phase-2 callers (and tests that iterate via
 * `it.each(CAPABILITY_MATRIX)`) keep working without changes; the
 * 24-row hand-written constant they used to import is gone.
 */
const ALL_MODES: Mode['kind'][] = ['solo', 'parallel', 'primary_tool', 'chatroom']
const ALL_PERMS: PermissionMode[] = ['strict', 'dangerously']

function buildMatrix(): ReadonlyArray<MatrixRow> {
  const out: MatrixRow[] = []
  for (const provider of Object.keys(CAPABILITIES_BY_PROVIDER) as ProviderId[]) {
    const cap = CAPABILITIES_BY_PROVIDER[provider]!
    for (const mode of ALL_MODES) for (const permissionMode of ALL_PERMS) {
      out.push({ mode, provider, permissionMode, ...deriveCapability(cap, mode, permissionMode) })
    }
  }
  return out
}

export const CAPABILITY_MATRIX: ReadonlyArray<MatrixRow> = buildMatrix()

export function lookup(
  mode: Mode['kind'],
  provider: ProviderId,
  permissionMode: PermissionMode,
): Capability {
  // Resolve provider → capabilities first so an unknown provider id
  // surfaces a precise error (was an opaque "no row for" pre-Phase-2).
  let cap: ProviderCapabilities
  try {
    cap = capabilitiesFor(provider)
  } catch {
    throw new Error(`capability-matrix: no row for mode=${mode} provider=${provider} perm=${permissionMode}`)
  }
  return deriveCapability(cap, mode, permissionMode)
}

export class UnsupportedCombinationError extends Error {
  constructor(
    public readonly mode: Mode['kind'],
    public readonly provider: ProviderId,
    public readonly permissionMode: PermissionMode,
    public readonly notes: string,
  ) {
    super(`combination not supported: mode=${mode} provider=${provider} perm=${permissionMode}${
      notes ? ` — ${notes}` : ''
    }`)
    this.name = 'UnsupportedCombinationError'
  }
}

export function assertSupported(
  mode: Mode['kind'],
  provider: ProviderId,
  permissionMode: PermissionMode,
): void {
  const cap = lookup(mode, provider, permissionMode)
  if (cap.forbidden) {
    throw new UnsupportedCombinationError(mode, provider, permissionMode, cap.notes)
  }
}

/**
 * Verify the matrix has a row for every (mode × provider × permissionMode)
 * combination. Called from bootstrap with the live `registry.list()` so the
 * set of providers is derived at runtime instead of hardcoded — adding a
 * new provider (gemini, cursor, …) to ProviderRegistry now only requires
 * the matrix rows, not a parallel edit to this hardcoded list.
 *
 * Previously self-invoked at module load with `['claude','codex']`
 * baked in. The foot-gun: a new provider would silently pass the
 * module-load check (since the new id wasn't in the list) and only
 * throw at first use of the missing combination — possibly in
 * production. Moving the call to bootstrap fails-fast at boot.
 */
export function assertMatrixComplete(providers: ProviderId[]): void {
  // Post-Phase-2: verify every (mode × provider × pm) derives without
  // error, instead of searching a flat array. capabilitiesFor() throws
  // on unknown provider ids; deriveCapability is pure on every input.
  // (The legacy duplicate-row check is gone — the new model can't
  // produce duplicates because each row is computed from its unique
  // coordinate triple.)
  for (const p of providers) for (const m of ALL_MODES) for (const pm of ALL_PERMS) {
    let cap: ProviderCapabilities
    try {
      cap = capabilitiesFor(p)
    } catch {
      throw new Error(`capability-matrix missing row: mode=${m} provider=${p} perm=${pm}`)
    }
    // Surface any future deriveCapability throw with the offending coord
    // so debugging stays as easy as the pre-Phase-2 "missing row" path.
    try {
      deriveCapability(cap, m, pm)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`capability-matrix derive failed: mode=${m} provider=${p} perm=${pm}: ${msg}`)
    }
  }
}
