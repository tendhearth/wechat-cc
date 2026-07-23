/**
 * cli-llm-eval.ts — guardrail #1 (spec 2026-07-23-daemon-owns-llm-memory-ops,
 * Task 3): a compiled `wechat-cc-cli` sidecar must never inline-spawn a
 * `query()`/Codex SDK call for LLM memory ops — the sidecar's environment
 * doesn't carry the same provider config the daemon does, and doing so
 * silently duplicates/diverges from the daemon-owned MemoryLlmOps. Instead
 * the compiled CLI delegates to the running daemon's internal-api routes
 * (`/v1/memory/synthesize`, `/v1/memory/profile/generate`) added in Task 2.
 *
 * Dev (bun, source mode) keeps the existing inline behavior unchanged — the
 * production call sites guard with `isCompiledBundle()` directly and only
 * call `delegateMemoryOp` in the compiled branch.
 */

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
 * `mode set` command's internal-api-info.json → bearer-token → POST pattern
 * (cli.ts's modeSetCmd) — including its try/catch-around-fetch and explicit
 * resp.ok/status branching, since the daemon's memory routes
 * (routes-memory.ts) return error bodies like `{error:'memory_not_wired'}`
 * (503) / `{error:'no_admin_chat_id'}` (400) / `{error:'unauthorized'}` (401)
 * that carry no `ok` key — a bare `resp.json()` would let those masquerade
 * as success.
 *
 * Returns the daemon's parsed JSON response verbatim on success (2xx), or a
 * structured `{ok:false, error}` on any failure (daemon not running,
 * non-2xx response, or the fetch itself throwing e.g. ECONNREFUSED) —
 * callers print this as-is in --json mode, or format a human message from
 * it otherwise.
 */
export async function delegateMemoryOp(
  op: MemoryDelegateOp,
  params: { chatId?: string },
  deps: DelegateMemoryOpDeps,
): Promise<unknown> {
  const info = deps.readApiInfo()
  if (!info) return { ok: false, error: 'daemon_required' }

  let resp: Awaited<ReturnType<typeof deps.fetch>>
  try {
    resp = await deps.fetch(`${info.baseUrl}${MEMORY_OP_PATHS[op]}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${info.token}`,
      },
      body: JSON.stringify(params.chatId ? { chat_id: params.chatId } : {}),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `could not reach daemon: ${msg}` }
  }

  const body = await resp.json().catch(() => undefined) as { error?: string } | undefined
  if (!resp.ok) return { ok: false, error: body?.error ?? `HTTP ${resp.status}` }
  return body
}
