/**
 * wechat-mcp reminders tools — multi-user precise-time reminders. Unlike
 * companion/agenda (operator-only, day-granular), these let the agent set a
 * precise-time reminder for ANY user: chat_id is whoever should receive it
 * (normally the current conversation's chat_id). Provide EITHER delay_seconds
 * (relative — preferred, no timezone math) OR due_at (absolute ISO 8601). The
 * daemon's reminder sweeper delivers it even if the session restarts.
 *
 * Extracted from the pre-refactor single-file main.ts (feat/reminders,
 * 2026-06-18) into the tools-*.ts module shape the MCP server now uses.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerReminderTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'schedule_reminder',
    {
      title: 'Schedule a precise-time reminder',
      description:
        '给某个用户设一个精确时间的提醒，到点由 daemon 直接发出（不依赖本会话存活，跨重启）。' +
        'chat_id=要收到提醒的用户（通常是当前对话的 chat_id）。' +
        '二选一：delay_seconds（相对秒数，首选，免时区计算）或 due_at（绝对 ISO 8601 时间）。' +
        'text=到点要发的内容。返回 { ok, reminder_id, due_at }。' +
        '适合"X 小时后/几点提醒我"。注意：发送依赖该用户的会话 token，若提醒延迟很久且用户长期未与 bot 互动，可能投递失败（会自动重试一段时间）。',
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
        return passthroughErrorResult(err, 'schedule_reminder')
      }
    },
  )

  server.registerTool(
    'cancel_reminder',
    {
      title: 'Cancel a pending reminder',
      description: '取消一个还未触发的提醒。reminder_id 来自 schedule_reminder / list_reminders；chat_id 必须是该提醒所属用户。返回 { ok, cancelled }。',
      inputSchema: { chat_id: z.string(), reminder_id: z.string() },
    },
    async ({ chat_id, reminder_id }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/reminders/cancel', { chat_id, reminder_id })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'cancel_reminder')
      }
    },
  )

  server.registerTool(
    'list_reminders',
    {
      title: 'List a user\'s reminders',
      description: '列出某个用户的所有提醒（含 pending/sent/cancelled/failed）。chat_id 必填。返回 { ok, reminders:[{id,due_at,text,status}] }。',
      inputSchema: { chat_id: z.string() },
    },
    async ({ chat_id }) => {
      try {
        const r = await client.request<unknown>('GET', `/v1/reminders/list?chat_id=${encodeURIComponent(chat_id)}`)
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'list_reminders')
      }
    },
  )
}
