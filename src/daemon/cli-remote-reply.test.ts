import { describe, it, expect, vi } from 'vitest'
import { makeRemoteReply } from './cli-remote-reply'
import type { A2AAgentRecord } from '../lib/agent-config'

const hand: A2AAgentRecord = { id: 'win-test', name: 'win', url: 'http://10.0.0.5:8717/a2a', inbound_api_key: 'i'.repeat(16), outbound_api_key: 'exec-key-000000000', capabilities: ['exec'], paused: false, transport: 'push', may_exec: false } as A2AAgentRecord
const s = { session_id: 'sid-full', source: 'codex' as const, cwd: '/w', origin_agent: 'win-test', lastSeenAt: 1 }

describe('remote reply(脑侧转给手)', () => {
  it('view → POST <手>/a2a/cli/reply,派活钥匙做 Bearer,拿 markdown;say → ok', async () => {
    const send = vi.fn(async (req: { url: string; body: unknown }) => ({ ok: true, response: (req.body as { kind: string }).kind === 'view' ? { ok: true, markdown: '# md' } : { ok: true } }))
    const rr = makeRemoteReply({ registry: { get: (id) => id === 'win-test' ? hand : null }, client: { send }, selfId: 'brain' })
    expect(await rr.view(s)).toEqual({ ok: true, markdown: '# md' })
    expect(send.mock.calls[0]![0]).toMatchObject({ url: 'http://10.0.0.5:8717/a2a/cli/reply', bearer: 'exec-key-000000000', body: { agent_id: 'brain', kind: 'view', session_id: 'sid-full' } })
    expect(await rr.say(s, '继续')).toEqual({ ok: true })
    expect((send.mock.calls[1]![0] as { body: { text: string } }).body.text).toBe('继续')
  })
  it('不是远端 / 手不认识 / 手拒绝 / 网络失败 → 各自的 error', async () => {
    const rr = makeRemoteReply({ registry: { get: () => null }, client: { send: async () => ({ ok: false, error: 'ECONNREFUSED' }) }, selfId: 'brain' })
    expect(await rr.view({ ...s, origin_agent: undefined })).toEqual({ ok: false, error: 'not_remote' })
    expect(await rr.view(s)).toEqual({ ok: false, error: 'hand_unknown:win-test' })
    const refused = makeRemoteReply({ registry: { get: () => hand }, client: { send: async () => ({ ok: true, response: { ok: false, error: 'session_unknown' } }) }, selfId: 'brain' })
    expect(await refused.say(s, 'x')).toEqual({ ok: false, error: 'session_unknown' })
    const down = makeRemoteReply({ registry: { get: () => hand }, client: { send: async () => ({ ok: false, error: 'ECONNREFUSED' }) }, selfId: 'brain' })
    expect(await down.view(s)).toEqual({ ok: false, error: 'ECONNREFUSED' })
  })
})
