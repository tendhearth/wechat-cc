/**
 * wechat-mcp Person tool (Knowledge Facts/Person inproc, Task 5) — lets the
 * agent assemble one contact's unified brief (relationship profile +
 * structured facts + open obligations + recent messages) in a single call,
 * via the daemon's /v1/knowledge/person/brief route (Task 3's
 * `makePersonApi`). Admin-only (see user-tier.ts ADMIN_ONLY): same
 * private-data trust class as knowledge_search/graph tools/facts tools.
 * Tool name + Chinese description reused verbatim from the retired
 * wxperson plugin (wechat-cc-plugins/packages/wxperson/wxperson/server.py's
 * TOOLS table). Mirrors tools-graph.ts's registerGraphTools shape.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerPersonTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'person_brief',
    {
      title: 'Unified brief for one person',
      description: '一次组装某人的统一简报:关系画像 + 结构化事实 + 未了义务 + 近期消息(按人名解析,同名会给候选)。想整体了解一个人时先用它,再叠上你自己的看法。仅管理员可用。',
      inputSchema: {
        name: z.string(),
        recent_n: z.number().int().optional(),
      },
    },
    async ({ name, recent_n }) => {
      try {
        const resp = await client.request('POST', '/v1/knowledge/person/brief', { name, recent_n })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'person_brief')
      }
    },
  )
}
