/**
 * 三只伙伴同进程对跑:me ─ A ─ B。A 同时开着两条信道(去 me 的、去 B 的);
 * sendEnvelope 按信道 id 找到对端,直接塞进对端的 onInbound(先 wish 再 intro)。
 *
 * `withC: true` 再往 A 身上挂一只 C(me ─ A ─ B/C):一条心愿转给**两个**朋友,
 * 两张答卷都从同一条(me ← A)信道回来。「帮着问了 N 个朋友」的 N ≥ 2 才是常态,
 * 而 hop 2 的幂等键分不分得开这两张,只有这个拓扑测得出来。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Envelope } from '../../core/envelope'
import { makeWish, type WishDeps, type WishService } from './wire-wish'
import { makeIntro, type IntroService } from './wire-intro'

export interface Peer {
  name: string; stateDir: string; owner: string[]; logs: string[]; journal: Array<{ text: string; peerLabel: string }>
  letters: Array<{ dir: 'in' | 'out'; channel: string; kind: string; payload: unknown }>
  /** 每次 holdBusy(label) 记一行,release 了就翻成 released:true(照 wire-wish.test.ts)。 */
  busy: Array<{ label: string; released: boolean }>
  /** adopt 的假注册表:self_id → 记录。介绍成了才会有人进来。 */
  registry: Map<string, { id: string; name: string; mailbox_addr: string }>
  /** adopt 开出来的信道行(和 wish 用的 `mine` 分开 —— 那是配对时就有的老信道)。 */
  channels: Array<{ id: string; peerAgentId: string | null; status: string }>
  /** 翻成 false = adopt 写得进注册表但开信道那三步炸了(真货里是 sqlite 抛错)。 */
  adoptOpensChannel: boolean
  wish: WishService
  intro?: IntroService
  judgeSays: { match: 'yes' | 'no'; blurb?: string } | Error
  clock: { ms: number }
}
/** 信道拓扑:channelId → [持有方, 对端, 对端看这条信道的 id]。 */
export interface Link { id: string; owner: string; peer: string; peerSideId: string }

export interface TrioOpts { budgetOk?: (sender: string) => boolean; withC?: boolean }

export function makeTrio(opts: TrioOpts = {}): { me: Peer; A: Peer; B: Peer; C?: Peer; deliver: (from: Peer, channel: string, env: Envelope) => boolean } {
  const links: Link[] = [
    { id: 'me>A', owner: 'me', peer: 'A', peerSideId: 'A>me' }, { id: 'A>me', owner: 'A', peer: 'me', peerSideId: 'me>A' },
    { id: 'A>B', owner: 'A', peer: 'B', peerSideId: 'B>A' }, { id: 'B>A', owner: 'B', peer: 'A', peerSideId: 'A>B' },
    ...(opts.withC ? [{ id: 'A>C', owner: 'A', peer: 'C', peerSideId: 'C>A' }, { id: 'C>A', owner: 'C', peer: 'A', peerSideId: 'A>C' }] : []),
  ]
  const peers = new Map<string, Peer>()
  const clock = { ms: Date.parse('2026-09-04T10:00:00.000Z') }
  const names: Record<string, Record<string, string>> = { me: { 'me>A': '阿A' }, A: { 'A>me': '小我', 'A>B': '阿B', 'A>C': '阿C' }, B: { 'B>A': '阿A' }, C: { 'C>A': '阿A' } }
  const deliver = (from: Peer, channel: string, env: Envelope): boolean => {
    const link = links.find(l => l.id === channel && l.owner === from.name)
    if (!link) return false
    const to = peers.get(link.peer)!
    from.letters.push({ dir: 'out', channel, kind: env.kind, payload: env.payload })
    to.letters.push({ dir: 'in', channel: link.peerSideId, kind: env.kind, payload: env.payload })
    const letterId = `${to.name}-in-${to.letters.length}`
    if (to.wish.onInbound(link.peerSideId, env, letterId)) return true
    if (to.intro?.onInbound(link.peerSideId, env, letterId)) return true
    to.owner.push(`📬 ${env.kind}`)
    return true
  }
  const mk = (name: string): Peer => {
    const p: Peer = { name, stateDir: mkdtempSync(join(tmpdir(), `trio-${name}-`)), owner: [], logs: [], journal: [], letters: [], busy: [], registry: new Map(), channels: [], adoptOpensChannel: true, wish: null as never, judgeSays: { match: 'no' }, clock }
    const mine = links.filter(l => l.owner === name).map(l => ({ id: l.id, status: 'open', degree: 1, peer_agent_id: `cc-${l.peer.toLowerCase()}00000001`, created_at: '2026-09-01T00:00:00.000Z' }))
    const deps: WishDeps = {
      stateDir: p.stateDir,
      channelStore: { get: (id: string) => mine.find(c => c.id === id) ?? null, list: () => mine } as never,
      sendEnvelope: async (c, env) => (deliver(p, c, env) ? { ok: true } : { ok: false, error: 'no_such_channel' }),
      gate: async (t) => ({ ok: true, redacted: t, violations: [] }),
      judge: async () => { if (p.judgeSays instanceof Error) throw p.judgeSays; return p.judgeSays },
      recordPostcard: (a) => { p.journal.push(a); return `row-${p.journal.length}` },
      notifyOwner: (t) => p.owner.push(t),
      peerLabel: (c) => names[name]?.[c] ?? '某人',
      forwardBudget: { withinBudget: (s) => opts.budgetOk?.(s) ?? true },
      holdBusy: (label) => { const e = { label, released: false }; p.busy.push(e); return () => { e.released = true } },
      now: () => (clock.ms += 1),
      newId: (() => { let n = 0; return () => `${name}${String(++n).padStart(6, '0')}`.toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 8) })(),
      newReplyId: (() => { let n = 0; return () => `r${name}${String(++n).padStart(6, '0')}`.toLowerCase().slice(0, 8) })(),
      log: (tag, line) => p.logs.push(`${tag} ${line}`),
    }
    p.wish = makeWish(deps)
    p.intro = makeIntro({
      stateDir: p.stateDir,
      channelStore: deps.channelStore,
      sendEnvelope: deps.sendEnvelope,
      buildCard: (role, nonce, bearer, chan) => ({
        v: 2, role, nonce, self_id: `cc-${name.toLowerCase()}00000001`, name,
        mailbox_addr: `M${name}`, mailbox_enc_pub: `E${name}`, relays: ['https://r/mailbox'],
        bearer, channel_id: chan.channelId, channel_pub: chan.pubkey,
      }),
      // 真货是 core/pairing.ts 的 adoptPeerCard:同 self_id 不同信箱 = 撞在别人身上,拒写。
      adopt: (card, _mine, _myKey, nonce) => {
        if ([...p.registry.values()].some(r => r.id === card.self_id && r.mailbox_addr !== card.mailbox_addr)) return { ok: false, reason: 'id_conflict' }
        p.registry.set(card.self_id, { id: card.self_id, name: card.name, mailbox_addr: card.mailbox_addr })
        if (!p.adoptOpensChannel) return { ok: true, channelOpened: false }
        p.channels.push({ id: `intro:${nonce}`, peerAgentId: card.self_id, status: 'open' })
        return { ok: true, channelOpened: true }
      },
      mintKey: () => 'k'.repeat(16),
      genChannel: () => ({ channelId: `${name}-c`, pubkey: `${name}-P`, privkey: `${name}-K` }),
      notifyOwner: deps.notifyOwner,
      peerLabel: deps.peerLabel,
      holdBusy: deps.holdBusy,
      now: deps.now,
      log: deps.log,
    })
    peers.set(name, p)
    return p
  }
  const me = mk('me'), A = mk('A'), B = mk('B')
  const C = opts.withC ? mk('C') : undefined
  return { me, A, B, ...(C ? { C } : {}), deliver }
}
export const flush = (): Promise<void> => new Promise(r => setTimeout(r, 30))
