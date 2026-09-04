/**
 * wechat-mcp social-seek outbound tool — lets the operator ask the daemon to
 * put a question to the people it knows (agent-social M1). Admin-only (see
 * user-tier.ts ADMIN_ONLY): unlike a2a_send (reply to an already-established
 * peer), this actively reaches out. Mirrors tools-a2a.ts's
 * registerA2ASendTool shape.
 *
 * 心愿 (spec 2026-09-04-wish-postcard §4) repoint: this tool keeps its NAME
 * (`social_seek` — the model already knows it) but now only PROPOSES
 * (POST /v1/social/wish) — it gates the text and stashes a draft, but sends
 * nothing. The actual send only happens once the owner explicitly says
 * 派 <id> (hitting /v1/social/wish/send) or 取消 <id> (hitting
 * /v1/social/wish/cancel) — those two legs are the CLI's job
 * (`wechat-cc social ...`), not this tool's; the model's job here is to
 * relay the preview (or, on a gate failure, which words can't go out) and
 * the hint back to the owner, then wait for their reply.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

interface WishProposeResponse {
  ok: boolean
  id?: string
  preview?: string
  error?: string
  violations?: string[]
}

export function registerSocialSeekTool(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'social_seek',
    {
      title: 'Propose a social wish via people the owner knows',
      description: '替主人向认识的人打听——本工具只生成脱敏预览并暂存草稿，不会立即发出。返回 { ok, id, preview } 或 { ok:false, error, violations }。请把 preview 转述给主人，并让主人回「派 <id>」才真正发出、或「取消 <id>」作废；若 ok:false，请原样告诉主人哪些话不能说出去。仅管理员可用。',
      inputSchema: {
        topic: z.string().describe('要寻找同好/资源的话题，例如"周末爬山搭子"'),
        city: z.string().optional().describe('可选，限定城市范围'),
      },
    },
    async ({ topic, city }) => {
      try {
        const resp = await client.request<WishProposeResponse>('POST', '/v1/social/wish', { text: topic + (city ? `(${city})` : '') })
        if (!resp.ok) return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
        const hint = `已生成脱敏预览并暂存;请把 preview 转述给主人,主人回「派 ${resp.id ?? '<id>'}」才发出,「取消 ${resp.id ?? '<id>'}」作废。`
        return { content: [{ type: 'text', text: JSON.stringify({ ...resp, hint }) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'social_seek')
      }
    },
  )
}
