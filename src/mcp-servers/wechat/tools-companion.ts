/**
 * wechat-mcp companion tools (RFC 03 P1.B B6) — enable/disable/status/snooze
 * the proactive-tick layer + toggle local-history auto-import. Split out of
 * main.ts; behavior verbatim.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerCompanionTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'companion_enable',
    {
      title: 'Enable Companion proactive ticks',
      description: '开启 Companion 主动关心：你在聊天里记下的待跟进（agenda.md）到点时系统会唤醒你来兑现。第一次调用会创建 config.json 并返回欢迎消息。幂等。',
      inputSchema: {},
    },
    async () => {
      try {
        const r = await client.request<unknown>('POST', '/v1/companion/enable')
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'companion_enable')
      }
    },
  )

  server.registerTool(
    'companion_disable',
    {
      title: 'Disable Companion proactive ticks',
      description: '关闭 Companion 主动推送。下一次 scheduler tick 不再触发。',
      inputSchema: {},
    },
    async () => {
      try {
        const r = await client.request<unknown>('POST', '/v1/companion/disable')
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'companion_disable')
      }
    },
  )

  server.registerTool(
    'companion_status',
    {
      title: 'Companion status',
      description: '查询 Companion 状态：是否开启、时区、默认 chat_id、snooze 截止时间。人格 / 触发器等历史详情请从 memory/ 读。',
      inputSchema: {},
    },
    async () => {
      try {
        const r = await client.request<unknown>('GET', '/v1/companion/status')
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'companion_status')
      }
    },
  )

  server.registerTool(
    'companion_snooze',
    {
      title: 'Snooze proactive pushes',
      description: '暂停所有主动推送若干分钟。用户说 "别烦我"/"停"/"snooze N 小时"/"shut up" 等时调用。',
      inputSchema: { minutes: z.number().int().min(1).max(24 * 60) },
    },
    async ({ minutes }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/companion/snooze', { minutes })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'companion_snooze')
      }
    },
  )

  server.registerTool(
    'companion_import_local',
    {
      title: 'Toggle local history auto-import',
      description: '开启/关闭"自动导入本机 claude/codex 的对话与记忆"。开启后：每次启动 + 每 24h 增量扫描本机历史入库（零 LLM 成本），并每 24h 重整一次"懂你"overview（约 1 次廉价调用/天）。用户说"导入我的本地记录/开启自动导入"→ enabled=true；"别再导入了"→ false。默认关。',
      inputSchema: { enabled: z.boolean() },
    },
    async ({ enabled }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/companion/import-local', { enabled })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'companion_import_local')
      }
    },
  )

  server.registerTool(
    'set_chat_pref',
    {
      title: 'Set chat preferences',
      description: '调整本对话的偏好——主动关心档位(off|low|high)和拆分回复。当用户表达"别烦我/多关心我/别拆分"这类偏好时使用,改完口头确认。',
      inputSchema: {
        chat_id: z.string(),
        care: z.enum(['off', 'low', 'high']).optional(),
        split: z.boolean().optional(),
      },
    },
    async ({ chat_id, care, split }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/chat-prefs', {
          chat_id,
          ...(care !== undefined ? { care } : {}),
          ...(split !== undefined ? { split } : {}),
        })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'set_chat_pref')
      }
    },
  )
}
