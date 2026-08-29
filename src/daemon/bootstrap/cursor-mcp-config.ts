/**
 * cursor-agent MCP session-config machinery — tier C (global-only), the
 * cursor twin of agy-mcp-config.ts (read that file's header for the full
 * safety rationale; every rule below is inherited from it):
 *
 * cursor-agent reads MCP servers from the global `~/.cursor/mcp.json`
 * (claude-style `{"mcpServers":{…}}`). Like agy, that file is static and
 * shared across whatever the operator runs — it can't carry a per-session
 * token, so we upsert ONE boot-minted long-lived 'trusted' token under our
 * namespaced key and gate /cursor to admin/trusted chats (mode-commands'
 * existing tier-C gate family).
 *
 * Safety rules (same as agy): only touch our own `wechat-cc:wechat` entry;
 * read-modify-write; create-if-absent; idempotent (no churn); never
 * "fix" corrupted JSON by clobbering; test-runner guard against writing the
 * operator's real ~/.cursor.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpStdioSpec } from '../../core/mcp-stdio-spec'
import { UNDER_TEST_RUNNER } from '../../lib/config'

export const CURSOR_WECHAT_MCP_NAMESPACE_ID = 'wechat-cc:wechat'

const CONFIG_FILE_NAME = 'mcp.json'
const LOG_TAG = 'cursor-mcp'

export interface PrepareCursorMcpOpts {
  wechatSpec: McpStdioSpec
  mintToken: () => string
  /** Test seam — defaults to `~/.cursor`. Tests MUST pass a mkdtemp dir. */
  cursorConfigDir?: string
  log: (tag: string, line: string) => void
}

interface McpConfigRoot {
  mcpServers?: unknown
  [key: string]: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Boot-time global upsert. Returns true iff the file was written. */
export function setupCursorGlobalMcp(opts: PrepareCursorMcpOpts): boolean {
  if (!opts.cursorConfigDir && UNDER_TEST_RUNNER) {
    opts.log(LOG_TAG, 'skipped under test runner — no explicit cursorConfigDir (refusing to default to the real ~/.cursor)')
    return false
  }
  const dir = opts.cursorConfigDir ?? join(homedir(), '.cursor')
  const path = join(dir, CONFIG_FILE_NAME)

  let existingRaw: string | null
  try {
    existingRaw = readFileSync(path, 'utf8')
  } catch {
    existingRaw = null
  }
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
      opts.log(LOG_TAG, `refusing to touch ${path}: unexpected shape (not {"mcpServers":{...}})`)
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
      // NEVER a per-session token — tier C contract, see header.
      WECHAT_SESSION_TOKEN: token,
      WECHAT_SESSION_TIER: 'trusted',
    },
  }

  const newRoot: McpConfigRoot = {
    ...existingRoot,
    mcpServers: { ...existingServers, [CURSOR_WECHAT_MCP_NAMESPACE_ID]: entry },
  }
  const newText = JSON.stringify(newRoot, null, 2) + '\n'
  if (existingRaw !== null && existingRaw === newText) return false

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, newText, { mode: 0o600 })
  renameSync(tmp, path)
  opts.log(LOG_TAG, `${existingRaw === null ? 'created' : 'updated'} ${path} (namespace "${CURSOR_WECHAT_MCP_NAMESPACE_ID}")`)
  return true
}

export interface RemoveCursorMcpOpts {
  cursorConfigDir?: string
  log: (tag: string, line: string) => void
}

/** Shutdown mirror — removes ONLY our namespaced entry. Returns true iff written. */
export function removeCursorGlobalMcp(opts: RemoveCursorMcpOpts): boolean {
  if (!opts.cursorConfigDir && UNDER_TEST_RUNNER) {
    opts.log(LOG_TAG, 'skipped under test runner — no explicit cursorConfigDir (refusing to default to the real ~/.cursor)')
    return false
  }
  const dir = opts.cursorConfigDir ?? join(homedir(), '.cursor')
  const path = join(dir, CONFIG_FILE_NAME)

  let existingRaw: string
  try {
    existingRaw = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  if (existingRaw.trim() === '') return false

  let parsed: unknown
  try {
    parsed = JSON.parse(existingRaw)
  } catch (err) {
    opts.log(LOG_TAG, `refusing to touch corrupted ${path}: ${(err as Error).message}`)
    return false
  }
  if (!isPlainObject(parsed) || ('mcpServers' in parsed && !isPlainObject(parsed.mcpServers))) {
    opts.log(LOG_TAG, `refusing to touch ${path}: unexpected shape (not {"mcpServers":{...}})`)
    return false
  }
  const existingRoot: McpConfigRoot = parsed
  const existingServers = isPlainObject(existingRoot.mcpServers) ? existingRoot.mcpServers : undefined
  if (!existingServers || !(CURSOR_WECHAT_MCP_NAMESPACE_ID in existingServers)) return false

  const remainingServers = { ...existingServers }
  delete remainingServers[CURSOR_WECHAT_MCP_NAMESPACE_ID]
  const newRoot: McpConfigRoot = { ...existingRoot, mcpServers: remainingServers }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(newRoot, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  opts.log(LOG_TAG, `removed namespace "${CURSOR_WECHAT_MCP_NAMESPACE_ID}" from ${path}`)
  return true
}
