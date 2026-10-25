/**
 * wechat-mcp 里两件不说话的表情工具:search_online_sticker_candidates(搜候选、看图,不发)与 sticker_feedback
 * (记主人对表情的反馈)。从 main.ts 拆出来的;行为照旧。
 *
 * 以前这里还有一整族「用工具说话」的工具(reply / reply_voice / send_file / edit_message / broadcast /
 * send_sticker / search_online_sticker / send_online_sticker_candidate)。回复交付(spec 2026-10-03)之后一轮最后
 * 写下的那段话就是回复、由 daemon 送达,daemon 起的每个 MCP 子进程都不再注册它们(当年按 WECHAT_REPLY_DELIVERY
 * 切);D3 把旧路连同开关一起删了。附件与 admin 的 message 在 tools-turn.ts。
 */
// 默认导入:zod v4 的具名 { z } 在 vitest 进程内加载时会解析成 undefined(见 tools-federated.ts)
import z from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerMessagingTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'search_online_sticker_candidates',
    {
      title: 'Search sticker candidates for visual selection',
      description: '联网搜索多张候选表情并返回预览，不发送。先根据语境看图选择最匹配的一张，再调用 sticker（mood + 那一张的 id + url）附到这一轮回复里。',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      try {
        const r = await client.request<{ candidates?: Array<{ id: string; url: string }> }>('POST', '/v1/wechat/search_online_sticker_candidates', { query })
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text', text: JSON.stringify(r) }]
        for (const candidate of (r.candidates ?? []).slice(0, 6)) {
          try {
            const response = await fetch(candidate.url)
            if (!response.ok) continue
            const mimeType = response.headers.get('content-type')?.split(';')[0] ?? 'image/gif'
            if (!mimeType.startsWith('image/')) continue
            const data = Buffer.from(await response.arrayBuffer()).toString('base64')
            content.push({ type: 'image', data, mimeType })
          } catch { /* one bad preview must not hide the others */ }
        }
        return { content }
      } catch (err) { return passthroughErrorResult(err, 'search_online_sticker_candidates') }
    },
  )

  server.registerTool(
    'sticker_feedback',
    {
      title: 'Record sticker feedback',
      description: '记录用户对刚发表情包的反馈，让后续选择更懂用户。用户说“这张不错/喜欢”用 positive；说“不是这个/太夸张/不喜欢”用 negative。',
      inputSchema: { chat_id: z.string(), signal: z.enum(['positive', 'negative']), file: z.string().optional() },
    },
    async ({ chat_id, signal, file }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/wechat/sticker_feedback', { chat_id, signal, ...(file ? { file } : {}) })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) { return passthroughErrorResult(err, 'sticker_feedback') }
    },
  )
}
