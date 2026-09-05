/**
 * 三只伙伴同进程对跑:me ─ A ─ B。A 同时开着两条信道(去 me 的、去 B 的);
 * sendEnvelope 按信道 id 找到对端,直接塞进对端的 onInbound(先 wish 再 intro)。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Envelope } from '../../core/envelope'
import { makeWish, type WishDeps, type WishService } from './wire-wish'

export interface Peer {
  name: string; stateDir: string; owner: string[]; logs: string[]; journal: Array<{ text: string; peerLabel: string }>
  letters: Array<{ dir: 'in' | 'out'; channel: string; kind: string; payload: unknown }>
  wish: WishService
  /** Task 6 挂上去;这里先留空位。 */
  intro?: { onInbound(channelRowId: string, env: Envelope, letterId: string): boolean }
  judgeSays: { match: 'yes' | 'no'; blurb?: string } | Error
  clock: { ms: number }
}
/** 信道拓扑:channelId → [持有方, 对端, 对端看这条信道的 id]。 */
export interface Link { id: string; owner: string; peer: string; peerSideId: string }

export interface TrioOpts { budgetOk?: (sender: string) => boolean }

export function makeTrio(opts: TrioOpts = {}): { me: Peer; A: Peer; B: Peer; deliver: (from: Peer, channel: string, env: Envelope) => boolean } {
  const links: Link[] = [
    { id: 'me>A', owner: 'me', peer: 'A', peerSideId: 'A>me' }, { id: 'A>me', owner: 'A', peer: 'me', peerSideId: 'me>A' },
    { id: 'A>B', owner: 'A', peer: 'B', peerSideId: 'B>A' }, { id: 'B>A', owner: 'B', peer: 'A', peerSideId: 'A>B' },
  ]
  const peers = new Map<string, Peer>()
  const clock = { ms: Date.parse('2026-09-04T10:00:00.000Z') }
  const names: Record<string, Record<string, string>> = { me: { 'me>A': '阿A' }, A: { 'A>me': '小我', 'A>B': '阿B' }, B: { 'B>A': '阿A' } }
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
    const p: Peer = { name, stateDir: mkdtempSync(join(tmpdir(), `trio-${name}-`)), owner: [], logs: [], journal: [], letters: [], wish: null as never, judgeSays: { match: 'no' }, clock }
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
      now: () => (clock.ms += 1),
      newId: (() => { let n = 0; return () => `${name}${String(++n).padStart(6, '0')}`.toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 8) })(),
      newReplyId: (() => { let n = 0; return () => `r${name}${String(++n).padStart(6, '0')}`.toLowerCase().slice(0, 8) })(),
      log: (tag, line) => p.logs.push(`${tag} ${line}`),
    }
    p.wish = makeWish(deps)
    peers.set(name, p)
    return p
  }
  const me = mk('me'), A = mk('A'), B = mk('B')
  return { me, A, B, deliver }
}
export const flush = (): Promise<void> => new Promise(r => setTimeout(r, 30))
