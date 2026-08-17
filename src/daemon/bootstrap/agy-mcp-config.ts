/**
 * agy (Antigravity CLI) MCP session-config machinery — tier C (global-only).
 *
 * spec 2026-08-17-agy-provider-design.md §3: agy has no config-dir env
 * override and no workspace-level config (spike-confirmed, both candidates
 * tested negative); the ONLY place agy reads MCP servers from is the global
 * `~/.gemini/config/mcp_config.json`. That file can't carry a per-session
 * `WECHAT_SESSION_TOKEN` (it's static, read once at agy boot, shared across
 * whatever conversation the operator happens to be running) — so tier C
 * accepts a smaller surface on purpose: `/agy` is gated to admin/trusted
 * chats only (mode-commands.ts, Task 6), and this module upserts ONE
 * long-lived 'trusted'-tier token into the global file at OUR daemon's boot
 * time. Never a per-session token — see `WECHAT_SESSION_TIER: 'trusted'`
 * below, always fixed, never threaded from a spawn context.
 *
 * Safety rules this module exists to uphold (spec §3, last paragraph):
 *  - only ever touch our own namespaced entry (`wechat-cc:wechat`) —
 *    anything else already in `mcpServers` (or at the file root) is
 *    round-tripped untouched;
 *  - read-modify-write, never blind-overwrite;
 *  - create the file/dirs if absent;
 *  - idempotent: recomputing the same entry from the same inputs must NOT
 *    rewrite the file (boot happens often; churn would mean agy's own file
 *    watchers — if any — thrash, and it makes `git diff`-style auditing of
 *    the file noisy for an operator who edited it by hand);
 *  - corrupted JSON must never be "fixed" by clobbering it — a `.tmp` +
 *    `readFileSync` protection strategy exists specifically so a botched
 *    write elsewhere in the operator's toolchain can't be silently
 *    stomped by us. On any doubt about shape, we log and back off.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpStdioSpec } from '../../core/mcp-stdio-spec'

/** Our namespaced entry key inside `mcpServers` — never touch any other key. */
export const AGY_WECHAT_MCP_NAMESPACE_ID = 'wechat-cc:wechat'

const CONFIG_FILE_NAME = 'mcp_config.json'

export interface PrepareAgyMcpOpts {
  /** wechat MCP stdio spec, built by bootstrap the same way as
   *  `wechatStdioForGemini`/`wechatStdioMcpSpec` (mcp-specs.ts). */
  wechatSpec: McpStdioSpec
  /** Mints the boot-time long-lived trusted token. Bootstrap (Task 6) wires
   *  this to `mintSessionToken('trusted', 'agy-static')`. Called at most
   *  once per `setupAgyGlobalMcp()` invocation, and never when the function
   *  is about to bail out without writing (corrupted/unexpected file). */
  mintToken: () => string
  /** Test seam — defaults to `~/.gemini/config`. Tests MUST pass a mkdtemp
   *  dir here; the real `~/.gemini` must never be touched by tests. */
  geminiConfigDir?: string
  log: (tag: string, line: string) => void
}

interface McpConfigRoot {
  mcpServers?: unknown
  [key: string]: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const LOG_TAG = 'agy-mcp'

/**
 * Tier C: boot-time global upsert into `~/.gemini/config/mcp_config.json`
 * (or `opts.geminiConfigDir` in tests). Returns true iff the file was
 * written (created or changed) — false on a no-op (idempotent repeat call,
 * or a defensive bail-out on unreadable/unexpected existing content).
 */
export function setupAgyGlobalMcp(opts: PrepareAgyMcpOpts): boolean {
  const dir = opts.geminiConfigDir ?? join(homedir(), '.gemini', 'config')
  const path = join(dir, CONFIG_FILE_NAME)

  let existingRaw: string | null
  try {
    existingRaw = readFileSync(path, 'utf8')
  } catch {
    existingRaw = null // absent — first-time setup, not an error
  }

  let existingRoot: McpConfigRoot = {}
  if (existingRaw !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(existingRaw)
    } catch (err) {
      opts.log(LOG_TAG, `refusing to touch corrupted ${path}: ${(err as Error).message}`)
      return false
    }
    if (!isPlainObject(parsed) || ('mcpServers' in parsed && !isPlainObject(parsed.mcpServers))) {
      opts.log(LOG_TAG, `refusing to touch ${path}: unexpected shape (not the expected {"mcpServers":{...}} object)`)
      return false
    }
    existingRoot = parsed
  }

  const existingServers = isPlainObject(existingRoot.mcpServers) ? existingRoot.mcpServers : {}
  const token = opts.mintToken()
  const entry: McpStdioSpec = {
    command: opts.wechatSpec.command,
    args: opts.wechatSpec.args,
    env: {
      ...(opts.wechatSpec.env ?? {}),
      // NEVER a per-session token here — tier C's whole safety contract is
      // that this file only ever carries the one boot-minted trusted token.
      WECHAT_SESSION_TOKEN: token,
      WECHAT_SESSION_TIER: 'trusted',
    },
  }

  const newRoot: McpConfigRoot = {
    ...existingRoot,
    mcpServers: { ...existingServers, [AGY_WECHAT_MCP_NAMESPACE_ID]: entry },
  }
  const newText = JSON.stringify(newRoot, null, 2) + '\n'

  if (existingRaw !== null && existingRaw === newText) {
    return false // same inputs ⇒ no rewrite churn
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, newText, { mode: 0o600 })
  renameSync(tmp, path)
  opts.log(LOG_TAG, `${existingRaw === null ? 'created' : 'updated'} ${path} (namespace "${AGY_WECHAT_MCP_NAMESPACE_ID}")`)
  return true
}
