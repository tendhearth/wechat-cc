#!/usr/bin/env bun
/**
 * delegate-mcp — RFC 03 P4. Standalone stdio MCP server that exposes
 * the OTHER provider as a `delegate_<peer>` tool, so the primary agent
 * can run a one-shot consultation against the peer.
 *
 * Loaded alongside wechat-mcp on each provider's session. The daemon
 * sets WECHAT_DELEGATE_PEER on the spawn env to declare which peer
 * this child should expose:
 *   Claude session → WECHAT_DELEGATE_PEER=codex → registers `delegate_codex`
 *   Codex  session → WECHAT_DELEGATE_PEER=claude → registers `delegate_claude`
 *
 * Recursion prevention: structural, not counter-based. The daemon's
 * /v1/delegate handler spawns the peer with a BARE-BONES SDK config
 * (no wechat-mcp, no delegate-mcp). The spawned peer therefore has no
 * `delegate_*` tool to call — recursion is impossible by construction.
 *
 * Stdout is the MCP transport — DO NOT write logs there. All logs go
 * to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createInternalApiClient } from '../wechat/client'
import { createDelegateMcpServer } from './server'

function logErr(line: string): void { process.stderr.write(`[delegate-mcp] ${line}\n`) }
const baseUrl = process.env.WECHAT_INTERNAL_API
const tokenFilePath = process.env.WECHAT_INTERNAL_TOKEN_FILE
const peer = process.env.WECHAT_DELEGATE_PEER
if (!baseUrl || !tokenFilePath || !peer) {
  logErr('FATAL: WECHAT_INTERNAL_API, WECHAT_INTERNAL_TOKEN_FILE and WECHAT_DELEGATE_PEER env vars are required')
  process.exit(2)
}
const server = createDelegateMcpServer(createInternalApiClient({ baseUrl, tokenFilePath, logger: logErr }), peer, logErr)
await server.connect(new StdioServerTransport())
logErr(`ready (pid=${process.pid}, peer=${peer}, base=${baseUrl})`)
