/**
 * cli-llm-eval.ts — guardrail #1 (spec 2026-07-23-daemon-owns-llm-memory-ops,
 * Task 3): a compiled `wechat-cc-cli` sidecar must never inline-spawn a
 * `query()`/Codex SDK call for LLM memory ops — the sidecar's environment
 * doesn't carry the same provider config the daemon does, and doing so
 * silently duplicates/diverges from the daemon-owned MemoryLlmOps. Instead
 * the compiled CLI delegates to the running daemon's internal-api routes
 * (`/v1/memory/synthesize`, `/v1/memory/profile/generate`) added in Task 2.
 *
 * Dev (bun, source mode) keeps the existing inline behavior unchanged —
 * `isCompiled() === false` just calls through to whatever inline eval the
 * caller built (the per-provider query()/Codex closures already in cli.ts).
 */

/** Thrown by the eval fn returned from makeCliSdkEval when running compiled —
 * signals "don't inline spawn; the caller should delegate to the daemon
 * instead" rather than silently doing the wrong thing. */
export class CompiledLlmError extends Error {
  constructor(message = 'compiled CLI sidecar cannot inline-spawn an LLM eval — delegate to the daemon instead') {
    super(message)
    this.name = 'CompiledLlmError'
  }
}

export interface MakeCliSdkEvalOpts {
  /** Returns true when this process is the compiled desktop sidecar
   * (isCompiledBundle() from runtime-info.ts). Injected for testability. */
  isCompiled: () => boolean
  /** The dev-mode inline eval (query()/Codex closure) — only ever invoked
   * when isCompiled() returns false. */
  inline: (prompt: string) => Promise<string>
}

/**
 * Builds an eval fn: source mode calls `inline`; compiled mode throws
 * CompiledLlmError without ever touching `inline` (guardrail — no
 * inline-spawn under any circumstance in a compiled bundle).
 */
export function makeCliSdkEval(opts: MakeCliSdkEvalOpts): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    if (opts.isCompiled()) throw new CompiledLlmError()
    return opts.inline(prompt)
  }
}

export type MemoryDelegateOp = 'synthesize' | 'profile-generate'

/** Minimal shape of STATE_DIR/internal-api-info.json → resolved baseUrl +
 * bearer token, already read/decoded by the caller (see cli.ts's existing
 * `mode set` command for the read-the-file-then-token-file pattern this
 * mirrors). */
export interface CliApiInfo {
  baseUrl: string
  token: string
}

export interface DelegateMemoryOpDeps {
  /** Reads STATE_DIR/internal-api-info.json + its token file; null when the
   * daemon isn't running (file missing/malformed). Injected for testability
   * — production callers pass a helper that does the real fs reads. */
  readApiInfo: () => CliApiInfo | null
  /** Injected fetch (production: global fetch) so tests can stub the daemon
   * response without a live HTTP server. */
  fetch: typeof globalThis.fetch
}

const MEMORY_OP_PATHS: Record<MemoryDelegateOp, string> = {
  'synthesize': '/v1/memory/synthesize',
  'profile-generate': '/v1/memory/profile/generate',
}

/**
 * Delegates an LLM memory op to the running daemon's internal-api instead of
 * inline-spawning claude/codex in the (compiled) CLI process. Mirrors the
 * `mode set` command's internal-api-info.json → bearer-token → POST pattern.
 *
 * Returns the daemon's parsed JSON response verbatim on success, or a
 * structured `{ok:false, error:'daemon_required'}` when the daemon isn't
 * reachable (no internal-api-info.json) — callers print this as-is in
 * --json mode, or format a human message from it otherwise.
 */
export async function delegateMemoryOp(
  op: MemoryDelegateOp,
  params: { chatId?: string },
  deps: DelegateMemoryOpDeps,
): Promise<unknown> {
  const info = deps.readApiInfo()
  if (!info) return { ok: false, error: 'daemon_required' }

  const resp = await deps.fetch(`${info.baseUrl}${MEMORY_OP_PATHS[op]}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${info.token}`,
    },
    body: JSON.stringify(params.chatId ? { chat_id: params.chatId } : {}),
  })
  return resp.json()
}
