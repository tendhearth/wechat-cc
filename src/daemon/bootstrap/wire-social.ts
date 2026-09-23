import { randomBytes, randomUUID } from 'node:crypto'
import { makeJudge } from '../../core/social-judge'
import { makeVisit } from './wire-visit'
import { makeWish } from './wire-wish'
import { makeIntro } from './wire-intro'
import { makeJournal } from '../../core/journal-store'
import { safeSvg } from '../../lib/svg-sanitize'
import { rasterizeSvgDarwin } from '../sticker-artist'
import { join } from 'node:path'
import { makeChannelStore } from '../../core/penpal-channel-store'
import { makeLetterStore } from '../../core/penpal-letter-store'
import { makeCorrespondent } from '../../core/penpal-correspondent'
import { letterUrl } from '../../core/a2a-delegate'
import { gateOutbound } from '../../core/a2a-disclosure'
import { makeMailboxSender } from '../../core/mailbox-sender'
import { makeMailboxClient } from '../../core/mailbox-client'
import { loadMailboxIdentity } from '../../core/mailbox-crypto'
import { generateKeypair } from '../../core/penpal-crypto'
import { buildOwnCard, adoptPeerCard } from '../../core/pairing'
import { makeForwardBudget } from '../../core/forward-budget'
import { FORWARD_PER_SENDER, FORWARD_WINDOW_MS } from '../../core/intro'
import { makeMailboxLetterHandler } from './mailbox-letter-handler'
import { makeRoutePostLetter } from './postletter-route'
import type { A2AServerOpts } from '../../core/a2a-server'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { A2AClient } from '../../core/a2a-client'
import type { ProviderRegistry } from '../../core/provider-registry'
import type { ProviderId } from '../../core/conversation'
import type { AgentConfig } from '../../lib/agent-config'
import type { Db } from '../../lib/db'
import type { SendAssistantText } from './fallback-reply'
import type { BootstrapDeps } from './types'

export interface SocialDeps {
  log: BootstrapDeps['log']
  stateDir: string
  /** 发文件给某个 chat(明信片 PNG)。缺失 ⇒ 明信片只进背包不发微信。 */
  sendFile?: (chatId: string, path: string) => Promise<unknown>
  db: Db
  configuredAgent: AgentConfig
  /** Resolved ONCE by bootstrap/index.ts (resolveSelfAgentId) — spec §2's
   *  stable-unique slug, shared with wirePairing + pipeline-deps' delegate
   *  path so every outbound seam self-reports the identical agent_id.
   *  Replaces the old per-call `resolveSelfAgentId(configuredAgent,
   *  deps.stateDir)` here (never re-resolve; see wire-pairing.ts's header). */
  selfId: string
  registry: ProviderRegistry
  defaultProviderId: ProviderId
  /**
   * In-process Knowledge Kernel accessors (facts/search/store/embedQuery/
   * embedder), assembled once in bootstrap/index.ts and threaded straight
   * into `makeOwnerGrounding` (daemon/social/owner-grounding.ts) below —
   * replaces the retired grounded-judge.ts plugin-spawn path (SJ Task 3).
   * Undefined whenever `knowledge_enabled` is off; the judge then grounds
   * on topic text alone (see the BOOT log this produces).
   */
  knowledge?: import('../social/owner-grounding').GroundingKnowledge
  resolveOperatorChatId: () => string | null
  sendAssistantText: SendAssistantText | undefined
  a2aRegistry: A2ARegistry
  a2aClient: A2AClient
  /**
   * busy 登记处(`Bootstrap['holdBusy']`,bootstrap/index.ts 的 busyRegistry)。
   * 串门和答心愿都是**脱离用户会话**跑模型的后台活 —— 不登记的话空闲自动
   * 重启会在半程把 daemon 掐了。往下透给 makeVisit / makeWish。
   */
  holdBusy?: (label: string) => () => void
}

export interface SocialWiring {
  onLetter: A2AServerOpts['onLetter']
  /**
   * I1 — the own-channel-ONLY letter handler for the mailbox poller (Task 8).
   * MUST be used instead of `onLetter` when replaying a decrypted mailbox
   * envelope: a mailbox drop carries no verified bearer, so it must never be
   * able to make this daemon do anything on a channel that isn't its own.
   * Undefined whenever social wiring itself is inert, same gate as `onLetter`.
   */
  onMailboxLetter?: A2AServerOpts['onLetter']
  social?: {
    penpal: {
      sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string; letter_id?: string }>
      resendLetter(letterId: string): Promise<{ ok: boolean; error?: string; letter_id?: string }>
      channelStore: import('../../core/penpal-channel-store').ChannelStore
      letterStore: import('../../core/penpal-letter-store').LetterStore
      /** 串门(2026-09-03 实验):伙伴主动去一个开着的信道那头聊几句。 */
      startVisit: import('./wire-visit').Visit['startVisit']
      activeVisit: import('./wire-visit').Visit['activeVisit']
      provenChannels: import('./wire-visit').Visit['provenChannels']
    }
    /** 心愿 / 明信片(spec 2026-09-04-wish-postcard)。onInbound 不露出去 ——
     *  信封只从 correspondent 那一个口进来。 */
    wish: Omit<import('./wire-wish').WishService, 'onInbound'>
    /** 介绍(spec 2026-09-04-introduction)。onInbound 不露出去 —— 信封只从
     *  correspondent 那一个口进来。 */
    intro: Omit<import('./wire-intro').IntroService, 'onInbound'>
  }
}

export async function wireSocial(deps: SocialDeps): Promise<SocialWiring> {
  const {
    registry, configuredAgent, resolveOperatorChatId, sendAssistantText,
    a2aRegistry, a2aClient, selfId,
  } = deps

  // ── 社交接线 ────────────────────────────────────────────────────────────
  // Gated on BOTH social_enabled and social_disclosure_policy — absent
  // either, the feature stays fully inert: no /a2a/letter handler, no
  // correspondent, no 串门 / 心愿(它们的路由 503)。
  //
  // 只有一条入站口:/a2a/letter → correspondent 解封 → 按 kind 分发
  // (letter / visit / wish / postcard)。新交互 = 加一个 case。
  let socialOnLetter: A2AServerOpts['onLetter']
  let socialOnMailboxLetter: A2AServerOpts['onLetter']
  let socialPenpal: {
    sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string; letter_id?: string }>
    resendLetter(letterId: string): Promise<{ ok: boolean; error?: string; letter_id?: string }>
    channelStore: import('../../core/penpal-channel-store').ChannelStore
    letterStore: import('../../core/penpal-letter-store').LetterStore
    startVisit: import('./wire-visit').Visit['startVisit']
    activeVisit: import('./wire-visit').Visit['activeVisit']
    provenChannels: import('./wire-visit').Visit['provenChannels']
  } | undefined
  let socialWish: Omit<import('./wire-wish').WishService, 'onInbound'> | undefined
  let socialIntro: Omit<import('./wire-intro').IntroService, 'onInbound'> | undefined

  if (configuredAgent.social_enabled && configuredAgent.social_disclosure_policy) {
    const socialPolicy = configuredAgent.social_disclosure_policy
    const socialCheapEval = registry.getCheapEval()
    // 闸门的超时由**实际会跑的 provider** 说了算,不再是写死的 12s。
    // 2026-09-01:agy 单次 10.3–14.3s,12s 的常数把派心愿卡成了「时灵时不灵」。
    const socialGateTimeoutMs = registry.getCheapEvalBudgetMs()
    if (!socialCheapEval) {
      // Same degrade pattern as the openai provider block above: log and
      // skip rather than throw. No registered provider implements cheapEval
      // is exotic in practice (claude always registers one), but the seam
      // must degrade gracefully like every other optional wiring here.
      deps.log('BOOT', 'social: no cheapEval available from any registered provider — social_enabled is on but wiring is skipped (inert)')
    } else {
      // 说出来 —— 这个数字决定派心愿会不会莫名其妙报 checker_unavailable,
      // 以前它是个藏在常数里的 12s,查了半天才查出来。
      deps.log('BOOT', `social: 披露闸门超时 ${socialGateTimeoutMs}ms(按实际 cheapEval provider 的延迟预算)`)
      // spec §2 — one stable-unique slug per daemon (env > config > generated),
      // resolved ONCE by bootstrap/index.ts and threaded in as `deps.selfId`
      // (shared with wirePairing + pipeline-deps' delegate path — see
      // SocialDeps.selfId's doc comment). Legacy 'wechat-cc' preserved when
      // no mailbox_relays is configured.
      const SOCIAL_SELF_ID = selfId
      // Mailbox transport (sub-project B): the store-and-forward dispatch arm
      // alongside push (a2aClient). Constructed once and used by postLetter's
      // peer-mailbox branch (Task 11).
      const mailboxSender = makeMailboxSender({ client: makeMailboxClient() })

      // The judge's grounding seam (daemon/social/owner-grounding.ts, SJ
      // Tasks 1-3) — replaces the retired grounded-judge.ts plugin-spawn
      // path. `ground` reads the owner's derived Knowledge Kernel facts
      // in-process (no child session, no provider-specific adapter, no
      // plugin MCP tools) and hands the judge already-fetched text to
      // reason over; `runTurn` stays the registry's own cheapEval — the
      // judge never spawns anything of its own any more.
      const { makeOwnerGrounding } = await import('../social/owner-grounding')
      const ground = makeOwnerGrounding(deps.knowledge)
      const socialRunTurn = async (systemPrompt: string, userPrompt: string) => socialCheapEval(`${systemPrompt}\n\n${userPrompt}`)
      const socialJudge = makeJudge({ runTurn: socialRunTurn, ground, policy: socialPolicy })
      deps.log('BOOT', deps.knowledge?.facts
        ? 'social: in-process grounded judge (kernel facts + search, no spawn, provider-agnostic)'
        : 'social: judge reasons from topic only — knowledge not wired (kernel off?). Not plugin-grounded.')

      // A3 (anonymous pen-pal channel): the per-connection channel row — holds
      // this side's X25519 keypair + channel id, and the peer's crossed
      // PenpalHandle once mutual. Real identity NEVER crosses this daemon's
      // boundary; only these ephemeral handles do.
      const channelStore = makeChannelStore(deps.db)
      const letterStore = makeLetterStore(deps.db)
      // Task 11: a target carrying a `mailbox` (crossed at pairing) goes
      // sealed+dropped straight to the peer's own mailbox; a push-only target
      // (no mailbox) falls through to the HTTP /a2a/letter path unchanged.
      const postLetter = makeRoutePostLetter({
        mailboxSend: (inner, peer) => mailboxSender.send(inner, peer),
        pushSend: async (target, body) => {
          const hand = a2aRegistry.get(target.relayVia ?? target.agentId)
          if (!hand) return false
          // A url-less mailbox peer never reaches here in practice (mailbox
          // targets go via mailboxSend above), but guard anyway — a
          // malformed/partial mailbox record must fail closed, not throw.
          if (!hand.url) return false
          const r = await a2aClient.send({ url: letterUrl(hand.url), bearer: hand.outbound_api_key, body: { agent_id: SOCIAL_SELF_ID, ...body } })
          return r.ok
        },
        selfId: SOCIAL_SELF_ID,
      })
      // 串门(wire-visit.ts):两只伙伴之间的对话走同一条信道。先让它认领 ——
      // 是串门信就由它接着聊/收尾,**不**当成主人的来信 ping 主人。
      // sendLetter 经 correspondent,但 correspondent 又要 notifyInbound —— 用
      // 一个 late-bound 引用解开这个环。
      let visit: import('./wire-visit').Visit | undefined
      // 心愿 / 明信片同理:分发点先声明,构造在 correspondent 之后。
      let wish: import('./wire-wish').WishService | undefined
      // 介绍同理:分发点先声明,构造在 wish 之后(makeIntro 复用 correspondent
      // 和 peerLabel,和串门/心愿一样)。
      let intro: import('./wire-intro').IntroService | undefined
      // 信封分发点(架构重构 §2.1)—— correspondent 已解开信封,这里**只按 kind
      // 分发**。新交互 = 加一个 case,不是加一条路由。不认识的 kind 记日志
      // 忽略:新版本发的类型老版本不炸。
      // 「这条信道那头是谁」只有一个说法:注册表里认识就叫名字,不认识就说
      // 第几度。信件、心愿、明信片共用它 —— 同一个朋友在主人眼里不能一处是
      // 「老王的 bot」、另一处是「第 1 度的某人」。
      const peerLabel = (channelRowId: string): string => {
        const ch = channelStore.get(channelRowId)
        const name = ch?.peer_agent_id ? a2aRegistry.get(ch.peer_agent_id)?.name : undefined
        return name || (ch ? `第 ${ch.degree} 度的某人` : '某人')
      }
      const onInbound: import('../../core/penpal-correspondent').CorrespondentDeps['onInbound'] = ({ channelRowId, letterId, plaintext, env }) => {
        switch (env.kind) {
          case 'letter': {
            const op = resolveOperatorChatId()
            if (!op || !sendAssistantText) return
            void sendAssistantText(op, `📬 ${peerLabel(channelRowId)}给你写信了:${plaintext.slice(0, 40)}\n(回信 ${channelRowId} <你的话>)`)
            return
          }
          case 'visit':
            if (!visit?.onInbound(channelRowId, env, letterId)) deps.log('SOCIAL', `visit envelope rejected channel=${channelRowId}`)
            return
          case 'wish':
          case 'postcard':
            if (!wish?.onInbound(channelRowId, env, letterId)) deps.log('SOCIAL', `${env.kind} envelope rejected channel=${channelRowId}`)
            return
          case 'intro':
            if (!intro?.onInbound(channelRowId, env, letterId)) deps.log('SOCIAL', `intro envelope rejected channel=${channelRowId}`)
            return
          default:
            deps.log('SOCIAL', `unknown envelope kind=${env.kind} channel=${channelRowId} — ignored`)
        }
      }
      const correspondent = makeCorrespondent({ channelStore, letterStore, postLetter, onInbound })
      visit = makeVisit({
        stateDir: deps.stateDir,
        channelStore, letterStore,
        // 出门 / 回程都持 busy token(空闲重启不能掐在半句话中间)。
        holdBusy: deps.holdBusy,
        sendEnvelope: (c, e) => correspondent.sendEnvelope(c, e),
        // 串门要有性格,不是分类任务:strongEval 优先,没有再退到 cheapEval。
        // (typeof 守卫:好几处测试夹具的 registry 只有 cheapEval 那两个方法。)
        evalText: (typeof registry.getStrongEval === 'function' ? registry.getStrongEval(deps.defaultProviderId) : null) ?? socialCheapEval,
        myName: configuredAgent.bot_name?.trim() || '我',
        disclosurePolicy: socialPolicy,
        notifyOwner: (text) => { const op = resolveOperatorChatId(); if (op && sendAssistantText) void sendAssistantText(op, text) },
        // 见闻进背包。Journal 无内存态,这里另起一个实例读同一张表没问题。
        recordVisit: ({ text, peerLabel }) => {
          const op = resolveOperatorChatId()
          return op ? makeJournal(deps.db).recordVisit({ chatId: op, text, peerLabel }) : null
        },
        // 明信片:模型出 SVG → safeSvg → 存背包(桌面内联渲染)→ 栅格化发微信。
        // 栅格化只有 macOS(qlmanage);别的平台桌面端照样看得到,微信收不到图。
        postcard: {
          sanitize: (svg) => safeSvg(svg),
          attach: (rowId, svg) => makeJournal(deps.db).attachImage(rowId, svg),
          send: async (svg) => {
            const op = resolveOperatorChatId()
            if (!op || !deps.sendFile) return
            const png = await rasterizeSvgDarwin(svg, join(deps.stateDir, 'companion', 'postcards'))
            if (png) await deps.sendFile(op, png)
          },
        },
        log: deps.log,
      })
      // 心愿(wire-wish.ts):和串门共用这条信道 —— 问的那边把 kind='wish' 投出去,
      // 答的那边拿同一个判官(socialJudge)和同一道披露门(gateOutbound)决定回不回。
      wish = makeWish({
        stateDir: deps.stateDir,
        channelStore,
        // 答一条心愿要跑判官 + 闸门,同样持 busy token。
        holdBusy: deps.holdBusy,
        sendEnvelope: (c, e) => correspondent.sendEnvelope(c, e),
        // 闸门超时用 provider 自己的预算,别再写死 12s(见上面那条 BOOT 日志)。
        gate: (text) => gateOutbound(text, { policy: socialPolicy, cheapEval: socialCheapEval, timeoutMs: socialGateTimeoutMs }),
        // 判官只读话题(social-judge.ts 的 JudgeInput)—— 心愿没有 city,
        // 就只递 topic。
        judge: (topic) => socialJudge({ topic }),
        // 明信片进背包(journal kind='postcard')—— 和串门见闻同一张表。
        recordPostcard: ({ text, peerLabel }) => {
          const op = resolveOperatorChatId()
          return op ? makeJournal(deps.db).recordPostcard({ chatId: op, text, peerLabel }) : null
        },
        notifyOwner: (text) => { const op = resolveOperatorChatId(); if (op && sendAssistantText) void sendAssistantText(op, text) },
        // 认识的人就叫名字,不认识就说第几度 —— 主人得知道这话是谁回的。
        peerLabel,
        // 转问节流(sub-project C):一条信道 24 小时内最多转问 FORWARD_PER_SENDER
        // 次——防止任何一个配过对的人无限地借我的手去问别人。
        forwardBudget: makeForwardBudget({ perSender: FORWARD_PER_SENDER, windowMs: FORWARD_WINDOW_MS }),
        log: deps.log,
      })
      // 介绍(wire-intro.ts):和心愿/串门共用同一批底子 —— correspondent 发信、
      // peerLabel 叫人、holdBusy 登记后台活。名片用 core/pairing.ts 的
      // buildOwnCard/adoptPeerCard 现造(和配对码同一套,rowPrefix='intro'
      // 把信道行和配对码那条分开)。
      const myMailbox = loadMailboxIdentity(deps.stateDir)
      const cardDeps = {
        selfId: () => SOCIAL_SELF_ID,
        name: () => configuredAgent.bot_name?.trim() || 'wechat-cc',
        self: { mailbox_addr: myMailbox.addr, mailbox_enc_pub: myMailbox.enc_pub, relays: configuredAgent.mailbox_relays ?? [] },
      }
      // mailbox_relays 为空时名片的 relays 也是空 —— 对方的 isValidPairCard
      // 会拒绝这张名片,交叉不成。这种机器本来也配不了对(见 wire-pairing.ts
      // 的同款门槛),可接受,记一行日志留痕。
      if (!configuredAgent.mailbox_relays?.length) deps.log('BOOT', 'intro: mailbox_relays 未配置 — 名片的 relays 会是空,对方会拒绝交叉(配对本来也需要它)')
      const adoptDeps = { registry: a2aRegistry, channelStore, log: (m: string) => deps.log('INTRO', m) }
      intro = makeIntro({
        stateDir: deps.stateDir, channelStore, holdBusy: deps.holdBusy,
        sendEnvelope: (c, e) => correspondent.sendEnvelope(c, e),
        buildCard: (role, nonce, bearer, chan) => buildOwnCard(cardDeps, role, nonce, bearer, chan),
        adopt: (card, mine, myKey, nonce) => {
          const r = adoptPeerCard(adoptDeps, card, mine, myKey, nonce, 'intro')
          return r.ok ? { ok: true, channelOpened: r.channelOpened } : r
        },
        mintKey: () => randomBytes(24).toString('hex'),
        genChannel: () => { const kp = generateKeypair(); return { channelId: randomUUID(), pubkey: kp.publicKey, privkey: kp.privateKey } },
        notifyOwner: (text) => { const op = resolveOperatorChatId(); if (op && sendAssistantText) void sendAssistantText(op, text) },
        peerLabel, log: deps.log,
      })
      socialIntro = { request: (r) => intro!.request(r), accept: (r) => intro!.accept(r), decline: (r) => intro!.decline(r), offers: () => intro!.offers() }
      // 只认自己的信道。别人的 channel_id 曾经会走 letterRelay 的 2 跳转发
      // (介绍人那条腿),那条路和 seek/echo/reveal 一起退役了 —— 现在认不出
      // 来就是丢,返回值和当年 routeLetter 找不到中继行时一模一样。
      socialOnLetter = async (ev) => {
        const mine = channelStore.getByMyChannelId(ev.channel_id)
        if (mine) return correspondent.receiveLetter(ev)
        deps.log('SOCIAL', `letter for unknown channel=${ev.channel_id} from=${ev.agent_id} — dropped`)
        return { ok: false, error: 'unknown_channel' }
      }
      // I1 (Task 8) — the mailbox-poller-safe variant: own-channel ONLY. A
      // mailbox drop carries no verified bearer (unlike the HTTP /a2a/letter
      // route, which at least authenticates the caller as a registered peer
      // before onLetter runs at all).
      socialOnMailboxLetter = makeMailboxLetterHandler({
        getByMyChannelId: (c) => channelStore.getByMyChannelId(c),
        receiveLetter: (ev) => correspondent.receiveLetter(ev),
      })
      socialPenpal = { sendLetter: (channel, text) => correspondent.sendLetter(channel, text), resendLetter: (id) => correspondent.resendLetter(id), channelStore, letterStore, startVisit: (c) => visit!.startVisit(c), activeVisit: () => visit!.activeVisit(), provenChannels: () => visit!.provenChannels() }
      socialWish = { propose: (t) => wish!.propose(t), send: (id) => wish!.send(id), cancel: (id) => wish!.cancel(id), list: () => wish!.list(), resolveRef: (r, a) => wish!.resolveRef(r, a) }
    }
  }

  return {
    onLetter: socialOnLetter,
    onMailboxLetter: socialOnMailboxLetter,
    ...(socialPenpal && socialWish && socialIntro ? { social: { penpal: socialPenpal, wish: socialWish, intro: socialIntro } } : {}),
  }
}
