import { describe, it, expect, vi } from 'vitest'
import { makeBrainForwarder } from './cli-brain-forward'
import type { A2AAgentRecord } from '../lib/agent-config'
import { PRESENT_IDLE_S } from '../core/cli-events'

const rec = (over: Partial<A2AAgentRecord> = {}): A2AAgentRecord => ({
  id: 'brain', name: 'brain', url: 'http://10.0.0.2:8717/a2a', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'k'.repeat(16),
  capabilities: [], paused: false, transport: 'push', may_exec: true, ...over,
} as A2AAgentRecord)

function harness(records: A2AAgentRecord[], responses: Record<string, unknown> = {}) {
  const calls: { url: string; bearer: string; body: unknown }[] = []
  const desktop: string[] = []
  const fwd = makeBrainForwarder({
    registry: { list: () => records },
    client: { send: async (req) => { calls.push(req); const r = responses[req.url.replace(/^.*\/a2a/, '/a2a')]; return r === 'fail' ? { ok: false, error: 'ECONNREFUSED' } : { ok: true, response: r ?? {} } } },
    selfId: 'win-test',
    notifyDesktop: async (t) => { desktop.push(t); return true },
    projectName: (c) => c,
    log: () => {},
  })
  return { fwd, calls, desktop }
}

const ev = { source: 'claude' as const, kind: 'stop' as const, session_id: 'abc123', cwd: '/w', text: 'done', idle_s: 900, machine: 'win-test' }

describe('brain forwarder(手侧)', () => {
  it('没有能叫回去的脑(占位 url / unused key / 没 may_exec / paused)→ brain() null,event noop', async () => {
    expect(harness([rec({ url: 'http://brain.local/a2a' })]).fwd.brain()).toBeNull()
    expect(harness([rec({ outbound_api_key: 'unused' })]).fwd.brain()).toBeNull()
    expect(harness([rec({ may_exec: false })]).fwd.brain()).toBeNull()
    expect(harness([rec({ paused: true })]).fwd.brain()).toBeNull()
    expect(await harness([]).fwd.event(ev)).toBe('noop')
  })

  it('有脑:事件 POST 到 <脑>/a2a/cli/event,带 agent_id 与 Bearer,回 action', async () => {
    const h = harness([rec()], { '/a2a/cli/event': { ok: true, action: 'scheduled' } })
    expect(h.fwd.brain()).toEqual({ id: 'brain', url: 'http://10.0.0.2:8717', key: 'k'.repeat(16) })
    expect(await h.fwd.event(ev)).toBe('scheduled')
    expect(h.calls[0]!.url).toBe('http://10.0.0.2:8717/a2a/cli/event')
    expect(h.calls[0]!.bearer).toBe('k'.repeat(16))
    expect(h.calls[0]!.body).toMatchObject({ agent_id: 'win-test', session_id: 'abc123', kind: 'stop' })
  })

  it('人就在这只手前(idle_s 小)→ 本机桌面通知,不转;权限也直接 owner_present', async () => {
    const h = harness([rec()])
    expect(await h.fwd.event({ ...ev, idle_s: PRESENT_IDLE_S - 1 })).toBe('noop')
    expect(h.calls).toEqual([])
    expect(h.desktop[0]).toContain('claude 完成了')
    expect(await h.fwd.permissionOpen({ source: 'claude', session_id: 'abc123', cwd: '/w', tool_name: 'Bash', idle_s: 3 })).toEqual({ status: 'owner_present' })
  })

  it('权限:登记 → 记住 hash;轮询 → 同路径带 hash;脑不通 → null / unknown', async () => {
    const h = harness([rec()], { '/a2a/cli/permission': { status: 'pending', hash: 'k3x9z' } })
    expect(await h.fwd.permissionOpen({ source: 'codex', session_id: 's', cwd: '/w', tool_name: 'Bash', idle_s: 900 })).toEqual({ status: 'pending', hash: 'k3x9z' })
    expect(h.fwd.ownsHash('k3x9z')).toBe(true)
    expect(h.fwd.ownsHash('zzzzz')).toBe(false)
    const w = harness([rec()], { '/a2a/cli/permission': { hash: 'k3x9z', status: 'allow' } })
    expect(await w.fwd.permissionWait('k3x9z', 5000)).toBe('allow')
    expect(w.calls[0]!.body).toMatchObject({ hash: 'k3x9z', wait_ms: 5000, agent_id: 'win-test' })
    const down = harness([rec()], { '/a2a/cli/permission': 'fail', '/a2a/cli/event': 'fail' })
    expect(await down.fwd.permissionOpen({ source: 'codex', session_id: 's', cwd: '/w', tool_name: 'Bash' })).toBeNull()
    expect(await down.fwd.permissionWait('k3x9z', 10)).toBe('unknown')
    expect(await down.fwd.event(ev)).toBe('noop')
  })
})
