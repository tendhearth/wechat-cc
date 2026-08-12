/**
 * wechat-mcp knowledge-search tool — lets the agent semantically search the
 * owner's WeChat message history ("that conversation where we talked about
 * X") via the daemon's embedded knowledge index. Admin-only (see
 * user-tier.ts ADMIN_ONLY): the index covers the owner's private message
 * history, same trust class as file_locate/social_seek. Mirrors
 * tools-social.ts's registerSocialSeekTool shape.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerKnowledgeSearchTool(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'knowledge_search',
    {
      title: 'Semantically search the owner\'s WeChat message history',
      description: '语义检索机主的微信消息历史——找"那次聊到 X 的对话"。回溯具体聊天内容时用它。仅管理员可用。',
      inputSchema: {
        query: z.string().describe('要检索的内容，例如"上次聊到的那个报销流程"'),
        limit: z.number().optional().describe('可选，返回结果条数上限'),
        conversation: z.string().optional().describe('可选，限定在某个会话内检索'),
      },
    },
    async ({ query, limit, conversation }) => {
      try {
        const resp = await client.request('POST', '/v1/knowledge/search', { query, limit, conversation })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'knowledge_search')
      }
    },
  )
}
