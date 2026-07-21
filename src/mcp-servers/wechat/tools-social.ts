/**
 * wechat-mcp social-seek outbound tool — lets the operator initiate outbound
 * social contact with external A2A agents around a topic (agent-social M1).
 * Admin-only (see user-tier.ts ADMIN_ONLY): unlike a2a_send (reply to an
 * already-established peer), this actively broadcasts an intent to strangers.
 * Mirrors tools-a2a.ts's registerA2ASendTool shape.
 *
 * P4 派心愿 (docs/superpowers/specs/2026-07-20-p4-seek-confirm-design.md):
 * this tool now only PROPOSES (POST /v1/social/seek/propose) — it gates the
 * topic/city and stashes a `proposed` row, but broadcasts nothing. The
 * actual send only happens once the owner explicitly confirms (派 <id>,
 * hitting /confirm) or voids it (取消 <id>, hitting /cancel) — those two
 * legs are the CLI's job (`wechat-cc social confirm|cancel`), not this
 * tool's; the model's job here is to relay the redacted preview and the
 * hint back to the owner, then wait for their reply.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerSocialSeekTool(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'social_seek',
    {
      title: 'Propose a social seek via A2A agents',
      description: '就某个话题向外部 A2A agent 网络"提案"一条觅食心愿——本工具只生成脱敏预览并暂存(proposed)，不会立即广播。返回 { intent_id, redacted, hint }。请把 redacted 预览转述给主人，并让主人回「派 <id>」才真正发出、或「取消 <id>」作废。仅管理员可用。',
      inputSchema: {
        topic: z.string().describe('要寻找同好/资源的话题，例如"周末爬山搭子"'),
        city: z.string().optional().describe('可选，限定城市范围'),
      },
    },
    async ({ topic, city }) => {
      try {
        const resp = await client.request<{ intent_id?: string; redacted?: string }>('POST', '/v1/social/seek/propose', { topic, city })
        const hint = '已生成脱敏预览并暂存；请向主人展示 redacted，并请主人回「派 ' + (resp.intent_id ?? '<id>') + '」发出，或「取消 ' + (resp.intent_id ?? '<id>') + '」作废。'
        return { content: [{ type: 'text', text: JSON.stringify({ ...resp, hint }) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'social_seek')
      }
    },
  )
}
