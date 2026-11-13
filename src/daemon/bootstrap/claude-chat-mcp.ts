import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { McpStdioSpec } from '../../adapters/executors/mcp-stdio-spec'
import { createInternalApiClient } from '../../mcp-servers/wechat/client'
import { createWechatMcpServer } from '../../mcp-servers/wechat/server'
import { createDelegateMcpServer } from '../../mcp-servers/delegate/server'
import { logErr } from '../../mcp-servers/wechat/tool-helpers'

/** SDK serializes stdio specs into argv. Core credentials stay in parent closures. */
export async function claudeChatMcp(name: 'wechat' | 'delegate', spec: McpStdioSpec, sessionEnv: Record<string, string>, signal?: AbortSignal): Promise<McpSdkServerConfigWithInstance> {
  const env = { ...spec.env, ...sessionEnv }
  const lifetime = new AbortController()
  const cancel = () => lifetime.abort()
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  lifetime.signal.addEventListener('abort', () => signal?.removeEventListener('abort', cancel), { once: true })
  const client = createInternalApiClient({
    baseUrl: env.WECHAT_INTERNAL_API!, tokenFilePath: env.WECHAT_INTERNAL_TOKEN_FILE!,
    sessionToken: env.WECHAT_SESSION_TOKEN ?? '', signal: lifetime.signal, logger: logErr,
  })
  try {
    const instance = name === 'wechat'
      ? await createWechatMcpServer(client, { tier: env.WECHAT_SESSION_TIER, participantTag: env.WECHAT_PARTICIPANT_TAG, logger: logErr })
      : createDelegateMcpServer(client, env.WECHAT_DELEGATE_PEER!, logErr)
    const onclose = instance.server.onclose
    instance.server.onclose = () => { cancel(); onclose?.() }
    return { type: 'sdk', name, instance }
  } catch (error) { cancel(); throw error }
}
