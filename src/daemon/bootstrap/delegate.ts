/**
 * Bare delegate providers + one-shot dispatch (RFC 03 P4).
 *
 * Constructed separately from the registry's main providers because they
 * intentionally have NO mcpServers configured: a delegated peer must not
 * have access to wechat tools (would let it pretend to reply directly to
 * the user) or its own delegate-mcp (would allow recursion). Recursion
 * prevention is structural here, not counter-based.
 *
 * Each delegate call spawns a fresh thread; SessionManager isn't involved
 * because these are throwaway one-shot consultations.
 */
import { createClaudeAgentProvider } from '../../core/claude-agent-provider'
import { createCodexAgentProvider } from '../../core/codex-agent-provider'
import { createOpenAiAgentProvider } from '../../core/openai-agent-provider'
import { createAiSdkChatModel } from '../../core/openai-chat-model'
import { createMcpToolBridge } from '../../core/openai-mcp-bridge'
import { collectTurn, type AgentProvider } from '../../core/agent-provider'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderId } from '../../core/conversation'
import { loadAgentConfig } from '../../lib/agent-config'
import { TIER_PROFILES, type TierProfile } from '../../core/user-tier'

export interface DelegateBuildDeps {
  /** State dir — used as the default cwd when caller doesn't pass one. */
  stateDir: string
  /** Optional override path for the claude-code binary. */
  claudeBin?: string
  /** Optional override path for the Codex CLI used by the bundled SDK. */
  codexPathOverride?: string
  /**
   * Test-only: pre-built delegate providers keyed by peer id, merged OVER the
   * built-in claude/codex/openai delegates. Lets a test route a peer to a fake
   * provider instead of spawning a subprocess / hitting the network. Production
   * callers never pass this.
   */
  delegateProviders?: Partial<Record<ProviderId, AgentProvider>>
}

export type DelegateDispatch = (
  peer: ProviderId,
  prompt: string,
  cwd?: string,
) =>
  Promise<
    | { ok: true; response: string; num_turns?: number; duration_ms?: number }
    | { ok: false; reason: string }
  >

export function buildDelegateDispatch(deps: DelegateBuildDeps): DelegateDispatch {
  const configuredAgent = loadAgentConfig(deps.stateDir)

  // Pin Claude model from agent-config.json (or stable full ID fallback).
  // Same rationale as the main bootstrap: don't inherit `~/.claude/.claude.json`
  // model resolution into the daemon's spawned subprocess. See bootstrap/index.ts
  // for the 2026-05-08 incident write-up.
  const claudeModel = configuredAgent.provider === 'claude' && configuredAgent.model
    ? configuredAgent.model
    : 'claude-opus-4-8'

  const delegateClaude = createClaudeAgentProvider({
    sdkOptionsForProject: (_alias: string, path: string, _tierProfile: TierProfile, _chatId: string): Options => {
      const o: Options = {
        cwd: path,
        model: claudeModel,
        // Plain claude_code preset — no wechat-specific append. Peer
        // doesn't see wechat conversation history; it's a clean slate.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        // Same rationale as bootstrap/index.ts: don't inherit user-global
        // ~/.claude/settings.json into the daemon-spawned subprocess.
        settingSources: ['project', 'local'],
        // Safer than bypassPermissions: delegate is read-mostly. Skip
        // the permission relay too — there's no human to ask, and
        // delegated peers shouldn't be writing to disk anyway.
        permissionMode: 'default',
        ...(deps.claudeBin ? { pathToClaudeCodeExecutable: deps.claudeBin } : {}),
      }
      return o
    },
  })

  const delegateCodex = createCodexAgentProvider({
    // A Bun-compiled desktop sidecar cannot resolve the SDK's optional
    // platform package from /$bunfs. Reuse the verified user CLI path passed
    // by bootstrap, just as the main Codex provider does.
    ...(deps.codexPathOverride ? { codexPathOverride: deps.codexPathOverride } : {}),
    ...(process.env.CODEX_MODEL || configuredAgent.model
      ? { model: process.env.CODEX_MODEL ?? configuredAgent.model }
      : {}),
    // sandboxMode + approvalPolicy moved out of CodexAgentProviderOptions in
    // Task 6 — they're now derived per-spawn from spawnOpts.tierProfile inside
    // the provider. See the dispatchDelegate call below for the tier choice
    // and its rationale.
    //
    // Deliberately NO mcpServers — bare-bones is the structural
    // recursion-prevention guarantee.
  })

  // openai-compatible backends (DeepSeek / Kimi / Qwen / GLM / Ollama / …) as a
  // bare delegate peer. Same clean-slate contract as claude/codex: an EMPTY MCP
  // bridge (no wechat tools → can't reply as the user; no delegate-mcp → can't
  // recurse); only the tier-gated fs/shell builtins remain. Built only when the
  // openai backend is fully configured (env key + base_url + model); otherwise
  // null, so `peer === 'openai'` reports unknown_peer like any unconfigured
  // provider. API key is env-only (WECHAT_OPENAI_API_KEY), mirroring
  // bootstrap/index.ts's main-provider registration.
  const openaiKey = process.env.WECHAT_OPENAI_API_KEY
  const delegateOpenai: AgentProvider | null =
    openaiKey && configuredAgent.openaiBaseUrl && configuredAgent.openaiModel
      ? (() => {
          const baseURL = configuredAgent.openaiBaseUrl
          const defaultModel = configuredAgent.openaiModel
          return createOpenAiAgentProvider({
            makeChatModel: (model) =>
              createAiSdkChatModel({ baseURL, apiKey: openaiKey, model: model ?? defaultModel }),
            // Empty spec set → bridge with zero MCP tools (bare-bones).
            makeMcpBridge: async () => createMcpToolBridge({}),
          })
        })()
      : null

  // Built-in delegates by peer id; test overrides win (see DelegateBuildDeps).
  const providers: Partial<Record<ProviderId, AgentProvider>> = {
    claude: delegateClaude,
    codex: delegateCodex,
    ...(delegateOpenai ? { openai: delegateOpenai } : {}),
    ...(deps.delegateProviders ?? {}),
  }

  /**
   * Run a one-shot prompt against the bare delegate provider for `peer`.
   * Used by internal-api's /v1/delegate route. Spawns a fresh thread,
   * dispatches once, closes. Cold-start cost (~3-5s) per call is
   * accepted as the price of "consult the peer cleanly."
   *
   * `cwd` (RFC 03 review #10): when caller passes one, peer can Read /
   * Bash files there (e.g. the calling agent's project). Otherwise
   * peer runs in deps.stateDir (a stable location with no project
   * files), preserving the "ask, don't do" framing.
   */
  return async function dispatchDelegate(peer, prompt, cwd) {
    const provider = providers[peer] ?? null
    if (!provider) return { ok: false, reason: `unknown_peer: ${peer}` }
    const started = Date.now()
    let session: Awaited<ReturnType<typeof provider.spawn>> | null = null
    try {
      // Per-peer tier selection — restores the pre-Task-6 "read-mostly"
      // delegate posture for codex while keeping claude auto-allow:
      //   - Claude side: TIER_PROFILES.trusted → permissionMode='default'.
      //     The delegate path doesn't wire canUseTool, so trusted is
      //     functionally auto-allow (same as the prior delegate posture).
      //   - Codex side: TIER_PROFILES.guest → sandboxMode='read-only' +
      //     approvalPolicy='untrusted'. Matches the original "ask, don't
      //     do" intent — delegate codex consults, it doesn't act. The
      //     approval-policy difference vs the pre-Task-6 'never' is
      //     functionally equivalent in delegate context (no UI to answer
      //     either way), but the sandbox is now correctly read-only.
      //
      // chatId='_delegate' is a sentinel — delegate spawns are
      // daemon-initiated (not tied to any real chat). The delegate's
      // sdkOptionsForProject ignores chatId (no canUseTool wired), but
      // the AgentProvider contract requires the field.
      session = await provider.spawn(
        { alias: '_delegate', path: cwd ?? deps.stateDir },
        {
          // claude keeps its auto-allow (trusted) posture; every other bare
          // delegate (codex, openai/Kimi/…) is read-mostly "consult, don't
          // act" → guest (read-only fs, writes/shell denied by the gate).
          tierProfile: peer === 'claude' ? TIER_PROFILES.trusted : TIER_PROFILES.guest,
          // Delegate is always strict — there's no daemon-wide --dangerously
          // override path that reaches here (delegate is invoked headless
          // for one-shot consultations, not user-initiated dispatch).
          permissionMode: 'strict',
          chatId: '_delegate',
        },
      )
      const result = await collectTurn(session.dispatch(prompt))
      const response = result.assistantText.join('\n').trim()
      return { ok: true, response, duration_ms: Date.now() - started }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    } finally {
      if (session) {
        try { await session.close() } catch { /* swallow shutdown errors */ }
      }
    }
  }
}
