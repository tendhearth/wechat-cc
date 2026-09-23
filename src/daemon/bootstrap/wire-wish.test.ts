import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWish, type WishDeps } from './wire-wish'
import { readWishes } from '../companion/wish-memory'
import { readIntroIndex, writeIntroIndex } from '../companion/intro-memory'
import type { Envelope } from '../../core/envelope'
import { makeTrio, flush as flush3 } from './social-trio.fixture'

/**
 * 两个 daemon 在同一个进程里对着派心愿。信道 store 用内存假货,sendEnvelope
 * 直接把信封塞进对端的 onInbound —— 这里测的是:谁判、谁被打扰、什么进日志。
 */
type Row = { id: string; direction: 'in' | 'out'; kind: string; payload: string | null }
interface Side {
  name: string; stateDir: string; letters: Row[]; owner: string[]; logs: string[]; journal: Array<{ text: string; peerLabel: string }>
  /** 每次 holdBusy(label) 记一行,release 了就翻成 released:true。 */
  busy: Array<{ label: string; released: boolean }>
  wish: ReturnType<typeof makeWish>; setPeer(p: Side): void; judgeSays: { match: 'yes' | 'no'; blurb?: string } | Error
}
const NOW = { ms: Date.parse('2026-09-04T10:00:00.000Z') }

type Chan = { id: string; status: string; degree: number; peer_agent_id?: string | null; created_at?: string }
const ONE_CHANNEL: Chan[] = [{ id: 'ch', status: 'open', degree: 1 }]
/** 闸门:true = 放行,false = 真违规(住址),对象 = 原样返回(用来演闸门自己没跑成)。 */
type GateSays = boolean | { ok: boolean; redacted: string; violations: string[] }
interface SideOpts {
  /** 这个信封别投出去,直接返回失败(演信道断了 / 对面不收)。 */
  failSend?: (env: Envelope) => boolean
  /** 在投给对端**之前**同步回一手 —— 演「对面秒答,明信片在 send 还没返回时就到了」。 */
  inline?: (env: Envelope, self: Side) => void
}
function side(name: string, judgeSays: Side['judgeSays'] = { match: 'no' }, gateSays: GateSays = true, channels: Chan[] = ONE_CHANNEL, opts: SideOpts = {}): Side {
  const letters: Row[] = [], owner: string[] = [], logs: string[] = [], journal: Side['journal'] = [], busy: Side['busy'] = []
  let peer: Side | null = null
  const self: Side = { name, stateDir: mkdtempSync(join(tmpdir(), 'wish-')), letters, owner, logs, journal, busy, wish: null as never, setPeer: p => { peer = p }, judgeSays }
  // 时钟每次读走 1ms:两条先后派的心愿得有先后,list() 才有「新的在前」可言。
  let clock = NOW.ms
  const deps: WishDeps = {
    stateDir: self.stateDir,
    channelStore: { get: (id: string) => channels.find(c => c.id === id) ?? null, list: () => channels } as never,
    sendEnvelope: async (_c, env) => {
      letters.push({ id: `${name}-out-${letters.length}`, direction: 'out', kind: env.kind, payload: JSON.stringify(env.payload) })
      if (opts.failSend?.(env)) return { ok: false, error: 'channel_down' }
      opts.inline?.(env, self)
      const inId = `${peer!.name}-in-${peer!.letters.length}`
      peer!.letters.push({ id: inId, direction: 'in', kind: env.kind, payload: JSON.stringify(env.payload) })
      if (!peer!.wish.onInbound('ch', env, inId)) peer!.owner.push(`📬 ${env.kind}`)
      return { ok: true }
    },
    gate: async (t) => (typeof gateSays === 'object' ? gateSays
      : gateSays ? { ok: true, redacted: t.replace('我住XX路', ''), violations: [] }
        : { ok: false, redacted: '', violations: ['住址'] }),
    judge: async () => { if (self.judgeSays instanceof Error) throw self.judgeSays; return self.judgeSays },
    recordPostcard: (a) => { journal.push(a); return `row-${journal.length}` },
    notifyOwner: (t) => owner.push(t),
    holdBusy: (label) => { const e = { label, released: false }; busy.push(e); return () => { e.released = true } },
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
  it('答心愿的那一段持 busy token —— 空闲自动重启不能在判官/闸门跑到一半时掐掉它', async () => {
    const A = side('A'), B = side('B', { match: 'yes', blurb: '我知道一个地方' })
    A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('找周末爬山搭子'); if (!p.ok) throw new Error()
    await A.wish.send(p.id); await flush()
    // 判的那边(B)登记了一次,并且**回完就放开**(不放开 = 永远重启不了)。
    expect(B.busy).toEqual([{ label: 'wish-answer', released: true }])
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
  it('send:同一个对端有两条 open 信道(重新配对留下的)→ 只投最新那条,主人不被打扰两遍', async () => {
    const DUP: Chan[] = [
      { id: 'ch', status: 'open', degree: 1, peer_agent_id: 'cc-b', created_at: '2026-09-04T00:00:00Z' },
      { id: 'ch-old', status: 'open', degree: 1, peer_agent_id: 'cc-b', created_at: '2026-09-01T00:00:00Z' },
    ]
    const A = side('A', { match: 'no' }, true, DUP), B = side('B', { match: 'no' })
    A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    expect(await A.wish.send(p.id)).toEqual({ ok: true, sentTo: 1 })
    await flush()
    expect(B.owner).toHaveLength(1)
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
  it('propose:闸门自己没跑成(checker_timeout)→ checker_unavailable,不当成违规、不存草稿', async () => {
    // gateOutbound 从不抛:超时/provider 故障是以 violations 的形式回来的。
    // 只看 ok 的话主人会读到「这句里有不能说的:checker_timeout」。
    const A = side('A', { match: 'no' }, { ok: false, redacted: '', violations: ['checker_timeout'] })
    expect(await A.wish.propose('找周末爬山搭子')).toEqual({ ok: false, error: 'checker_unavailable' })
    expect(readWishes(A.stateDir)).toEqual([])
    expect(A.logs.some(l => l.includes('checker_timeout'))).toBe(true)
  })
  it('答的时候闸门没跑成 → 主人听到「想回但没寄出去(模型没响应)」,不是「我说不知道」', async () => {
    const A = side('A')
    const B = side('B', { match: 'yes', blurb: '我知道一个地方' }, { ok: false, redacted: '', violations: ['checker_error: boom'] })
    A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    await A.wish.send(p.id); await flush()
    expect(B.owner).toEqual(['🙋 阿一 的伙伴来打听「x」,我想回但没寄出去(模型没响应)'])
    expect(A.journal).toEqual([])
  })
  it('明信片寄不出去 → 答的那边的主人也要知道(不能只进日志)', async () => {
    const A = side('A')
    const B = side('B', { match: 'yes', blurb: '我知道一个地方' }, true, ONE_CHANNEL, { failSend: env => env.kind === 'postcard' })
    A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    await A.wish.send(p.id); await flush()
    expect(B.owner).toEqual(['🙋 阿一 的伙伴来打听「x」,我想回但没寄出去'])
    expect(A.journal).toEqual([])
  })
  it('对面秒答:明信片在 send 还没返回时就回来了 —— 照样收下(open 先落盘,再广播)', async () => {
    const TWO: Chan[] = [{ id: 'ch', status: 'open', degree: 1 }, { id: 'ch2', status: 'open', degree: 1 }]
    let replied = false
    const A = side('A', { match: 'no' }, true, TWO, {
      inline: (env, self) => {
        if (env.kind !== 'wish' || replied) return
        replied = true
        const p = env.payload as { id: string }
        self.wish.onInbound('ch', { kind: 'postcard', payload: { wishId: p.id, text: '我知道一个地方' } }, 'inline')
      },
    })
    const B = side('B', { match: 'no' }); A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('找周末爬山搭子'); if (!p.ok) throw new Error()
    expect(await A.wish.send(p.id)).toEqual({ ok: true, sentTo: 2 })
    await flush()
    // sentTo 是回读改的那一列,replies 是明信片写的那一列 —— 两次写不能互相抹掉。
    expect(readWishes(A.stateDir)[0]).toMatchObject({ status: 'open', sentTo: 2, replies: 1 })
    expect(A.journal).toHaveLength(1)
  })
  it('明信片打到还是草稿的心愿 → 这一次丢掉,但幂等键没被占:派出去之后重投照收', async () => {
    const A = side('A'), B = side('B'); A.setPeer(B); B.setPeer(A)
    const p = await A.wish.propose('x'); if (!p.ok) throw new Error()
    const pc: Envelope = { kind: 'postcard', payload: { wishId: p.id, text: '我知道一个地方' } }
    expect(A.wish.onInbound('ch', pc, 'l1')).toBe(true)
    expect(A.journal).toEqual([])
    await A.wish.send(p.id)
    expect(A.wish.onInbound('ch', pc, 'l2')).toBe(true)
    expect(A.journal).toHaveLength(1)
    expect(readWishes(A.stateDir)[0]!.replies).toBe(1)
  })
  it('对方给的有效期超过 7 天 → 按上限算并留痕(不能比 14 天幂等窗口活得还久)', async () => {
    const B = side('B', { match: 'no' }); B.setPeer(side('A'))
    expect(B.wish.onInbound('ch', { kind: 'wish', payload: { id: 'far00000', text: 'x', expiresAt: '3000-01-01T00:00:00.000Z' } }, 'l1')).toBe(true)
    await flush()
    expect(B.logs.some(l => l.includes('超过 7 天上限'))).toBe(true)
    expect(B.owner).toEqual(['🙋 阿一 的伙伴来打听「x」,我说不知道'])   // 夹了有效期,但心愿照常处理
  })
  it('不是 wish / postcard 的信封 → false', () => {
    expect(side('A').wish.onInbound('ch', { kind: 'letter', payload: {} }, 'x')).toBe(false)
  })
})

describe('介绍:转问与回声原路返回(spec 2026-09-04-introduction §1/§2)', () => {
  const send = async (me: ReturnType<typeof makeTrio>['me'], text = '找周末爬山搭子') => {
    const p = await me.wish.propose(text); if (!p.ok) throw new Error(p.error)
    const s = await me.wish.send(p.id); if (!s.ok) throw new Error(s.reason)
    return p.id
  }
  it('A 答不上 → 转给 B(hop 2)→ B 答 → A 原路转回(带 replyId,不入 A 日志)→ 我这边 label 是「阿A 的朋友」并记下引用', async () => {
    const { me, A, B } = makeTrio()
    B.judgeSays = { match: 'yes', blurb: '我朋友周末常去' }
    const id = await send(me)
    await flush3()
    expect(A.owner).toEqual([`🙋 小我 的伙伴来打听「找周末爬山搭子」,我答不上,帮着问了 1 个朋友`])
    expect(B.letters.filter(l => l.dir === 'in').map(l => (l.payload as { hop: number }).hop)).toEqual([2])
    expect(B.owner).toEqual([`🙋 阿A 的伙伴来打听「找周末爬山搭子」,我回了:我朋友周末常去`])
    expect(A.journal).toEqual([])
    expect(me.journal).toEqual([{ text: '我朋友周末常去', peerLabel: '阿A 的朋友' }])
    expect(me.owner[0]).toMatch(/^📮 阿A 的朋友 回了你的心愿「找周末爬山搭子」:我朋友周末常去\(想认识就回「认识 [0-9a-z]{6}」\)$/)
    const refs = me.wish.list().find(w => w.id === id)!.postcards!
    expect(refs).toHaveLength(1); expect(refs[0]).toMatchObject({ via: 'me>A', preview: '我朋友周末常去' })
  })
  it('A 帮着问了 2 个朋友 → 两张答卷都从同一条信道回来,一张都不能丢', async () => {
    const { me, A, B, C } = makeTrio({ withC: true })
    B.judgeSays = { match: 'yes', blurb: '阿B 知道一个' }
    C!.judgeSays = { match: 'yes', blurb: '阿C 也知道一个' }
    const id = await send(me)
    await flush3()
    expect(A.owner).toEqual([`🙋 小我 的伙伴来打听「找周末爬山搭子」,我答不上,帮着问了 2 个朋友`])
    // 两张 hop 2 都走 me>A 这一条信道 —— 幂等键只按信道记的话,第二张会被吞掉
    expect(me.letters.filter(l => l.dir === 'in' && l.kind === 'postcard')).toHaveLength(2)
    expect(me.journal.map(j => j.text).sort()).toEqual(['阿B 知道一个', '阿C 也知道一个'])
    expect(me.owner.filter(o => o.startsWith('📮'))).toHaveLength(2)
    const w = me.wish.list().find(x => x.id === id)!
    expect(w.replies).toBe(2)
    expect(w.postcards).toHaveLength(2)
    expect(new Set(w.postcards!.map(r => r.replyId)).size).toBe(2)   // 两条各有自己的 replyId,认识哪个是哪个
    expect(me.logs.some(l => l.includes('已经收过'))).toBe(false)
  })
  it('转问期间信箱写进来的 replies 不被覆盖(转问台账要在重新读过的索引上改)', async () => {
    // 真货里这是信箱轮询:forwardWish 每投一封都是 await,期间 handlePostcard
    // 会把一条中继 replies 写进同一张 introductions.json。
    const stateDir = mkdtempSync(join(tmpdir(), 'wish-fwd-'))
    const at = new Date(NOW.ms).toISOString()
    const chans: Chan[] = [{ id: 'src', status: 'open', degree: 1, peer_agent_id: 'cc-src' }, { id: 'f1', status: 'open', degree: 1, peer_agent_id: 'cc-f1' }]
    const w = makeWish({
      stateDir,
      channelStore: { get: (id: string) => chans.find(c => c.id === id) ?? null, list: () => chans } as never,
      sendEnvelope: async () => {
        const idx = readIntroIndex(stateDir)
        idx.replies['rmid0001'] = { wishId: 'other000', fromChannel: 'f1', at }
        writeIntroIndex(stateDir, idx)
        return { ok: true }
      },
      gate: async (t) => ({ ok: true, redacted: t, violations: [] }),
      judge: async () => ({ match: 'no' }),
      recordPostcard: () => null,
      notifyOwner: () => { /* 主人那句话这条用例不关心 */ },
      peerLabel: () => '阿一',
      forwardBudget: { withinBudget: () => true },
      now: () => NOW.ms,
      log: () => { /* 同上 */ },
    })
    const env: Envelope = { kind: 'wish', payload: { id: 'w0000001', text: 'x', expiresAt: new Date(NOW.ms + 60_000).toISOString() } }
    expect(w.onInbound('src', env, 'l1')).toBe(true)
    await flush()
    const idx = readIntroIndex(stateDir)
    expect(idx.forwards['w0000001']!.to).toEqual(['f1'])          // 转问照记
    expect(idx.replies['rmid0001']).toMatchObject({ wishId: 'other000' })   // 中途写进来的那条还在
  })
  it('B 收到 hop 2 后不再转(它自己判不能也只是说不知道)', async () => {
    const { me, A, B } = makeTrio()
    await send(me); await flush3()
    expect(B.owner).toEqual([`🙋 阿A 的伙伴来打听「找周末爬山搭子」,我说不知道`])
    expect(B.letters.filter(l => l.dir === 'out')).toHaveLength(0)
    expect(A.owner[0]).toContain('帮着问了 1 个朋友')
  })
  it('A 自己能答 → 不转', async () => {
    const { me, A, B } = makeTrio()
    A.judgeSays = { match: 'yes', blurb: '我常去' }
    await send(me); await flush3()
    expect(B.letters).toHaveLength(0)
    expect(me.journal).toEqual([{ text: '我常去', peerLabel: '阿A' }])
  })
  it('预算耗尽 → 不转,主人听到的是「我说不知道」', async () => {
    const { me, A, B } = makeTrio({ budgetOk: () => false })
    await send(me); await flush3()
    expect(B.letters).toHaveLength(0)
    expect(A.owner).toEqual([`🙋 小我 的伙伴来打听「找周末爬山搭子」,我说不知道`])
  })
  it('同一条心愿到 A 两次 → 只转一次;B 的明信片到 A 两次 → 只中继一次', async () => {
    const { me, A, B, deliver } = makeTrio()
    B.judgeSays = { match: 'yes', blurb: 'ok' }
    await send(me); await flush3()
    const wishEnv = me.letters.find(l => l.dir === 'out' && l.kind === 'wish')!
    deliver(me, 'me>A', { kind: 'wish', payload: wishEnv.payload }); await flush3()
    expect(B.letters.filter(l => l.dir === 'in' && l.kind === 'wish')).toHaveLength(1)
    const pc = B.letters.find(l => l.dir === 'out' && l.kind === 'postcard')!
    deliver(B, 'B>A', { kind: 'postcard', payload: pc.payload }); await flush3()
    expect(me.letters.filter(l => l.dir === 'in' && l.kind === 'postcard')).toHaveLength(1)
  })
  it('没有 forwardBudget 依赖(老调用方)→ 永不转:用单信道夹具 side() 验证', async () => {
    const S = side('A'); const T = side('B'); S.setPeer(T); T.setPeer(S)
    const p = await S.wish.propose('x'); if (!p.ok) throw new Error(); await S.wish.send(p.id); await flush()
    expect(T.owner).toEqual(['🙋 阿一 的伙伴来打听「x」,我说不知道'])
  })
  it('list() 的 postcards 带 viaLabel(桌面要显示「谁的朋友」)', async () => {
    const { me, B } = makeTrio()
    B.judgeSays = { match: 'yes', blurb: 'ok' }
    const id = await send(me); await flush3()
    expect(me.wish.list().find(w => w.id === id)!.postcards![0]).toMatchObject({ via: 'me>A', viaLabel: '阿A' })
  })
})
