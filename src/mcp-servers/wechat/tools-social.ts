/**
 * wechat-mcp social-seek outbound tool — lets the operator initiate outbound
 * social contact with external A2A agents around a topic (agent-social M1).
 * Admin-only (see user-tier.ts ADMIN_ONLY): unlike a2a_send (reply to an
 * already-established peer), this actively broadcasts an intent to strangers.
 * Mirrors tools-a2a.ts's registerA2ASendTool shape.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerSocialSeekTool(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'social_seek',
    {
      title: 'Seek social match via A2A agents',
      description: '就某个话题向已注册的外部 A2A agent 网络发起"牵线"意图——广播给可能相关的 agent，双方都确认后才算"点亮"。仅管理员可用。返回 SeekOutcome: { intent_id, matched, lit }。',
      inputSchema: {
        topic: z.string().describe('要寻找同好/资源的话题，例如"周末爬山搭子"'),
        city: z.string().optional().describe('可选，限定城市范围'),
      },
    },
    async ({ topic, city }) => {
      try {
        const resp = await client.request<unknown>('POST', '/v1/social/seek', { topic, city })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'social_seek')
      }
    },
  )
}
