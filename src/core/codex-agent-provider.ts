import { Codex, type Thread, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk'
import { tmpdir } from 'node:os'
import { mergeEnvIntoMcpServers, CORE_MCP_SERVER_NAMES, type AgentEvent, type AgentProject, type AgentProvider, type AgentSession, type PermissionMode, type ProviderCapabilities, type SpawnContext } from './agent-provider'
import { resolveCodexCheapModel } from './codex-cheap-model'
import type { TierProfile } from './user-tier'
import type { McpStdioSpec } from './mcp-stdio-spec'
import { makeTurnEmitter } from './turn-emitter'
import { codexErrorCode, codexTimeoutsFromEnv, watchCodexEvents, type CodexTimeouts } from './codex-errors'
import { providerErrorCodeOf, withProviderCode } from '../lib/provider-error-code'
import { log } from '../lib/log'

/**
 * RFC 05 Phase 2 — Codex SDK has no per-tool callback (every dispatch
 * runs to completion against the SDK-level sandbox), so strict-mode
 * gating maps to coarse sandbox levels. All three levels supported.
 */
export const CODEX_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: false,
  adminMcpTools: true,
  sandboxLevels: new Set(['read-only', 'workspace-write', 'full']),
  supportsDelegation: true,
  supportsResume: true,
  defaultPeer: 'claude',
  authFailHint: '⚠ Codex 登录已过期，请在电脑上跑 `codex login` 后再发消息。',
}

export interface CodexTierSdkOpts {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'untrusted' | 'on-request' | 'never'
}

/**
 * Pure translation from (TierProfile, permissionMode) → Codex SDK options.
 *
 * Codex has no per-tool callback equivalent to Claude's canUseTool.
 * Tier enforcement is therefore coarser:
 *   - `permissionMode='dangerously'` → full access on every chat (operator
 *     opted into bypass; tier doesn't matter)
 *   - admin → workspace-write sandbox. Admin's destructive ops relay on
 *     the Claude side via canUseTool, but codex has no equivalent gate to
 *     honor that relay — so rather than hand admin unconditional
 *     danger-full-access, it drops to workspace-write (write within cwd,
 *     no approval). danger-full-access is `--dangerously`-only.
 *   - trusted → workspace-write sandbox (no admin UI to field
 *     'on-request' prompts, so we use 'never' approval — destructive
 *     ops within the workspace cwd are still possible; documented
 *     limitation)
 *   - guest → read-only sandbox + untrusted approval (functionally
 *     restricted to reading + replying)
 *
 * Pre-RFC-05 this function ignored `permissionMode` entirely and
 * derived everything from `TierProfile` shape — which silently broke
 * the `--dangerously` operator override for non-admin chats (C5).
 */
export function tierProfileToCodexSdkOpts(tp: TierProfile, permissionMode: PermissionMode): CodexTierSdkOpts {
  if (permissionMode === 'dangerously') {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
  }
  // strict mode. A profile that denies nothing AND relays nothing is the
  // full-bypass shape → danger-full-access.
  if (tp.deny.size === 0 && tp.relay.size === 0) {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
  }
  // Sandbox scope keys off what the tier can actually DO, not deny-set
  // cardinality: any tier that can write files and run shell (admin, trusted)
  // gets workspace-write; one that can't (guest — read/reply only) gets
  // read-only. The old `deny.size === 0` check mis-fired the moment a tier
  // denied a tool unrelated to fs/shell scope (e.g. the admin-only
  // daemon_introspect now in trusted.deny), collapsing trusted to read-only.
  if (tp.allow.has('fs_write') && tp.allow.has('shell')) {
    return { sandboxMode: 'workspace-write', approvalPolicy: 'never' }
  }
  return { sandboxMode: 'read-only', approvalPolicy: 'untrusted' }
}

/**
 * codex-agent-provider — Codex SDK companion to claude-agent-provider, using
 * @openai/codex-sdk's persistent Thread API. Replaces the old one-shot
 * `codex exec` cli-provider (RFC 03 §6).
 *
 * Auth-agnostic per RFC 03 §3.6 / C7: this provider does NOT accept an
 * `apiKey` field, and does NOT pass apiKey to `new Codex({...})`. The SDK
 * transparently inherits process.env into the spawned codex CLI, so users
 * get whichever auth path they have set up locally:
 *   - `codex login` → ~/.codex/auth.json (ChatGPT subscription)
 *   - OPENAI_API_KEY / CODEX_API_KEY in env (or ~/.codex/config.toml)
 *
 * Translation table from Codex SDK events to AgentEvents:
 *
 *   thread.started                              → { kind: 'init', sessionId }
 *   item.completed{type=agent_message}          → { kind: 'text', text }
 *   item.completed{type=mcp_tool_call}          → { kind: 'tool_call', server, tool }
 *   turn.completed                              → { kind: 'result', sessionId, numTurns, durationMs }
 *   turn.failed                                 → { kind: 'error', message, code }
 *   error                                       → { kind: 'error', message, code }
 *   error「Reconnecting...」                     → (不是终态:只记日志,见 codex-errors)
 *
 * `code` 是边界产的结构化码(codex-errors.codexErrorCode;arch backlog #4 第 2 步)。
 * 连不上时 codex 会无限期地发「Reconnecting... waiting for network」—— 两个边界超时
 * (codex-errors.CodexTimeouts)把这一轮以 `network` 收掉,不再一片沉默。
 */

// Auth-failure classification now lives in auth-fail.ts's sdk-error wide
// set (AUTH_FAIL_SDK_ERROR) — see makeTurnEmitter()'s errorText/error.

/** Test-time injection for the Codex constructor. */
export type CodexFactory = (opts: ConstructorParameters<typeof Codex>[0]) => Codex

export interface CodexAgentProviderOptions {
  /** Optional override for the codex CLI binary path; SDK default is the @openai/codex npm dep. */
  codexPathOverride?: string
  /** Maps to ThreadOptions.model. Falsy → SDK default. */
  model?: string
  /**
   * stdio MCP servers to load via SDK config flattening (RFC 03 §5.2).
   * Passed to `new Codex({ config: { mcp_servers: <this> } })`; the SDK
   * serialises each entry as `--config mcp_servers.<name>.<key>=<toml>`,
   * which the codex CLI parses into its TOML mcp_servers table on
   * startup. Spike 1 verifies the round-trip end-to-end.
   *
   * Auth-agnostic per RFC 03 §3.6 / C7: we do NOT pass the user's
   * apiKey via this channel either — env on the spawned MCP child
   * process is supplied by the caller via the `env` field.
   */
  mcpServers?: Record<string, McpStdioSpec>
  /**
   * v0.5.7 — when true, sets the codex CLI's
   * `dangerously_bypass_approvals_and_sandbox=true` config (equivalent to the
   * `--dangerously-bypass-approvals-and-sandbox` CLI flag). Without this,
   * codex 0.128.0 refuses MCP tool calls with `"user cancelled MCP tool
   * call"` even under `approval_policy="never"` + `sandbox="danger-full-access"`,
   * because MCP approval has its own gate that only the bypass key opens.
   * The daemon flips this on whenever the operator passed `--dangerously` so
   * codex can actually call `mcp__wechat__reply` headlessly.
   */
  dangerouslyBypassApprovalsAndSandbox?: boolean
  /** Test-only: inject a mock Codex factory. Production omits this. */
  codexFactory?: CodexFactory
  /** 边界超时;缺省读 WECHAT_CODEX_FIRST_EVENT_TIMEOUT_MS / WECHAT_CODEX_CONNECT_TIMEOUT_MS(见 codex-errors)。 */
  timeouts?: CodexTimeouts
}

export function createCodexAgentProvider(opts: CodexAgentProviderOptions = {}): AgentProvider {
  const factory: CodexFactory = opts.codexFactory ?? ((args) => new Codex(args))
  // Resolve once at provider construction — auto-detect picks up new
  // model cache entries on next daemon restart, matching how the user
  // adds models (codex login → cache refreshes → restart daemon).
  const cheapModel = resolveCodexCheapModel()
  const timeouts = (): CodexTimeouts => opts.timeouts ?? codexTimeoutsFromEnv()
  // Hoisted Codex instance reused across every cheapEval call. The
  // Codex constructor itself does NOT spawn a CLI subprocess (only
  // startThread + run/runStreamed do), so a single instance is safe to
  // share. Without this hoist, the chatroom moderator's 3-5 cheapEval
  // calls per /chat dispatch each constructed a fresh Codex →
  // measurable cold-start overhead per round.
  const cheapCodex = factory({
    ...(opts.codexPathOverride ? { codexPathOverride: opts.codexPathOverride } : {}),
  })

  // 守护(评审 #193 P1-1):SDK 每一轮都起一个新的 codex exec,继承**那一刻**的 process.env ——
  // 所以这一轮实际连的端点就是此刻 process.env 里的 OPENAI_BASE_URL(按调用时读,正好对得上)。
  const codexBaseUrl = () => process.env.OPENAI_BASE_URL || null
  return {
    callTarget(kind, ctx) {
      if (kind === 'cheapEval' || kind === 'strongEval') return { provider: 'codex', model: cheapModel ?? null, baseUrl: codexBaseUrl() }
      return { provider: 'codex', model: ctx?.model ?? opts.model ?? null, baseUrl: codexBaseUrl() }
    },
    /** CLI 子进程一档(约 3-5s/次),给 20s 余量。 */
    cheapEvalBudgetMs: 20_000,
    async cheapEval(prompt: string): Promise<string> {
      // One-shot eval via an ephemeral thread. Minimal everything — no
      // MCP, no network, no shell, no codebase context. Used by chatroom
      // moderator + companion introspect via ProviderRegistry.getCheapEval().
      const thread = cheapCodex.startThread({
        model: cheapModel,
        // Codex currently rejects `minimal` when the CLI advertises image_gen
        // in its tool catalog (400: tool cannot be used with minimal). `low`
        // remains the cheapest compatible one-shot setting.
        modelReasoningEffort: 'low',
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        webSearchEnabled: false,
        webSearchMode: 'disabled',
        networkAccessEnabled: false,
        workingDirectory: tmpdir(),
        skipGitRepoCheck: true,
      })
      // runStreamed(而不是 run):run 把「Reconnecting…」吞在里面,连不上时一直挂着
      // (ingest / gardener 这类没设预算的调用方就跟着挂)。流式 + 边界超时 ⇒ 带码抛出。
      const aborter = new AbortController()
      const parts: string[] = []
      try {
        const { events } = await thread.runStreamed(prompt, { signal: aborter.signal })
        for await (const ev of watchCodexEvents(events as AsyncGenerator<ThreadEvent>, { timeouts: timeouts(), abort: () => aborter.abort(), onNotice: m => log('CODEX_RECONNECT', `cheapEval ${m.slice(0, 200)}`) })) {
          // Concatenate agent_message items — that's the assistant's text
          // output. Reasoning items and tool calls are filtered out.
          if (ev.type === 'item.completed' && ev.item.type === 'agent_message') parts.push(ev.item.text)
          else if (ev.type === 'turn.failed') throw withProviderCode(new Error(ev.error.message), codexErrorCode(ev.error.message))
          else if (ev.type === 'error') throw withProviderCode(new Error(ev.message), codexErrorCode(ev.message))
        }
      } catch (err) {
        // 已经带码的(超时 / 上面的终态)原样抛;codex 子进程自己退出的(`Codex Exec exited
        // with code 1: …` + stderr)在这里补码。
        if (providerErrorCodeOf(err)) throw err
        throw withProviderCode(err, codexErrorCode(err instanceof Error ? err.message : String(err)))
      }
      return parts.join('')
    },
    async spawn(
      project: AgentProject,
      // `chatId` is part of the AgentProvider.spawn contract so the Claude
      // provider can bake it into its per-session canUseTool closure. Codex
      // has no per-tool callback equivalent (tier enforcement is coarser,
      // via sandboxMode/approvalPolicy on the Thread), so we accept it for
      // contract conformance but don't consume it.
      spawnOpts: SpawnContext,
    ): Promise<AgentSession> {
      const tierOpts = tierProfileToCodexSdkOpts(spawnOpts.tierProfile, spawnOpts.permissionMode)
      const config: Record<string, unknown> = {}
      if (opts.mcpServers) {
        // Per-session internal-api auth: merge the env-only WECHAT_SESSION_TOKEN
        // (secret bearer) + WECHAT_SESSION_TIER (non-secret) into the CORE stdio
        // MCP children's env at spawn — codex's MCP spec is fixed at construction,
        // so this per-spawn merge is how a codex session carries its tier (the
        // provider-agnostic seam; same env the claude side bakes in bootstrap).
        // Scoped to CORE_MCP_SERVER_NAMES so third-party plugins never receive
        // the bearer token (they'd otherwise be able to call the loopback API).
        const sessionEnv = spawnOpts.mcpEnv ?? {}
        const withEnv = mergeEnvIntoMcpServers(
          opts.mcpServers as Record<string, { env?: Record<string, string> }>,
          sessionEnv,
          CORE_MCP_SERVER_NAMES,
        )
        // Cast through `unknown` because CodexConfigValue forbids undefined
        // and our optional fields (args?, env?) carry that variance through
        // the index signature even when always populated. SDK serialiser
        // (flattenConfigOverrides at dist/index.js:297) skips undefined
        // children so this is safe at runtime.
        config.mcp_servers = withEnv as unknown as Record<string, never>
      }
      if (opts.dangerouslyBypassApprovalsAndSandbox) {
        config.dangerously_bypass_approvals_and_sandbox = true
      }
      const codex = factory({
        ...(opts.codexPathOverride ? { codexPathOverride: opts.codexPathOverride } : {}),
        ...(Object.keys(config).length > 0 ? { config: config as never } : {}),
      })
      // Sandbox + approval policy come from the tier — no hardcoded fallback.
      // admin → danger-full-access + never (matches old --dangerously behaviour),
      // trusted → workspace-write + never, guest → read-only + untrusted.
      // Per-spawn model (daemon's /model pin, read fresh by session-manager)
      // wins over the construction-time default — so a model switch applies on
      // the next session without a daemon restart.
      const model = spawnOpts.model ?? opts.model
      const threadOptions = {
        workingDirectory: project.path,
        skipGitRepoCheck: true,
        sandboxMode: tierOpts.sandboxMode,
        approvalPolicy: tierOpts.approvalPolicy,
        ...(model ? { model } : {}),
      } as const

      const thread: Thread = spawnOpts.resumeSessionId
        ? codex.resumeThread(spawnOpts.resumeSessionId, threadOptions)
        : codex.startThread(threadOptions)

      if (spawnOpts.resumeSessionId) {
        log('SESSION_RESUME', `alias=${project.alias} thread_id=${spawnOpts.resumeSessionId} provider=codex`)
      }

      let turnCount = 0
      let activeAborter: AbortController | null = null
      let closed = false
      // RFC 03 P5 review #4: prepend the per-spawn system prompt exactly once
      // per session (on the first dispatch). Codex SDK has no system-prompt
      // slot, so the daemon-assembled instructions (SpawnContext) ride the
      // first user message; subsequent turns rely on Codex's own history.
      const appendInstructions = spawnOpts.appendInstructions
      let instructionsInjected = !appendInstructions

      return {
        callTarget: () => ({ provider: 'codex', model: model ?? null, baseUrl: codexBaseUrl() }),
        dispatch(text: string): AsyncIterable<AgentEvent> {
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              if (closed) return
              const turnAborter = new AbortController()
              activeAborter = turnAborter
              const em = makeTurnEmitter()
              let initEmitted = false

              // First-dispatch-only injection of channel instructions (RFC 03 P5
              // review #4). Codex SDK has no system_prompt slot; prefix the
              // user message instead. Subsequent turns rely on Codex's own
              // history retention.
              let dispatchedText = text
              if (!instructionsInjected && appendInstructions) {
                dispatchedText = `${appendInstructions}\n\n---\n\n${text}`
                instructionsInjected = true
              }

              // 这一轮已经发过终态错误(turn.failed / 终止的 error)之后,codex 子进程照例
              // 以 exit 1 收尾、SDK 再抛一次 —— 那一下不是新信息,不再往下送。
              let terminalErrorSent = false
              try {
                const { events } = await thread.runStreamed(dispatchedText, { signal: turnAborter.signal })
                const watched = watchCodexEvents(events as AsyncGenerator<ThreadEvent>, {
                  timeouts: timeouts(),
                  abort: () => turnAborter.abort(),
                  onNotice: m => log('CODEX_RECONNECT', `alias=${project.alias} ${m.slice(0, 300)}`),
                })
                for await (const ev of watched) {
                  if (ev.type === 'thread.started') {
                    if (!initEmitted) {
                      log('SESSION_INIT', `alias=${project.alias} thread_id=${ev.thread_id} provider=codex`)
                      initEmitted = true
                    }
                    yield { kind: 'init', sessionId: ev.thread_id }
                  } else if (ev.type === 'item.completed') {
                    const item = (ev as { item: ThreadItem }).item
                    if (item.type === 'agent_message') {
                      yield { kind: 'text', text: item.text }
                    } else if (item.type === 'mcp_tool_call') {
                      yield { kind: 'tool_call', server: item.server, tool: item.tool }
                    }
                  } else if (ev.type === 'turn.completed') {
                    yield em.finish({ sessionId: thread.id ?? '', numTurns: ++turnCount })
                  } else if (ev.type === 'turn.failed') {
                    const m = ev.error.message
                    console.error(`wechat channel: [SESSION_RESULT] alias=${project.alias} provider=codex turn.failed=${m.slice(0, 400)}`)
                    terminalErrorSent = true
                    yield em.errorText(m, { code: codexErrorCode(m) })
                  } else if (ev.type === 'error') {
                    const m = (ev as { type: 'error'; message: string }).message
                    console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} provider=codex stream-error=${m.slice(0, 400)}`)
                    terminalErrorSent = true
                    yield em.errorText(m, { code: codexErrorCode(m) })
                  }
                }
              } catch (err) {
                // 边界超时(watchCodexEvents 抛的,已带码):这一轮以带码的 error 事件收尾,
                // 不往外抛 —— 抛出去 coordinator 就拿不到 summary,主人收不到任何话。
                const timeoutCode = providerErrorCodeOf(err)
                if (timeoutCode) {
                  const m = err instanceof Error ? err.message : String(err)
                  console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} provider=codex timeout code=${timeoutCode}: ${m.slice(0, 300)}`)
                  yield em.errorText(m, { code: timeoutCode })
                  return
                }
                // Skip the SESSION_ERROR log on user/preempt-initiated
                // aborts — both `/stop` and "new dispatch preempts prior"
                // legitimately abort the in-flight runStreamed, and the
                // coordinator already surfaces that path silently. Logging
                // them at error severity would spam channel.log and
                // obscure real SDK failures.
                const isAbort = err instanceof Error
                  && (err.name === 'AbortError' || turnAborter.signal.aborted)
                if (isAbort) throw err
                const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
                console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} provider=codex dispatch threw: ${detail}`)
                // codex 子进程以非零码退出(`Codex Exec exited with code 1: …` + stderr)。
                // 已经发过终态错误就不再重复;否则把它变成带码的 error 事件(stderr 里常有
                // 真因,比如 `failed to connect to websocket: HTTP error: 401`)—— 以前它被
                // 原样抛出,coordinator 拿不到 summary,回合记成 error 且 error 为空(§4.7)。
                if (terminalErrorSent) return
                const m = err instanceof Error ? err.message : String(err)
                yield em.errorText(m, { code: codexErrorCode(m) })
                return
              } finally {
                if (activeAborter === turnAborter) activeAborter = null
              }
            },
          }
        },
        async cancel(): Promise<void> {
          if (closed) return
          // Abort the in-flight runStreamed without setting closed=true,
          // so subsequent dispatches still work. The thread itself is
          // long-lived; only the per-turn CLI invocation gets killed.
          activeAborter?.abort()
        },
        async close(): Promise<void> {
          closed = true
          // Codex SDK's Thread doesn't expose a `close()` — the underlying
          // codex CLI subprocess is per-runStreamed (one CLI invocation per
          // turn), so there's nothing long-running to terminate. Aborting
          // any in-flight turn is sufficient.
          activeAborter?.abort()
        },
      }
    },
  }
}
