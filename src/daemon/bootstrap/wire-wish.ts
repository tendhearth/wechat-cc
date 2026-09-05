/**
 * wire-wish.ts — 「心愿」的 daemon 接线。协议与状态机在 core/wish.ts。
 *
 * spec 2026-09-04-wish-postcard §1.2/§1.3。心愿是伙伴替主人去问**认识的人**:
 *
 *   主人说想问什么 → 披露门(gateOutbound)先删掉不该出门的 → 落草稿
 *   → 派:一个 kind='wish' 的信封投给每一条开着的信道(store-and-forward,
 *     投出去就算,对方什么时候看是对方的事)
 *   → 对面的伙伴拿判官(makeJudge)问自己主人能不能帮:不能就静默,能就把
 *     那句话再过一遍**自己**的披露门,封成 kind='postcard' 原路回来
 *   → 回来的明信片进「带回来的」(journal kind='postcard')+ 跟主人说一句。
 *
 * 两处不变量:
 *   - **两边的主人各只被打扰一句**。答的那边:「有人来打听 X,我回了 Y」;
 *     问的那边:「Z 回了你的心愿」。中间的判官、闸门、重投,主人都不该看见。
 *   - **所有失败只记日志**。判官挂了、闸门超时了、信道断了 —— 一次没问成
 *     不该在任何地方冒错给主人,和串门同一个姿势。
 *
 * 状态每次从 wishes.json 读、纯函数算、写回(量小,和 neighbors.json 一样,
 * 不缓存)。收件幂等靠 wishes-seen.json:信箱是 at-least-once,同一条心愿到
 * 两次,判官不能跑两次、主人不能被打扰两次。
 *
 * 介绍(spec 2026-09-04-introduction §1/§2):判「不能」的那个伙伴,如果自己
 * 还开着别的信道(认识别人),就替主人把这条心愿转给自己的朋友(hop 1 →
 * hop 2,受 forwardBudget 节流,缺省不转)。朋友答上来的明信片(仍是 hop 1)
 * 原路转回介绍人,介绍人再包一层 hop 2 + replyId 转回最初问的人 —— **介绍
 * 人自己既不进日志也不打扰主人,只是搭了一次桥**。最初问的人收到 hop 2
 * 的明信片,才落 `postcards` 引用(hop 1 的直接回信不留 —— 那些人本来就
 * 认识),主人那句话尾巴上加一句「想认识就回」。介绍人的转问台账(谁转给了
 * 谁、谁的 replyId 对应哪条链路)记在 introductions.json(intro-memory.ts),
 * 每次读写前后都过一遍 pruneIntroIndex —— 和 wishes.json 一样不缓存。
 */
import {
  newWishId, draftWish, sendWish, cancelWish, acceptPostcard, resolveWishRef, recentWishes,
  effectiveStatus, wishEnvelope, forwardedWishEnvelope, parseWishPayload, postcardEnvelope, parsePostcardPayload, seenKey,
  recordPostcardRef, WISH_TTL_MS, type WishRecord, type WishStatus, type WishPayload, type PostcardRef, type Hop,
} from '../../core/wish'
import { isCheckerFailure } from '../../core/a2a-disclosure'
import { readWishes, writeWishes, markWishSeen } from '../companion/wish-memory'
import { readIntroIndex, writeIntroIndex } from '../companion/intro-memory'
import { newReplyId as coreNewReplyId, pruneIntroIndex, FORWARD_ONLY_WHEN_UNABLE, HINT_MAX, type IntroIndex } from '../../core/intro'
import type { Envelope } from '../../core/envelope'
import { primaryChannels, type ChannelStore } from '../../core/penpal-channel-store'

export interface WishDeps {
  stateDir: string
  channelStore: Pick<ChannelStore, 'get' | 'list'>
  /** 发一个信封到信道(correspondent.sendEnvelope)。 */
  sendEnvelope(channelRowId: string, env: Envelope): Promise<{ ok: boolean; error?: string }>
  /** 披露门:返回 ok/redacted/violations(a2a-disclosure.gateOutbound 的裹法由调用方给)。 */
  gate(text: string): Promise<{ ok: boolean; redacted: string; violations: string[] }>
  /** 判官:我主人能不能帮。 */
  judge(topic: string): Promise<{ match: 'yes' | 'no'; blurb?: string }>
  /** 见闻进日志(seeker 侧)。 */
  recordPostcard(a: { text: string; peerLabel: string }): string | null
  notifyOwner(text: string): void
  /**
   * busy 登记处(Bootstrap['holdBusy'])。答一条心愿要跑判官 + 披露门,是
   * **脱离用户会话**的后台模型活 —— 不登记的话空闲自动重启会在判官跑到一半
   * 时把 daemon 掐了,对面等到的是永远不来的明信片。没接 = 不登记(测试/
   * 老调用方),不是错误。见 bootstrap/delegate.ts 的 'a2a-delegate'。
   */
  holdBusy?: (label: string) => () => void
  /** 怎么称呼这条信道那头的人(注册表名字 / 第 N 度的某人)。 */
  peerLabel(channelRowId: string): string
  /**
   * 转问节流(forward-budget.ts 的 makeForwardBudget)。缺省 = 永不转问 ——
   * 没接这个依赖的老调用方(现有两个 side() 测试)行为不变:判「不能」就
   * 是「我说不知道」,不会替主人去问别人。
   */
  forwardBudget?: { withinBudget(senderId: string): boolean }
  now?: () => number
  newId?: () => string
  /** 介绍人给「谁问过谁」发一个 replyId。缺省用 core/intro.ts 的 newReplyId。 */
  newReplyId?: () => string
  log(tag: string, line: string): void
}

export interface WishService {
  propose(text: string): Promise<
    | { ok: true; id: string; preview: string }
    | { ok: false; error: 'gate_failed' | 'checker_unavailable' | 'empty'; violations?: string[] }
  >
  send(id: string): Promise<{ ok: true; sentTo: number } | { ok: false; reason: 'not_found' | 'not_draft' | 'too_many_open' | 'no_channels' }>
  cancel(id: string): { ok: true; status: 'closed' | 'cancelled' } | { ok: false; reason: 'not_found' | 'already_done' }
  list(): Array<WishRecord & { effective: WishStatus | 'expired'; postcards?: Array<PostcardRef & { viaLabel: string }> }>
  resolveRef(ref: string, among: readonly WishStatus[]): ReturnType<typeof resolveWishRef>
  /** correspondent 分发进来的 kind='wish' / 'postcard'。不是这两种 → false。 */
  onInbound(channelRowId: string, env: Envelope, letterId: string): boolean
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function makeWish(deps: WishDeps): WishService {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? newWishId
  const newReplyId = deps.newReplyId ?? coreNewReplyId
  const nowIso = (): string => new Date(now()).toISOString()
  const log = (line: string): void => deps.log('WISH', line)
  /** 登记一段后台活。登记失败、放开失败都只当没登记 —— busy 记账绝不能
   *  把异常冒进它包着的流程里(和 delegate.ts 同一个姿势)。 */
  const holdBusy = (label: string): (() => void) => {
    let release: (() => void) | undefined
    try { release = deps.holdBusy?.(label) } catch { release = undefined }
    return () => { try { release?.() } catch { /* 放开失败:下一次重启窗口再说 */ } }
  }

  // ── 答的那边:有人来打听 ────────────────────────────────────────────────

  /**
   * 转问:把一条自己答不上的心愿转给自己开着的其他信道(排除来源信道)。
   * 已经转过(forwards[id] 存在)、预算用完、没有别的信道 —— 都只返回 0,
   * 不抛不炸;成功转给几个就记几个,写回前照例 pruneIntroIndex。
   */
  const forwardWish = async (channelRowId: string, p: WishPayload): Promise<number> => {
    const idx = readIntroIndex(deps.stateDir)
    if (idx.forwards[p.id]) return 0
    if (!deps.forwardBudget?.withinBudget(channelRowId)) {
      log(`wish=${p.id} 转问预算用完(来自 ${channelRowId})— 不转`)
      return 0
    }
    const targets = primaryChannels(deps.channelStore.list()).filter(c => c.id !== channelRowId)
    if (targets.length === 0) return 0
    const to: string[] = []
    for (const c of targets) {
      try {
        const r = await deps.sendEnvelope(c.id, forwardedWishEnvelope(p))
        if (r.ok) to.push(c.id)
        else log(`wish=${p.id} 转问 ${c.id} 失败: ${r.error ?? 'send_failed'}`)
      } catch (err) { log(`wish=${p.id} 转问 ${c.id} 抛错: ${errText(err)}`) }
    }
    if (to.length === 0) return 0
    const merged: IntroIndex = { ...idx, forwards: { ...idx.forwards, [p.id]: { from: channelRowId, to, preview: p.text.slice(0, HINT_MAX), at: nowIso() } } }
    const { index } = pruneIntroIndex(merged, now())
    writeIntroIndex(deps.stateDir, index)
    log(`wish=${p.id} 转问给了 ${to.length} 个朋友: ${to.join(',')}`)
    return to.length
  }

  /**
   * 判「不能」/ blurb 空 / 闸门违规之后的落点:能转就转(hop 1 且开了
   * forwardBudget 依赖),转成了几个就说「帮着问了 N 个朋友」,转不成 —
   * 老规矩「我说不知道」。hop 2(已经是转问来的)不再往下转,免得链子越拉
   * 越长。
   */
  const sayCantHelp = async (channelRowId: string, id: string, text: string, expiresAt: string, hop: Hop, asked: string): Promise<void> => {
    if (hop === 1 && FORWARD_ONLY_WHEN_UNABLE && deps.forwardBudget) {
      const n = await forwardWish(channelRowId, { id, text, expiresAt, hop })
      if (n > 0) { deps.notifyOwner(`${asked},我答不上,帮着问了 ${n} 个朋友`); return }
    }
    deps.notifyOwner(`${asked},我说不知道`)
  }

  /**
   * 判官 + 我自己的披露门。判「不能」、blurb 空、闸门不放行 —— 对外一律静默
   * (答不上来不必让对面知道我拒了什么),对内跟主人说一句「我说不知道」
   * (或者转问成了,说「帮着问了 N 个朋友」)。
   */
  const answerWish = async (channelRowId: string, id: string, text: string, expiresAt: string, hop: Hop): Promise<void> => {
    const release = holdBusy('wish-answer')
    try { await answerWishInner(channelRowId, id, text, expiresAt, hop) } finally { release() }
  }

  const answerWishInner = async (channelRowId: string, id: string, text: string, expiresAt: string, hop: Hop): Promise<void> => {
    const label = deps.peerLabel(channelRowId)
    const asked = `🙋 ${label} 的伙伴来打听「${text}」`
    const verdict = await deps.judge(text)
    const blurb = verdict.match === 'yes' ? (verdict.blurb ?? '').trim() : ''
    if (!blurb) {
      if (verdict.match === 'yes') log(`wish=${id} 判官说能帮但没给话 — 按不知道处理`)
      await sayCantHelp(channelRowId, id, text, expiresAt, hop, asked)
      return
    }
    const gated = await deps.gate(blurb)
    // 闸门自己没跑成(超时 / provider 挂了 / 回话读不懂)≠ 主人的话违规。
    // 前者是「我想回但没回成」,后者才是「我决定不说」—— 主人听到的必须
    // 是两句不同的话,不然一次模型故障会被记成一次「我说不知道」。
    if (!gated.ok && isCheckerFailure(gated.violations)) {
      log(`wish=${id} 回话时披露门不可用(${gated.violations.join(',')}) — 没回`)
      deps.notifyOwner(`${asked},我想回但没寄出去(模型没响应)`)
      return
    }
    if (!gated.ok || gated.redacted.trim() === '') {
      log(`wish=${id} 回话没过披露门(${gated.violations.join(',') || 'empty_after_redaction'}) — 按不知道处理`)
      await sayCantHelp(channelRowId, id, text, expiresAt, hop, asked)
      return
    }
    const reply = gated.redacted.trim()
    // 寄不出去也要跟主人说 —— 他已经知道「有人来打听」了,再不说一句,这件事
    // 在他那边就永远停在半空中(日志只有我看得见)。
    let sent: { ok: boolean; error?: string }
    try { sent = await deps.sendEnvelope(channelRowId, postcardEnvelope(id, reply)) }
    catch (err) { sent = { ok: false, error: errText(err) } }
    if (!sent.ok) {
      log(`wish=${id} 明信片没寄出去: ${sent.error ?? 'send_failed'}`)
      deps.notifyOwner(`${asked},我想回但没寄出去`)
      return
    }
    deps.notifyOwner(`${asked},我回了:${reply}`)
    log(`wish=${id} 回了一张明信片 → ${channelRowId}`)
  }

  /** 收到一条心愿。是我们的 kind 就认领(返回 true),坏的/过期的/重复的只记日志。 */
  const handleWish = (channelRowId: string, env: Envelope): boolean => {
    const p = parseWishPayload(env)
    if (!p) { log(`收到一条读不懂的心愿 channel=${channelRowId} — 丢`); return true }
    // 有效期是**对方给的数**,不是我们算的:一条 expiresAt='3000-01-01' 的心愿
    // 会比 wishes-seen 的 14 天幂等窗口活得还久 —— 窗口一过,同一条心愿再投一次
    // 就会重新惊动判官和主人。按我们自己的 7 天上限夹一刀,超出的部分不认。
    const cap = now() + WISH_TTL_MS
    const peerExpiry = Date.parse(p.expiresAt)
    const expiresAtMs = Math.min(peerExpiry, cap)
    if (peerExpiry > cap) log(`wish=${p.id} 对方给的有效期 ${p.expiresAt} 超过 7 天上限 — 按 ${new Date(cap).toISOString()} 算`)
    if (expiresAtMs < now()) { log(`wish=${p.id} 已过期(${p.expiresAt}) — 丢`); return true }
    if (!markWishSeen(deps.stateDir, seenKey(p.id, channelRowId), nowIso())) {
      log(`wish=${p.id} 这条信道上已经处理过 — 丢(信箱 at-least-once)`)
      return true
    }
    // 判官 + 闸门 + 回信都慢,onInbound 必须同步返回:分发点不能被一次模型调用堵住。
    void answerWish(channelRowId, p.id, p.text, new Date(expiresAtMs).toISOString(), p.hop)
      .catch(err => log(`wish=${p.id} 回不上来(没打扰主人): ${errText(err)}`))
    return true
  }

  /** 收到一张明信片。这一段是同步的 —— 没有模型调用,只有读写和两句话。 */
  const handlePostcard = (channelRowId: string, env: Envelope): boolean => {
    const p = parsePostcardPayload(env)
    if (!p) { log(`收到一张读不懂的明信片 channel=${channelRowId} — 丢`); return true }

    // 介绍人中继:这张明信片(hop 1,朋友的原话)是我转问出去的那条心愿的
    // 回音 —— 原路转回最初问的人,包一层 hop 2 + replyId,自己**既不进
    // journal 也不打扰主人**(我只是搭了一次桥,不是当事人)。发不出去也
    // 只记日志:replyId 已经落在 replies 里,主人回来「认识」时能查到,
    // 不能因为这一次转发失败就把它悄悄抹掉。
    const idx = readIntroIndex(deps.stateDir)
    const fwd = idx.forwards[p.wishId]
    if (fwd && fwd.to.includes(channelRowId) && p.hop === 1) {
      if (!markWishSeen(deps.stateDir, seenKey(`rl:${p.wishId}`, channelRowId), nowIso())) {
        log(`postcard wish=${p.wishId} 这条中继链路上已经转过 — 丢`)
        return true
      }
      const replyId = newReplyId()
      const merged: IntroIndex = { ...idx, replies: { ...idx.replies, [replyId]: { wishId: p.wishId, fromChannel: channelRowId, at: nowIso() } } }
      const { index } = pruneIntroIndex(merged, now())
      writeIntroIndex(deps.stateDir, index)
      const release = holdBusy('wish-relay')
      void (async () => {
        try {
          const sent = await deps.sendEnvelope(fwd.from, postcardEnvelope(p.wishId, p.text, { hop: 2, replyId }))
          if (!sent.ok) log(`wish=${p.wishId} 中继回 ${fwd.from} 没寄出去: ${sent.error ?? 'send_failed'}`)
          else log(`wish=${p.wishId} 中继回去了 → ${fwd.from} replyId=${replyId}`)
        } catch (err) { log(`wish=${p.wishId} 中继回 ${fwd.from} 抛错: ${errText(err)}`) }
      })().finally(release)
      return true
    }

    // 先看认不认这张明信片,**认了才记幂等键**。反过来的话,一张因为竞态
    // (心愿还没落盘)被判成 unknown 的明信片会把键占掉 —— 对面重投的那一次
    // 就被当成「已经收过」永远丢掉了。这里丢的只是这一次投递,不是这张片。
    const r = acceptPostcard(readWishes(deps.stateDir), p.wishId, now())
    if (!r.ok) { log(`postcard wish=${p.wishId} ${r.reason} — 丢`); return true }
    // 明信片的幂等键和心愿分开:同一个 id 在既发又收的那一边会撞车。
    if (!markWishSeen(deps.stateDir, seenKey(`pc:${p.wishId}`, channelRowId), nowIso())) {
      log(`postcard wish=${p.wishId} 这条信道上已经收过 — 丢`)
      return true
    }
    // hop 2 = 介绍人转回来的:留一条引用(将来「认识」要用),称呼改成
    // 「A 的朋友」,主人那句尾巴加一句怎么认识。hop 1 的直接回信不留引用
    // —— 那些人本来就认识,没有「引荐」这回事。
    const isRelayed = p.hop === 2
    const label = isRelayed ? `${deps.peerLabel(channelRowId)} 的朋友` : deps.peerLabel(channelRowId)
    const list = isRelayed
      ? recordPostcardRef(r.list, p.wishId, { replyId: p.replyId!, via: channelRowId, at: nowIso(), preview: p.text.slice(0, 40) })
      : r.list
    writeWishes(deps.stateDir, list)
    try { deps.recordPostcard({ text: p.text, peerLabel: label }) }
    catch (err) { log(`明信片入库失败(还是会跟主人说): ${errText(err)}`) }
    const tail = isRelayed ? `（想认识就回「认识 ${p.replyId!.slice(0, 6)}」）` : ''
    deps.notifyOwner(`📮 ${label} 回了你的心愿「${r.wish.redacted.slice(0, 20)}」:${p.text}${tail}`)
    log(`postcard wish=${p.wishId} 收下了 replies=${r.wish.replies}`)
    return true
  }

  return {
    async propose(text) {
      const body = text.trim()
      if (body === '') return { ok: false, error: 'empty' }
      let gated: { ok: boolean; redacted: string; violations: string[] }
      try { gated = await deps.gate(body) }
      catch (err) { log(`披露门不可用: ${errText(err)}`); return { ok: false, error: 'checker_unavailable' } }
      // 闸门**不抛**:超时和 provider 故障是以 violations 的形式返回的
      // (checker_timeout / checker_error: … / checker_unparseable)。只看 ok
      // 的话,主人会看到「这句里有不能说的:checker_timeout」—— 把一次模型
      // 抽风说成他的话有问题,还把草稿吞了。
      if (!gated.ok && isCheckerFailure(gated.violations)) {
        log(`披露门不可用(${gated.violations.join(',')})`)
        return { ok: false, error: 'checker_unavailable' }
      }
      if (!gated.ok) return { ok: false, error: 'gate_failed', violations: gated.violations }
      const redacted = gated.redacted.trim()
      if (redacted === '') return { ok: false, error: 'gate_failed', violations: gated.violations }
      const id = newId()
      writeWishes(deps.stateDir, draftWish(readWishes(deps.stateDir), { id, text: body, redacted, nowIso: nowIso() }))
      return { ok: true, id, preview: redacted }
    },

    async send(id) {
      const iso = nowIso()
      // 先算一遍状态迁移(草稿在不在、够不够额度)。算不过就直接回,一个字
      // 都不写;算得过就先落盘再广播(下面那段注释说的是为什么)。
      const pre = sendWish(readWishes(deps.stateDir), id, iso, 0)
      if (!pre.ok) return { ok: false, reason: pre.reason }
      // 一个对方只投一次:重新配对会留下同一个 peer_agent_id 的旧 open 行,
      // 挨条投等于把同一个人的主人打扰两遍。
      const targets = primaryChannels(deps.channelStore.list())
      if (targets.length === 0) return { ok: false, reason: 'no_channels' }   // 草稿留着,有信道了再派
      // **先落 open,再广播**。第一个对端可能在 sendEnvelope 还没返回时就把
      // 明信片原路送回来了(同一进程里的两只伙伴就是这样),那时候心愿要是
      // 还停在 draft,acceptPostcard 会以 unknown 把它丢掉 —— 答得越快越收不到。
      writeWishes(deps.stateDir, pre.list)
      const env = wishEnvelope(pre.wish)
      let sentTo = 0
      for (const c of targets) {
        try {
          const r = await deps.sendEnvelope(c.id, env)
          if (r.ok) sentTo += 1
          else log(`wish=${id} 投 ${c.id} 失败: ${r.error ?? 'send_failed'}`)
        } catch (err) { log(`wish=${id} 投 ${c.id} 抛错: ${errText(err)}`) }
      }
      // 只改 sentTo 一列,而且是在**重新读过**的表上改:投递是 await,期间
      // 回来的明信片已经把 replies 写进过这张表,整表覆盖会把它抹掉。
      const after = readWishes(deps.stateDir)
      if (after.some(w => w.id === id)) {
        writeWishes(deps.stateDir, after.map(w => (w.id === id ? { ...w, sentTo } : w)))
      }
      log(`wish=${id} 派出去了 sentTo=${sentTo}/${targets.length}`)
      return { ok: true, sentTo }
    },

    cancel(id) {
      const r = cancelWish(readWishes(deps.stateDir), id)
      if (!r.ok) return r
      writeWishes(deps.stateDir, r.list)
      return { ok: true, status: r.wish.status as 'closed' | 'cancelled' }
    },

    list() {
      const t = now()
      return recentWishes(readWishes(deps.stateDir), t).map(w => {
        const { postcards, ...rest } = w
        const withEffective = { ...rest, effective: effectiveStatus(w, t) }
        return postcards
          ? { ...withEffective, postcards: postcards.map(r => ({ ...r, viaLabel: deps.peerLabel(r.via) })) }
          : withEffective
      })
    },

    resolveRef(ref, among) {
      return resolveWishRef(readWishes(deps.stateDir), ref, among)
    },

    onInbound(channelRowId, env, _letterId) {
      if (env.kind === 'wish') return handleWish(channelRowId, env)
      if (env.kind === 'postcard') return handlePostcard(channelRowId, env)
      return false
    },
  }
}
