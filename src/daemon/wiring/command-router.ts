/**
 * command-router.ts — admin control-command handling, extracted from the
 * `dispatch` closure that used to live inline in pipeline-deps.ts (2026-08-26
 * 架构审查:逻辑不该藏在接线文件里).
 *
 * Responsibility: parse an owner/admin WeChat message as a deterministic
 * control command (串门 / 回信 / 配对 / 派 / 取消 / 允许-拒绝-邀请码-待批准)
 * and, if it matches, handle it and report `true`. Anything that isn't a command —
 * or comes from a non-admin, or from an install whose gate isn't satisfied —
 * returns `false`, and the caller falls through to a normal agent turn.
 *
 * The router renders EVERY outcome itself (success + all failure reasons);
 * none of these commands go through the engine's async `notify`. Each block
 * is gated on its optional `boot.X` wire, so an unconfigured feature is inert
 * (the message falls through) exactly as before. Behavior is byte-for-byte
 * the pre-extraction closure — only the dependency edges are now explicit.
 */
import { randomBytes } from 'node:crypto'
import type { InboundMsg } from '../../domain/prompt-format'
import { parseLetterCommand, parseVisitCommand, parseSeekCommand, parseIntroCommand, type WishService, type IntroService } from '../../features/social'
import { parsePairCommand } from '../../domain/pair-command'
import { parseGuestCommand } from '../../domain/guest-command'
import { socialUnavailableLine, type SocialState } from '../social-state'
import { previewText } from '../inbound/mw-access'
import type { WechatCommand } from '../commands/registry'
import { GUEST_REQUEST_TTL_MS } from '../guest-requests'
import type { GuestRequestStore } from '../guest-requests'
import type { PairingEngine } from '../../app/pairing'

export interface CommandRouterDeps {
  isAdmin: (chatId: string) => boolean
  loadAccess: () => { admins?: string[] }
  appendAllowFrom: (chatId: string) => void
  /** CC-voice outbound to the owner's own chat. Absent ⇒ outcomes are silent
   *  (same optional posture as the pre-extraction closure). */
  sendAssistantText?: (chatId: string, text: string) => unknown
  /** 串门 / 派 / 取消 — present only when social is wired; undefined ⇒ those
   *  blocks inert (the message falls through to a normal turn). */
  social?: {
    wish: Pick<WishService, 'send' | 'cancel' | 'resolveRef'>
    penpal: { startVisit(channel?: string): Promise<{ ok: true; id: string; channel: string } | { ok: false; reason: string }> }
    /** 「认识 / 同意 / 不了」(spec 2026-09-04-introduction) — present only
     *  when social is wired; undefined ⇒ inert (message falls through). */
    intro: Pick<IntroService, 'request' | 'accept' | 'decline'>
  }
  /** 回信 — present only when the pen-pal channel is wired. */
  penpal?: { sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string }> }
  /**
   * 社交没接上时它现在是关着还是坏了(第三批 3b 第 3 步 3-2)。有它 ⇒ 主人发了一句社交命令(串门 / 派 / 认识 / 回信)
   * 而社交不在,**明说**(关着:去设置里打开;坏了:没起来、去哪看原因),不再悄悄落成一轮普通对话。
   * 只在那句话确实是社交命令时才调(probe 每条消息都过,读配置要省着)。缺省 ⇒ 老行为。
   */
  socialState?: () => SocialState
  /** 配对 — present only when mailbox_relays is configured. */
  pairing?: PairingEngine
  /** Guest path (允许/拒绝/邀请码/待批准) — always constructed, gated by admins-list. */
  guestRequests: Pick<GuestRequestStore, 'resolve' | 'listPending' | 'createInvite'>
  /** Capture a first-ever guest's routing state before the welcome send. */
  hydrateRoute: (chatId: string, accountId: string, contextToken: string) => void
  /** Direct WeChat send (guest welcome, which needs the raw transport). */
  sendMessage: (chatId: string, text: string) => Promise<{ error?: string }>
  /** Re-fire the guest's original message through the FULL inbound pipeline. */
  redispatch: (run: { msg: InboundMsg; receivedAtMs: number; requestId: string; redispatch: true }) => Promise<void>
  log: (tag: string, line: string) => void
  now?: () => number
}

export interface CommandRouter {
  /** 只读:这条消息是不是我会处理的控制命令(与 tryHandle 的闸门逐条一致,不发消息、不改状态)。重构第二批步 2。 */
  probe(msg: InboundMsg): boolean
  /** True iff the message was a control command this router handled. */
  tryHandle(msg: InboundMsg): Promise<boolean>
}

/**
 * 控制命令,一条一行(第三批 3d:微信命令一种写法)。以前这里是一个大入口(probe / tryHandle 里串着七段);
 * 现在每条命令在命令表里是自己的一行,id 是 `control.<名字>`,group 都是 'control'(trace / consumedBy 读的不变)。
 * 每行的 probe 就是它 handle 里那道闸的只读版,handle 是原来那一段原样搬过来的。**行的顺序就是原来那七段的顺序。**
 */
export function makeControlCommands(deps: CommandRouterDeps): WechatCommand[] {
  const now = deps.now ?? (() => Date.now())
  const say = (chatId: string, text: string) => { void deps.sendAssistantText?.(chatId, text) }

  /** 是社交命令,而社交此刻不在 ⇒ 关着 / 坏了 / 刚打开;否则 null(包括不是社交命令、社交好好的、没接 socialState)。 */
  const socialAbsentFor = (t: string): Exclude<SocialState, 'ok'> | null => {
    if ((deps.social && deps.penpal) || !deps.socialState) return null
    // 「同意 <ref>」除外:「同意」也是权限卡的放行词(pending-permissions 的 ALLOW_WORDS),码是两位数(「同意 07」);
    // 社交不在时根本不会有待回的介绍,这句只可能是在批权限,别回它「社交关着」
    const intro = parseIntroCommand(t)
    const isSocialCmd = (!deps.social && (parseVisitCommand(t) || parseSeekCommand(t) || (intro && intro.kind !== 'accept')))
      || (!deps.penpal && parseLetterCommand(t))
    if (!isSocialCmd) return null
    const s = deps.socialState()
    return s === 'ok' ? null : s
  }
  const row = (name: string, probe: (m: InboundMsg) => boolean, handle: (msg: InboundMsg) => Promise<boolean>, extra: Pick<WechatCommand, 'ownsSlash'> = {}): WechatCommand =>
    ({ id: `control.${name}`, group: 'control', probe, handle, ...extra })
  // /visit 是串门的斜杠写法。认它的行要排在 mode 的兜底(「不认识 /xx」)之前 —— 社交不在时也一样,
  // 所以 social-off 那行也认 /visit,不然社交关着时 /visit 会被兜底说成「不认识」(e2e 路由快照抓到的)
  const ownsVisitSlash = (m: InboundMsg): boolean => /^\s*\/visit\b/i.test(m.text ?? '')

  return [
    // 社交命令,但社交不在:明说,不落成普通对话(关着 ≠ 坏了,两句话不一样)
    row('social-off', (m) => deps.isAdmin(m.chatId) && !!socialAbsentFor(m.text), async (msg) => {
      const absent = socialAbsentFor(msg.text)
      if (!absent) return false
      say(msg.chatId, socialUnavailableLine(absent))
      return true
    }, { ownsSlash: ownsVisitSlash }),
    row('visit', (m) => deps.isAdmin(m.chatId) && !!deps.social && !!parseVisitCommand(m.text), async (msg) => {
      // 串门(2026-09-03 实验)—— 主人说「串门」,伙伴挑一个开着的笔友信道过去
      // 聊几句,回来讲给主人听。见 core/visit.ts 顶部的 WHY。
      if (deps.social && deps.isAdmin(msg.chatId)) {
        const v = parseVisitCommand(msg.text)
        if (v) {
          say(msg.chatId, '出门了,聊完回来跟你说。')
          const r = await deps.social.penpal.startVisit(v.channel)
          if (!r.ok) {
            say(msg.chatId, r.reason === 'unknown_channel'
              ? '没找到这一家。说「串门」我自己挑,或者「串门 邻居」去邻居家。'
              : `没出得了门:${r.reason}`)
          }
          return true
        }
      }
      return false
    }, { ownsSlash: ownsVisitSlash }),
    row('letter', (m) => deps.isAdmin(m.chatId) && !!deps.penpal && !!parseLetterCommand(m.text), async (msg) => {
      // Pen-pal outbound reply (Task 10) — the owner's "回信 <channel>
      // <text>" WeChat reply sends a letter on that open channel instead
      // of dispatching a normal agent turn. Guarded on boot.penpal being
      // wired (Task 11); until then this block is inert and every
      // message — including a well-formed "回信" — falls through to a
      // normal turn, same as boot.social above.
      if (deps.penpal && deps.isAdmin(msg.chatId)) {
        const letterCmd = parseLetterCommand(msg.text)
        if (letterCmd) {
          const r = await deps.penpal.sendLetter(letterCmd.channel, letterCmd.text)
          if (!r.ok) say(msg.chatId, '没找到这条笔友通道 / 发送失败。')
          return true
        }
      }
      return false
    }),
    row('pair', (m) => deps.isAdmin(m.chatId) && !!deps.pairing && !!parsePairCommand(m.text), async (msg) => {
      // 配对 (spec §7) — admin-gated, deterministic parse, mirrors 串门/回信.
      // Inert (falls through to a normal turn) until boot.pairing is wired
      // (Task 6, i.e. mailbox_relays configured). start()/accept() are
      // SYNC calls the caller is waiting on — this seam renders EVERY
      // outcome itself (success + all failure reasons). boot.pairing's
      // own `notify` dep is reserved for the initiator's ASYNC poller
      // (card found later / TTL expiry) — see pairing.ts's notify doc
      // comment; it does NOT fire for anything start()/accept() resolve
      // synchronously, so there is no double-message here.
      if (deps.pairing && deps.isAdmin(msg.chatId)) {
        const pair = parsePairCommand(msg.text)
        if (pair) {
          if (pair.kind === 'start') {
            const r = await deps.pairing.start()
            say(msg.chatId, r.ok
              ? `配对码 ${r.code},发给朋友,10 分钟内有效`
              : '中继暂时够不着,配对码没能生成——稍后再试')
          } else {
            const r = await deps.pairing.accept(pair.code)
            const text = r.ok
              ? `和 ${r.peer.name} 的 bot 连上了 ✓ 现在可以互相觅食/写信了`
              : r.reason === 'self_pair'
                ? '这是你自己的码,换个朋友的码试试'
                : r.reason === 'id_conflict'
                  ? '对方 bot 使用旧版共享身份且与你已有的朋友撞名——请让对方升级出唯一身份后重试'
                  : r.reason === 'relay_drop_failed'
                    ? '名片没能投到中继,配对没完成——请重试'
                    : '码不对或已过期,让朋友重新生成一个'
            say(msg.chatId, text)
          }
          return true
        }
      }
      return false
    }),
    row('wish', (m) => deps.isAdmin(m.chatId) && !!deps.social && !!parseSeekCommand(m.text), async (msg) => {
      // 派 / 取消 心愿 (spec 2026-09-04-wish-postcard) — admin-gated send/cancel
      // of a drafted wish, mirrors the 串门/配对 blocks above (renders every
      // outcome itself, no engine notify). `派` is ALREADY the delegate
      // imperative (admin-commands.ts's DELEGATE_RE: 让/派 <hand> 执行/跑
      // <task>) — parseSeekCommand's id-charset guard ([0-9a-fA-F-]+)
      // keeps a delegate command like "派 家里 跑 拉日志" from ever
      // matching here (belt); makeMwAdmin already runs before this
      // dispatch seam in the wired pipeline and consumes DELEGATE_RE
      // first (suspenders). Inert (falls through) until boot.social is
      // wired, same posture as the 串门/配对 blocks.
      if (deps.social && deps.isAdmin(msg.chatId)) {
        const cmd = parseSeekCommand(msg.text)
        if (cmd) {
          // 派 only ever acts on a draft; 取消 also closes one already out
          // (its replies keep landing in the bag — see wish.cancel).
          const among = cmd.kind === 'confirm' ? ['draft'] as const : ['draft', 'open'] as const
          const res = deps.social.wish.resolveRef(cmd.ref, among)
          if (!res.ok) {
            say(msg.chatId, res.reason === 'ambiguous'
              ? '有多条心愿匹配这个开头,请给更长的编号'
              : '这条心愿不存在或已处理')
            return true
          }
          if (cmd.kind === 'confirm') {
            const r = await deps.social.wish.send(res.id)
            say(msg.chatId, r.ok
              ? `已派给 ${r.sentTo} 个朋友,等回音…`
              : r.reason === 'no_channels'
                ? '你还没有开着信道的朋友,先配对'
                : r.reason === 'too_many_open'
                  ? '同时最多 3 条心愿,先取消一条'
                  : '这条心愿不存在或已处理')
          } else {
            const r = deps.social.wish.cancel(res.id)
            say(msg.chatId, r.ok
              ? (r.status === 'cancelled' ? '已作废' : '已关掉,之后的回音还会进背包')
              : '这条心愿不存在或已处理')
          }
          return true
        }
      }
      return false
    }),
    row('intro', (m) => deps.isAdmin(m.chatId) && !!deps.social && !!parseIntroCommand(m.text), async (msg) => {
      // 认识 / 同意 / 不了 (spec 2026-09-04-introduction) — admin-gated,
      // deterministic parse, same posture as 派/取消 above: the router
      // renders EVERY outcome itself. `认识` asks the introducer to forward
      // a request on a postcard's replyId (from `wish.list()`'s postcards);
      // `同意`/`不了` answer an incoming offer (from `intro.offers()`).
      // Inert (falls through) until boot.social is wired.
      if (deps.social && deps.isAdmin(msg.chatId)) {
        const cmd = parseIntroCommand(msg.text)
        if (cmd) {
          if (cmd.kind === 'request') {
            const r = await deps.social.intro.request(cmd.ref)
            say(msg.chatId, r.ok
              ? '已经托朋友去问了,对方点头我就告诉你'
              : r.reason === 'not_found' ? '没有这张明信片'
                : r.reason === 'ambiguous' ? '有多张匹配,请给更长的编号'
                  : r.reason === 'already_requested' ? '已经在问了,等对方点头'
                    : '没送出去,稍后再试')
          } else {
            const fn = cmd.kind === 'accept' ? deps.social.intro.accept : deps.social.intro.decline
            const r = await fn(cmd.ref)
            say(msg.chatId, r.ok
              ? (cmd.kind === 'accept' ? '好,我把名片递过去了' : '好,我回了不了')
              : r.reason === 'not_found' ? '没有这条邀约(可能过期了)'
                : r.reason === 'ambiguous' ? '有多张匹配,请给更长的编号'
                  : '没送出去,稍后再试')
          }
          return true
        }
      }
      return false
    }),
    row('guest', (m) => !!deps.loadAccess().admins?.length && deps.isAdmin(m.chatId) && !!parseGuestCommand(m.text), async (msg) => {
      // 允许/拒绝/邀请码/待批准 (guest path spec §3) — admin-gated,
      // deterministic parse, mirrors 串门/回信/配对 above. Unlike those,
      // this block is NOT gated behind an optional boot.X wire —
      // guestRequests/guestForwardBudget are unconditionally constructed
      // above, so the guest path is always live; the gate is
      // isAdmin(msg.chatId) (same identity gate mw-access's guest
      // branch itself never bypasses — a non-admin sending "允许
      // 123456" falls straight through to a normal turn, matching
      // parseGuestCommand's own deterministic-exact-match contract)
      // PLUS [fix-wave ruling, CONTROLLER — Important 2] a real,
      // non-empty `access.admins` list. On a legacy admins-empty
      // install, `isAdmin()` falls back to allowFrom membership — so
      // an already-approved guest (who IS in allowFrom) would also
      // read as "admin" and could mint invite codes / run 允许/拒绝
      // themselves. Requiring `admins?.length` here closes that
      // escalation chain the same way mw-access's guest branch does
      // (src/daemon/inbound/mw-access.ts) — on such an install this
      // block simply never fires; the guest text falls through to
      // `boot.coordinator.dispatch(msg)` below like any other message.
      if (deps.loadAccess().admins?.length && deps.isAdmin(msg.chatId)) {
        const guestCmd = parseGuestCommand(msg.text)
        if (guestCmd) {
          if (guestCmd.kind === 'allow') {
            const request = deps.guestRequests.resolve(guestCmd.code, 'allowed')
            if (!request) {
              say(msg.chatId, '码不对或已过期(发「待批准」看当前请求)')
              return true
            }
            deps.appendAllowFrom(request.chatId)
            say(msg.chatId, `已允许 ${request.chatId}`)
            // Hydrate BEFORE sending the guest welcome (fix round 1,
            // Important #3 — spec §3 calls for hydrate here too, same
            // as mw-access's own fresh/invite-accept paths): the
            // guest's chat was never allowlisted while pending, so
            // mw-capture-ctx never ran for it — without this,
            // sendMessage below can hit assertChatRoutable's
            // "unknown chat_id" failure on a first-ever contact whose
            // routing state was only ever captured into the STORED
            // GuestRequest, not into ctxStore/acctStore themselves.
            deps.hydrateRoute(request.chatId, request.accountId, request.contextToken)
            const guestSend = await deps.sendMessage(request.chatId, '主人同意啦!')
            if (guestSend.error) {
              // The owner already got their ✅ above (can't un-send it) —
              // the least we owe is a log that tells the truth instead
              // of silently swallowing a failed guest-facing send.
              deps.log('ACCESS', `guest approve: welcome send to ${request.chatId} failed: ${guestSend.error}`)
            }
            // Re-fire the guest's original message through the FULL
            // pipeline (not just this inner dispatch closure) — same
            // onboarding-echo posture as makeOnboardingHandler's
            // dispatchInbound above: redispatch:true so mw-dedup
            // doesn't swallow it, and running the whole pipeline (not
            // just coordinator.dispatch) lets mw-onboarding pick it up
            // and ask the guest's nickname before echoing their
            // original question back through the provider.
            await deps.redispatch({
              msg: request.firstMsg,
              receivedAtMs: now(),
              requestId: randomBytes(4).toString('hex'),
              redispatch: true,
            })
            return true
          }
          if (guestCmd.kind === 'deny') {
            const request = deps.guestRequests.resolve(guestCmd.code, 'denied')
            if (!request) {
              say(msg.chatId, '码不对或已过期(发「待批准」看当前请求)')
              return true
            }
            // The guest gets NOTHING — spec §3: "不替 owner 说难听话;
            // 此后纯静默" (guestRequests.wasDenied now gates mw-access's
            // guest branch silent on every future message from them).
            say(msg.chatId, '已拒绝,ta 不会再打扰你。')
            return true
          }
          if (guestCmd.kind === 'invite') {
            const invite = deps.guestRequests.createInvite()
            say(msg.chatId, `邀请码:${invite.code}(48 小时内有效,一次一人)。把这串数字发给朋友,ta 加我微信好友后把码发给我就能聊了。`)
            return true
          }
          // 'pending'
          const pending = deps.guestRequests.listPending()
          const text = pending.length === 0
            ? '目前没有待批准的请求。'
            : pending.map(r => {
                const hoursLeft = Math.max(0, Math.floor((r.createdAt + GUEST_REQUEST_TTL_MS - now()) / 3_600_000))
                return `「${r.code}」 ${r.chatId}:"${previewText(r.firstMsg.text)}"(剩 ${hoursLeft} 小时)`
              }).join('\n')
          say(msg.chatId, text)
          return true
        }
      }
      return false
    }),
  ]
}

/**
 * 老形状(probe / tryHandle):同一组行串起来。命令表直接用 makeControlCommands 的行;这个留给单测和别的老调用方,
 * 也顺带证明拆成行以后行为没变(command-router.test 一条没改)。
 */
export function makeCommandRouter(deps: CommandRouterDeps): CommandRouter {
  const rows = makeControlCommands(deps)
  const claims = (c: WechatCommand, m: InboundMsg): boolean => { try { return c.probe(m) } catch { return false } }
  return {
    probe: (msg) => rows.some(r => claims(r, msg)),
    async tryHandle(msg) {
      for (const r of rows) if (claims(r, msg) && await r.handle(msg)) return true
      return false
    },
  }
}
