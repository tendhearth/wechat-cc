/**
 * wire-intro.ts — 「介绍」的 daemon 接线(spec 2026-09-04-introduction §3)。
 * 协议、索引和过期规则在 core/intro.ts;写注册表 + 开信道在 core/pairing.ts。
 *
 * 心愿的转问(wire-wish.ts)只让最初问的人看见「A 的朋友回了你」——**没有**
 * 名字、没有信箱、没有信道。想真认识,得走这里的五步,而且中间隔着一个人:
 *
 *   我 ──request(带我的名片)──▶ A ──forward(只有一句 hint)──▶ B
 *                                                              │
 *                                       ◀── accept(带 B 的名片)┘ / decline
 *   我 ◀──card(B 的名片)── A ──card(我的名片)──▶ B
 *
 * 三条红线,和 spec 的「介绍是人情,不是查询」一一对应:
 *
 *   1. **身份只在最后一跳过线**。`forward` 里没有名片 —— B 的主人在点头之前
 *      看不到我是谁,只看到「阿A 的朋友,就是问 X 那位」。我的名片一直躺在 A
 *      的 `pending` 里,A 绝不提前转出去。摇头的人什么也没暴露。
 *   2. **唯一的人工门在被介绍方**。我按「认识」是发起,不是同意;A 是自动
 *      转的(它已经替我问过一次了,不必再打扰它主人);只有 B 的主人要亲口
 *      说「同意」。A 的主人事后才被告知「我把谁介绍给了谁」。
 *   3. **每一封信都要先证明「你有资格提这件事」**。`request` 只认发心愿那条
 *      信道(`forwards[wishId].from`),`accept`/`decline` 只认被介绍方那条
 *      (`pending[replyId].targetChannel`),`card` 只认这边确实还挂着的那笔
 *      介绍(我的 `wishes.json` 里的 `myIntro`,或 B 点过头的 `offers`)。
 *      不合的一律**记日志丢掉**,不回错、不打扰主人 —— 冒充者连「猜中了没」
 *      都不该知道。
 *
 * 状态每次从 introductions.json 读、算、写回(读完先 `pruneIntroIndex`,和
 * wishes.json 一样不缓存)。介绍人忘性 7 天:过了还没等到点头,`pending` 过期
 * 掉,替被介绍方给最初问的人回一句「不了」—— 不然那个人永远停在半空中。
 *
 * `onInbound` 必须**同步**返回 true(分发点不能被 adopt 的 sqlite 写或一次
 * 发信堵住);真正的活在 `void (async …)().catch(log)` 里,持 busy token
 * `intro` —— 空闲自动重启不能在交叉名片发到一半时把 daemon 掐了。
 */
import {
  introEnvelope, parseIntroPayload, pruneIntroIndex, resolveIntroRef, isIntroClaimLive, FORWARD_PER_SENDER,
  type IntroIndex, type IntroPayload,
} from '../../core/intro'
import { readIntroIndex, writeIntroIndex } from '../companion/intro-memory'
import { findPostcardRef, attachMyIntro, clearMyIntro, type PostcardRef } from '../../core/wish'
import { readWishes, writeWishes } from '../companion/wish-memory'
import type { Envelope } from '../../core/envelope'
import type { PairCard } from '../../core/pairing'
import type { ChannelStore } from '../../core/penpal-channel-store'

/** 我这边为这一笔介绍现开的信道句柄 + 铸的钥匙(和 PostcardRef['myIntro'] 同形)。 */
type MyIntro = NonNullable<PostcardRef['myIntro']>

export interface IntroDeps {
  stateDir: string
  channelStore: Pick<ChannelStore, 'get' | 'list'>
  sendEnvelope(channelRowId: string, env: Envelope): Promise<{ ok: boolean; error?: string }>
  /** 我的名片:wire-social 用 buildOwnCard 包好(role 只是字段,不影响逻辑)。 */
  buildCard(role: 'initiator' | 'acceptor', nonce: string, bearer: string, chan: { channelId: string; pubkey: string }): PairCard
  /** 采纳对方名片:wire-social 用 adoptPeerCard(…, 'intro') 包好。 */
  adopt(card: PairCard, mine: { channelId: string; pubkey: string; privkey: string }, myMintedKey: string, nonce: string): { ok: true; channelOpened: boolean } | { ok: false; reason: 'id_conflict' }
  mintKey(): string
  genChannel(): { channelId: string; pubkey: string; privkey: string }
  notifyOwner(text: string): void
  peerLabel(channelRowId: string): string
  holdBusy?: (label: string) => () => void
  now?: () => number
  log(tag: string, line: string): void
}

export interface IntroService {
  /** 我看到「A 的朋友」的明信片,想认识:按 replyId 前缀。 */
  request(replyRef: string): Promise<{ ok: true; replyId: string } | { ok: false; reason: 'not_found' | 'ambiguous' | 'already_requested' | 'send_failed' }>
  /** 被介绍方主人点头 / 摇头:按 offers 的 replyId 前缀。 */
  accept(offerRef: string): Promise<{ ok: true; replyId: string } | { ok: false; reason: 'not_found' | 'ambiguous' | 'send_failed' }>
  decline(offerRef: string): Promise<{ ok: true; replyId: string } | { ok: false; reason: 'not_found' | 'ambiguous' | 'send_failed' }>
  offers(): Array<{ replyId: string; hint: string; viaLabel: string; at: string }>
  onInbound(channelRowId: string, env: Envelope, letterId: string): boolean
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const without = <T>(rec: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _drop, ...rest } = rec
  return rest
}

export function makeIntro(deps: IntroDeps): IntroService {
  const now = deps.now ?? Date.now
  const nowIso = (): string => new Date(now()).toISOString()
  const log = (line: string): void => deps.log('INTRO', line)

  /** 登记一段后台活。登记失败、放开失败都只当没登记(照 wire-wish.ts)。 */
  const holdBusy = (label: string): (() => void) => {
    let release: (() => void) | undefined
    try { release = deps.holdBusy?.(label) } catch { release = undefined }
    return () => { try { release?.() } catch { /* 放开失败:下一次重启窗口再说 */ } }
  }
  /** 后台一段:持 `intro` token,抛什么都只记日志,绝不冒到分发点上去。 */
  const bg = (what: string, fn: () => Promise<void>): void => {
    const release = holdBusy('intro')
    void fn().catch(err => log(`${what} 出错: ${errText(err)}`)).finally(release)
  }
  /**
   * 主人动作里那段「发信 + 落盘」。这一段也是**脱离用户会话**的活(主人在微信
   * 里敲完「认识」就走了),空闲自动重启不能在信发出去、claim 还没写回的中间
   * 把 daemon 掐了 —— 那会留下一个两边对不上的介绍。
   */
  const withBusy = async <T>(fn: () => Promise<T>): Promise<T> => {
    const release = holdBusy('intro')
    try { return await fn() } finally { release() }
  }
  /**
   * 这张名片说自己是谁,和这条信道那头**实际**是谁,对得上吗?
   *
   * 信道行里的 `peer_agent_id` 是配对(或上一笔介绍)那一刻从对方名片上落下来
   * 的,是这条线上唯一一份不由这封信自证的身份。不对账的话:任何一个配过对的
   * 人都能递一张 `self_id` 写着别人 slug 的名片过来,我 `adoptPeerCard` 一写,
   * 那个 slug 就连到了他的信箱上;等真正的那个人来跟我配对,`adoptPeerCard`
   * 只会回一句 `id_conflict` —— 冒名者把这个 id 占死了。spec 的「不防介绍人」
   * 说的是 A 可以在 hint 上做手脚,不是「谁都能自称是别人」。
   */
  const cardIsFromPeer = (channelRowId: string, card: PairCard, what: string): boolean => {
    const row = deps.channelStore.get(channelRowId)
    if (!row || row.peer_agent_id !== card.self_id) {
      log(`${what} 名片的 self_id(${card.self_id})不是这条信道的对端(${row?.peer_agent_id ?? '无此信道'})— 丢`)
      return false
    }
    return true
  }
  const send = async (chan: string, env: Envelope, what: string): Promise<boolean> => {
    try {
      const r = await deps.sendEnvelope(chan, env)
      if (!r.ok) log(`${what} 发 ${chan} 失败: ${r.error ?? 'send_failed'}`)
      return r.ok
    } catch (err) { log(`${what} 发 ${chan} 抛错: ${errText(err)}`); return false }
  }

  /**
   * 读索引 = 读 → prune → (我是介绍人时)替过期的 pending 给最初问的人回一句
   * 「不了」→ 写回。**每一次**读都走这里:主人的动作、收信、列表都算,过期
   * 清理才不需要一个定时器。
   */
  const load = (): IntroIndex => {
    const raw = readIntroIndex(deps.stateDir)
    const { index, expiredPending } = pruneIntroIndex(raw, now())
    if (expiredPending.length === 0) return index
    writeIntroIndex(deps.stateDir, index)
    for (const e of expiredPending) {
      const wishId = raw.pending[e.replyId]?.wishId ?? ''
      log(`pending replyId=${e.replyId} 7 天没等到点头 — 替对方回一句「不了」`)
      if (wishId === '') continue   // 索引被手改坏了:信封会被对面判成读不懂,不如不发
      bg('过期 decline', async () => {
        await send(e.requesterChannel, introEnvelope({ stage: 'decline', replyId: e.replyId, wishId }), `过期 decline replyId=${e.replyId}`)
      })
    }
    return index
  }
  const save = (idx: IntroIndex): void => {
    const { index } = pruneIntroIndex(idx, now())
    writeIntroIndex(deps.stateDir, index)
  }

  // ── 收信:五个 stage ───────────────────────────────────────────────────

  /**
   * 我是介绍人 A:最初问的人说「认识」。三道闸 —— 这条链路我记过吗、提这张
   * 明信片的是不是当初发心愿的那条信道、replyId 和 wishId 对不对得上。过了
   * 就把他的名片扣在 `pending` 里(**不转出去**),只把一句 hint 转给答话方。
   */
  const onRequest = (channelRowId: string, p: IntroPayload): boolean => {
    if (!p.card) { log(`request replyId=${p.replyId} 没带名片 — 丢`); return true }
    const idx = load()
    const rep = idx.replies[p.replyId]
    const fwd = idx.forwards[p.wishId]
    if (!rep || !fwd) { log(`request replyId=${p.replyId} 我没转问过这条(replies/forwards 缺一)— 丢`); return true }
    if (fwd.from !== channelRowId) { log(`request replyId=${p.replyId} 不是发心愿的那条信道来的(${channelRowId} ≠ ${fwd.from})— 丢`); return true }
    if (rep.wishId !== p.wishId) { log(`request replyId=${p.replyId} 和心愿对不上(${rep.wishId} ≠ ${p.wishId})— 丢`); return true }
    // 已经在牵这一笔了。重投一次不该把扣在手里的名片换掉(换了的话,对方点头
    // 之后转出去的会是第二封信里那张 —— 谁都能拿这个覆盖别人的身份)。
    if (idx.pending[p.replyId]) { log(`request replyId=${p.replyId} 已经在牵了 — 丢(不覆盖手里的名片)`); return true }
    // 第四道闸:名片上的身份得是这条信道那头的人本人(见 cardIsFromPeer)。
    if (!cardIsFromPeer(channelRowId, p.card, `request replyId=${p.replyId}`)) return true
    save({ ...idx, pending: { ...idx.pending, [p.replyId]: { wishId: p.wishId, requesterChannel: channelRowId, requesterCard: p.card, targetChannel: rep.fromChannel, at: nowIso() } } })
    bg('forward', async () => {
      await send(rep.fromChannel, introEnvelope({ stage: 'forward', replyId: p.replyId, wishId: p.wishId, hint: fwd.preview }), `forward replyId=${p.replyId}`)
    })
    return true
  }

  /**
   * 我是被介绍方 B:介绍人替他朋友来问一句。这是**唯一**一处要主人开口的地方。
   * 已经在台账上了就只记日志 —— 信箱 at-least-once,同一笔介绍到两次不该把
   * 主人问两遍(也不该把他刚点过的头擦掉重来)。
   */
  const onForward = (channelRowId: string, p: IntroPayload): boolean => {
    const idx = load()
    if (idx.offers[p.replyId]) { log(`forward replyId=${p.replyId} 已经在台账上了 — 丢(不重复打扰主人)`); return true }
    const hint = (p.hint ?? '').trim()
    if (hint === '') { log(`forward replyId=${p.replyId} 没有 hint — 丢`); return true }
    // 配额:一条信道同时最多压着 FORWARD_PER_SENDER 笔「等主人回话」的邀约。
    // 没有这道闸,任何一个配过对的人都能无限地写我的台账、无限地敲我主人 ——
    // 介绍是人情,人情有额度。答过的(点头/摇头)不占额,所以主人一回话就腾
    // 出一个位子。
    const waiting = Object.values(idx.offers).filter(o => o.viaChannel === channelRowId && !o.myIntro).length
    if (waiting >= FORWARD_PER_SENDER) { log(`forward replyId=${p.replyId} ${channelRowId} 压着 ${waiting} 笔没回话的邀约 — 丢(不再打扰主人)`); return true }
    save({ ...idx, offers: { ...idx.offers, [p.replyId]: { wishId: p.wishId, viaChannel: channelRowId, hint, at: nowIso() } } })
    const short = p.replyId.slice(0, 6)
    deps.notifyOwner(`🤝 ${deps.peerLabel(channelRowId)} 的朋友(就是问「${hint}」那位)想认识你。回「同意 ${short}」或「不了 ${short}」`)
    return true
  }

  /**
   * 我是介绍人 A:被介绍方点头了。这一刻才交叉名片 —— 两封 `card` 各去一边。
   * 一封发不出去也照发另一封、照删 pending:半边的介绍重新配对就能补,一条
   * 卡死的 pending 主人却谁也看不见(只会在 7 天后诈尸发一句「不了」)。
   */
  const onAccept = (channelRowId: string, p: IntroPayload): boolean => {
    if (!p.card) { log(`accept replyId=${p.replyId} 没带名片 — 丢`); return true }
    const idx = load()
    const pd = idx.pending[p.replyId]
    if (!pd) { log(`accept replyId=${p.replyId} 没有对应的 pending — 丢`); return true }
    if (pd.targetChannel !== channelRowId) { log(`accept replyId=${p.replyId} 不是被介绍方那条信道来的(${channelRowId} ≠ ${pd.targetChannel})— 丢`); return true }
    // 名片上的身份得是这条信道那头的人本人 —— 这张会被我原样转给最初问的人,
    // 他没有第二个渠道能核对(见 cardIsFromPeer)。
    if (!cardIsFromPeer(channelRowId, p.card, `accept replyId=${p.replyId}`)) return true
    const theirCard = p.card
    save({ ...idx, pending: without(idx.pending, p.replyId) })
    bg('交叉名片', async () => {
      await send(pd.requesterChannel, introEnvelope({ stage: 'card', replyId: p.replyId, wishId: pd.wishId, card: theirCard }), `card→请求方 replyId=${p.replyId}`)
      await send(pd.targetChannel, introEnvelope({ stage: 'card', replyId: p.replyId, wishId: pd.wishId, card: pd.requesterCard }), `card→被介绍方 replyId=${p.replyId}`)
      deps.notifyOwner(`🤝 我把 ${deps.peerLabel(pd.requesterChannel)} 介绍给了 ${deps.peerLabel(pd.targetChannel)}`)
    })
    return true
  }

  /**
   * 摇头。两种身份:`pending` 里有 = 我是介绍人(原路转给最初问的人);
   * 心愿里挂着这笔 `myIntro` = 我是最初问的人(擦掉 myIntro,跟主人说一句)。
   * 都不是 → 丢。擦掉 myIntro 是为了「可以再问一次」—— 人家这次不想,不代表
   * 下次也不想。
   */
  const onDecline = (channelRowId: string, p: IntroPayload): boolean => {
    const idx = load()
    const pd = idx.pending[p.replyId]
    if (pd) {
      if (pd.targetChannel !== channelRowId) { log(`decline replyId=${p.replyId} 不是被介绍方那条信道来的(${channelRowId} ≠ ${pd.targetChannel})— 丢`); return true }
      save({ ...idx, pending: without(idx.pending, p.replyId) })
      bg('转发 decline', async () => {
        await send(pd.requesterChannel, introEnvelope({ stage: 'decline', replyId: p.replyId, wishId: pd.wishId }), `decline→请求方 replyId=${p.replyId}`)
      })
      return true
    }
    const list = readWishes(deps.stateDir)
    const found = findPostcardRef(list, p.replyId)
    if (!found.ok || found.ref.via !== channelRowId || !found.ref.myIntro) {
      log(`decline replyId=${p.replyId} 我没在等这笔介绍 — 丢`)
      return true
    }
    writeWishes(deps.stateDir, clearMyIntro(list, found.ref.replyId))
    deps.notifyOwner(`${deps.peerLabel(channelRowId)} 的朋友这次不想认识新朋友`)
    return true
  }

  /** 采纳 + 跟主人说一句。冲突就只说一句,不开信道、不动这边的 claim。 */
  const adoptAndTell = (channelRowId: string, card: PairCard, replyId: string, mine: MyIntro, clearClaim: () => void): void => {
    let r: ReturnType<IntroDeps['adopt']>
    try { r = deps.adopt(card, mine, mine.bearer, replyId) }
    catch (err) { log(`card replyId=${replyId} adopt 抛错: ${errText(err)}`); return }
    if (!r.ok) {
      log(`card replyId=${replyId} adopt 拒了: ${r.reason}`)
      deps.notifyOwner('介绍失败:对方身份和已有联系人冲突')
      return
    }
    // 注册表已经写好了 = 朋友是交上了,信道没开成是另一回事(重新配对能补)。
    if (!r.channelOpened) log(`card replyId=${replyId} 注册表写好了但信道没开成`)
    clearClaim()
    deps.notifyOwner(`🤝 你和 ${card.name} 成了朋友(经 ${deps.peerLabel(channelRowId)} 介绍)${r.channelOpened ? '' : ',信道稍后补'}`)
    log(`card replyId=${replyId} 成了 — ${card.self_id}`)
  }

  /**
   * 最后一跳:介绍人转来的对方名片。只认这边**确实还挂着**的那笔介绍 ——
   * 我这边是心愿里那条 `myIntro`,B 那边是自己点过头的 `offers[replyId].myIntro`
   * (没点头就没有 myIntro,一封凭空来的 card 进不来)。
   */
  const onCard = (channelRowId: string, p: IntroPayload): boolean => {
    if (!p.card) { log(`card replyId=${p.replyId} 没带名片 — 丢`); return true }
    const card = p.card
    const list = readWishes(deps.stateDir)
    const found = findPostcardRef(list, p.replyId)
    if (found.ok && found.ref.via === channelRowId && found.ref.myIntro) {
      const mine = found.ref.myIntro
      const replyId = found.ref.replyId
      bg('adopt(请求方)', async () => {
        adoptAndTell(channelRowId, card, replyId, mine, () => writeWishes(deps.stateDir, clearMyIntro(readWishes(deps.stateDir), replyId)))
      })
      return true
    }
    const idx = load()
    const offer = idx.offers[p.replyId]
    if (offer && offer.viaChannel === channelRowId && offer.myIntro) {
      const mine = offer.myIntro
      bg('adopt(被介绍方)', async () => {
        adoptAndTell(channelRowId, card, p.replyId, mine, () => { const cur = load(); save({ ...cur, offers: without(cur.offers, p.replyId) }) })
      })
      return true
    }
    log(`card replyId=${p.replyId} 我没在等这笔介绍(既不是我请求的,也不是我点过头的)— 丢`)
    return true
  }

  return {
    async request(replyRef) {
      const list = readWishes(deps.stateDir)
      const found = findPostcardRef(list, replyRef)
      if (!found.ok) return { ok: false, reason: found.reason }
      const { wishId, ref } = found
      // 已经问过一次了。再问一次不会更快,只会让 A 那边多一条 pending。
      // 但这句「已经在问」只压 7 天(isIntroClaimLive)—— 过了这个点,A 那边
      // 的 pending 早已在同一把尺子上过期,card 也确定不会再来了,主人有权
      // 重新问一次(下面的 attachMyIntro 会把那把过期的钥匙原地换掉)。
      if (isIntroClaimLive(ref.myIntro, now())) return { ok: false, reason: 'already_requested' }
      const chan = deps.genChannel()
      const bearer = deps.mintKey()
      const card = deps.buildCard('initiator', ref.replyId, bearer, chan)
      return withBusy(async () => {
        // **先落 myIntro 再发信**:同进程的两只伙伴之间,card 可能在 sendEnvelope
        // 还没返回时就绕一圈回来了,那时候 claim 要是还没写,最后一跳会被丢掉。
        writeWishes(deps.stateDir, attachMyIntro(list, ref.replyId, { ...chan, bearer, at: nowIso() }))
        const ok = await send(ref.via, introEnvelope({ stage: 'request', replyId: ref.replyId, wishId, card }), `request replyId=${ref.replyId}`)
        if (!ok) {
          // 发不出去就把 claim 擦掉 —— 不然 already_requested 会把这张明信片
          // 永远钉死在「问过了」上。重读一遍再擦:上面 await 期间别人也在写。
          writeWishes(deps.stateDir, clearMyIntro(readWishes(deps.stateDir), ref.replyId))
          return { ok: false, reason: 'send_failed' }
        }
        log(`request replyId=${ref.replyId} 发出去了 → ${ref.via}`)
        return { ok: true, replyId: ref.replyId }
      })
    },

    async accept(offerRef) {
      const idx = load()
      const r = resolveIntroRef(Object.keys(idx.offers), offerRef)
      if (!r.ok) return { ok: false, reason: r.reason }
      const offer = idx.offers[r.id]!
      const chan = deps.genChannel()
      const bearer = deps.mintKey()
      const card = deps.buildCard('acceptor', r.id, bearer, chan)
      return withBusy(async () => {
        // 同上:claim 先落盘,card 回来才认得。
        save({ ...idx, offers: { ...idx.offers, [r.id]: { ...offer, myIntro: { ...chan, bearer, at: nowIso() } } } })
        const ok = await send(offer.viaChannel, introEnvelope({ stage: 'accept', replyId: r.id, wishId: offer.wishId, card }), `accept replyId=${r.id}`)
        if (!ok) {
          // 发不出去就把 myIntro 擦掉。`offers()` 不列有 myIntro 的(那是「在等
          // 名片」),不擦的话这笔邀约从主人眼里消失了,他连再点一次头的机会都
          // 没有。重读一遍再擦 —— await 期间别的信也在写这张表。
          const cur = load()
          const stale = cur.offers[r.id]
          if (stale) {
            const { myIntro: _drop, ...bare } = stale
            save({ ...cur, offers: { ...cur.offers, [r.id]: bare } })
          }
          return { ok: false, reason: 'send_failed' }
        }
        log(`accept replyId=${r.id} 发出去了 → ${offer.viaChannel}`)
        return { ok: true, replyId: r.id }
      })
    },

    async decline(offerRef) {
      const idx = load()
      const r = resolveIntroRef(Object.keys(idx.offers), offerRef)
      if (!r.ok) return { ok: false, reason: r.reason }
      const offer = idx.offers[r.id]!
      return withBusy(async () => {
        // **发成了才删**。先删的话,一次信道抖动就把这笔邀约从主人眼里抹掉了,
        // 而对面还在等回话 —— 主人以为自己回绝了,人家永远收不到。
        const ok = await send(offer.viaChannel, introEnvelope({ stage: 'decline', replyId: r.id, wishId: offer.wishId }), `decline replyId=${r.id}`)
        if (!ok) return { ok: false, reason: 'send_failed' }
        const cur = load()
        save({ ...cur, offers: without(cur.offers, r.id) })
        return { ok: true, replyId: r.id }
      })
    },

    offers() {
      // 已经点过头的(有 myIntro)不再列 —— 那是「在等名片」,不是「等你回话」。
      return Object.entries(load().offers)
        .filter(([, o]) => !o.myIntro)
        .map(([replyId, o]) => ({ replyId, hint: o.hint, viaLabel: deps.peerLabel(o.viaChannel), at: o.at }))
        .sort((a, b) => b.at.localeCompare(a.at))
    },

    onInbound(channelRowId, env, _letterId) {
      if (env.kind !== 'intro') return false
      const p = parseIntroPayload(env)
      if (!p) { log(`收到一封读不懂的 intro channel=${channelRowId} — 丢`); return true }
      switch (p.stage) {
        case 'request': return onRequest(channelRowId, p)
        case 'forward': return onForward(channelRowId, p)
        case 'accept': return onAccept(channelRowId, p)
        case 'decline': return onDecline(channelRowId, p)
        case 'card': return onCard(channelRowId, p)
      }
    },
  }
}
