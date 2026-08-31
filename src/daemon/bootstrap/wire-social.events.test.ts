/**
 * 社交往来落 a2a_events —— 亲密度排序(rankPeersByCloseness)按 a2a_events 的
 * recency/volume/reciprocity 给 peer 排序,而 wireSocial 从建成起【只读不写】
 * 这张表:intent/echo/reveal 一律不记账。真机上 a2a_events 恒为 0 行,排序
 * 实际退化成 id 字典序。这里钉住"社交出入站要留痕",同时钉住"留痕不得携带
 * 内容"(事件 text 会渲染进桌面「看往来」)。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wireSocial } from './wire-social'
import { openTestDb } from '../../lib/db'
import { makeA2AEventsStore } from '../../core/a2a-events-store'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { A2AClient } from '../../core/a2a-client'
import type { ProviderRegistry } from '../../core/provider-registry'
import type { AgentConfig } from '../../lib/agent-config'

const PEER = {
  id: 'cc-peer', name: 'Peer', url: 'http://peer.local', inbound_api_key: 'in-key-0123456789',
  outbound_api_key: 'out-key', capabilities: [], paused: false, transport: 'push' as const,
}

function harness(stateDir: string) {
  const eventsStore = makeA2AEventsStore(openTestDb())
  const configuredAgent: AgentConfig = {
    provider: 'claude', dangerouslySkipPermissions: false, autoStart: false, closeStopsDaemon: false,
    social_enabled: true, social_disclosure_policy: '兴趣可说；住址不可',
  }
  const a2aRegistry: A2ARegistry = {
    list: () => [PEER], get: (id: string) => (id === PEER.id ? PEER : null),
    verifyBearer: () => null, add: () => {}, remove: () => {}, setPaused: () => {},
    update: () => { throw new Error('unused') },
  } as unknown as A2ARegistry
  const a2aClient: A2AClient = {
    fetchAgentCard: async () => { throw new Error('unused') },
    send: async () => ({ ok: true }),
  }
  const registry = { getCheapEval: () => async () => JSON.stringify({ violation: false }) } as unknown as ProviderRegistry
  return { eventsStore, configuredAgent, a2aRegistry, a2aClient, registry, stateDir }
}

describe('wireSocial — 社交往来落 a2a_events(亲密度排序的信号来源)', () => {
  it('派出心愿 → 给该 peer 记一条 out 事件,且事件正文不含心愿内容', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wire-social-events-'))
    try {
      const h = harness(stateDir)
      const wiring = await wireSocial({
        log: () => {}, stateDir, db: openTestDb(), configuredAgent: h.configuredAgent,
        selfId: 'test-self', registry: h.registry, defaultProviderId: 'claude', pluginMcp: {},
        currentClaudeModel: () => 'claude-opus-4-8', claudeBin: undefined,
        resolveOperatorChatId: () => null, sendAssistantText: undefined,
        a2aRegistry: h.a2aRegistry, a2aClient: h.a2aClient, eventsStore: h.eventsStore,
        getServerBaseUrl: () => null, holdBusy: () => () => {},
      })
      expect(wiring.social).toBeDefined()

      const TOPIC = '找摄影搭子拍胶片'
      const proposed = await wiring.social!.broker.propose(TOPIC)
      expect(proposed.ok).toBe(true)
      if (!proposed.ok) return
      wiring.social!.broker.confirmSeek(proposed.intent_id)

      await vi.waitFor(() => expect(h.eventsStore.counts(PEER.id).outbound).toBeGreaterThan(0))
      const rows = h.eventsStore.recentForAgent(PEER.id, 10)
      expect(rows.some(r => r.direction === 'out')).toBe(true)
      // 匿名层不变量:事件正文渲染进桌面活动流,绝不能带心愿正文
      for (const r of rows) expect(r.text).not.toContain('摄影')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

// v2(2026-07-22)退役了同步 MatchReceipt 回声:v1 对端收得到心愿,但
// 【回不来明信片】。a2a-intent.ts 自己写着 "fleet must upgrade",可代码里
// 从没有任何地方在发送前看一眼对端版本 —— 真出现老版本对端,两边都只会
// 觉得"怎么一直没人回",没有任何信号。
describe('wireSocial — 给 v1 对端发心愿时留下告警', () => {
  async function forageTo(peer: Record<string, unknown>, log: (t: string, l: string) => void) {
    const stateDir = mkdtempSync(join(tmpdir(), 'wire-social-proto-'))
    try {
      const h = harness(stateDir)
      const reg: A2ARegistry = {
        list: () => [peer], get: (id: string) => (id === peer.id ? peer : null),
        verifyBearer: () => null, add: () => {}, remove: () => {}, setPaused: () => {},
        update: () => { throw new Error('unused') },
      } as unknown as A2ARegistry
      const wiring = await wireSocial({
        log, stateDir, db: openTestDb(), configuredAgent: h.configuredAgent,
        selfId: 'test-self', registry: h.registry, defaultProviderId: 'claude', pluginMcp: {},
        currentClaudeModel: () => 'claude-opus-4-8', claudeBin: undefined,
        resolveOperatorChatId: () => null, sendAssistantText: undefined,
        a2aRegistry: reg, a2aClient: h.a2aClient, eventsStore: h.eventsStore,
        getServerBaseUrl: () => null, holdBusy: () => () => {},
      })
      const proposed = await wiring.social!.broker.propose('找摄影搭子')
      if (!proposed.ok) throw new Error('propose failed')
      wiring.social!.broker.confirmSeek(proposed.intent_id)
      await vi.waitFor(() => expect(h.eventsStore.counts(String(peer.id)).outbound).toBeGreaterThan(0))
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  }

  it('对端记录着 proto_version=1 → 日志里点名它收不到明信片', async () => {
    const lines: string[] = []
    await forageTo({ ...PEER, proto_version: 1 }, (_t, l) => lines.push(l))
    expect(lines.some(l => l.includes(PEER.id) && l.includes('proto_version'))).toBe(true)
  })

  it('对端是 v2、或根本没记版本(配对码建的边从不写)→ 不告警,不制造噪音', async () => {
    const v2: string[] = []
    await forageTo({ ...PEER, proto_version: 2 }, (_t, l) => v2.push(l))
    expect(v2.some(l => l.includes('proto_version'))).toBe(false)
    const absent: string[] = []
    await forageTo({ ...PEER }, (_t, l) => absent.push(l))
    expect(absent.some(l => l.includes('proto_version'))).toBe(false)
  })
})

// 二跳转发此前是 push-only:forwardTargets 明确把 url-less 的信箱对端过滤掉
// (注释:"2-hop forward transport is STILL push-only"),而 forwardSend 又直接
// 用 a2aClient 打 intentUrl(hand.url)。结果是 NAT 后的朋友的朋友永远收不到
// 转发的心愿 —— 和刚修的「揭晓走信箱」同源:一度能走信箱,二度却走不了。
describe('wireSocial — 二跳转发要能落到 url-less 的信箱对端', () => {
  it('W 收到 hop=1 的心愿 → 转发时把只有信箱的 Q 也算作目标,并按信箱投递', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wire-social-fwd-'))
    try {
      const h = harness(stateDir)
      const SENDER = { ...PEER, id: 'cc-sender' }
      // Q:双 NAT 的朋友的朋友 —— 没有 url,只有完整的信箱坐标。
      // relays 指向一个必然拒连的本地端口:投递会失败(快),但"选中并按信箱
      // 投递"这个事实已经由出站事件记录下来了。
      const Q = {
        id: 'cc-q', name: 'Q', inbound_api_key: 'in-key-0123456789', outbound_api_key: 'out-key',
        capabilities: [], paused: false, transport: 'mailbox' as const,
        mailbox_addr: 'QADDR', mailbox_enc_pub: 'QENCPUB', relays: ['http://127.0.0.1:9'],
      }
      const reg: A2ARegistry = {
        list: () => [SENDER, Q],
        get: (id: string) => (id === Q.id ? Q : id === SENDER.id ? SENDER : null),
        verifyBearer: () => null, add: () => {}, remove: () => {}, setPaused: () => {},
        update: () => { throw new Error('unused') },
      } as unknown as A2ARegistry

      const wiring = await wireSocial({
        log: () => {}, stateDir, db: openTestDb(), configuredAgent: h.configuredAgent,
        selfId: 'test-self', registry: h.registry, defaultProviderId: 'claude', pluginMcp: {},
        currentClaudeModel: () => 'claude-opus-4-8', claudeBin: undefined,
        resolveOperatorChatId: () => null, sendAssistantText: undefined,
        a2aRegistry: reg, a2aClient: h.a2aClient, eventsStore: h.eventsStore,
        getServerBaseUrl: () => null, holdBusy: () => () => {},
      })
      expect(wiring.onIntent).toBeDefined()

      const receipt = await wiring.onIntent!({
        agent: SENDER as never,
        card: {
          intent_id: 'i-fwd-1', kind: 'seek', topic: '找会修胶片相机的师傅',
          hop: 1, expires_at: new Date(Date.now() + 3600_000).toISOString(),
        } as never,
      })
      expect(receipt.match).toBe('no')   // v2 快速 ack

      // 后台扇出:Q 必须被选中,且走的是 postToHand(信箱分支)
      await vi.waitFor(() => expect(h.eventsStore.counts(Q.id).outbound).toBeGreaterThan(0))
      const rows = h.eventsStore.recentForAgent(Q.id, 5)
      expect(rows.some(r => r.direction === 'out' && r.text.includes('心愿'))).toBe(true)
      // 不回头发给来源
      expect(h.eventsStore.counts(SENDER.id).outbound).toBe(0)
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })
})
