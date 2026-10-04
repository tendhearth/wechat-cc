/**
 * 回复交付(spec docs/superpowers/specs/2026-10-03-reply-delivery-design.md §4.5 / §4.6)的工具面 ——
 * 只注册给 `replyDelivery = daemon` 的 provider(daemon 在这个 MCP 子进程的环境里设
 * `WECHAT_REPLY_DELIVERY=daemon`)。这类 provider **没有** reply / reply_voice / send_file / edit_message /
 * broadcast / send_sticker 这些「用工具说话」的工具:一轮最后写下的那段话就是回复,daemon 负责送达。
 *
 *   voice(text) / sticker(...) / attach_file(path) —— 本轮回复的附件,**不带 chat_id**(目标永远是本轮的
 *     聊天,daemon 从会话令牌取),在文字之后按调用顺序发出;回执是 {ok:true, attached:true}。
 *   message(to, text) —— 只给 admin:往**别处**发(别的聊天 / 主人自己的微信 / 群发)。
 */
// 默认导入:zod v4 的具名 { z } 在 vitest 进程内加载时会解析成 undefined(见 tools-federated.ts)
import z from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerTurnTools(server: McpServer, client: InternalApiClient, opts: { admin: boolean }): void {
  const post = async (tool: string, path: string, body: Record<string, unknown>) => {
    try {
      const r = await client.request<unknown>('POST', path, body)
      return { content: [{ type: 'text' as const, text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, tool)
    }
  }
  const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

  server.registerTool(
    'voice',
    {
      title: 'Attach a voice message to this reply',
      description: '把这段话作为**语音**附在本轮回复上:daemon 合成,在你最后写下的文字之后发出。用户要语音、或道晚安 / 安慰这类适合用声音的短句时用;≤ 500 字,不放代码 / 链接 / 长列表。只想发语音时,最后的文字留空或写同一句即可(只会发语音);合成失败 daemon 会自动改发文字,你不用兜底。',
      inputSchema: { text: z.string() },
    },
    async ({ text }) => post('voice', '/v1/turn/attach', { kind: 'voice', text }),
  )

  server.registerTool(
    'sticker',
    {
      title: 'Attach a sticker to this reply',
      description: '给本轮回复附一张表情,在文字之后发出;一轮最多一张,配合文字而不是替代文字。三种用法选一:tag=本地表情库的 tag;或 mood+id+url=先用 search_online_sticker_candidates 看图、选中的那一张;或 mood+query=按情绪联网找一张(query 用英文关键词)。',
      inputSchema: {
        tag: z.string().optional(),
        mood: z.string().optional(),
        id: z.string().optional(),
        url: z.string().optional(),
        query: z.string().optional(),
      },
    },
    async (args) => post('sticker', '/v1/turn/attach', { kind: 'sticker', ...defined(args) }),
  )

  server.registerTool(
    'attach_file',
    {
      title: 'Attach a local file to this reply',
      description: '把本机文件(绝对路径)附在本轮回复上,在文字之后发出。',
      inputSchema: { path: z.string() },
    },
    async ({ path }) => post('attach_file', '/v1/turn/attach', { kind: 'file', path }),
  )

  if (!opts.admin) return

  server.registerTool(
    'message',
    {
      title: 'Send a message somewhere else',
      description: "往**别处**发一条:to='owner'(主人自己的微信)、某个 chat_id、或 'broadcast'(群发所有在线用户;account_id 可选)。只用于**不是本轮这个聊天**的目标 —— 本轮要对这个人说的话直接写在最后,daemon 会发;to 等于本轮聊天会报错。",
      inputSchema: { to: z.string(), text: z.string(), account_id: z.string().optional() },
    },
    async (args) => post('message', '/v1/wechat/message', defined(args)),
  )
}
