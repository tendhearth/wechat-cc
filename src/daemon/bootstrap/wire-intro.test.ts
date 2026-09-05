import { describe, it, expect } from 'vitest'
import { makeTrio, flush } from './social-trio.fixture'
import { readWishes, writeWishes } from '../companion/wish-memory'
import { readIntroIndex, writeIntroIndex } from '../companion/intro-memory'

/**
 * 三只伙伴同进程对跑(me ─ A ─ B):me 派心愿 → A 答不上转给 B → B 答 →
 * A 原路中继回一张带 replyId 的明信片。这里从那张明信片开始,测「认识」。
 */
async function throughPostcard() {
  const t = makeTrio()
  t.B.judgeSays = { match: 'yes', blurb: '我朋友周末常去' }
  const p = await t.me.wish.propose('找周末爬山搭子'); if (!p.ok) throw new Error(p.error)
  const s = await t.me.wish.send(p.id); if (!s.ok) throw new Error(s.reason)
  await flush()
  const ref = t.me.wish.list().find(w => w.id === p.id)!.postcards![0]!
  return { ...t, wishId: p.id, replyId: ref.replyId }
}

/** 把一笔邀约的来路改成不存在的信道 —— 演「主人回话的时候信道断了」。 */
function breakOfferChannel(stateDir: string, replyId: string): void {
  const idx = readIntroIndex(stateDir)
  idx.offers[replyId]!.viaChannel = 'B>ZZ'
  writeIntroIndex(stateDir, idx)
}

describe('介绍:两边点头就成朋友(spec 2026-09-04-introduction §3)', () => {
  it('我「认识」→ A forward(不带名片)→ B 主人一句 → B 同意 → A 交叉名片 → 双方注册表互有对方、intro:<replyId> 信道各一条、三边主人各一句', async () => {
    const t = await throughPostcard()
    const r = await t.me.intro!.request(t.replyId.slice(0, 6))
    expect(r).toEqual({ ok: true, replyId: t.replyId })
    await flush()
    const fwd = t.B.letters.find(l => l.dir === 'in' && l.kind === 'intro')!
    expect(fwd.payload).toMatchObject({ stage: 'forward', hint: '找周末爬山搭子' })
    expect((fwd.payload as { card?: unknown }).card).toBeUndefined()
    expect(t.B.owner.at(-1)).toBe(`🤝 阿A 的朋友(就是问「找周末爬山搭子」那位)想认识你。回「同意 ${t.replyId.slice(0, 6)}」或「不了 ${t.replyId.slice(0, 6)}」`)
    expect(t.B.intro!.offers()).toMatchObject([{ replyId: t.replyId, hint: '找周末爬山搭子', viaLabel: '阿A' }])
    expect(await t.B.intro!.accept(t.replyId.slice(0, 6))).toEqual({ ok: true, replyId: t.replyId })
    await flush()
    expect(t.me.registry.get('cc-b00000001')).toMatchObject({ name: 'B' })
    expect(t.B.registry.get('cc-me00000001')).toMatchObject({ name: 'me' })
    expect(t.me.channels).toEqual([{ id: `intro:${t.replyId}`, peerAgentId: 'cc-b00000001', status: 'open' }])
    expect(t.B.channels).toEqual([{ id: `intro:${t.replyId}`, peerAgentId: 'cc-me00000001', status: 'open' }])
    expect(t.me.owner.at(-1)).toBe('🤝 你和 B 成了朋友(经 阿A 介绍)')
    expect(t.B.owner.at(-1)).toBe('🤝 你和 me 成了朋友(经 阿A 介绍)')
    expect(t.A.owner.at(-1)).toBe('🤝 我把 小我 介绍给了 阿B')
    expect(t.B.intro!.offers()).toEqual([])
    expect(t.A.registry.size).toBe(0)   // 介绍人自己不加任何人
  })
  it('B 不了 → 我一句话,无信道,myIntro 清掉', async () => {
    const t = await throughPostcard()
    await t.me.intro!.request(t.replyId); await flush()
    expect(await t.B.intro!.decline(t.replyId)).toEqual({ ok: true, replyId: t.replyId }); await flush()
    expect(t.me.owner.at(-1)).toBe('阿A 的朋友这次不想认识新朋友')
    expect(t.me.channels).toEqual([]); expect(t.B.channels).toEqual([])
    expect(await t.me.intro!.request(t.replyId)).toEqual({ ok: true, replyId: t.replyId })   // 可以再问一次
  })
  it('request:不认识的 replyId / 前缀撞车 / 重复请求', async () => {
    const t = await throughPostcard()
    expect(await t.me.intro!.request('zzzzzz')).toEqual({ ok: false, reason: 'not_found' })
    expect(await t.me.intro!.request(t.replyId)).toMatchObject({ ok: true })
    expect(await t.me.intro!.request(t.replyId)).toEqual({ ok: false, reason: 'already_requested' })
  })
  it('A 只接受来自发心愿那条信道的 request(别人冒充 → 丢)', async () => {
    const t = await throughPostcard()
    const card = { v: 2, role: 'initiator', nonce: 'x', self_id: 'cc-evil0000001', name: 'E', mailbox_addr: 'ME', mailbox_enc_pub: 'EE', relays: ['https://r/mailbox'], bearer: 'e'.repeat(16), channel_id: 'ec', channel_pub: 'EP' }
    // 从 B 那条信道伪造一个 request
    t.deliver(t.B, 'B>A', { kind: 'intro', payload: { stage: 'request', replyId: t.replyId, wishId: t.wishId, card } })
    await flush()
    expect(t.B.letters.filter(l => l.dir === 'in' && l.kind === 'intro')).toHaveLength(0)
    expect(t.A.logs.some(l => /request.*(不是发心愿|丢)/.test(l))).toBe(true)
    expect(t.A.owner.filter(o => o.startsWith('📬'))).toEqual([])   // 认领了(onInbound=true),没漏成「一封没人认的信」
  })
  it('request 的 replyId 和 wishId 对不上 → 丢', async () => {
    const t = await throughPostcard()
    const p2 = await t.me.wish.propose('找人一起打球'); if (!p2.ok) throw new Error(p2.error)
    const s2 = await t.me.wish.send(p2.id); if (!s2.ok) throw new Error(s2.reason)
    await flush()
    const ref2 = t.me.wish.list().find(w => w.id === p2.id)!.postcards![0]!
    expect(ref2.replyId).not.toBe(t.replyId)
    const card = { v: 2, role: 'initiator', nonce: 'x', self_id: 'cc-me00000001', name: 'me', mailbox_addr: 'Mme', mailbox_enc_pub: 'Eme', relays: ['https://r/mailbox'], bearer: 'm'.repeat(16), channel_id: 'mc', channel_pub: 'MP' }
    const before = t.B.letters.filter(l => l.dir === 'in' && l.kind === 'intro').length
    // replyId 是第一条心愿的链路,wishId 却写成第二条 —— 拿别人的钥匙开这把锁
    t.deliver(t.me, 'me>A', { kind: 'intro', payload: { stage: 'request', replyId: t.replyId, wishId: p2.id, card } })
    await flush()
    expect(t.B.letters.filter(l => l.dir === 'in' && l.kind === 'intro')).toHaveLength(before)
    expect(t.A.logs.some(l => /request.*和心愿对不上/.test(l))).toBe(true)
  })
  it('读不懂的 / 我没转问过的 intro → 照样认领(onInbound=true)并丢,主人一个字都看不见', async () => {
    const t = await throughPostcard()
    const card = { v: 2, role: 'initiator', nonce: 'x', self_id: 'cc-me00000001', name: 'me', mailbox_addr: 'Mme', mailbox_enc_pub: 'Eme', relays: ['https://r/mailbox'], bearer: 'm'.repeat(16), channel_id: 'mc', channel_pub: 'MP' }
    const n = t.A.owner.length
    t.deliver(t.me, 'me>A', { kind: 'intro', payload: { stage: '来一个没见过的 stage' } })
    t.deliver(t.me, 'me>A', { kind: 'intro', payload: { stage: 'request', replyId: 'zzzzzzzz', wishId: 'zzzzzzzz', card } })
    await flush()
    expect(t.A.owner).toHaveLength(n)
    expect(t.A.logs.some(l => /读不懂的 intro/.test(l))).toBe(true)
    expect(t.A.logs.some(l => /我没转问过这条/.test(l))).toBe(true)
  })
  it('accept 没有对应 pending → 丢,没人被打扰', async () => {
    const t = await throughPostcard()
    const card = { v: 2, role: 'acceptor', nonce: 'x', self_id: 'cc-b00000001', name: 'B', mailbox_addr: 'MB', mailbox_enc_pub: 'EB', relays: ['https://r/mailbox'], bearer: 'b'.repeat(16), channel_id: 'bc', channel_pub: 'BP' }
    t.deliver(t.B, 'B>A', { kind: 'intro', payload: { stage: 'accept', replyId: t.replyId, wishId: t.wishId, card } })
    await flush()
    expect(t.me.letters.filter(l => l.dir === 'in' && l.kind === 'intro')).toHaveLength(0)
  })
  it('accept 来自别的信道(不是被介绍方那条)→ 丢,名片不交叉', async () => {
    const t = await throughPostcard()
    await t.me.intro!.request(t.replyId); await flush()
    const card = { v: 2, role: 'acceptor', nonce: 'x', self_id: 'cc-evil0000001', name: 'E', mailbox_addr: 'ME', mailbox_enc_pub: 'EE', relays: ['https://r/mailbox'], bearer: 'e'.repeat(16), channel_id: 'ec', channel_pub: 'EP' }
    // pending.targetChannel 是 A>B;这封从「我」那条信道来,冒充点头
    t.deliver(t.me, 'me>A', { kind: 'intro', payload: { stage: 'accept', replyId: t.replyId, wishId: t.wishId, card } })
    await flush()
    expect(t.A.letters.filter(l => l.dir === 'out' && (l.payload as { stage?: string }).stage === 'card')).toHaveLength(0)
    expect(t.me.registry.size).toBe(0); expect(t.B.registry.size).toBe(0)
    expect(t.A.logs.some(l => /accept.*不是被介绍方/.test(l))).toBe(true)
  })
  it('card 没有对应的 claim(被介绍方还没点头)→ 丢,不写注册表', async () => {
    const t = await throughPostcard()
    await t.me.intro!.request(t.replyId); await flush()   // B 收到 forward,但主人没点头
    const card = { v: 2, role: 'initiator', nonce: 'x', self_id: 'cc-me00000001', name: 'me', mailbox_addr: 'Mme', mailbox_enc_pub: 'Eme', relays: ['https://r/mailbox'], bearer: 'm'.repeat(16), channel_id: 'mc', channel_pub: 'MP' }
    t.deliver(t.A, 'A>B', { kind: 'intro', payload: { stage: 'card', replyId: t.replyId, wishId: t.wishId, card } })
    await flush()
    expect(t.B.registry.size).toBe(0); expect(t.B.channels).toEqual([])
    expect(t.B.logs.some(l => /card.*没在等这笔介绍/.test(l))).toBe(true)
  })
  it('同一封 forward 到两次 → 主人只被问一次', async () => {
    const t = await throughPostcard()
    await t.me.intro!.request(t.replyId); await flush()
    const n = t.B.owner.length
    t.deliver(t.A, 'A>B', { kind: 'intro', payload: { stage: 'forward', replyId: t.replyId, wishId: t.wishId, hint: '找周末爬山搭子' } })
    await flush()
    expect(t.B.owner).toHaveLength(n)
    expect(t.B.intro!.offers()).toHaveLength(1)
  })
  it('点过头、名片还没回来的邀约不再列进 offers()(那是在等名片,不是等主人回话)', async () => {
    const t = await throughPostcard()
    await t.me.intro!.request(t.replyId); await flush()
    expect(t.B.intro!.offers()).toHaveLength(1)
    const idx = readIntroIndex(t.B.stateDir)
    idx.offers[t.replyId]!.myIntro = { channelId: 'c', pubkey: 'P', privkey: 'K', bearer: 'b'.repeat(16), at: new Date(t.B.clock.ms).toISOString() }
    writeIntroIndex(t.B.stateDir, idx)
    expect(t.B.intro!.offers()).toEqual([])
  })
  it('decline 来路不对 → 丢:A 不认别条信道的摇头,我不认没请求过的摇头', async () => {
    const t = await throughPostcard()
    // 我根本没按过「认识」,却收到一封 decline —— 没有 myIntro 就没有这回事
    const n0 = t.me.owner.length
    t.deliver(t.A, 'A>me', { kind: 'intro', payload: { stage: 'decline', replyId: t.replyId, wishId: t.wishId } })
    await flush()
    expect(t.me.owner).toHaveLength(n0)
    expect(t.me.logs.some(l => /decline.*没在等这笔介绍/.test(l))).toBe(true)
    // 真按了「认识」之后,A 那边的 pending 只认被介绍方那条信道的摇头
    await t.me.intro!.request(t.replyId); await flush()
    const n1 = t.me.owner.length
    t.deliver(t.me, 'me>A', { kind: 'intro', payload: { stage: 'decline', replyId: t.replyId, wishId: t.wishId } })
    await flush()
    expect(t.me.owner).toHaveLength(n1)   // A 没把这封冒充的摇头转回来
    expect(t.A.logs.some(l => /decline.*不是被介绍方/.test(l))).toBe(true)
  })
  it('request 寄不出去 → myIntro 不留,还能再问', async () => {
    const t = await throughPostcard()
    // 把这张明信片的来路改成一条不存在的信道 —— 演「信道断了」
    const list = readWishes(t.me.stateDir)
    writeWishes(t.me.stateDir, list.map(w => ({ ...w, postcards: w.postcards?.map(r => ({ ...r, via: 'me>ZZ' })) })))
    expect(await t.me.intro!.request(t.replyId)).toEqual({ ok: false, reason: 'send_failed' })
    expect(readWishes(t.me.stateDir).flatMap(w => w.postcards ?? [])[0]!.myIntro).toBeUndefined()
  })
  it('accept 寄不出去 → myIntro 擦掉,邀约还留在 offers() 里(主人能再点一次头)', async () => {
    const t = await throughPostcard()
    await t.me.intro!.request(t.replyId); await flush()
    breakOfferChannel(t.B.stateDir, t.replyId)
    expect(await t.B.intro!.accept(t.replyId)).toEqual({ ok: false, reason: 'send_failed' })
    expect(t.B.intro!.offers()).toMatchObject([{ replyId: t.replyId }])
    expect(readIntroIndex(t.B.stateDir).offers[t.replyId]!.myIntro).toBeUndefined()
  })
  it('decline 寄不出去 → 邀约留着(不能让主人以为回绝了、对面却永远在等)', async () => {
    const t = await throughPostcard()
    await t.me.intro!.request(t.replyId); await flush()
    breakOfferChannel(t.B.stateDir, t.replyId)
    expect(await t.B.intro!.decline(t.replyId)).toEqual({ ok: false, reason: 'send_failed' })
    expect(t.B.intro!.offers()).toMatchObject([{ replyId: t.replyId }])
  })
  it('一条信道最多压着 3 笔没回话的邀约;主人回了一笔就腾出一个位子', async () => {
    const t = await throughPostcard()
    const fwd = (replyId: string) => t.deliver(t.A, 'A>B', { kind: 'intro', payload: { stage: 'forward', replyId, wishId: t.wishId, hint: '找周末爬山搭子' } })
    const n = t.B.owner.length
    for (const id of ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004']) fwd(id)
    await flush()
    expect(t.B.intro!.offers().map(o => o.replyId).sort()).toEqual(['aaaa0001', 'aaaa0002', 'aaaa0003'])
    expect(t.B.owner).toHaveLength(n + 3)   // 第 4 笔一个字都没惊动主人
    expect(t.B.logs.some(l => /forward.*压着 3 笔/.test(l))).toBe(true)
    // 点过头的那笔也不占额度(它在等名片,不在等主人回话)
    expect(await t.B.intro!.accept('aaaa0001')).toMatchObject({ ok: true })
    fwd('aaaa0005'); await flush()
    expect(t.B.intro!.offers().map(o => o.replyId).sort()).toEqual(['aaaa0002', 'aaaa0003', 'aaaa0005'])
  })
  it('同一个 replyId 的 request 到两次 → 扣在手里的名片不被换掉', async () => {
    const t = await throughPostcard()
    await t.me.intro!.request(t.replyId); await flush()
    const evil = { v: 2, role: 'initiator', nonce: 'x', self_id: 'cc-evil0000001', name: 'E', mailbox_addr: 'ME', mailbox_enc_pub: 'EE', relays: ['https://r/mailbox'], bearer: 'e'.repeat(16), channel_id: 'ec', channel_pub: 'EP' }
    t.deliver(t.me, 'me>A', { kind: 'intro', payload: { stage: 'request', replyId: t.replyId, wishId: t.wishId, card: evil } })
    await flush()
    expect(t.A.logs.some(l => /request.*已经在牵了/.test(l))).toBe(true)
    await t.B.intro!.accept(t.replyId); await flush()
    expect(t.B.registry.get('cc-me00000001')).toMatchObject({ name: 'me' })   // 交出去的还是第一封那张
    expect(t.B.registry.get('cc-evil0000001')).toBeUndefined()
  })
  it('身份冲突:我这边已有同 id 不同信箱的联系人 → 介绍失败一句话,无信道', async () => {
    const t = await throughPostcard()
    t.me.registry.set('cc-b00000001', { id: 'cc-b00000001', name: 'Other', mailbox_addr: 'DIFFERENT' })
    await t.me.intro!.request(t.replyId); await flush()
    await t.B.intro!.accept(t.replyId); await flush()
    expect(t.me.owner.at(-1)).toBe('介绍失败:对方身份和已有联系人冲突')
    expect(t.me.channels).toEqual([])
    // claim 不擦:这是本机数据真撞车了,得先解决冲突,不是「再问一次」能好的
    expect(readWishes(t.me.stateDir).flatMap(w => w.postcards ?? [])[0]!.myIntro).toBeTruthy()
  })
  it('注册表写好了但信道没开成 → 还是「成了朋友」,只是尾巴上说一句「信道稍后补」', async () => {
    const t = await throughPostcard()
    t.me.adoptOpensChannel = false
    await t.me.intro!.request(t.replyId); await flush()
    await t.B.intro!.accept(t.replyId); await flush()
    expect(t.me.owner.at(-1)).toBe('🤝 你和 B 成了朋友(经 阿A 介绍),信道稍后补')
    expect(t.me.registry.get('cc-b00000001')).toMatchObject({ name: 'B' })
    expect(t.me.channels).toEqual([])
  })
  it('pending 过期 → A 替 B 发 decline', async () => {
    const t = await throughPostcard()
    await t.me.intro!.request(t.replyId); await flush()
    t.me.clock.ms += 7 * 24 * 60 * 60_000 + 1000    // 三方共用一个时钟
    await t.A.intro!.decline('nothing')             // A 侧读一次索引 → prune → 替对方发 decline
    await flush()
    expect(t.me.owner.at(-1)).toBe('阿A 的朋友这次不想认识新朋友')
  })
  it('intro 信封持 busy token 且放开;非 intro kind → false', async () => {
    const t = await throughPostcard()
    await t.me.intro!.request(t.replyId); await flush()
    expect(t.A.busy.some(b => b.label === 'intro' && b.released)).toBe(true)      // 收信那段
    expect(t.me.busy.some(b => b.label === 'intro' && b.released)).toBe(true)     // 主人动作那段
    expect(t.me.intro!.onInbound('me>A', { kind: 'letter', payload: {} }, 'x')).toBe(false)
  })
})
