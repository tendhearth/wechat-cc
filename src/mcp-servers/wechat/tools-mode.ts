/**
 * wechat-mcp mode tools — let the agent switch THIS chat's provider/model when
 * the owner asks in plain language(「换成 DeepSeek」「用 Gemini 试试」),
 * instead of the owner having to know which slash command maps to which
 * vendor. Thin wrapper over POST /v1/conversation/set-mode (the same
 * coordinator path /cc /api /agy use). Registered for non-guest sessions;
 * classify gates it to ToolKind 'mode_switch' (trusted+).
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'
import { PROVIDER_IDS } from '../../lib/provider-ids'

export function registerModeTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'provider_switch',
    {
      title: 'Switch this chat\'s provider / model',
      description:
        '把**这个对话**切到另一家后端(可顺带钉模型),只影响本对话。主人说「换成 DeepSeek / 用 Gemini / 切回 Claude」时用。'
        + 'provider 取值:claude(Claude 订阅)、agy(Gemini 订阅)、cursor、codex、openai(主人自配的 OpenAI 兼容 API —— DeepSeek/Kimi/Qwen 这类都走它,model 填网关上的模型名如 DeepSeek)。'
        + '同家换版本(opus 4.8 → opus 5)不用这个,用 model_set。切完由你自己告诉主人,不要再复述系统回执。',
      inputSchema: {
        chat_id: z.string(),
        provider: z.enum(PROVIDER_IDS),
        model: z.string().min(1).max(100).optional().describe('可选,钉这个对话的模型;省略 = 该 provider 的全局默认'),
      },
    },
    async ({ chat_id, provider, model }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/conversation/set-mode', {
          chatId: chat_id,
          mode: { kind: 'solo', provider, ...(model ? { model } : {}) },
          quiet: true,
        })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'provider_switch')
      }
    },
  )
}
