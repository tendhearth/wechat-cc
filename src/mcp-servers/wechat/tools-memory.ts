/**
 * wechat-mcp memory tools — read/write/list/soft-delete over the daemon's
 * sandboxed memory/ store (loopback to /v1/memory/*). Split out of main.ts;
 * behavior verbatim. Legacy wire shapes preserved so the system prompt's tool
 * docs stay true.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerMemoryTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'memory_read',
    {
      title: 'Read memory file',
      description: '读 memory/ 下的一个文件。不存在返回 exists:false。相对路径，只允许 .md。',
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      try {
        const resp = await client.request<{ exists: boolean; content?: string; error?: string }>(
          'POST', '/v1/memory/read', { path },
        )
        // Preserve legacy wire shape: agent sees the same JSON it always saw.
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'memory_read')
      }
    },
  )

  server.registerTool(
    'memory_write',
    {
      title: 'Write memory file',
      description: '写 memory/ 下的一个文件（atomic, 覆盖）。相对路径，只允许 .md。单文件 100KB 上限。父目录自动创建。',
      inputSchema: { path: z.string(), content: z.string() },
    },
    async ({ path, content }) => {
      try {
        const resp = await client.request<{ ok: boolean; error?: string }>(
          'POST', '/v1/memory/write', { path, content },
        )
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'memory_write')
      }
    },
  )

  server.registerTool(
    'memory_list',
    {
      title: 'List memory files',
      description: '列 memory/ 下所有 .md 文件（递归）。传 dir 只列该子目录。返回相对路径数组。',
      // Refine `dir`: cap length + reject null bytes. Defense-in-depth for
      // the downstream /v1/memory/list URL — encodeURIComponent doesn't
      // protect against URL-shape attacks at the daemon's HTTP layer if
      // the daemon ever trusts the path beyond its sandboxed memory root.
      inputSchema: {
        dir: z.string()
          .max(512, 'dir must be <= 512 chars')
          .refine(s => !s.includes('\0'), { message: 'dir must not contain null bytes' })
          .optional(),
      },
    },
    async ({ dir }) => {
      try {
        const qs = dir ? `?dir=${encodeURIComponent(dir)}` : ''
        const resp = await client.request<{ files: string[]; error?: string }>(
          'GET', `/v1/memory/list${qs}`,
        )
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'memory_list')
      }
    },
  )

  server.registerTool(
    'memory_delete',
    {
      title: 'Soft-delete a memory file',
      description:
        '把 memory/ 下的一个 .md 文件"软删除"——重命名为 .deleted-<时间> 后缀，不进入 memory_list() 结果；用户可在终端 mv 还原。\n' +
        '何时调用：用户明确说"忘了/删掉/不要这个了"。不要因为"觉得过时了"主观删除。\n' +
        '硬删除：本工具不提供。若需彻底擦除（隐私 / 法律原因），让用户手动 rm `~/.claude/channels/wechat/memory/<chat>/<path>.deleted-*`。\n' +
        '必填 reason：写下用户说了什么 / 你为何认为该删，会进 audit 日志（dashboard 可查），方便事后追溯。',
      inputSchema: {
        chat_id: z.string(),
        path: z.string()
          .max(500, 'path must be <= 500 chars')
          .refine(s => !s.includes('\0'), { message: 'path must not contain null bytes' }),
        reason: z.string()
          .min(4, 'reason must be at least 4 chars — quote the user or state your inference')
          .max(500, 'reason must be <= 500 chars'),
      },
    },
    async ({ chat_id, path, reason }) => {
      try {
        const resp = await client.request<{
          ok: boolean
          tombstone?: string
          existed?: boolean
          error?: string
        }>('POST', '/v1/memory/delete', { chat_id, path, reason })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'memory_delete')
      }
    },
  )
}
