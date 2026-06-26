/**
 * wechat-mcp project + user-name tools — list/switch/add/remove projects and
 * persist a wechat user's display name. Split out of main.ts; behavior verbatim.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerProjectTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: '列出已注册的项目及当前项目。',
      inputSchema: {},
    },
    async () => {
      try {
        const arr = await client.request<unknown>('GET', '/v1/projects/list')
        return { content: [{ type: 'text', text: JSON.stringify(arr) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'list_projects')
      }
    },
  )

  server.registerTool(
    'switch_project',
    {
      title: 'Switch project',
      description: '切换到指定项目别名。',
      inputSchema: { alias: z.string() },
    },
    async ({ alias }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/projects/switch', { alias })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'switch_project')
      }
    },
  )

  server.registerTool(
    'add_project',
    {
      title: 'Register a new project',
      description: '注册一个新项目（别名 + 绝对路径）。',
      inputSchema: { alias: z.string(), path: z.string() },
    },
    async ({ alias, path }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/projects/add', { alias, path })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'add_project')
      }
    },
  )

  server.registerTool(
    'remove_project',
    {
      title: 'Remove a project',
      description: '移除一个已注册的项目。',
      inputSchema: { alias: z.string() },
    },
    async ({ alias }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/projects/remove', { alias })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'remove_project')
      }
    },
  )

  server.registerTool(
    'set_user_name',
    {
      title: 'Persist a wechat user display name',
      description: '记住新用户的显示名称。',
      inputSchema: { chat_id: z.string(), name: z.string() },
    },
    async ({ chat_id, name }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/user/set_name', { chat_id, name })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'set_user_name')
      }
    },
  )
}
