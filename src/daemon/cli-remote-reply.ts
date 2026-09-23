/**
 * cli-remote-reply.ts — 脑侧:主人在微信里「看 / 说」的那条会话在某只手上,把请求转给
 * 那只手的 /a2a/cli/reply(spec 2026-09-09-cli-hook-push §6.5)。钥匙就是派活用的那把
 * (brain → hand 的 outbound_api_key),手那边验的也是同一道 may_exec 门。
 */
import type { A2AAgentRecord } from '../lib/agent-config'
import type { CliSessionInfo } from '../core/cli-events'

export interface RemoteReplyDeps {
  registry: { get(id: string): A2AAgentRecord | null }
  client: { send(req: { url: string; bearer: string; body: unknown }): Promise<{ ok: boolean; response?: unknown; error?: string; http_status?: number }> }
  selfId: string
}

function baseOf(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/a2a$/, '')
}

export function makeRemoteReply(deps: RemoteReplyDeps) {
  type CallResult = { ok: true; resp: Record<string, unknown> } | { ok: false; error: string }
  async function call(s: CliSessionInfo, body: Record<string, unknown>): Promise<CallResult> {
    if (!s.origin_agent) return { ok: false, error: 'not_remote' }
    const hand = deps.registry.get(s.origin_agent)
    if (!hand || !hand.url) return { ok: false, error: `hand_unknown:${s.origin_agent}` }
    if (hand.paused) return { ok: false, error: 'hand_paused' }
    const r = await deps.client.send({ url: `${baseOf(hand.url)}/a2a/cli/reply`, bearer: hand.outbound_api_key, body: { ...body, agent_id: deps.selfId, session_id: s.session_id } })
    if (!r.ok) return { ok: false, error: r.error ?? `http_${r.http_status ?? '?'}` }
    const resp = (r.response && typeof r.response === 'object') ? r.response as Record<string, unknown> : {}
    if (resp['ok'] !== true) return { ok: false, error: typeof resp['error'] === 'string' ? resp['error'] : 'hand_refused' }
    return { ok: true, resp }
  }
  return {
    async view(s: CliSessionInfo): Promise<{ ok: true; markdown: string } | { ok: false; error: string }> {
      const r = await call(s, { kind: 'view' })
      if (!r.ok) return r
      const md = r.resp['markdown']
      return typeof md === 'string' ? { ok: true, markdown: md } : { ok: false, error: 'no_markdown' }
    },
    async say(s: CliSessionInfo, text: string): Promise<{ ok: boolean; error?: string }> {
      const r = await call(s, { kind: 'say', text })
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
  }
}
