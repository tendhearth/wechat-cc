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
  /**
   * 这台机器上到底有没有 Claude Code。默认 true(向后兼容:既有调用方/测试
   * 不传就当有)。
   *
   * WHY:codex 和 openai 的 delegate 都是**建成了才进 providers**,唯独
   * claude 是无条件建的。于是一台没装 claude 的机器照样对外宣称能跑 claude
   * delegate —— bootstrap 开机明明打了「WARNING: no Claude Code binary found」,
   * 这里却当没看见。2026-09-02 真机上就是这样:委派过去只拿回
   * 「Claude Code process exited with code 1」。
   */
  claudeAvailable?: boolean
  /** Optional override path for the Codex CLI used by the bundled SDK. */
  codexPathOverride?: string
  /**
   * Boot logger (same shape as BootstrapDeps.log). Optional — defaults to a
   * no-op so existing callers (tests) that don't care about log lines don't
   * need to pass one. Used to surface a BOOT-visible line when the codex
   * delegate is skipped (see the codexPathOverride gate below).
   */
  log?: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /**
   * Test-only: pre-built delegate providers keyed by peer id, merged OVER the
   * built-in claude/codex/openai delegates. Lets a test route a peer to a fake
   * provider instead of spawning a subprocess / hitting the network. Production
   * callers never pass this.
   */
  delegateProviders?: Partial<Record<ProviderId, AgentProvider>>
  /**
   * busy-registry hold (spec 2026-08-11 §2, Task 4 step 3) — a delegate
   * dispatch is a one-shot session outside SessionManager, so without this
   * the idle self-restart check can't see it running. Held for the whole
   * dispatchDelegate call (spawn → dispatch → close), released even on
   * throw. ABSENT ⇒ no-op, exactly as before this feature existed.
   */
  holdBusy?: (label: string) => () => void
}

export type DelegateDispatch = (
  /**
   * 省略 ⇒ **由本机自己决定**用哪个 agent(见 dispatchDelegate 的实现)。
   *
   * 2026-09-02 真机实验:把一台只跑 openai-compatible(Kimi)、既没有 claude
   * 也没有 codex CLI 的机器配成 hand,委派立刻失败 —— 因为大脑那边写死了
   * `peer: 'claude'`。哪个 agent 跑在**那台机器上**,只有那台机器知道;大脑
   * 可以指定(「让 win 用 codex 跑」),但不指定时不该替它假设。
   */
  peer: ProviderId | undefined,
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

  // Bug #86 — mirror the openai branch below: only build the codex delegate
  // when bootstrap has already verified a real CLI (deps.codexPathOverride).
  // createCodexAgentProvider eagerly constructs the SDK (`new Codex()` inside
  // its factory), which calls the bundled SDK's findCodexPath(); on a
  // Bun-compiled desktop sidecar (/$bunfs/...) that throws because it can't
  // resolve @openai/codex from real node_modules. Building this
  // unconditionally meant a refused-or-absent codex CLI took the whole
  // daemon down at boot for claude-only users. Without an override, we skip
  // construction entirely — dispatchDelegate('codex', …) then falls through
  // to the unknown_peer branch below, same as any other unconfigured peer.
  const delegateCodex: AgentProvider | null = deps.codexPathOverride
    ? createCodexAgentProvider({
        // A Bun-compiled desktop sidecar cannot resolve the SDK's optional
        // platform package from /$bunfs. Reuse the verified user CLI path passed
        // by bootstrap, just as the main Codex provider does.
        codexPathOverride: deps.codexPathOverride,
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
    : (() => {
        deps.log?.('BOOT', 'codex delegate not registered — no verified codex CLI (codexPathOverride absent); delegate_codex will report unknown_peer')
        return null
      })()

  // openai-compatible backends (DeepSeek / Kimi / Qwen / GLM / Ollama / …) as a
  // bare delegate peer. Same clean-slate contract as claude/codex: an EMPTY MCP
  // bridge (no wechat tools → can't reply as the user; no delegate-mcp → can't
  // recurse); only the tier-gated fs/shell builtins remain. Built only when the
  // openai backend is fully configured (env key + base_url + model); otherwise
  // null, so `peer === 'openai'` reports unknown_peer like any unconfigured
  // provider. API key is env-only (WECHAT_OPENAI_API_KEY), mirroring
  // bootstrap/index.ts's main-provider registration.
  // 外部集成反馈 #3 (2026-08-26):配齐即全会话可 delegate 相当于给所有
  // 会话开了一条通往该端点的路;delegateOpenai:false 可关(默认 true 保持
  // 向后兼容 —— "端点只服务某一个会话"的场景显式关掉)。
  const openaiKey = process.env.WECHAT_OPENAI_API_KEY
  const delegateOpenai: AgentProvider | null =
    configuredAgent.delegateOpenai !== false && openaiKey && configuredAgent.openaiBaseUrl && configuredAgent.openaiModel
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
  const claudeAvailable = deps.claudeAvailable !== false
  if (!claudeAvailable) {
    deps.log?.('BOOT', 'claude delegate not registered — no Claude Code binary on this machine; 委派会点名本机实际可用的 provider')
  }
  const providers: Partial<Record<ProviderId, AgentProvider>> = {
    ...(claudeAvailable ? { claude: delegateClaude } : {}),
    ...(delegateCodex ? { codex: delegateCodex } : {}),
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
  /** 本机建成了 delegate 的 provider,按「配置的默认优先」排。 */
  const availablePeers = (): ProviderId[] => {
    const built = (Object.keys(providers) as ProviderId[]).filter(id => providers[id])
    const own = configuredAgent.provider as ProviderId | undefined
    return own && built.includes(own) ? [own, ...built.filter(id => id !== own)] : built
  }

  return async function dispatchDelegate(peer, prompt, cwd) {
    const available = availablePeers()
    // peer 省略 ⇒ 用本机自己的默认(配置的 provider 优先,否则任何一个建成的)。
    // 有手总比没手好:配了 agy 但 agy 的 delegate 没建成时,回落到建成的那个,
    // 而不是让整台机器当不了手。
    const chosen = peer ?? available[0]
    if (!chosen) return { ok: false, reason: 'no_delegate_provider: 这台机器没有任何可用的 delegate provider' }
    const provider = providers[chosen] ?? null
    // 点名它到底有什么。旧行为是照着请求去 spawn 一个不存在的 CLI,拿回
    // 「Claude Code process exited with code 1」—— 那条消息没有任何可行动
    // 的信息,而真相(这台机器上根本没装 claude)一个字都没说。
    if (!provider) return { ok: false, reason: `unknown_peer: ${chosen} —— 这台机器可用的是 [${available.join(', ') || '(无)'}]` }
    // busy-registry hold (spec 2026-08-11 §2, Task 4 step 3) — spans the
    // whole one-shot session below (spawn → dispatch → close), released in
    // the finally alongside session.close() regardless of outcome.
    let releaseBusy: (() => void) | undefined
    try { releaseBusy = deps.holdBusy?.('a2a-delegate') } catch { releaseBusy = undefined }
    const started = Date.now()
    let session: Awaited<ReturnType<typeof provider.spawn>> | null = null
    try {
      // Tier:**所有 provider 一视同仁**,都是 trusted。
      //
      // 2026-09-02 改。此前是 `peer === 'claude' ? trusted : guest`,理由写的是
      // 「非 claude 的 delegate 读多写少、consult 不 act」。两个问题:
      //
      // 1. **它没有实现自己声称的东西。** guest 的 GUEST_ALLOW 是
      //    {reply, share_page, memory_read, observations_read} —— **不含
      //    fs_read**。想要的是 read-only,拿到的是 read-nothing:真机上那台
      //    Kimi 手连自己机器上的 package.json 都读不了,自己报
      //    「工具 "Read" 未被授权使用」。一台读不了任何东西的"手"不是手。
      // 2. **它把安全边界放错了层。** 边界从来不是"哪个 provider",而是
      //    "谁能派活给我" —— 而那件事此前根本没检查(只验 bearer)。现在
      //    `/a2a/exec` 要求 `may_exec`(只有 hand accept / hand invite 那条
      //    两端都需 CLI 访问权的路径会写 true),边界回到了它该在的地方。
      //
      // 授权既然已经等价于一次 SSH 密钥交换(`daemon a2a enable` 自己就警告
      // 「treat the pairing token like a remote-shell key」),再按 provider
      // 分档就只是历史巧合 —— claude 早就是 trusted 了。
      //
      // 仍然**不是 admin**:daemon_remediate / config_admin 那一档留给本机
      // 操作者,派来的活不该能改我的 daemon 配置或重启我。
      //
      // chatId='_delegate' is a sentinel — delegate spawns are
      // daemon-initiated (not tied to any real chat). The delegate's
      // sdkOptionsForProject ignores chatId (no canUseTool wired), but
      // the AgentProvider contract requires the field.
      session = await provider.spawn(
        { alias: '_delegate', path: cwd ?? deps.stateDir },
        {
          tierProfile: TIER_PROFILES.trusted,
          // Delegate is always strict — there's no daemon-wide --dangerously
          // override path that reaches here (delegate is invoked headless
          // for one-shot consultations, not user-initiated dispatch).
          permissionMode: 'strict',
          chatId: '_delegate',
        },
      )
      const result = await collectTurn(session.dispatch(prompt))
      if (result.error) {
        return { ok: false, reason: result.errorCode ? `${result.errorCode}: ${result.error}` : result.error }
      }
      const response = result.assistantText.join('\n').trim()
      return { ok: true, response, duration_ms: Date.now() - started }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    } finally {
      if (session) {
        try { await session.close() } catch { /* swallow shutdown errors */ }
      }
      try { releaseBusy?.() } catch { /* release 幂等且不抛,防御性 */ }
    }
  }
}
