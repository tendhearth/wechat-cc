/**
 * wechat-mcp Config tools — lets the agent read and change the owner's
 * daemon configuration conversationally ("把知识内核打开"、"换成 gemini
 * flash"), backed by the whitelist-bounded config surface
 * (src/lib/config-surface.ts) via /v1/config/*. Admin-only (user-tier.ts
 * 'config_admin'): a config write steers the daemon itself, same fail-closed
 * posture as daemon_remediate. Mirrors tools-facts.ts's registerFactsTools
 * shape.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerConfigTools(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'config_get',
    {
      title: 'Read the daemon config surface',
      description:
        '读取可配置项白名单及当前值(含类型/可写性/生效时机)。主人问"现在什么配置"或想改设置前先调这个。仅管理员可用。',
      inputSchema: {},
    },
    async () => {
      try {
        const resp = await client.request('GET', '/v1/config/surface')
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'config_get')
      }
    },
  )

  server.registerTool(
    'config_set',
    {
      title: 'Write one whitelisted config key',
      description:
        '修改一个白名单配置项。只在主人明确要求改配置时调用;先 config_get 确认键名和可选值。' +
        '布尔用 on/off,枚举用 config_get 返回的 values。回复里会带生效时机' +
        '(immediate=立即 / daemon-restart=需重启 / next-tick=下个周期 / reinstall=下次安装)——把它转告主人。' +
        'reason 写清楚主人的原话或理由,会进审计日志。仅管理员可用。',
      inputSchema: {
        key: z.string(),
        value: z.string(),
        reason: z.string().min(2),
      },
    },
    async ({ key, value, reason }) => {
      try {
        const resp = await client.request('POST', '/v1/config/set', { key, value, reason })
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'config_set')
      }
    },
  )
}
