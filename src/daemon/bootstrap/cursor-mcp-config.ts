/**
 * cursor-agent 全局 mcp.json 清理 —— 只剩 boot 时清掉上一版留下的条目。
 *
 * 上一版(print 模式)往 cursor-agent 唯一的全局 MCP 入口 `~/.cursor/mcp.json`
 * (claude 式 `{"mcpServers":{…}}`)里塞过一把 boot-minted 长效 'trusted' 令牌,
 * 命名空间键是 `wechat-cc:wechat`。对话侧改走 ACP 后(acp-cursor-chat.ts),
 * wechat/delegate MCP 按会话注入、带逐会话 token 与 tier,那个全局静态条目
 * 不再被读取 —— 留着只是一把风险更高的旧钥匙,所以 boot 时主动删掉它。
 *
 * 安全规则与 agy-mcp-config.ts 一致(read-modify-write;只动自己的
 * `wechat-cc:wechat` 一个键;绝不因为文件损坏就整体覆盖;测试 runner 下
 * 不传 cursorConfigDir 就自动跳过,绝不碰操作者真的 ~/.cursor)。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { UNDER_TEST_RUNNER } from '../../lib/config'

/** 上一版写入时用的命名空间键 —— 只在本文件内私有,不再对外导出。 */
const LEGACY_CURSOR_WECHAT_MCP_KEY = 'wechat-cc:wechat'

const CONFIG_FILE_NAME = 'mcp.json'
const LOG_TAG = 'cursor-mcp'

interface McpConfigRoot {
  mcpServers?: unknown
  [key: string]: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export interface RemoveCursorMcpOpts {
  cursorConfigDir?: string
  log: (tag: string, line: string) => void
}

/** boot-time 清理 —— 移除 ONLY 我们的命名空间条目。Returns true iff written. */
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
  if (!existingServers || !(LEGACY_CURSOR_WECHAT_MCP_KEY in existingServers)) return false

  const remainingServers = { ...existingServers }
  delete remainingServers[LEGACY_CURSOR_WECHAT_MCP_KEY]
  const newRoot: McpConfigRoot = { ...existingRoot, mcpServers: remainingServers }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(newRoot, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  opts.log(LOG_TAG, `removed namespace "${LEGACY_CURSOR_WECHAT_MCP_KEY}" from ${path}`)
  return true
}
