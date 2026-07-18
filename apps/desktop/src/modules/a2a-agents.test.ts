import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api.js', () => ({ invokeApi: vi.fn() }))

beforeEach(() => {
  // @ts-expect-error minimal getElementById stub before import
  globalThis.document = { getElementById: () => null }
  class NodeStub { static TEXT_NODE = 3 }
  // @ts-expect-error stub Node
  globalThis.Node = NodeStub
})

const { renderForageDesk } = await import('./a2a-agents.js')
const { invokeApi } = await import('../api.js')

function fakeEl() {
  return {
    textContent: '', innerHTML: '', hidden: false, disabled: false, title: '',
    dataset: {} as Record<string, string>, childNodes: [] as any[],
    classList: {
      values: new Set<string>(),
      add(c: string) { this.values.add(c) },
      remove(c: string) { this.values.delete(c) },
      toggle(c: string, f?: boolean) { f ? this.values.add(c) : this.values.delete(c) },
      contains(c: string) { return this.values.has(c) },
    },
    setAttribute(k: string, v: string) { (this as any)[k] = v },
    appendChild(n: any) { this.childNodes.push(n); return n },
    querySelector() { return null },
    addEventListener: vi.fn(),
    closest: () => null,
  }
}

function installDom(extra: Record<string, any> = {}) {
  const ids = ['fd-hero-status','fd-wishes','fd-postcards','fd-wishes-count',
    'fd-postcards-count','fd-peers','fd-peers-count','fd-inbound-toggle',
    'fd-inbound-note','fd-social-note','fd-sow','fd-sow-hint',
    'a2a-agents-list','a2a-server-banner']
  const byId: Record<string, any> = {}
  for (const id of ids) byId[id] = fakeEl()
  Object.assign(byId, extra)
  globalThis.document = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: () => fakeEl(),
  } as unknown as typeof document
  return byId
}

const foragingSeek = { id: 's1', kind: 'seek', topic: '找个会修老相机的师傅', status: 'foraging', hop: 1, peers_asked: 5, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
const echoedSeek   = { id: 's2', kind: 'seek', topic: '转让布偶猫', status: 'echoed', hop: 1, peers_asked: 4, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
const pendingEcho  = { id: 's2:peerX', seek_id: 's2', peer_masked: '三度外的某人', degree: 3, content: '我家布偶刚生了一窝', status: 'pending', created_at: new Date().toISOString() }

describe('renderForageDesk — wishes', () => {
  it('foraging seek renders 觅食中 + pulse + degree bar + peers-asked', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [foragingSeek], echoes: [], inbound: { enabled: false } })
    const html = el['fd-wishes'].innerHTML
    expect(html).toContain('觅食中')
    expect(html).toContain('fd-pulse')
    expect(html).toContain('fd-deg')
    expect(html).toContain('第 1 度')
    expect(html).toContain('问了 5 个')
    expect(html).toContain('求物求人')     // kind:'seek'
  })

  it('echoed seek renders the 有回音 badge (not the forage ribbon)', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [echoedSeek], echoes: [], inbound: { enabled: false } })
    const html = el['fd-wishes'].innerHTML
    expect(html).toContain('fd-echo-badge')
    expect(html).toContain('有回音')
    expect(html).not.toContain('fd-pulse')
  })

  it('fun kind renders 朋友间小乐趣 chip', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [{ ...foragingSeek, kind: 'fun' }], echoes: [], inbound: null })
    expect(el['fd-wishes'].innerHTML).toContain('朋友间小乐趣')
  })

  it('empty seeks → warm empty state', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null })
    expect(el['fd-wishes'].innerHTML).toContain('fd-empty')
  })
})

describe('renderForageDesk — postcards', () => {
  it('pending echo renders 揭晓牵线 + masked identity + degree stamp', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [echoedSeek], echoes: [pendingEcho], inbound: null })
    const html = el['fd-postcards'].innerHTML
    expect(html).toContain('揭晓牵线')
    expect(html).toContain('三度外的某人')
    expect(html).toContain('从第 3 度')        // stamp
    expect(html).toContain('data-action="reveal"')
    expect(html).toContain('data-id="s2:peerX"')
    expect(html).toContain('转让布偶猫')        // joined seek topic
  })

  it('revealed echo renders connected treatment (peer_masked now real name)', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [echoedSeek], echoes: [{ ...pendingEcho, status: 'revealed', peer_masked: '老张' }], inbound: null })
    const html = el['fd-postcards'].innerHTML
    expect(html).toContain('老张')
    expect(html).toContain('已牵线')
    expect(html).not.toContain('揭晓牵线')
  })

  it('privacy: render never reads/emits peer_agent_id', () => {
    const el = installDom()
    const dirty = { ...pendingEcho, peer_agent_id: 'SECRET-agent-42' }
    renderForageDesk({ agents: [], seeks: [echoedSeek], echoes: [dirty], inbound: null })
    expect(el['fd-postcards'].innerHTML).not.toContain('SECRET-agent-42')
  })

  it('empty echoes → warm empty state', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null })
    expect(el['fd-postcards'].innerHTML).toContain('fd-empty')
  })
})

describe('renderForageDesk — hero + net', () => {
  it('hero status shows agent count, summed peers-asked, echo count', () => {
    const el = installDom()
    renderForageDesk({
      agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      seeks: [foragingSeek, echoedSeek], echoes: [pendingEcho], inbound: { enabled: true },
    })
    const html = el['fd-hero-status'].innerHTML
    expect(html).toContain('2 位')          // agents.length
    expect(html).toContain('9')             // 5 + 4 peers_asked
    expect(html).toContain('1')             // echoes.length
  })

  it('inbound toggle reflects enabled state', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: { enabled: true } })
    expect(el['fd-inbound-toggle'].classList.contains('fd-on')).toBe(true)
    expect(el['fd-inbound-toggle']['aria-checked']).toBe('true')
  })

  it('inbound off → toggle not lit', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: { enabled: false } })
    expect(el['fd-inbound-toggle'].classList.contains('fd-on')).toBe(false)
  })

  it('peers summary derives avatars from agent names', () => {
    const el = installDom()
    renderForageDesk({ agents: [{ id: 'a', name: '老王' }, { id: 'b', name: '小李' }], seeks: [], echoes: [], inbound: null })
    expect(el['fd-peers'].innerHTML).toContain('王')
    expect(el['fd-peers-count'].textContent).toContain('连着 2 位')
  })

  it('social routes unwired (null) → 未启用 note, agent count still shows', () => {
    const el = installDom()
    renderForageDesk({ agents: [{ id: 'a', name: 'A' }], seeks: null, echoes: null, inbound: null })
    expect(el['fd-social-note'].hidden).toBe(false)
    expect(el['fd-social-note'].textContent).toContain('未启用')
    expect(el['fd-hero-status'].innerHTML).toContain('1 位')
  })
})
