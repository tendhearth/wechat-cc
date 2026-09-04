import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWish, type WishDeps } from './wire-wish'
import { readWishes } from '../companion/wish-memory'
import type { Envelope } from '../../core/envelope'

/**
 * 两个 daemon 在同一个进程里对着派心愿。信道 store 用内存假货,sendEnvelope
 * 直接把信封塞进对端的 onInbound —— 这里测的是:谁判、谁被打扰、什么进日志。
 */
type Row = { id: string; direction: 'in' | 'out'; kind: string; payload: string | null }
interface Side {
  name: string; stateDir: string; letters: Row[]; owner: string[]; logs: string[]; journal: Array<{ text: string; peerLabel: string }>
  wish: ReturnType<typeof makeWish>; setPeer(p: Side): void; judgeSays: { match: 'yes' | 'no'; blurb?: string } | Error
}
const NOW = { ms: Date.parse('2026-09-04T10:00:00.000Z') }

const ONE_CHANNEL = [{ id: 'ch', status: 'open', degree: 1 }]
function side(name: string, judgeSays: Side['judgeSays'] = { match: 'no' }, gateOk = true, channels: Array<{ id: string; status: string; degree: number }> = ONE_CHANNEL): Side {
  const letters: Row[] = [], owner: string[] = [], logs: string[] = [], journal: Side['journal'] = []
  let peer: Side | null = null
  const self: Side = { name, stateDir: mkdtempSync(join(tmpdir(), 'wish-')), letters, owner, logs, journal, wish: null as never, setPeer: p => { peer = p }, judgeSays }
  // 时钟每次读走 1ms:两条先后派的心愿得有先后,list() 才有「新的在前」可言。
  let clock = NOW.ms
  const deps: WishDeps = {
    stateDir: self.stateDir,
    channelStore: { get: (id: string) => channels.find(c => c.id === id) ?? null, list: () => channels } as never,
    sendEnvelope: async (_c, env) => {
      letters.push({ id: `${name}-out-${letters.length}`, direction: 'out', kind: env.kind, payload: JSON.stringify(env.payload) })
      const inId = `${peer!.name}-in-${peer!.letters.length}`
      peer!.letters.push({ id: inId, direction: 'in', kind: env.kind, payload: JSON.stringify(env.payload) })
      if (!peer!.wish.onInbound('ch', env, inId)) peer!.owner.push(`📬 ${env.kind}`)
      return { ok: true }
    },
    gate: async (t) => (gateOk ? { ok: true, redacted: t.replace('我住XX路', ''), violations: [] } : { ok: false, redacted: '', violations: ['住址'] }),
    judge: async () => { if (self.judgeSays instanceof Error) throw self.judgeSays; return self.judgeSays },
    recordPostcard: (a) => { journal.push(a); return `row-${journal.length}` },
    notifyOwner: (t) => owner.push(t),
    peerLabel: () => (name === 'A' ? '阿二' : '阿一'),
    now: () => (clock += 1),
    newId: (() => { let n = 0; return () => `${name.toLowerCase()}${String(++n).padStart(7, '0')}` })(),
    log: (tag, line) => logs.push(`${tag} ${line}`),
  }
  self.wish = makeWish(deps)
  return self
}
const flush = () => new Promise(r => setTimeout(r, 20))

describe('心愿:两只伙伴对着问', () => {
  it('A 派 → B 判「能」→ 明信片回 A:A 日志一条、A 主人一句、B 主人一句、replies=1', async () => {
    const A = side('A'), B = side('B', { match: 'yes', blurb: '我朋友周末常去,我住XX路' })
    A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('找周末爬山搭子')
    expect(p.ok).toBe(true); if (!p.ok) return
    const s = await A.wish.send(p.id)
    expect(s).toEqual({ ok: true, sentTo: 1 })
    await flush()
    expect(B.owner).toEqual(['🙋 阿一 的伙伴来打听「找周末爬山搭子」,我回了:我朋友周末常去,'])
    expect(A.journal).toEqual([{ text: '我朋友周末常去,', peerLabel: '阿二' }])
    expect(A.owner).toEqual(['📮 阿二 回了你的心愿「找周末爬山搭子」:我朋友周末常去,'])
    expect(readWishes(A.stateDir)[0]).toMatchObject({ status: 'open', sentTo: 1, replies: 1 })
    expect(A.letters.filter(l => l.direction === 'in').map(l => l.kind)).toEqual(['postcard'])
  })
  it('B 判「不能」→ 静默不回,B 主人仍被告知;A 无变化', async () => {
    const A = side('A'), B = side('B', { match: 'no' }); A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    await A.wish.send(p.id); await flush()
    expect(B.owner).toEqual(['🙋 阿一 的伙伴来打听「x」,我说不知道'])
    expect(A.journal).toEqual([]); expect(A.owner).toEqual([])
  })
  it('B 的判官抛错 → 只记日志,不打扰任何人', async () => {
    const A = side('A'), B = side('B', new Error('provider down')); A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    await A.wish.send(p.id); await flush()
    expect(B.owner).toEqual([]); expect(B.logs.some(l => l.includes('provider down'))).toBe(true)
  })
  it('同一条心愿重投 → B 只判一次', async () => {
    const A = side('A'), B = side('B', { match: 'no' }); A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    await A.wish.send(p.id); await flush()
    const env: Envelope = { kind: 'wish', payload: JSON.parse(A.letters[0]!.payload!) }
    expect(B.wish.onInbound('ch', env, 'dup')).toBe(true); await flush()
    expect(B.owner).toHaveLength(1)
  })
  it('过期的心愿被 B 丢;A 收到不认识 / 过期 wishId 的明信片丢', async () => {
    const A = side('A'), B = side('B', { match: 'yes', blurb: 'ok' }); A.setPeer(B); B.setPeer(A)
    expect(B.wish.onInbound('ch', { kind: 'wish', payload: { id: 'dead0000', text: 'x', expiresAt: '2020-01-01T00:00:00.000Z' } }, 'l1')).toBe(true)
    await flush(); expect(B.owner).toEqual([])
    expect(A.wish.onInbound('ch', { kind: 'postcard', payload: { wishId: 'nope0000', text: 'hi' } }, 'l2')).toBe(true)
    expect(A.journal).toEqual([])
  })
  it('propose:披露门不过 → gate_failed 带 violations,不存草稿;门抛错 → checker_unavailable', async () => {
    const A = side('A', { match: 'no' }, false)
    expect(await A.wish.propose('我住XX路')).toMatchObject({ ok: false, error: 'gate_failed', violations: ['住址'] })
    expect(readWishes(A.stateDir)).toEqual([])
  })
  it('send:没有开着的信道 → no_channels,草稿保留', async () => {
    const A = side('A', { match: 'no' }, true, [])          // 第 4 个参数:没有任何信道
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    expect(await A.wish.send(p.id)).toEqual({ ok: false, reason: 'no_channels' })
    expect(readWishes(A.stateDir)[0]!.status).toBe('draft')
  })
  it('send:已有 3 条 open → 第 4 条 too_many_open', async () => {
    const A = side('A'), B = side('B'); A.setPeer(B); B.setPeer(A)
    for (let i = 0; i < 3; i++) { const p = await A.wish.propose(`w${i}`); if (!p.ok) throw new Error(); expect((await A.wish.send(p.id)).ok).toBe(true) }
    const p4 = await A.wish.propose('w4'); if (!p4.ok) throw new Error()
    expect(await A.wish.send(p4.id)).toEqual({ ok: false, reason: 'too_many_open' })
  })
  it('cancel:draft → cancelled,open → closed;list 带 effective', async () => {
    const A = side('A'); A.setPeer(side('B'))
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    expect(A.wish.cancel(p.id)).toEqual({ ok: true, status: 'cancelled' })
    const q = await A.wish.propose('y'); if (!q.ok) throw new Error()
    await A.wish.send(q.id)
    expect(A.wish.cancel(q.id)).toEqual({ ok: true, status: 'closed' })
    expect(A.wish.list().map(w => w.effective)).toEqual(['closed', 'cancelled'])
  })
  it('不是 wish / postcard 的信封 → false', () => {
    expect(side('A').wish.onInbound('ch', { kind: 'letter', payload: {} }, 'x')).toBe(false)
  })
})
