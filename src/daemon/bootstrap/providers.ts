import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { createProviderRegistry, type ProviderRegistry } from '../../core/provider-registry'
import { createClaudeAgentProvider } from '../../core/claude-agent-provider'
import { createCodexAgentProvider } from '../../core/codex-agent-provider'
import { buildSystemPrompt } from '../../core/prompt-builder'
import { assertMatrixComplete, capabilitiesFor, capabilityProviderIds } from '../../core/capability-matrix'
import type { ProviderId } from '../../core/conversation'
import type { PermissionMode } from '../../core/capability-matrix'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ConversationStore } from '../../core/conversation-store'
import type { AgentConfig, AgentProviderKind } from '../../lib/agent-config'
import type { Access } from '../../lib/access'
import type { CompanionConfig } from '../companion/config'
import { loadAccess } from '../../lib/access'
import { loadCompanionConfig } from '../companion/config'
import { findOnPath, probeBinaryVersion } from '../../lib/util'
import { findCodexBinary } from '../../lib/find-codex-binary'
import { checkCodexVersion } from './codex-version-check'
import { attemptCodexAutofix } from '../../lib/codex-autofix'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildOpenaiMcpSpecs, type McpStdioSpec } from './mcp-specs'
import { claudeSessionJsonlPath, codexSessionJsonlPaths } from './session-paths'
import type { BootstrapDeps } from './types'
import codexCliPkg from '@openai/codex/package.json' with { type: 'json' }

// Locate the wechat-cc source-mode install root (where package.json lives).
// Source mode: derived from this file's path. Compiled-binary mode (Bun's
// /$bunfs/...): existsSync(repoRoot/package.json) returns false → return null.
// Null → codex-autofix returns "unsafe" and the daemon falls back to bundled.
function wechatCcRepoRoot(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url))     // .../src/daemon/bootstrap
    const root = join(here, '..', '..', '..')                // .../<repo>
    if (existsSync(join(root, 'package.json'))) return root
    return null
  } catch {
    return null
  }
}

// Get the user's PATH-installed codex binary + version (skips wechat-cc's
// own bundled probe — that would loop back to ourselves). Used by
// codex-autofix to decide whether the bundled SDK needs realignment.
function detectUserCodexOnPath(): { path: string | null; version: string | null } {
  const path = findOnPath('codex')
  if (!path) return { path: null, version: null }
  const raw = probeBinaryVersion(path)
  if (!raw) return { path, version: null }
  // probeBinaryVersion returns "codex-cli 0.133.0" or similar; extract semver.
  const m = /(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/.exec(raw)
  return { path, version: m?.[1] ?? null }
}

export interface ProviderDeps {
  log: BootstrapDeps['log']
  stateDir: string
  ilink: Pick<BootstrapDeps['ilink'], 'askUser' | 'companion'>
  agentProviderKind?: AgentProviderKind
  configuredAgent: AgentConfig
  permissionMode: PermissionMode
  conversationStore: ConversationStore
  sdkOptionsForProject: (alias: string, path: string, tierProfile: import('../../core/user-tier').TierProfile, chatId: string, mcpEnv?: Record<string, string>, appendInstructions?: string) => Options
  claudeBin: string | undefined
  currentClaudeModel: () => string
  resolveAdminChatId: (access: Access, companion: CompanionConfig, initiatingChatId?: string | null) => string | null
  pluginMcp: Record<string, McpStdioSpec>
  wechatStdioForCodex: McpStdioSpec | null
  delegateStdioForCodex: McpStdioSpec | null
  wechatStdioForCursor: McpStdioSpec | null
  delegateStdioForCursor: McpStdioSpec | null
  wechatStdioForOpenai: McpStdioSpec | null
  delegateStdioForOpenai: McpStdioSpec | null
  wechatStdioForGemini: McpStdioSpec | null
}

export interface ProviderWiring {
  registry: ProviderRegistry
  defaultProviderId: ProviderId
  codexBinary: string | null
  codexVersionCheck: ReturnType<typeof checkCodexVersion> | null
}

export async function registerProviders(deps: ProviderDeps): Promise<ProviderWiring> {
  // Re-materialize the bare locals the moved blocks reference, so their bodies
  // stay byte-identical to the original buildBootstrap code.
  const {
    configuredAgent, permissionMode, conversationStore, sdkOptionsForProject,
    claudeBin, currentClaudeModel, resolveAdminChatId, pluginMcp,
    wechatStdioForCodex, delegateStdioForCodex, wechatStdioForCursor,
    delegateStdioForCursor, wechatStdioForOpenai, delegateStdioForOpenai,
    wechatStdioForGemini,
  } = deps
  const HOME = homedir()

  const defaultProviderId: ProviderId = deps.agentProviderKind
    ?? (process.env.WECHAT_AGENT_PROVIDER === 'codex' ? 'codex' : configuredAgent.provider)

  // RFC 03 P2 — register BOTH providers up front, regardless of which one
  // is the current default. Per-chat /cc and /codex slash commands flip
  // chats independently; the registry is the source of truth for what's
  // dispatchable. Construction is cheap (no subprocess until first
  // acquire), so we don't gate codex behind any "is the binary installed"
  // check — that's reported by `wechat-cc doctor` separately.
  // RFC 03 §3.6 / C7 — auth-agnostic. We do NOT pass `apiKey` to the codex
  // provider; the user's `codex login` or OPENAI_API_KEY env are honored
  // transparently by the SDK.
  const registry = createProviderRegistry()
  registry.register(
    'claude',
    createClaudeAgentProvider({
      sdkOptionsForProject,
      // Threaded into cheapEval's query() call so the bun-compile
      // findClaudePath() trap doesn't bite the chatroom moderator path
      // (same protection the legacy haiku-eval helper provided).
      ...(claudeBin ? { claudeBin } : {}),
      // strongEval (the /chat verdict) runs on the live default model, not
      // haiku — synthesis quality matters more than cost there.
      strongModel: currentClaudeModel,
    }),
    {
      displayName: 'Claude',
      canResume: (cwd, sid) => existsSync(claudeSessionJsonlPath(HOME, cwd, sid)),
    },
  )
  // Auto-fix codex SDK to match the user's PATH codex CLI version when
  // they diverge. This lets a user-driven `npm i -g @openai/codex@X`
  // propagate into wechat-cc's bundled SDK without waiting for a
  // wechat-cc release. See src/lib/codex-autofix.ts for safety constraints.
  //
  // Fire-and-forget: we DO NOT await. A `bun add` against a slow npm
  // registry can take many seconds (and was observed to hang outright);
  // blocking daemon boot on it produces a daemon that appears dead. By
  // detaching the promise, boot continues with the bundled SDK in
  // memory and the on-disk node_modules realigns in the background. The
  // SDK swap takes effect on the NEXT daemon restart (the in-memory
  // SDK was already required() before this function ran, so even an
  // awaited fix wouldn't swap it within this process).
  //
  // Inner timeout (default 90s) + spawn-hard-kill (100s) protect against
  // a permanently hung `bun add` zombie.
  void attemptCodexAutofix({
    installDir: wechatCcRepoRoot(),
    bundledSdkVersion: codexCliPkg.version,
    detectUserCodex: () => detectUserCodexOnPath(),
    envDisabled: process.env.WECHAT_CC_DISABLE_CODEX_AUTOFIX === '1',
    log: (line) => deps.log('CODEX_AUTOFIX', line),
  }).then((outcome) => {
    switch (outcome.status) {
      case 'fixed':
        deps.log('CODEX_AUTOFIX',
          `done: ${outcome.from} → ${outcome.to}. Restart daemon to use the new SDK.`)
        break
      case 'failed':
        deps.log('CODEX_AUTOFIX',
          `failed (${outcome.from} → ${outcome.to}): ${outcome.reason}. ` +
          `Continuing with bundled v${outcome.from}.`)
        break
      case 'timed_out':
        deps.log('CODEX_AUTOFIX',
          `timed out after ${Math.floor(outcome.timeoutMs / 1000)}s (${outcome.from} → ${outcome.to}). ` +
          `Bun add killed. Continuing with bundled v${outcome.from}; investigate npm/network.`)
        break
      case 'unsafe':
        deps.log('CODEX_AUTOFIX', `skipped: ${outcome.reason}. Bundled SDK in use.`)
        break
      case 'disabled':
      case 'matched':
      case 'no_user_codex':
        // Silent — these are the common "nothing to do" outcomes.
        break
    }
  }).catch((err) => {
    deps.log('CODEX_AUTOFIX', `unexpected error in background auto-fix: ${err}`)
  })

  // Conditional codex registration (v0.5.6) — find a real codex CLI on disk.
  // The Codex SDK's internal `findCodexPath()` uses moduleRequire.resolve()
  // which can't see real node_modules from inside the bun-compiled bundle
  // (its `import.meta.url` is `/$bunfs/...`), so we MUST pass `codexPathOverride`.
  // When no codex is on disk we just don't register the provider — setMode
  // codex then 4xx's at validateMode (visible in dashboard as a red dropdown
  // border + revert) instead of silently swallowing dispatch errors per turn.
  const codexBinary = findCodexBinary()
  // Boot-time SDK ↔ CLI version match. The codex wire protocol is version-
  // locked: a mismatched CLI (e.g. globally-installed `codex` 0.125 paired
  // with our bundled SDK 0.128) silently emits events the SDK can't decode
  // and every dispatch returns empty assistantText (no reply, no error —
  // see src/lib/find-codex-binary.ts:81-86). Better to refuse registration
  // loudly than ship a provider that will silently never reply.
  const codexVersionCheck = codexBinary
    ? checkCodexVersion({
        binary: codexBinary,
        probe: probeBinaryVersion,
        expectedVersion: codexCliPkg.version,
      })
    : null
  if (codexBinary && codexVersionCheck?.ok) {
    deps.log('BOOT', `codex binary: ${codexBinary} (v${codexVersionCheck.actualSemver})`)
    registry.register(
      'codex',
      createCodexAgentProvider({
        codexPathOverride: codexBinary,
        // Construction-time model default ONLY from CODEX_MODEL. Do NOT fall back
        // to configuredAgent.model — that is the CONFIGURED provider's model, so
        // on a claude-default install it's a claude id (e.g. claude-opus-4-8),
        // which codex rejects ("model not supported") → every codex turn exits 1
        // (breaks /codex, /both, /chat). When the configured provider IS codex,
        // the pinned model is supplied per-spawn via currentModelFor('codex')
        // (SpawnContext.model); otherwise codex uses its own SDK default.
        ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
        // Task 6: sandboxMode + approvalPolicy moved out of CodexAgentProviderOptions —
        // they're now derived per-spawn from spawnOpts.tierProfile inside the provider.
        // admin tier maps to danger-full-access + never (matches the old --dangerously
        // posture); trusted → workspace-write + never; guest → read-only + untrusted.
        // The dangerouslyBypassApprovalsAndSandbox flag stays here because it's a
        // provider-construction-time codex CLI config knob (not a per-thread option).
        // v0.5.7 — when daemon runs --dangerously, bypass MCP approval (else codex 0.128
        // cancels every mcp__wechat__reply with "user cancelled MCP tool call").
        dangerouslyBypassApprovalsAndSandbox: permissionMode === 'dangerously',
        // Codex SDK has no system-prompt slot; the per-spawn instructions are
        // injected into the first user message by the provider from
        // SpawnContext.appendInstructions (assembled by buildInstructions
        // below), so nothing is baked at construction here.
        mcpServers: {
          ...(wechatStdioForCodex ? { wechat: wechatStdioForCodex } : {}),
          ...(delegateStdioForCodex ? { delegate: delegateStdioForCodex } : {}),
          ...pluginMcp,
        },
      }),
      {
        displayName: 'Codex',
        canResume: (_cwd, sid) => codexSessionJsonlPaths(HOME, sid).some(p => existsSync(p)),
      },
    )
  } else if (codexBinary && codexVersionCheck && !codexVersionCheck.ok) {
    // VERSION MISMATCH: user has codex installed, but its protocol version
    // doesn't match our bundled SDK. Three resolution paths:
    //   - Wait for codex-autofix (running in background since boot start;
    //     it'll `bun add @openai/codex-sdk@<userVer>` to realign).
    //     Restart daemon after autofix completes.
    //   - Manually downgrade global: `npm i -g @openai/codex@<expected>`.
    //   - Manually upgrade wechat-cc: `bun add @openai/codex-sdk@<userVer>
    //     @openai/codex@<userVer>` in the wechat-cc install dir.
    deps.log('BOOT',
      `codex provider NOT registered — version mismatch. ` +
      `Your codex CLI at ${codexBinary} is ` +
      `v${codexVersionCheck.actualSemver ?? codexVersionCheck.rawVersion ?? '(unreadable)'}, ` +
      `but wechat-cc's bundled SDK expects v${codexVersionCheck.expectedVersion}. ` +
      `The codex SDK ↔ CLI protocol is version-locked (silent fail otherwise). ` +
      `Resolution: (a) wait for the background auto-fix to realign SDK to your CLI version, then restart daemon; ` +
      `or (b) downgrade global codex: \`npm i -g @openai/codex@${codexVersionCheck.expectedVersion}\`.`,
    )
  } else {
    // NOT INSTALLED: no codex on PATH or in ~/.nvm. Tell the user the
    // exact one-time setup. We deliberately don't bundle codex (post
    // Task #18) — `codex login` is required for auth anyway, and bundling
    // hid which version was actually in use.
    deps.log('BOOT',
      `codex provider NOT registered — codex CLI not installed. ` +
      `To enable codex / /both / /chat modes:\n` +
      `  1. \`npm i -g @openai/codex@${codexCliPkg.version}\`\n` +
      `  2. \`codex login\`  (one-time OAuth or API-key setup; auth lives in ~/.codex/)\n` +
      `  3. Restart daemon.`,
    )
  }

  // ──────────────────────────────────────────────────────────────
  // Cursor SDK provider — third registered provider.
  //
  // CURSOR_API_KEY is env-only — not stored in agent-config.json.
  // (Secret-on-disk in plaintext is a worse posture than an env var
  // in the operator's shell rc / systemd unit.) The SDK is loaded via
  // dynamic import so wechat-cc remains installable without
  // @cursor/sdk — operators who don't want Cursor can `bun remove
  // @cursor/sdk` and the registration silently skips.
  //
  // See docs/superpowers/specs/2026-05-23-cursor-sdk-provider-design.md.
  const cursorKey = process.env.CURSOR_API_KEY
  if (cursorKey && !configuredAgent.cursorModel) {
    // Cursor SDK's @cursor/sdk/dist/esm/options.d.ts says model is "required
    // for local agents" — local is the only mode wechat-cc uses today.
    // Fail-fast at boot with an actionable message rather than crash on
    // first dispatch when Agent.create rejects without a model.
    deps.log('BOOT',
      'cursor: CURSOR_API_KEY is set but cursorModel is not configured. ' +
      'Cursor SDK requires a model id for local agents. ' +
      'Run `wechat-cc provider set cursor --model composer-2` (or another id from `Cursor.models.list()`). ' +
      'Provider not registered.',
    )
  } else if (cursorKey) {
    try {
      const cursorMod = await import('@cursor/sdk') as unknown as import('../../core/cursor-agent-provider').CursorSdkNamespace
      const { createCursorAgentProvider } = await import('../../core/cursor-agent-provider')
      registry.register(
        'cursor',
        createCursorAgentProvider({
          sdk: cursorMod,
          apiKey: cursorKey,
          model: configuredAgent.cursorModel!,
          mcpServers: {
            ...(wechatStdioForCursor ? { wechat: wechatStdioForCursor } : {}),
            ...(delegateStdioForCursor ? { delegate: delegateStdioForCursor } : {}),
            ...pluginMcp,
          },
        }),
        {
          displayName: 'Cursor',
          // P1 ships with resume disabled — Agent.resume(agentId) is documented
          // but unverified in the spike beyond static types. Enable in a P1.1
          // follow-up after dogfooding.
          canResume: () => false,
        },
      )
      deps.log('BOOT', 'cursor: SDK + API key present — provider registered')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log('BOOT', `cursor: SDK not available (${msg}) — run \`bun add @cursor/sdk\` to enable; provider not registered`)
    }
  } else {
    deps.log('BOOT', 'cursor: CURSOR_API_KEY not set — provider not registered')
  }

  // ──────────────────────────────────────────────────────────────
  // OpenAI-compatible provider — fourth registered provider. Targets any
  // OpenAI-Chat-Completions-shaped endpoint (DeepSeek/Kimi/Qwen/OpenRouter/
  // Ollama, …) via the AI SDK. WECHAT_OPENAI_API_KEY is env-only (same
  // rationale as CURSOR_API_KEY above); base_url + model live in
  // agent-config.json (openaiBaseUrl/openaiModel) since they're not secret
  // and vary per backend. All three must be present or the provider is
  // skipped with a BOOT log line. The SDK modules are dynamic-imported so a
  // registration failure (missing dep, bad config) degrades to a log line
  // instead of crashing boot.
  const openaiKey = process.env.WECHAT_OPENAI_API_KEY
  if (openaiKey && configuredAgent.openaiBaseUrl && configuredAgent.openaiModel) {
    // Narrowed into locals: property access on `configuredAgent` doesn't
    // stay narrowed inside the `makeChatModel` closure below (TS only
    // preserves narrowing for local const bindings, not object properties).
    const openaiBaseUrl = configuredAgent.openaiBaseUrl
    const defaultOpenaiModel = configuredAgent.openaiModel
    try {
      const { createOpenAiAgentProvider } = await import('../../core/openai-agent-provider')
      const { createAiSdkChatModel } = await import('../../core/openai-chat-model')
      const { createMcpToolBridge } = await import('../../core/openai-mcp-bridge')
      registry.register(
        'openai',
        createOpenAiAgentProvider({
          // Built per-spawn (not once at construction) so an operator's
          // `/api <model>` pin — re-read via the mtime-cached config reader
          // through currentModelFor → SpawnContext.model — takes effect on
          // the NEXT session without a daemon restart. `model` is undefined
          // for background evals (cheapEval/strongEval) and for spawns before
          // any pin exists; both fall back to the boot-time configured model.
          // createAiSdkChatModel is cheap (just SDK client wiring, no
          // network), so constructing one per spawn is fine.
          makeChatModel: (model) => createAiSdkChatModel({
            baseURL: openaiBaseUrl,
            apiKey: openaiKey,
            model: model ?? defaultOpenaiModel,
          }),
          // Gated via buildOpenaiMcpSpecs so only wechat/delegate ever see
          // sessionEnv (WECHAT_SESSION_TOKEN) — third-party plugin MCP specs
          // must never receive the daemon's loopback bearer token. See
          // mcp-specs.ts buildOpenaiMcpSpecs doc comment.
          makeMcpBridge: async (sessionEnv) => createMcpToolBridge(
            buildOpenaiMcpSpecs(
              { wechat: wechatStdioForOpenai, delegate: delegateStdioForOpenai, pluginMcp },
              sessionEnv,
            ),
          ),
          log: deps.log,
        }),
        {
          displayName: 'OpenAI-compatible',
          // No resume support in v1 — same posture as cursor above.
          canResume: () => false,
        },
      )
      deps.log('BOOT', 'openai: base_url + model + WECHAT_OPENAI_API_KEY present — provider registered')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log('BOOT', `openai: registration failed (${msg}) — provider not registered`)
    }
  } else {
    deps.log('BOOT', 'openai: not configured (need WECHAT_OPENAI_API_KEY + openaiBaseUrl + openaiModel) — provider not registered')
  }

  // ──────────────────────────────────────────────────────────────
  // Gemini provider — fifth registered provider.
  //
  // GEMINI_API_KEY (or GOOGLE_API_KEY) is env-only — not stored in
  // agent-config.json. The @google/genai SDK is loaded via dynamic
  // import so wechat-cc remains installable without it — operators
  // who don't want Gemini can `bun remove @google/genai` and the
  // registration silently skips.
  //
  // geminiModel must be set via `wechat-cc provider set gemini
  // --model gemini-flash-latest` before the key is useful.
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  if (geminiKey && !configuredAgent.geminiModel) {
    deps.log('BOOT',
      'gemini: GEMINI_API_KEY is set but geminiModel is not configured. ' +
      'Run `wechat-cc provider set gemini --model gemini-flash-latest`. Provider not registered.',
    )
  } else if (geminiKey) {
    try {
      const { GoogleGenAI } = await import('@google/genai')
      const { createGeminiAgentProvider, makeGeminiToolGate, connectWechatMcp } = await import('../../core/gemini-agent-provider')
      const { lookup } = await import('../../core/capability-matrix')
      const genaiClient = new GoogleGenAI({ apiKey: geminiKey }) as unknown as import('../../core/gemini-agent-provider').GenaiClient
      const buildGate = makeGeminiToolGate({
        askUser: deps.ilink.askUser,
        adminFor: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(deps.stateDir), chatId),
        modeFor: (chatId) => conversationStore.get(chatId)?.mode.kind ?? 'solo',
        lookupBase: (mode, perm) => lookup(mode as never, 'gemini', perm),
      })
      registry.register(
        'gemini',
        createGeminiAgentProvider({
          genai: genaiClient,
          model: configuredAgent.geminiModel!,
          systemInstruction: buildSystemPrompt({
            providerId: 'gemini',
            peerProviderId: 'claude',
            companionEnabled: deps.ilink.companion.status().enabled,
            delegateAvailable: false,
          }),
          mcpConnect: () => {
            if (!wechatStdioForGemini) throw new Error('gemini: internalApi unavailable — cannot connect wechat MCP')
            return connectWechatMcp(wechatStdioForGemini)
          },
          buildGate,
          cheapModel: process.env.WECHAT_GEMINI_CHEAP_MODEL ?? 'gemini-flash-latest',
        }),
        { displayName: 'Gemini', canResume: () => false },
      )
      deps.log('BOOT', 'gemini: SDK + API key present — provider registered')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log('BOOT', `gemini: SDK not available (${msg}) — run \`bun add @google/genai\` to enable; provider not registered`)
    }
  } else {
    deps.log('BOOT', 'gemini: GEMINI_API_KEY not set — provider not registered')
  }

  // Fail-fast at boot if any registered provider is missing matrix rows.
  // Was previously a module-load self-call in capability-matrix with a
  // hardcoded ['claude', 'codex'] — added providers (gemini, cursor, …)
  // would silently slip past and only throw at first use in production.
  assertMatrixComplete(registry.list())

  return { registry, defaultProviderId, codexBinary, codexVersionCheck }
}
