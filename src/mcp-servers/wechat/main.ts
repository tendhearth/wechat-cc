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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createInternalApiClient } from './client'
import { logErr, formatError } from './tool-helpers'
import { registerMemoryTools } from './tools-memory'
import { registerProjectTools } from './tools-projects'
import { registerVoiceShareTools } from './tools-voice-share'
import { registerMessagingTools } from './tools-messaging'
import { registerCompanionTools } from './tools-companion'
import { registerA2ASendTool } from './tools-a2a'
import { registerDaemonTools } from './tools-daemon'
import { registerFileTools } from './tools-files'
import { registerSocialTools } from './tools-social'
import { registerKnowledgeSearchTool } from './tools-knowledge'
import { registerFederatedQueryTool } from './tools-federated'
import { registerGraphTools } from './tools-graph'
import { registerFactsTools } from './tools-facts'
import { registerConfigTools } from './tools-config'
import { registerPersonTools } from './tools-person'

const baseUrl = process.env.WECHAT_INTERNAL_API
const tokenFilePath = process.env.WECHAT_INTERNAL_TOKEN_FILE

if (!baseUrl || !tokenFilePath) {
  logErr('FATAL: WECHAT_INTERNAL_API and WECHAT_INTERNAL_TOKEN_FILE env vars are required')
  logErr(`got WECHAT_INTERNAL_API=${baseUrl ?? '(unset)'} WECHAT_INTERNAL_TOKEN_FILE=${tokenFilePath ?? '(unset)'}`)
  process.exit(2)
}

const client = createInternalApiClient({
  baseUrl,
  tokenFilePath,
  logger: logErr,
})

const server = new McpServer(
  { name: 'wechat-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

// Admin-session flag, derived from the non-secret WECHAT_SESSION_TIER the
// daemon bakes into THIS MCP child's env at spawn (next to the secret
// WECHAT_SESSION_TOKEN). The agent runs in the LLM and cannot alter this env,
// so gating the daemon-control tools (diagnostic_* / model_* / session_release
// / daemon_restart) on it is robust on EVERY provider — including codex, which
// has no per-tool canUseTool callback. Non-admin sessions simply don't get the
// tools registered, AND the route layer rejects a non-admin token anyway
// (defence in depth).
const SESSION_IS_ADMIN = process.env.WECHAT_SESSION_TIER === 'admin'

// `ping` stays inline — the canonical "is the MCP-over-stdio + internal-api
// channel alive" probe that integration tests assert against.
server.registerTool(
  'ping',
  {
    title: 'Ping daemon',
    description: 'Round-trips a request through the daemon internal-api and returns its pid. Used by integration tests to verify the full MCP-over-stdio + internal-api channel is alive.',
    inputSchema: {},
    outputSchema: {
      ok: z.boolean(),
      daemon_pid: z.number(),
    },
  },
  async () => {
    try {
      const resp = await client.request<{ ok: boolean; daemon_pid: number }>('GET', '/v1/health')
      return {
        content: [{ type: 'text', text: JSON.stringify(resp) }],
        structuredContent: resp,
      }
    } catch (err) {
      logErr(`ping failed: ${formatError(err)}`)
      return {
        content: [{ type: 'text', text: `ping failed: ${formatError(err)}` }],
        isError: true,
      }
    }
  },
)

// ─── reminders(每聊天、分钟级、一次性)────────────────────────────────
// 与 companion/agenda(operator-only、天粒度)不同:这是给「当前聊天」设的
// 精确时间提醒,由 daemon 的 sweeper 直接投递,跨重启存活。chat_id 必须是
// 当前对话的 chat_id —— 服务端按会话身份校验,给别的聊天设提醒会被 403。

server.registerTool(
  'schedule_reminder',
  {
    title: 'Schedule a precise-time reminder',
    description:
      '给当前聊天的用户设一个精确时间的提醒，到点由 daemon 直接发出（不依赖本会话存活，跨重启）。' +
      'chat_id=当前对话的 chat_id（服务端校验，只能给本聊天设）。' +
      '二选一：delay_seconds（相对秒数，首选，免时区计算）或 due_at（绝对 ISO 8601 时间）。' +
      'text=到点要发的内容。返回 { ok, reminder_id, due_at }。适合"X 小时后/几点提醒我"。' +
      '若到点时投递失败会按指数退避自动重试最多 24 小时。',
    inputSchema: {
      chat_id: z.string(),
      text: z.string().min(1).max(4000),
      delay_seconds: z.number().int().min(1).max(60 * 60 * 24 * 365).optional(),
      due_at: z.string().optional(),
    },
  },
  async ({ chat_id, text, delay_seconds, due_at }) => {
    try {
      const payload: Record<string, unknown> = { chat_id, text }
      if (delay_seconds !== undefined) payload.delay_seconds = delay_seconds
      if (due_at !== undefined) payload.due_at = due_at
      const r = await client.request<unknown>('POST', '/v1/reminders/schedule', payload)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      logErr(`schedule_reminder failed: ${formatError(err)}`)
      return { content: [{ type: 'text', text: `schedule_reminder failed: ${formatError(err)}` }], isError: true }
    }
  },
)

server.registerTool(
  'cancel_reminder',
  {
    title: 'Cancel a pending reminder',
    description: '取消当前聊天一个还未触发的提醒。reminder_id 来自 schedule_reminder / list_reminders；chat_id=当前对话的 chat_id。返回 { ok, cancelled }。',
    inputSchema: { chat_id: z.string(), reminder_id: z.string() },
  },
  async ({ chat_id, reminder_id }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/reminders/cancel', { chat_id, reminder_id })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      logErr(`cancel_reminder failed: ${formatError(err)}`)
      return { content: [{ type: 'text', text: `cancel_reminder failed: ${formatError(err)}` }], isError: true }
    }
  },
)

server.registerTool(
  'list_reminders',
  {
    title: "List this chat's reminders",
    description: '列出当前聊天的所有提醒（含 pending/sent/cancelled/failed）。chat_id=当前对话的 chat_id。返回 { ok, reminders:[{id,due_at,text,status}] }。',
    inputSchema: { chat_id: z.string() },
  },
  async ({ chat_id }) => {
    try {
      const r = await client.request<unknown>('GET', `/v1/reminders/list?chat_id=${encodeURIComponent(chat_id)}`)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      logErr(`list_reminders failed: ${formatError(err)}`)
      return { content: [{ type: 'text', text: `list_reminders failed: ${formatError(err)}` }], isError: true }
    }
  },
)

// Tool families — each module registers its own group (thin wrappers over the
// internal-api client). Order is preserved from the original single-file table.
registerMemoryTools(server, client)
registerProjectTools(server, client)
registerVoiceShareTools(server, client)
registerMessagingTools(server, client)
registerCompanionTools(server, client)
registerA2ASendTool(server, client)

// Daemon self-diagnosis + remediation — admin-tier sessions only (the
// provider-agnostic gate; non-admin sessions never see these tools).
if (SESSION_IS_ADMIN) {
  registerDaemonTools(server, client)
  registerFileTools(server, client)
  // 社交工具面(spec 2026-09-05-social-tools):social_seek + 九个读 / 动
  // 主人社交层的工具。admin-only(user-tier.ts 的 social_seek / social_act
  // 都在 ADMIN_ONLY);非 admin 会话根本看不到,路由层再拒一次。
  registerSocialTools(server, client)
  // agent-facing search (AS T4): knowledge_search runs a semantic query
  // over the owner's WeChat message history — same private-data trust
  // class as file_locate/social_seek, so admin-only.
  registerKnowledgeSearchTool(server, client)
  // memory-infra Phase 2a (HF W1): federated_query reshapes the same
  // knowledge-search retrieval into hearth-compatible cited hits, letting
  // hearth (a separate memory app) query wechat-cc as a federated source.
  // Same private-data trust class as knowledge_search above, so admin-only.
  registerFederatedQueryTool(server, client)
  // Knowledge Graph inproc (GR T5): contact_profile/top_contacts/
  // relationship_subgraph/connectors/graph_status read the owner's full
  // contact/relationship graph — same private-data trust class as
  // knowledge_search above, so admin-only.
  registerGraphTools(server, client)
  // Knowledge Facts/Person inproc (FP T5): extraction_batch/record_facts/
  // contact_facts/find_facts/set_fact_status/extraction_status and
  // person_brief read/write the owner's structured fact store and
  // per-contact briefs — same private-data trust class as the graph tools
  // above, so admin-only.
  registerFactsTools(server, client)
  registerPersonTools(server, client)
  // Config surface: config_get/config_set read+write the owner's daemon
  // configuration through the whitelist in src/daemon/config-surface.ts —
  // a config write steers the daemon itself, so admin-only ('config_admin').
  registerConfigTools(server, client)
}

const transport = new StdioServerTransport()
await server.connect(transport)
logErr(`ready (pid=${process.pid}, base=${baseUrl})`)
