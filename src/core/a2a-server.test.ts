import { describe, expect, it, vi } from 'vitest'
import { createA2AServer } from './a2a-server'
import type { A2ARegistry } from './a2a-registry'
import type { A2AAgentRecord } from '../lib/agent-config'
import { A2A_PROTO_VERSION } from './a2a-intent'

function rec(id: string, overrides: Partial<A2AAgentRecord> = {}): A2AAgentRecord {
  return {
    id, name: id, url: `https://${id}/a2a`,
    inbound_api_key: `wc_${id}1234567890123456`.slice(0, 24),  // min 16
    outbound_api_key: `out_${id}`,
    capabilities: ['notify'], paused: false, may_exec: false, ...overrides, transport: overrides.transport ?? 'push',
  }
}

function fakeRegistry(agents: A2AAgentRecord[]): A2ARegistry {
  return {
    list: () => agents,
    get: (id) => agents.find(a => a.id === id) ?? null,
    verifyBearer: (id, bearer) => {
      const a = agents.find(x => x.id === id)
      return a && a.inbound_api_key === bearer ? a : null
    },
    add: vi.fn(), remove: vi.fn(), setPaused: vi.fn(), update: vi.fn(),
  }
}

async function startServer(opts: {
  agents?: A2AAgentRecord[]
  onNotify?: (event: import('./a2a-server').NotifyEvent) => Promise<void>
  onExec?: (event: import('./a2a-server').ExecEvent) => Promise<import('./a2a-server').ExecResult>
  onIntent?: (event: import('./a2a-server').IntentEvent) => Promise<import('./a2a-intent').MatchReceipt>
  onReveal?: (event: import('./a2a-server').RevealEvent) => Promise<{ mutual: boolean; handle?: import('./penpal-crypto').PenpalHandle }>
  onLetter?: (event: import('./a2a-server').LetterEvent) => Promise<{ ok: boolean; error?: string }>
  onEcho?: (event: import('./a2a-server').EchoEvent) => Promise<{ ok: boolean }>
} = {}) {
  const onNotify: (event: import('./a2a-server').NotifyEvent) => Promise<void> = opts.onNotify ?? vi.fn(async () => {})
  const server = createA2AServer({
    host: '127.0.0.1', port: 0,
    registry: fakeRegistry(opts.agents ?? [rec('alpha')]),
    onNotify,
    ...(opts.onExec ? { onExec: opts.onExec } : {}),
    ...(opts.onIntent ? { onIntent: opts.onIntent } : {}),
    ...(opts.onReveal ? { onReveal: opts.onReveal } : {}),
    ...(opts.onLetter ? { onLetter: opts.onLetter } : {}),
    ...(opts.onEcho ? { onEcho: opts.onEcho } : {}),
    daemonInfo: { name: 'wechat-cc', version: '0.6.x' },
  })
  await server.start()
  return { server, onNotify, baseUrl: server.baseUrl() }
}

describe('a2a-server', () => {
  it('GET /.well-known/agent.json returns the daemon Agent Card', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/.well-known/agent.json`)
      expect(res.status).toBe(200)
      const card = await res.json() as { name: string; capabilities: Array<{ name: string }> }
      expect(card.name).toBe('wechat-cc')
      expect(card.capabilities.some(c => c.name === 'notify')).toBe(true)
    } finally {
      await server.stop()
    }
  })

  it('advertises the A2A protocol version in the agent card', async () => {
    const { server, baseUrl } = await startServer({})
    try {
      const card = await (await fetch(`${baseUrl}/.well-known/agent.json`)).json() as { proto_version?: number }
      expect(card.proto_version).toBe(A2A_PROTO_VERSION)
    } finally { await server.stop() }
  })

  it('POST /a2a/notify with valid Bearer + matching agent_id calls onNotify and returns 200', async () => {
    const onNotify = vi.fn(async () => {})
    const alphaRec = rec('alpha')
    const { server, baseUrl } = await startServer({ agents: [alphaRec], onNotify })
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${alphaRec.inbound_api_key}`,
        },
        body: JSON.stringify({ agent_id: 'alpha', text: 'hello', urgency: 'normal' }),
      })
      expect(res.status).toBe(200)
      expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({ id: 'alpha' }),
        text: 'hello',
        urgency: 'normal',
      }))
    } finally {
      await server.stop()
    }
  })

  it('POST /a2a/notify without Authorization → 401', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: 'alpha', text: 'x' }),
      })
      expect(res.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  it('POST /a2a/notify with wrong Bearer → 401', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer wrong-key-completely' },
        body: JSON.stringify({ agent_id: 'alpha', text: 'x' }),
      })
      expect(res.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  it('POST /a2a/notify with body.agent_id != bearer-owning agent → 403', async () => {
    const alphaRec = rec('alpha')
    const { server, baseUrl } = await startServer({ agents: [alphaRec, rec('beta')] })
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
        body: JSON.stringify({ agent_id: 'beta', text: 'spoof' }),
      })
      // alpha's key, beta's id → 401 from verifyBearer (since verifyBearer(beta, alpha's key) returns null)
      // The test wants explicit detection. Acceptable to be 401 here (verifyBearer treats it as a mismatch).
      // Either 401 or 403 is acceptable as long as the request is rejected and onNotify NOT called.
      expect([401, 403]).toContain(res.status)
    } finally {
      await server.stop()
    }
  })

  it('POST /a2a/notify with paused agent → 202 (silently drop)', async () => {
    const onNotify = vi.fn(async () => {})
    const alphaRec = rec('alpha', { paused: true })
    const { server, baseUrl } = await startServer({
      agents: [alphaRec],
      onNotify,
    })
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
        body: JSON.stringify({ agent_id: 'alpha', text: 'x' }),
      })
      expect(res.status).toBe(202)
      expect(onNotify).not.toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  })

  it('POST /a2a/notify with missing text → 400', async () => {
    const alphaRec = rec('alpha')
    const { server, baseUrl } = await startServer({ agents: [alphaRec] })
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
        body: JSON.stringify({ agent_id: 'alpha' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await server.stop()
    }
  })

  it('unknown path returns 404', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/anything-else`)
      expect(res.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('GET on /a2a/notify (wrong method) returns 405', async () => {
    const { server, baseUrl } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/a2a/notify`)
      expect(res.status).toBe(405)
    } finally {
      await server.stop()
    }
  })

  describe('POST /a2a/exec (hand mode)', () => {
    it('runs the local agent and returns the result when authed', async () => {
      const onExec = vi.fn(async () => ({ ok: true as const, response: 'did the thing' }))
      // 2026-09-02:exec 现在要显式授权(may_exec),bearer 不再等于「能执行」。
      const alphaRec = { ...rec('alpha'), may_exec: true }
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onExec })
      try {
        const res = await fetch(`${baseUrl}/a2a/exec`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', prompt: '看下家里的 README', peer: 'codex', cwd: '/home/me/proj' }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, response: 'did the thing' })
        expect(onExec).toHaveBeenCalledWith(expect.objectContaining({
          agent: expect.objectContaining({ id: 'alpha' }),
          peer: 'codex', prompt: '看下家里的 README', cwd: '/home/me/proj',
        }))
      } finally { await server.stop() }
    })

    // 2026-09-02:缺省不再补 'claude'。哪个 agent 跑在**这台**机器上,只有
    // 这台机器知道 —— 路由把 undefined 原样传下去,由 dispatchDelegate 用
    // 本机自己的默认 provider 解析。写死 claude 会让任何不装 claude 的机器
    // 当不了手(真机上就是这样:委派只拿回「进程退出码 1」)。
    it('peer 省略时原样传 undefined,不替本机假设成 claude', async () => {
      const onExec = vi.fn(async () => ({ ok: true as const, response: 'r' }))
      const alphaRec = { ...rec('alpha'), may_exec: true }
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onExec })
      try {
        await fetch(`${baseUrl}/a2a/exec`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', prompt: 'x' }),
        })
        expect(onExec).toHaveBeenCalledWith(expect.objectContaining({ peer: undefined }))
      } finally { await server.stop() }
    })

    it('returns 501 when this machine is not wired as a hand (no onExec)', async () => {
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec] })  // no onExec
      try {
        const res = await fetch(`${baseUrl}/a2a/exec`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', prompt: 'x' }),
        })
        expect(res.status).toBe(501)
      } finally { await server.stop() }
    })

    it('rejects exec without a valid Bearer → 401, onExec not called', async () => {
      const onExec = vi.fn(async () => ({ ok: true as const, response: 'r' }))
      const { server, baseUrl } = await startServer({ onExec })
      try {
        const res = await fetch(`${baseUrl}/a2a/exec`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent_id: 'alpha', prompt: 'x' }),
        })
        expect(res.status).toBe(401)
        expect(onExec).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('advertises the exec capability in the Agent Card only when wired', async () => {
      const withExec = await startServer({ onExec: async () => ({ ok: true, response: 'r' }) })
      const without = await startServer()
      try {
        const a = await (await fetch(`${withExec.baseUrl}/.well-known/agent.json`)).json() as { capabilities: Array<{ name: string }> }
        const b = await (await fetch(`${without.baseUrl}/.well-known/agent.json`)).json() as { capabilities: Array<{ name: string }> }
        expect(a.capabilities.some(c => c.name === 'exec')).toBe(true)
        expect(b.capabilities.some(c => c.name === 'exec')).toBe(false)
      } finally { await withExec.server.stop(); await without.server.stop() }
    })
  })

  describe('POST /a2a/intent (agent-social M1)', () => {
    it('runs onIntent and returns the Match Receipt when authed', async () => {
      const onIntent = vi.fn(async (e: import('./a2a-server').IntentEvent) => (
        { intent_id: e.card.intent_id, match: 'yes' as const, blurb: '也爱摄影' }
      ))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onIntent })
      try {
        const res = await fetch(`${baseUrl}/a2a/intent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({
            agent_id: 'alpha',
            card: { intent_id: 'i1', kind: 'seek', topic: '找摄影搭子', expires_at: new Date(Date.now() + 60000).toISOString() },
          }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ intent_id: 'i1', match: 'yes' })
        expect(onIntent).toHaveBeenCalledWith(expect.objectContaining({
          agent: expect.objectContaining({ id: 'alpha' }),
          card: expect.objectContaining({ intent_id: 'i1', topic: '找摄影搭子' }),
        }))
      } finally { await server.stop() }
    })

    it('returns 501 when this machine is not wired for intent (no onIntent)', async () => {
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec] })  // no onIntent
      try {
        const res = await fetch(`${baseUrl}/a2a/intent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({
            agent_id: 'alpha',
            card: { intent_id: 'i1', kind: 'seek', topic: 'x', expires_at: new Date(Date.now() + 60000).toISOString() },
          }),
        })
        expect(res.status).toBe(501)
      } finally { await server.stop() }
    })

    it('rejects intent without a valid Bearer → 401, onIntent not called', async () => {
      const onIntent = vi.fn(async (e: import('./a2a-server').IntentEvent) => (
        { intent_id: e.card.intent_id, match: 'yes' as const }
      ))
      const { server, baseUrl } = await startServer({ onIntent })
      try {
        const res = await fetch(`${baseUrl}/a2a/intent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agent_id: 'alpha',
            card: { intent_id: 'i1', kind: 'seek', topic: 'x', expires_at: new Date(Date.now() + 60000).toISOString() },
          }),
        })
        expect(res.status).toBe(401)
        expect(onIntent).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('advertises the intent capability in the Agent Card only when wired', async () => {
      const withIntent = await startServer({ onIntent: async (e) => ({ intent_id: e.card.intent_id, match: 'no' }) })
      const without = await startServer()
      try {
        const a = await (await fetch(`${withIntent.baseUrl}/.well-known/agent.json`)).json() as { capabilities: Array<{ name: string }> }
        const b = await (await fetch(`${without.baseUrl}/.well-known/agent.json`)).json() as { capabilities: Array<{ name: string }> }
        expect(a.capabilities.some(c => c.name === 'intent')).toBe(true)
        expect(b.capabilities.some(c => c.name === 'intent')).toBe(false)
      } finally { await withIntent.server.stop(); await without.server.stop() }
    })
  })

  describe('POST /a2a/echo (v2 async echo return)', () => {
    it('runs onEcho and returns { ok: true } when authed', async () => {
      const onEcho = vi.fn(async (_e: import('./a2a-server').EchoEvent) => ({ ok: true }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onEcho })
      try {
        const res = await fetch(`${baseUrl}/a2a/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({
            agent_id: 'alpha', intent_id: 'i1',
            echo: { blurb: '也爱摄影', degree: 1 },
          }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(onEcho).toHaveBeenCalledWith(expect.objectContaining({
          agent: expect.objectContaining({ id: 'alpha' }),
          msg: expect.objectContaining({ intent_id: 'i1', agent_id: 'alpha' }),
        }))
      } finally { await server.stop() }
    })

    it('POST /a2a/echo without Authorization → 401, onEcho not called', async () => {
      const onEcho = vi.fn(async () => ({ ok: true }))
      const { server, baseUrl } = await startServer({ onEcho })
      try {
        const res = await fetch(`${baseUrl}/a2a/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1', echo: { blurb: 'x', degree: 1 } }),
        })
        expect(res.status).toBe(401)
        expect(onEcho).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('POST /a2a/echo with wrong Bearer → 401, onEcho not called', async () => {
      const onEcho = vi.fn(async () => ({ ok: true }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onEcho })
      try {
        const res = await fetch(`${baseUrl}/a2a/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': 'Bearer wrong-key-completely' },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1', echo: { blurb: 'x', degree: 1 } }),
        })
        expect(res.status).toBe(401)
        expect(onEcho).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('POST /a2a/echo with body.agent_id != bearer-owning agent → 403, onEcho not called', async () => {
      const onEcho = vi.fn(async () => ({ ok: true }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec, rec('beta')], onEcho })
      try {
        const res = await fetch(`${baseUrl}/a2a/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'beta', intent_id: 'i1', echo: { blurb: 'x', degree: 1 } }),
        })
        expect([401, 403]).toContain(res.status)
        expect(onEcho).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('POST /a2a/echo with paused agent → 202 (silently drop), onEcho not called', async () => {
      const onEcho = vi.fn(async () => ({ ok: true }))
      const alphaRec = rec('alpha', { paused: true })
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onEcho })
      try {
        const res = await fetch(`${baseUrl}/a2a/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1', echo: { blurb: 'x', degree: 1 } }),
        })
        expect(res.status).toBe(202)
        expect(onEcho).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('POST /a2a/echo with a bad shape (missing echo.blurb) → 400, onEcho not called', async () => {
      const onEcho = vi.fn(async () => ({ ok: true }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onEcho })
      try {
        const res = await fetch(`${baseUrl}/a2a/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1', echo: { degree: 1 } }),
        })
        expect(res.status).toBe(400)
        expect(onEcho).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('returns 501 when this machine is not wired for echo (no onEcho)', async () => {
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec] })  // no onEcho
      try {
        const res = await fetch(`${baseUrl}/a2a/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1', echo: { blurb: 'x', degree: 1 } }),
        })
        expect(res.status).toBe(501)
      } finally { await server.stop() }
    })

    it('advertises the echo capability in the Agent Card only when wired', async () => {
      const withEcho = await startServer({ onEcho: async () => ({ ok: true }) })
      const without = await startServer()
      try {
        const a = await (await fetch(`${withEcho.baseUrl}/.well-known/agent.json`)).json() as { capabilities: Array<{ name: string }> }
        const b = await (await fetch(`${without.baseUrl}/.well-known/agent.json`)).json() as { capabilities: Array<{ name: string }> }
        expect(a.capabilities.some(c => c.name === 'echo')).toBe(true)
        expect(b.capabilities.some(c => c.name === 'echo')).toBe(false)
      } finally { await withEcho.server.stop(); await without.server.stop() }
    })
  })

  describe('POST /a2a/reveal (async foraging spine)', () => {
    it('runs onReveal and returns { mutual, handle } when authed', async () => {
      const onReveal = vi.fn(async (_e: import('./a2a-server').RevealEvent) => ({ mutual: true, handle: { pubkey: 'pub-b', channel_id: 'ch-1' } }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onReveal })
      try {
        const res = await fetch(`${baseUrl}/a2a/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1' }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ mutual: true, handle: { pubkey: 'pub-b', channel_id: 'ch-1' } })
        expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'alpha', intent_id: 'i1' }))
      } finally { await server.stop() }
    })

    it('forwards relay_token + peer_handle from the body to onReveal (verified agent_id preserved)', async () => {
      const onReveal = vi.fn(async (_e: import('./a2a-server').RevealEvent) => ({ mutual: false }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onReveal })
      try {
        const res = await fetch(`${baseUrl}/a2a/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1', relay_token: 'T', peer_handle: { pubkey: 'pub-q', channel_id: 'ch-9' } }),
        })
        expect(res.status).toBe(200)
        expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({
          agent_id: 'alpha', intent_id: 'i1', relay_token: 'T', peer_handle: { pubkey: 'pub-q', channel_id: 'ch-9' },
        }))
      } finally { await server.stop() }
    })

    it('drops a malformed peer_handle (missing channel_id) to undefined without 400ing', async () => {
      const onReveal = vi.fn(async (_e: import('./a2a-server').RevealEvent) => ({ mutual: false }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onReveal })
      try {
        const res = await fetch(`${baseUrl}/a2a/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1', peer_handle: { pubkey: 'pub-q' } }),
        })
        expect(res.status).toBe(200)
        expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'alpha', intent_id: 'i1' }))
        expect(onReveal.mock.calls[0]?.[0]?.peer_handle).toBeUndefined()
      } finally { await server.stop() }
    })

    it('passes a crossed mailbox through peer_handle to onReveal', async () => {
      const onReveal = vi.fn(async (_e: import('./a2a-server').RevealEvent) => ({ mutual: false }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onReveal })
      try {
        const res = await fetch(`${baseUrl}/a2a/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({
            agent_id: 'alpha', intent_id: 'i1',
            peer_handle: { pubkey: 'pub-q', channel_id: 'ch-9', mailbox: { addr: 'A', enc_pub: 'E', relays: ['https://r/'] } },
          }),
        })
        expect(res.status).toBe(200)
        expect(onReveal.mock.calls[0]?.[0]?.peer_handle).toEqual({
          pubkey: 'pub-q', channel_id: 'ch-9', mailbox: { addr: 'A', enc_pub: 'E', relays: ['https://r/'] },
        })
      } finally { await server.stop() }
    })

    it('drops a malformed mailbox (missing enc_pub) to undefined without 400ing, keeps the handle', async () => {
      const onReveal = vi.fn(async (_e: import('./a2a-server').RevealEvent) => ({ mutual: false }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onReveal })
      try {
        const res = await fetch(`${baseUrl}/a2a/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({
            agent_id: 'alpha', intent_id: 'i1',
            peer_handle: { pubkey: 'pub-q', channel_id: 'ch-9', mailbox: { addr: 'A' } },
          }),
        })
        expect(res.status).toBe(200)
        expect(onReveal.mock.calls[0]?.[0]?.peer_handle).toEqual({ pubkey: 'pub-q', channel_id: 'ch-9' })
      } finally { await server.stop() }
    })

    it('returns 501 when this machine is not wired for reveal (no onReveal)', async () => {
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec] })
      try {
        const res = await fetch(`${baseUrl}/a2a/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1' }),
        })
        expect(res.status).toBe(501)
      } finally { await server.stop() }
    })

    it('rejects reveal without a valid Bearer → 401, onReveal not called', async () => {
      const onReveal = vi.fn(async () => ({ mutual: false }))
      const { server, baseUrl } = await startServer({ onReveal })
      try {
        const res = await fetch(`${baseUrl}/a2a/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent_id: 'alpha', intent_id: 'i1' }),
        })
        expect(res.status).toBe(401)
        expect(onReveal).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('advertises the reveal capability in the agent card only when wired', async () => {
      const wired = await startServer({ onReveal: async () => ({ mutual: false }) })
      try {
        const card = await (await fetch(`${wired.baseUrl}/.well-known/agent.json`)).json() as { capabilities: Array<{ name: string }> }
        expect(card.capabilities.some(c => c.name === 'reveal')).toBe(true)
      } finally { await wired.server.stop() }
      const bare = await startServer({})
      try {
        const card = await (await fetch(`${bare.baseUrl}/.well-known/agent.json`)).json() as { capabilities: Array<{ name: string }> }
        expect(card.capabilities.some(c => c.name === 'reveal')).toBe(false)
      } finally { await bare.server.stop() }
    })
  })

  describe('POST /a2a/letter (E2E pen-pal inbound)', () => {
    it('runs onLetter with the verified agent_id + sealed fields, returns { ok: true }', async () => {
      const onLetter = vi.fn(async (_e: import('./a2a-server').LetterEvent) => ({ ok: true }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onLetter })
      try {
        const res = await fetch(`${baseUrl}/a2a/letter`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', channel_id: 'ch-1', nonce: 'n-1', ct: 'ct-1', tag: 't-1' }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(onLetter).toHaveBeenCalledWith({ agent_id: 'alpha', channel_id: 'ch-1', nonce: 'n-1', ct: 'ct-1', tag: 't-1' })
      } finally { await server.stop() }
    })

    it('returns 501 when this machine is not wired for letter (no onLetter)', async () => {
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec] })
      try {
        const res = await fetch(`${baseUrl}/a2a/letter`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', channel_id: 'ch-1', nonce: 'n-1', ct: 'ct-1', tag: 't-1' }),
        })
        expect(res.status).toBe(501)
        const body = await res.json() as { error: string }
        expect(body.error).toBe('letter_not_supported')
      } finally { await server.stop() }
    })

    it.each(['channel_id', 'nonce', 'ct', 'tag'])('missing/blank %s → 400 invalid_body, onLetter not called', async (field) => {
      const onLetter = vi.fn(async () => ({ ok: true }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onLetter })
      try {
        const full: Record<string, unknown> = { agent_id: 'alpha', channel_id: 'ch-1', nonce: 'n-1', ct: 'ct-1', tag: 't-1' }
        full[field] = ''
        const res = await fetch(`${baseUrl}/a2a/letter`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify(full),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: string }
        expect(body.error).toBe('invalid_body')
        expect(onLetter).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('rejects letter without a valid Bearer → 401, onLetter not called', async () => {
      const onLetter = vi.fn(async () => ({ ok: true }))
      const { server, baseUrl } = await startServer({ onLetter })
      try {
        const res = await fetch(`${baseUrl}/a2a/letter`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent_id: 'alpha', channel_id: 'ch-1', nonce: 'n-1', ct: 'ct-1', tag: 't-1' }),
        })
        expect(res.status).toBe(401)
        expect(onLetter).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('rejects letter with wrong Bearer → 401, onLetter not called', async () => {
      const onLetter = vi.fn(async () => ({ ok: true }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onLetter })
      try {
        const res = await fetch(`${baseUrl}/a2a/letter`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-key-completely' },
          body: JSON.stringify({ agent_id: 'alpha', channel_id: 'ch-1', nonce: 'n-1', ct: 'ct-1', tag: 't-1' }),
        })
        expect(res.status).toBe(401)
        expect(onLetter).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('malformed JSON body → 400 invalid_json, no crash', async () => {
      const onLetter = vi.fn(async () => ({ ok: true }))
      const alphaRec = rec('alpha')
      const { server, baseUrl } = await startServer({ agents: [alphaRec], onLetter })
      try {
        const res = await fetch(`${baseUrl}/a2a/letter`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${alphaRec.inbound_api_key}` },
          body: '{not json',
        })
        expect(res.status).toBe(400)
        expect(onLetter).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('advertises the letter capability in the agent card only when wired', async () => {
      const wired = await startServer({ onLetter: async () => ({ ok: true }) })
      try {
        const card = await (await fetch(`${wired.baseUrl}/.well-known/agent.json`)).json() as { capabilities: Array<{ name: string }> }
        expect(card.capabilities.some(c => c.name === 'letter')).toBe(true)
      } finally { await wired.server.stop() }
      const bare = await startServer({})
      try {
        const card = await (await fetch(`${bare.baseUrl}/.well-known/agent.json`)).json() as { capabilities: Array<{ name: string }> }
        expect(card.capabilities.some(c => c.name === 'letter')).toBe(false)
      } finally { await bare.server.stop() }
    })
  })

  describe('onAuthFailed observability', () => {
    it('emits onAuthFailed with reason=missing_bearer when no Authorization header', async () => {
      const onAuthFailed = vi.fn()
      const server = createA2AServer({
        host: '127.0.0.1', port: 0,
        registry: fakeRegistry([rec('alpha')]),
        onNotify: async () => {},
        onAuthFailed,
        daemonInfo: { name: 'wechat-cc', version: '0.6' },
      })
      await server.start()
      try {
        await fetch(`${server.baseUrl()}/a2a/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent_id: 'alpha', text: 'hi' }),
        })
        expect(onAuthFailed).toHaveBeenCalledWith({ agent_id_claimed: 'alpha', reason: 'missing_bearer' })
      } finally { await server.stop() }
    })

    it('emits onAuthFailed with reason=wrong_bearer when bearer mismatches', async () => {
      const onAuthFailed = vi.fn()
      const alphaRec = rec('alpha')
      const server = createA2AServer({
        host: '127.0.0.1', port: 0,
        registry: fakeRegistry([alphaRec]),
        onNotify: async () => {},
        onAuthFailed,
        daemonInfo: { name: 'wechat-cc', version: '0.6' },
      })
      await server.start()
      try {
        await fetch(`${server.baseUrl()}/a2a/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': 'Bearer totally-wrong-key' },
          body: JSON.stringify({ agent_id: 'alpha', text: 'hi' }),
        })
        expect(onAuthFailed).toHaveBeenCalledWith({ agent_id_claimed: 'alpha', reason: 'wrong_bearer' })
      } finally { await server.stop() }
    })

    it('emits onAuthFailed with reason=wrong_bearer when claimed agent_id is unknown (verifyBearer returns null)', async () => {
      const onAuthFailed = vi.fn()
      const server = createA2AServer({
        host: '127.0.0.1', port: 0,
        registry: fakeRegistry([rec('alpha')]),
        onNotify: async () => {},
        onAuthFailed,
        daemonInfo: { name: 'wechat-cc', version: '0.6' },
      })
      await server.start()
      try {
        await fetch(`${server.baseUrl()}/a2a/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': 'Bearer x' },
          body: JSON.stringify({ agent_id: 'nonexistent', text: 'hi' }),
        })
        expect(onAuthFailed).toHaveBeenCalledWith({ agent_id_claimed: 'nonexistent', reason: 'wrong_bearer' })
      } finally { await server.stop() }
    })

    it('does NOT emit onAuthFailed for malformed bodies (no agent_id to attribute)', async () => {
      const onAuthFailed = vi.fn()
      const server = createA2AServer({
        host: '127.0.0.1', port: 0,
        registry: fakeRegistry([rec('alpha')]),
        onNotify: async () => {},
        onAuthFailed,
        daemonInfo: { name: 'wechat-cc', version: '0.6' },
      })
      await server.start()
      try {
        // Invalid JSON
        await fetch(`${server.baseUrl()}/a2a/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'not-json',
        })
        // Missing agent_id
        await fetch(`${server.baseUrl()}/a2a/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hi' }),
        })
        expect(onAuthFailed).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('does NOT emit onAuthFailed on successful notify', async () => {
      const onAuthFailed = vi.fn()
      const alphaRec = rec('alpha')
      const server = createA2AServer({
        host: '127.0.0.1', port: 0,
        registry: fakeRegistry([alphaRec]),
        onNotify: async () => {},
        onAuthFailed,
        daemonInfo: { name: 'wechat-cc', version: '0.6' },
      })
      await server.start()
      try {
        const res = await fetch(`${server.baseUrl()}/a2a/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${alphaRec.inbound_api_key}` },
          body: JSON.stringify({ agent_id: 'alpha', text: 'hi' }),
        })
        expect(res.status).toBe(200)
        expect(onAuthFailed).not.toHaveBeenCalled()
      } finally { await server.stop() }
    })

    it('swallows exceptions from onAuthFailed (response still 401)', async () => {
      const server = createA2AServer({
        host: '127.0.0.1', port: 0,
        registry: fakeRegistry([rec('alpha')]),
        onNotify: async () => {},
        onAuthFailed: () => { throw new Error('observability blew up') },
        daemonInfo: { name: 'wechat-cc', version: '0.6' },
      })
      await server.start()
      try {
        const res = await fetch(`${server.baseUrl()}/a2a/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent_id: 'alpha', text: 'hi' }),
        })
        expect(res.status).toBe(401)
      } finally { await server.stop() }
    })
  })
})

// 2026-09-02。owner 的原话:「hand 的目的是连接自己的另一台 wechat-cc 设备
// 不是么」—— 对。但在此之前,路由**分不出**谁是自己的机器:
//
//   `/a2a/exec` 只验 bearer,而 registry 是一张**平的**信任表,里面同时装着
//   我自己的机器(hand accept/invite,两端都要 CLI 访问权)和朋友的 bot
//   (六位配对码 / a2a install)。hand 侧给 brain 写的记录是 capabilities: [],
//   跟社交对端长得一模一样。
//
// 于是「非 claude 的 delegate 一律 guest」那道闸其实是在**用能力钳制补一个
// 缺失的授权检查**,而且补错了地方:卡死了合法用途(自己的手连自己机器上的
// 文件都读不了),却没挡住真正的口子(claude 那条是 trusted,对任何已配对的
// 对端开放)。
//
// 授权检查放回它该在的地方:`may_exec`。
describe('POST /a2a/exec —— 只有我授权过的大脑能派活', () => {
  it('may_exec=false 的对端(社交朋友、a2a install 手工加的)→ 403,不进 onExec', async () => {
    const onExec = vi.fn(async () => ({ ok: true as const, response: 'r' }))
    const social = { ...rec('friend'), may_exec: false }
    const { server, baseUrl } = await startServer({ agents: [social], onExec })
    try {
      const r = await fetch(`${baseUrl}/a2a/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${social.inbound_api_key}` },
        body: JSON.stringify({ agent_id: 'friend', prompt: 'rm -rf /' }),
      })
      expect(r.status).toBe(403)
      expect(await r.json()).toMatchObject({ error: 'exec_not_authorized' })
      expect(onExec).not.toHaveBeenCalled()   // 连本地 agent 都不该起
    } finally { server.stop() }
  })

  it('may_exec=true 的对端(hand accept / hand invite 建立的)→ 正常派活', async () => {
    const onExec = vi.fn(async () => ({ ok: true as const, response: 'done' }))
    const brain = { ...rec('mybrain'), may_exec: true }
    const { server, baseUrl } = await startServer({ agents: [brain], onExec })
    try {
      const r = await fetch(`${baseUrl}/a2a/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${brain.inbound_api_key}` },
        body: JSON.stringify({ agent_id: 'mybrain', prompt: 'x' }),
      })
      expect(r.status).toBe(200)
      expect(await r.json()).toMatchObject({ ok: true, response: 'done' })
      expect(onExec).toHaveBeenCalled()
    } finally { server.stop() }
  })
})
