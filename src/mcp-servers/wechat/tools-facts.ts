/**
 * wechat-mcp Facts tools (Knowledge Facts/Person inproc, Task 5) — lets the
 * agent extract and query structured facts (entities/relations/obligations)
 * from the owner's 1:1 message history, backed by the daemon's in-proc
 * facts.db (Task 1) via the /v1/knowledge/facts/* routes. Admin-only (see
 * user-tier.ts ADMIN_ONLY): same private-data trust class as
 * knowledge_search/graph tools/file_locate/social_seek.
 * Tool names + Chinese descriptions are reused verbatim from the retired
 * wxfacts plugin (wechat-cc-plugins/packages/wxfacts/wxfacts/server.py's
 * TOOLS table) so agents that already know wxfacts need no relearning.
 * Mirrors tools-graph.ts's registerGraphTools shape.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerFactsTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'extraction_batch',
    {
      title: 'Next un-extracted 1:1 message batch',
      description: '取下一批未抽取的 1:1 消息(不给 contact 则选积压最多的联系人)。你(agent)据此抽取实体/关系/义务,再调 record_facts 回写。仅管理员可用。',
      inputSchema: {
        contact: z.string().optional(),
        limit: z.number().int().optional(),
      },
    },
    async ({ contact, limit }) => {
      try {
        const resp = await client.request('POST', '/v1/knowledge/facts/extraction_batch', { contact, limit })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'extraction_batch')
      }
    },
  )

  server.registerTool(
    'chat_history',
    {
      title: 'Raw chat transcript lookup',
      description: '【管理员】查某个 chat 的原始聊天记录。默认给最近 limit 条(旧→新);给 query 则全文搜索;给 before(ISO 时间戳)则向更早翻页。刚接手对话缺上下文时用它——交接摘要之外的原文都在这里。',
      inputSchema: {
        chatId: z.string().describe('微信 chat_id'),
        limit: z.number().int().min(1).max(200).optional(),
        query: z.string().optional().describe('全文搜索关键词;省略则按时间取最近'),
        before: z.string().optional().describe('ISO 时间戳,取严格早于此刻的一页(向上翻)'),
      },
    },
    async ({ chatId, limit, query, before }) => {
      try {
        const qs = new URLSearchParams({ chatId })
        if (limit) qs.set('limit', String(limit))
        if (query) qs.set('query', query)
        if (before) qs.set('before', before)
        const resp = await client.request('GET', `/v1/chat/history?${qs}`)
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'chat_history')
      }
    },
  )

  server.registerTool(
    'record_facts',
    {
      title: 'Record extracted facts + advance the batch',
      description: '回写你抽取到的结构化断言并推进该批水位(facts 可空,只推进)。fact: {kind,predicate,value,related_contact?,time_ref?,confidence?,source_msg_keys?}。confidence=low|med|high;kind 建议 entity|relation|obligation|attribute|event。仅管理员可用。',
      inputSchema: {
        batch_id: z.string(),
        facts: z.array(z.any()).optional(),
      },
    },
    async ({ batch_id, facts }) => {
      try {
        const resp = await client.request('POST', '/v1/knowledge/facts/record_facts', { batch_id, facts: facts ?? [] })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'record_facts')
      }
    },
  )

  server.registerTool(
    'contact_facts',
    {
      title: "One contact's extracted facts",
      description: '某联系人已抽取的事实(按 kind 分组)。仅管理员可用。',
      inputSchema: {
        name: z.string(),
      },
    },
    async ({ name }) => {
      try {
        const resp = await client.request('POST', '/v1/knowledge/facts/contact_facts', { name })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'contact_facts')
      }
    },
  )

  server.registerTool(
    'find_facts',
    {
      title: 'Find facts across contacts',
      description: '跨联系人查事实(query 子串匹配 predicate/value)。如 kind=obligation 查未了义务。仅管理员可用。',
      inputSchema: {
        kind: z.string().optional(),
        predicate: z.string().optional(),
        query: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().optional(),
      },
    },
    async ({ kind, predicate, query, status, limit }) => {
      try {
        const resp = await client.request('POST', '/v1/knowledge/facts/find_facts', { kind, predicate, query, status, limit })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'find_facts')
      }
    },
  )

  server.registerTool(
    'set_fact_status',
    {
      title: 'Change a fact status',
      description: '改事实状态:resolved(如义务已还)/superseded(过时纠正)。仅管理员可用。',
      inputSchema: {
        id: z.number().int(),
        status: z.string(),
      },
    },
    async ({ id, status }) => {
      try {
        const resp = await client.request('POST', '/v1/knowledge/facts/set_fact_status', { id, status })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'set_fact_status')
      }
    },
  )

  server.registerTool(
    'extraction_status',
    {
      title: 'Extraction progress',
      description: '抽取进度:每联系人已抽取到/剩余、按 kind 的事实总数。仅管理员可用。',
      inputSchema: {},
    },
    async () => {
      try {
        const resp = await client.request('GET', '/v1/knowledge/facts/extraction_status')
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'extraction_status')
      }
    },
  )
}
