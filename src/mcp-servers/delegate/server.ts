/** Shared delegate tool registration; credentials belong to the supplied client. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import z from 'zod'
import type { InternalApiClient } from '../wechat/client'
import { formatError, formatErrorShort } from '../wechat/tool-helpers'

export function createDelegateMcpServer(client: InternalApiClient, peer: string, logErr: (line: string) => void = () => {}): McpServer {
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(peer)) throw new Error('Invalid delegate peer')
  const server = new McpServer(
    { name: 'delegate-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  // Display-cased peer name for the tool description (English title-case;
  // the daemon's provider-display-names.ts is canonical for the user-
  // facing prefix in parallel mode, but for the tool description we just
  // want a readable hint).
  function titleCase(s: string): string {
    if (s.length === 0) return s
    return s.charAt(0).toUpperCase() + s.slice(1)
  }
  const peerDisplay = titleCase(peer)

  server.registerTool(
    `delegate_${peer}`,
    {
      title: `Delegate to ${peerDisplay}`,
      description:
        `把一个具体问题交给 ${peerDisplay}（另一个 AI 助手）做一次性咨询，常用于二意见 / 代码审计 / 不同视角对比。` +
        `${peerDisplay} 不会看到当前对话历史 — 你需要把背景概括在 prompt 里。` +
        `${peerDisplay} 是只读环境（不能改文件、不能发微信、不能再 delegate）。返回它的回答全文。` +
        `每次都是新开的一个 ${peerDisplay}，不是主人终端里正在干活的那个会话，看不到它在做什么。主人要的是跟那条会话本身说话 / 讨论时，用 terminal_sessions 找码、terminal_say 送话（有这两个工具时）。` +
        `一次通常要一到几分钟（冷启动 + 回答），先跟主人说一声在问，别把慢当成对方忙。` +
        `仅在用户明确要求二意见，或你认为另一视角真的能改善答案时使用。`,
      inputSchema: {
        prompt: z.string().describe(`The question or task to send to ${peerDisplay}. Self-contained — include any context the peer needs since it sees no conversation history.`),
        context_summary: z.string().optional().describe('Optional: a 1-3 sentence summary of the surrounding context if the prompt alone is ambiguous.'),
        cwd: z.string().optional().describe(`Optional absolute path: if you want ${peerDisplay} to be able to Read/Bash/etc. files from a specific directory (e.g. the project the user is asking about), pass it here. Otherwise the peer runs in a sandboxed scratch dir with no project file access — RFC 03 P5 review #10.`),
      },
    },
    async ({ prompt, context_summary, cwd }) => {
      try {
        // RFC 03 P5 review #7 — depth = 0 from regular sessions. The
        // daemon /v1/delegate handler rejects any depth > 0 as a defense-
        // in-depth backstop; bare delegate peers don't have this MCP
        // loaded so they can't naturally produce a non-zero depth, but
        // the explicit field documents intent.
        const resp = await client.request<{ ok: boolean; response?: string; reason?: string }>(
          'POST', '/v1/delegate', { peer, prompt, context_summary, cwd, depth: 0 },
        )
        // Pass through the daemon's structured response so the agent can
        // distinguish success / failure cleanly.
        return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
      } catch (err) {
        const detail = formatError(err)
        logErr(`delegate_${peer} failed: ${formatErrorShort(err)}`)
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: detail }) }] }
      }
    },
  )

  return server
}
