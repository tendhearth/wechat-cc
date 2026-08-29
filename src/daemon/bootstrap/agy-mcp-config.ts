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
 *  - only ever touch our own namespaced entry (`wechat-cc-wechat`, plus a
 *    purge of the legacy colon-carrying `wechat-cc:wechat`) — anything else
 *    already in `mcpServers` (or at the file root) is round-tripped
 *    untouched;
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
import { UNDER_TEST_RUNNER } from '../../lib/config'

/** Our namespaced entry key inside `mcpServers` — never touch any other key.
 *
 *  MUST stay inside `[a-zA-Z0-9_-]`: agy derives tool names as
 *  `mcp_<serverKey>_<tool>` and validates the WHOLE name against
 *  `^[a-zA-Z0-9_-]{1,64}$`. The original `wechat-cc:wechat` carried a colon,
 *  so agy silently rejected all 32 wechat tools at every boot and the
 *  provider ran tool-less from 2026-08-17 until this was caught in its
 *  cli.log on 2026-08-29 ("encountered invalid tool …" ×32). */
export const AGY_WECHAT_MCP_NAMESPACE_ID = 'wechat-cc-wechat'

/** The pre-2026-08-29 colon-carrying key — purged on sight by both setup
 *  (one-time migration) and remove, so stale entries with dead tokens don't
 *  linger in the operator's config. */
const LEGACY_NAMESPACE_ID = 'wechat-cc:wechat'

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
  // TEST-RUNNER GUARD (incident 2026-08-17, fix round 1 — same rationale as
  // config.ts's STATE_DIR guard): every e2e run that boots a real daemon
  // (real internalApi + a real `agy` binary on PATH) reached this function
  // with NO explicit geminiConfigDir, and the default silently resolved to
  // the OPERATOR'S REAL ~/.gemini/config/mcp_config.json — a write to live
  // user state from a test run. Masked in dev only because that file
  // happened to be 0 bytes there (JSON.parse('') throws → the corrupted-
  // file bail-out below happened to save us by accident, not by design).
  // So: under a test runner, an omitted geminiConfigDir is a hard skip, not
  // a homedir default — a test that WANTS this to actually write must pass
  // an explicit (mkdtemp'd) geminiConfigDir, exactly like WECHAT_STATE_DIR
  // must be explicit for STATE_DIR under test.
  if (!opts.geminiConfigDir && UNDER_TEST_RUNNER) {
    opts.log(LOG_TAG, 'skipped under test runner — no explicit geminiConfigDir (refusing to default to the real ~/.gemini/config)')
    return false
  }
  const dir = opts.geminiConfigDir ?? join(homedir(), '.gemini', 'config')
  const path = join(dir, CONFIG_FILE_NAME)

  let existingRaw: string | null
  try {
    existingRaw = readFileSync(path, 'utf8')
  } catch {
    existingRaw = null // absent — first-time setup, not an error
  }
  // agy itself ships a 0-byte placeholder mcp_config.json (real-deploy
  // finding 2026-08-18): JSON.parse('') would trip the corrupted-file
  // no-clobber guard below and permanently block setup. An empty or
  // whitespace-only file carries no user data to lose — treat as absent.
  if (existingRaw !== null && existingRaw.trim() === '') existingRaw = null

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

  const migratedServers = { ...existingServers }
  delete migratedServers[LEGACY_NAMESPACE_ID]   // one-time colon-key migration
  const newRoot: McpConfigRoot = {
    ...existingRoot,
    mcpServers: { ...migratedServers, [AGY_WECHAT_MCP_NAMESPACE_ID]: entry },
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

export interface RemoveAgyMcpOpts {
  /** Same test seam as `PrepareAgyMcpOpts.geminiConfigDir` — tests MUST pass
   *  a mkdtemp dir; production never sets this from main.ts. */
  geminiConfigDir?: string
  log: (tag: string, line: string) => void
}

/**
 * Mirror image of `setupAgyGlobalMcp`, wired to the daemon's graceful-
 * shutdown path (spec §3's registered residual): deletes ONLY our
 * namespaced entry (`AGY_WECHAT_MCP_NAMESPACE_ID`) from the global
 * `mcp_config.json`, so a dead boot-minted trusted token doesn't sit in the
 * operator's interactive agy config between daemon runs. Same safety
 * posture as setup — test-runner guard, read-modify-write, corrupted/
 * unexpected-shape bail-outs, atomic tmp+rename — except there is no
 * "create if absent" case: a missing file or an absent entry is simply a
 * no-op (false), never an error. If removing our entry leaves `mcpServers`
 * empty, the empty object is kept (the file itself is never deleted — it
 * may be user-created and carry other top-level keys we don't know about).
 * Returns true iff the file was written (our entry existed and got
 * removed).
 */
export function removeAgyGlobalMcp(opts: RemoveAgyMcpOpts): boolean {
  // Same TEST-RUNNER GUARD rationale as setupAgyGlobalMcp — an omitted
  // geminiConfigDir under a test runner must never fall back to the
  // operator's real ~/.gemini/config, on shutdown any more than on boot.
  if (!opts.geminiConfigDir && UNDER_TEST_RUNNER) {
    opts.log(LOG_TAG, 'skipped under test runner — no explicit geminiConfigDir (refusing to default to the real ~/.gemini/config)')
    return false
  }
  const dir = opts.geminiConfigDir ?? join(homedir(), '.gemini', 'config')
  const path = join(dir, CONFIG_FILE_NAME)

  let existingRaw: string
  try {
    existingRaw = readFileSync(path, 'utf8')
  } catch {
    return false // absent — nothing to remove, not an error
  }
  // Empty/whitespace-only ≡ absent (agy's own 0-byte placeholder — see the
  // matching guard in setupAgyGlobalMcp): nothing to remove, and it must
  // not be mislabeled "corrupted" by the parse below.
  if (existingRaw.trim() === '') return false

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
  const existingRoot: McpConfigRoot = parsed
  const existingServers = isPlainObject(existingRoot.mcpServers) ? existingRoot.mcpServers : undefined

  if (!existingServers ||
      !(AGY_WECHAT_MCP_NAMESPACE_ID in existingServers || LEGACY_NAMESPACE_ID in existingServers)) {
    return false // neither our entry nor the legacy one is there — idempotent no-op
  }

  const remainingServers = { ...existingServers }
  delete remainingServers[AGY_WECHAT_MCP_NAMESPACE_ID]
  delete remainingServers[LEGACY_NAMESPACE_ID]
  const newRoot: McpConfigRoot = { ...existingRoot, mcpServers: remainingServers }
  const newText = JSON.stringify(newRoot, null, 2) + '\n'

  const tmp = `${path}.tmp`
  writeFileSync(tmp, newText, { mode: 0o600 })
  renameSync(tmp, path)
  opts.log(LOG_TAG, `removed namespace "${AGY_WECHAT_MCP_NAMESPACE_ID}" from ${path}`)
  return true
}
