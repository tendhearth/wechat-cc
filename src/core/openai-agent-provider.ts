import type { ProviderCapabilities, AgentEvent } from './agent-provider'
import type { TurnDelta } from './openai-chat-model'

/** wechat MCP tool names that get server:'wechat' stamped on their event (used
 *  by isReplyToolCall to detect the reply tool). Kept small — extend if the
 *  wechat server adds reply-like tools. */
const WECHAT_TOOL_NAMES = new Set([
  'reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast',
  'memory_read', 'memory_list', 'memory_write', 'memory_edit', 'memory_delete',
  'observations_read', 'observations_list', 'observations_write', 'share_page', 'a2a_send',
])

export const OPENAI_CAPABILITIES: ProviderCapabilities = {
  // We own the loop, so per-tool gating IS realisable.
  perToolCallback: true,
  // No SDK/OS sandbox in v1 — the tier gate is the only barrier.
  sandboxLevels: new Set(),
  supportsDelegation: true,
  supportsResume: false,
  defaultPeer: 'claude',
  authFailHint: 'openai: set WECHAT_OPENAI_API_KEY (and check base_url/model in agent config).',
}

export function mapDeltaToEvent(d: TurnDelta): AgentEvent {
  if (d.kind === 'text') return { kind: 'text', text: d.text }
  return {
    kind: 'tool_call',
    tool: d.name,
    ...(WECHAT_TOOL_NAMES.has(d.name) ? { server: 'wechat' } : {}),
  }
}
