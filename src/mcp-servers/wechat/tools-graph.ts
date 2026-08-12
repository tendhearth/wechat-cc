/**
 * wechat-mcp Graph Query tools (Knowledge Graph inproc, Task 5) — lets the
 * agent read the owner's contact/relationship graph (built in-proc by
 * graph-build.ts's rebuildGraphFromSource, Task 4) via the daemon's
 * /v1/knowledge/graph/* routes. Admin-only (see user-tier.ts ADMIN_ONLY):
 * same private-data trust class as knowledge_search/file_locate/social_seek.
 * Tool names + Chinese descriptions are reused verbatim from the retired
 * wxgraph plugin (wechat-cc-plugins/packages/wxgraph/wxgraph/server.py's
 * TOOLS table) so agents that already know wxgraph need no relearning.
 * Mirrors tools-knowledge.ts's registerKnowledgeSearchTool shape.
 *
 * `rank_contacts` is deliberately NOT exposed here — per the plan, it's for
 * agent-social's `discover` flow, not a direct agent-facing tool.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerGraphTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'contact_profile',
    {
      title: 'Relationship profile for one contact',
      description: '某个联系人的关系画像(分项分数+互动明细+提及伙伴)。仅管理员可用。',
      inputSchema: {
        name: z.string().describe('联系人名字(按微信联系人名解析，同名可能对不准)'),
      },
    },
    async ({ name }) => {
      try {
        const resp = await client.request('POST', '/v1/knowledge/graph/contact_profile', { name })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'contact_profile')
      }
    },
  )

  server.registerTool(
    'top_contacts',
    {
      title: 'Rank contacts by a relationship dimension',
      description: '按维度排序联系人:closeness/volume/recency/reciprocity/neglected。仅管理员可用。',
      inputSchema: {
        by: z.string().optional().describe('排序维度，默认 closeness'),
        limit: z.number().optional().describe('返回条数上限，默认 20'),
        kind: z.enum(['person', 'group']).optional().describe('联系人类型，默认 person'),
      },
    },
    async ({ by, limit, kind }) => {
      try {
        const resp = await client.request('POST', '/v1/knowledge/graph/top_contacts', { by, limit, kind })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'top_contacts')
      }
    },
  )

  server.registerTool(
    'relationship_subgraph',
    {
      title: 'My relationship subgraph',
      description: '以我为中心的关系子图(节点+边),给 agent 推理/渲染。仅管理员可用。',
      inputSchema: {
        center: z.string().optional().describe('可选，子图中心（当前实现未生效，仅保留兼容位）'),
        limit: z.number().optional().describe('节点数上限，默认 30'),
      },
    },
    async ({ center, limit }) => {
      try {
        const resp = await client.request('POST', '/v1/knowledge/graph/relationship_subgraph', { center, limit })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'relationship_subgraph')
      }
    },
  )

  server.registerTool(
    'connectors',
    {
      title: 'How two contacts are connected in my world',
      description: '两个联系人在我世界里的连接(共群+互相提及)。仅管理员可用。',
      inputSchema: {
        name_a: z.string().describe('联系人 A 的名字'),
        name_b: z.string().describe('联系人 B 的名字'),
      },
    },
    async ({ name_a, name_b }) => {
      try {
        const resp = await client.request('POST', '/v1/knowledge/graph/connectors', { a: name_a, b: name_b })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'connectors')
      }
    },
  )

  server.registerTool(
    'graph_status',
    {
      title: 'Graph build status',
      description: '联系人数/owner/是否需重建。仅管理员可用。',
      inputSchema: {},
    },
    async () => {
      try {
        const resp = await client.request('GET', '/v1/knowledge/graph/status')
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'graph_status')
      }
    },
  )
}
