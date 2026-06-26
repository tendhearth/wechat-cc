/**
 * wechat-mcp a2a outbound-send tool — lets the operator reply to a `[A2A:<id>]`
 * notification from an external agent. Non-admin (any allow-listed session).
 * Split out of main.ts; behavior verbatim.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerA2ASendTool(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'a2a_send',
    {
      title: 'Send to A2A agent',
      description: '给已注册的外部 A2A agent 发送消息。用于操作者让你"回复 [A2A:xxx]"那条通知时——agent_id 就是 [A2A:<id>] 前缀里的 id。返回 { ok, http_status?, error?, registered? }。',
      inputSchema: {
        agent_id: z.string().describe('已注册的 agent id，例如 deploy-bot'),
        text: z.string().describe('要发给该 agent 的消息正文'),
      },
    },
    async ({ agent_id, text }) => {
      try {
        const resp = await client.request<unknown>('POST', '/v1/a2a/send', { agent_id, text })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'a2a_send')
      }
    },
  )
}
