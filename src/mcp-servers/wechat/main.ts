#!/usr/bin/env bun
/**
 * wechat-mcp — standalone stdio MCP server (RFC 03 §5).
 *
 * Loaded by both the Claude Agent SDK and Codex SDK as a stdio MCP server.
 * This file is the orchestrator: it sets up the client + server, registers the
 * `ping` probe inline, then delegates each tool family to its own module
 * (tools-memory / tools-projects / tools-voice-share / tools-messaging /
 * tools-companion / tools-a2a, and tools-daemon for admin sessions). Shared
 * error/log plumbing lives in tool-helpers.
 *
 * Two env vars must be set by the spawning daemon:
 *   WECHAT_INTERNAL_API        e.g. http://127.0.0.1:54321
 *   WECHAT_INTERNAL_TOKEN_FILE absolute path to mode-0600 token file
 *
 * Stdout is the MCP transport — DO NOT write logs there. All logs go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createInternalApiClient } from './client'
import { logErr } from './tool-helpers'
import { createWechatMcpServer } from './server'

const baseUrl = process.env.WECHAT_INTERNAL_API
const tokenFilePath = process.env.WECHAT_INTERNAL_TOKEN_FILE
if (!baseUrl || !tokenFilePath) {
  logErr('FATAL: WECHAT_INTERNAL_API and WECHAT_INTERNAL_TOKEN_FILE env vars are required')
  logErr(`got WECHAT_INTERNAL_API=${baseUrl ?? '(unset)'} WECHAT_INTERNAL_TOKEN_FILE=${tokenFilePath ?? '(unset)'}`)
  process.exit(2)
}
const client = createInternalApiClient({ baseUrl, tokenFilePath, logger: logErr })
const server = await createWechatMcpServer(client, {
  tier: process.env.WECHAT_SESSION_TIER,
  participantTag: process.env.WECHAT_PARTICIPANT_TAG,
  logger: logErr,
})
await server.connect(new StdioServerTransport())
logErr(`ready (pid=${process.pid}, base=${baseUrl})`)
