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
import type { InboundMsg } from '../../core/prompt-format'
import { parseLetterCommand } from '../../core/penpal-letter-command'
import { parseVisitCommand } from '../../core/visit-command'
import { parsePairCommand } from '../../core/pair-command'
import { parseSeekCommand } from '../../core/seek-command'
import { parseGuestCommand } from '../../core/guest-command'
import { parseIntroCommand } from '../../core/intro-command'
import { previewText } from '../inbound/mw-access'
import { GUEST_REQUEST_TTL_MS } from '../guest-requests'
import type { GuestRequestStore } from '../guest-requests'
import type { PairingEngine } from '../../core/pairing'
import type { WishService } from '../bootstrap/wire-wish'
import type { IntroService } from '../bootstrap/wire-intro'

export interface CommandRouterDeps {
  isAdmin: (chatId: string) => boolean
  loadAccess: () => { admins?: string[] }
  appendAllowFrom: (chatId: string) => void
  /** CC-voice outbound to the owner's own chat. Absent ⇒ outcomes are silent
   *  (same optional posture as the pre-extraction closure). */
  sendAssistantText?: (chatId: string, text: string) => void | Promise<void>
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
  /** True iff the message was a control command this router handled. */
  tryHandle(msg: InboundMsg): Promise<boolean>
}

export function makeCommandRouter(deps: CommandRouterDeps): CommandRouter {
  const now = deps.now ?? (() => Date.now())
  const say = (chatId: string, text: string) => { void deps.sendAssistantText?.(chatId, text) }

  return {
    async tryHandle(msg: InboundMsg): Promise<boolean> {
      // 串门(2026-09-03 实验)—— 主人说「串门」,伙伴挑一个开着的笔友信道过去
      // 聊几句,回来讲给主人听。见 core/visit.ts 顶部的 WHY。
      if (deps.social && deps.isAdmin(msg.chatId)) {
        const v = parseVisitCommand(msg.text)
        if (v) {
          say(msg.chatId, '🚶 出门了,聊完回来跟你说。')
          const r = await deps.social.penpal.startVisit(v.channel)
          if (!r.ok) {
            say(msg.chatId, r.reason === 'unknown_channel'
              ? '没找到这一家。说「串门」我自己挑,或者「串门 邻居」去邻居家。'
              : `没出得了门:${r.reason}`)
          }
          return true
        }
      }
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
              say(msg.chatId, '❌ 码不对或已过期(发「待批准」看当前请求)')
              return true
            }
            deps.appendAllowFrom(request.chatId)
            say(msg.chatId, `✅ 已允许 ${request.chatId}`)
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
              say(msg.chatId, '❌ 码不对或已过期(发「待批准」看当前请求)')
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
    },
  }
}
