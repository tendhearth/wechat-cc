/**
 * wechat-mcp voice-config + share-page tools. Voice tools read/write the local
 * TTS config (reply_voice itself lives with the messaging family). Share tools
 * publish/resurface a one-time Markdown URL. Split out of main.ts; verbatim.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerVoiceShareTools(server: McpServer, client: InternalApiClient): void {
  // ─── voice config ───────────────────────────────────────────────────────
  server.registerTool(
    'voice_config_status',
    {
      title: 'Get TTS config status',
      description: '查询当前 TTS 配置状态。不返回 api_key，只返回 provider、默认音色、base_url/model（如果是 http_tts）、saved_at。',
      inputSchema: {},
    },
    async () => {
      try {
        const r = await client.request<unknown>('GET', '/v1/voice/status')
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'voice_config_status')
      }
    },
  )

  server.registerTool(
    'save_voice_config',
    {
      title: 'Save TTS config (with test-synth validation)',
      description: '保存 TTS 配置。provider=http_tts 时必须提供 base_url + model（常见：VoxCPM2 通过本地 vllm serve --omni 部署）；provider=qwen 时必须提供 api_key。保存前会做一次 1 秒测试合成验证。',
      inputSchema: {
        provider: z.enum(['http_tts', 'qwen']),
        base_url: z.string().url().optional(),
        model: z.string().optional(),
        api_key: z.string().optional(),
        default_voice: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/voice/save_config', args)
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'save_voice_config')
      }
    },
  )

  // ─── share_page / resurface_page ──────────────────────────────────────────
  server.registerTool(
    'share_page',
    {
      title: 'Publish Markdown to a one-time URL',
      description: '把 Markdown 内容发布为一次性 URL。返回 {url, slug}。needs_approval=true 时页面会渲染 ✓ Approve 按钮（默认 false，纯内容文档不带按钮）。chat_id 传入后页脚会出现"📄 发 PDF 到微信"按钮，点击会把 PDF 推到该 chat。',
      inputSchema: {
        title: z.string(),
        content: z.string(),
        needs_approval: z.boolean().optional(),
        chat_id: z.string().optional(),
        account_id: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/share/page', args)
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'share_page')
      }
    },
  )

  server.registerTool(
    'resurface_page',
    {
      title: 'Resurface a previously shared page',
      description: '根据 slug 或标题片段重新生成一个有效 URL。',
      inputSchema: {
        slug: z.string().optional(),
        title_fragment: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/share/resurface', args)
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'resurface_page')
      }
    },
  )
}
