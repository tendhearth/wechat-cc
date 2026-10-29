/**
 * App 里跟 CC 说一句(重构第二批步 6c,从 pipeline-deps.ts 搬出来):桌面 / 手机「跟 CC 说」在主人自己的会话上
 * 跑真的一轮、把回复同步交还;回合串行(isInFlight 前置拒 + coordinator.submitTurn 持每 chat 锁),
 * 先过 route + consume(与微信同一张命令表),落库进同一条消息流。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Bootstrap } from '../bootstrap'
import type { WechatAccounts } from '../../ports/wechat'
import type { CareLedger } from '../../features/companion'
import { loadCompanionConfig } from '../../lib/companion-config'
import type { makeMessagesStore } from '../../lib/messages-store'
import type { InboundMsg } from '../../domain/prompt-format'
import type { MatterStore } from '../../ports/matters'
import type { PetSignals } from '../pet-signals'
import type { StickerLib } from '../../features/stickers'
import type { makeReplySinks, SinkExtras } from '../reply-sinks'
import { encodeExtras, hasExtras, projectReplyExtras, stickerDataUri, withStickerImages, type AppReplyExtras, type ConverseResult, CONVERSE_IMAGE_LIMITS, converseFileStem, isConverseImageMime, type ConverseImage } from '../app-reply'
import { withReplyScope } from '../inbound/reply-scope'
import type { InboundCtx } from '../inbound/types'
import type { AppTurn } from '../inbound/build'
import { surfaceOrigin } from '../../features/phone'
import { resolveOwnerSessionKey } from './owner-session-key'

export interface WireConverseDeps {
  stateDir: string
  boot: Bootstrap
  careLedger: CareLedger
  replySinks: ReturnType<typeof makeReplySinks>
  messagesStore: ReturnType<typeof makeMessagesStore>
  ilink: Pick<WechatAccounts, 'resolveAccountId'>
  log: (tag: string, line: string) => void
  /** App 一轮先过的 route + consume(main 建好流水线后才有;没接 ⇒ 直接进对话)。 */
  appTurn(): AppTurn | null
  matters?: MatterStore
  petSignals?: PetSignals
  stickers?: StickerLib
}

export type CompanionConverse = (text: string, origin?: 'desktop' | 'phone', images?: ConverseImage[]) => Promise<ConverseResult>

export function wireCompanionConverse(d: WireConverseDeps): CompanionConverse {
  const { stateDir, boot, careLedger, replySinks, messagesStore, ilink, log } = d
  // App-conversation-channel converse (voice arc Stage 0, Task 2) — drives
  // one real turn on the owner's own chat session and hands the reply back
  // synchronously. Synthesizes an InboundMsg the same shape a real WeChat
  // inbound would have (userId==chatId is correct for a solo owner chat)
  // and dispatches it straight through the coordinator — NOT through the
  // poll-loop/inbound-pipeline middleware chain, since this isn't a WeChat
  // inbound. The agent's `reply` tool still posts to POST /v1/wechat/reply
  // as normal; the open sink captures it instead of ilink-sending.
  // 「一件事」:桌面 / 手机上跟 CC 说的话和微信里的进同一条消息流(source 记表面),三个入口看到的是同一段对话。落库失败不影响这一轮。
  // 回复交付(2026-10-04):附件与旁白跟着回复那一行落库(messages.extras),手机从消息库拉对话时才看得到;
  // 只有附件、没有文字的一轮也写这一行(text 为空),否则那张表情 / 那段语音就没地方挂。
  /** 带附件的那句在历史里记成什么样:「原文\n[图片 ×N]」(手机按它认落地,一字不能改),有文件再加「[文件 ×M]」。 */
  const attachmentRecordText = (text: string, atts: NonNullable<InboundMsg['attachments']>) => {
    const images = atts.filter(a => a.kind === 'image').length, files = atts.length - images
    return [text.trim(), images ? `[图片 ×${images}]` : '', files ? `[文件 ×${files}]` : ''].filter(Boolean).join('\n')
  }
  const persistAppTurn = (origin: 'desktop' | 'phone', synthetic: InboundMsg, text: string, reply: string | undefined, extras?: AppReplyExtras | null, uploads?: ConverseImage[]) => {
    const ts = new Date().toISOString()
    const ownerChatId = synthetic.chatId
    const incoming=synthetic.attachments?.length?encodeExtras({attachments:synthetic.attachments.map((a,i)=>({kind:'file',path:a.path,name:basename(uploads?.[i]?.name||a.path)})),narration:[]}):undefined
    void messagesStore.append({ id: `app:${origin}:${synthetic.createTimeMs}:in`, chatId: ownerChatId, ts, direction: 'in', kind: 'text', text: synthetic.attachments?.length ? attachmentRecordText(text, synthetic.attachments) : text, source: origin, ...(incoming?{extras:incoming}:{}) }).catch(() => {})
    const encoded = encodeExtras(extras)
    if (reply || encoded) void messagesStore.append({ id: `app:${origin}:${synthetic.createTimeMs}:out`, chatId: ownerChatId, ts: new Date(Date.now() + 1).toISOString(), direction: 'out', kind: 'text', text: reply ?? '', source: origin, ...(encoded ? { extras: encoded } : {}) }).catch(() => {})
  }
  // 本地表情:解析一次(标签 → 表情库里随机一张),落库与桌面回包看到的是同一张。
  const stickerDir = join(stateDir, 'stickers')
  const projectExtras = (x: SinkExtras | undefined): AppReplyExtras | null =>
    x ? projectReplyExtras(x, { stickerFile: tag => d.stickers?.resolve(tag) ?? null }) : null
  const companionConverse = async (text: string, origin: 'desktop' | 'phone' = 'desktop', images?: ConverseImage[]): Promise<ConverseResult> => {
    // self-restart (spec 2026-08-03-daemon-self-restart-on-stale-code,
    // Task 3 review finding #1) — an App /converse turn is real owner
    // activity, but it dispatches straight through the coordinator and
    // NEVER passes through mw-messages (see this function's own doc
    // comment above), so without this call quietFor() would read Infinity
    // forever while the owner is mid-conversation in the desktop app,
    // making the idle-tick self-restart check free to fire between turns.
    // Same posture as mw-messages: optional, wrapped so a throw here can
    // never break the app turn it's marking.
    try { boot.markInboundActivity?.() } catch { /* 绝不能因为记一笔就打断 app 轮次 */ }
    // 桌宠(spec §5.1):app 里说话也是「主人联系过我」。和上面一样,记一笔
    // 绝不能打断轮次 —— 但这里只是一次 Math.max 赋值,不会抛。
    d.petSignals?.noteContact()
    const ownerChatId = loadCompanionConfig(stateDir).default_chat_id
    if (!ownerChatId) throw new Error('companion_owner_chat_not_configured')
    // 主人在 App 里说话也是「回了」:清掉伙伴的无回复计数(微信那边由 mw 的 resetCareNoReply 清)。
    // 否则 CC 落到 App 的问候,主人在 App 里回了,学到的暂停(连着 2 条没回 ⇒ 安静)照样会触发。
    try { careLedger.resetNoReply(ownerChatId) } catch { /* 记账失败不打断轮次 */ }
    // 「一件事」:app 里对 CC 说的话属于主人那条 chat matter,并且它现在在桌面表面露过面。
    // 出生地只在这次首建时写:桌面说的 ⇒ desktop;手机说的 ⇒ App / 浏览器(按传输判,不知道 ⇒ null)。
    try { const m = d.matters?.ensureChat(ownerChatId, undefined, surfaceOrigin(origin)); if (m) d.matters!.bind(m.id, 'desktop', 'app') } catch { /* 登记失败不打断轮次 */ }
    // D3 review follow-up: app-converse captures the reply through a sink, but a
    // chatroom-mode chat is preempt-policy (submitTurn runs the turn BARE, no
    // per-chat lock) AND chatroom forbids the `reply` tool — so an app turn on a
    // chatroom-mode owner chat would run unserialized and capture nothing.
    // Reject clearly instead of hanging / returning an empty reply. (Pre-D3 this
    // was a silent no-op; D3 makes the policy explicit, so we guard it explicitly.)
    if (boot.coordinator.getMode(ownerChatId).kind === 'chatroom') {
      throw new Error('owner_chat_in_chatroom_mode')
    }
    // PRIMARY guard (spec §3, HIGH finding fix): refuse to start an app turn
    // while a WeChat turn is already dispatching on the owner's session.
    // replySinks.open() below only catches app-vs-app races (both go through
    // this closure); a WeChat inbound never touches replySinks, so without
    // this check a WeChat message and an app /converse racing on the same
    // (alias, providerId, chatId) would both acquire the SAME SessionManager
    // handle and dispatch concurrently on one AgentSession. Resolves the key
    // the exact same way ConversationCoordinator.dispatch will (see
    // resolveOwnerSessionKey above) and reuses SessionManager.isInFlight —
    // the SAME in-flight guard the companion push tick checks before
    // dispatching (tick-bodies.ts's dispatchToChat).
    const ownerKey = resolveOwnerSessionKey(ownerChatId, {
      resolveProject: boot.resolve,
      getMode: (cid) => boot.coordinator.getMode(cid),
      defaultProviderId: boot.defaultProviderId,
    })
    if (ownerKey && boot.sessionManager.isInFlight({ alias: ownerKey.alias, providerId: ownerKey.providerId, chatId: ownerChatId })) {
      // Same error string as the replySinks guard below so the route's
      // reply_sink_busy → 409 session_busy mapping (internal-api/routes.ts)
      // stays unchanged.
      throw new Error('reply_sink_busy')
    }
    // The isInFlight pre-check above is a fast, lock-free rejection for the
    // still-common case (WeChat turn already running) so the app UI gets an
    // immediate 409 without waiting on the mutex. Below, session
    // serialization (session-serialization-design.md) closes the residual
    // this pre-check alone can't: the SINK's entire open→close lifetime runs
    // INSIDE the per-chat turn (submitTurn's `within` hook), so a WeChat/tick
    // turn queued behind this app turn cannot start — and cannot have its
    // reply-tool output stolen by the still-open app sink — until this turn's
    // sink is closed. D3: submitTurn owns the lock/policy + the dispatch; the
    // app path just supplies the capture logic to run within the locked turn
    // (no more hand-rolled runExclusive/dispatchInner + the deadlock footgun).
    // 桌面拖进 / 粘进来的图(2026-10-05):和微信收到的图一样落到 inbox,当附件交给 CC(它用读文件工具看)。
    // 文件名带来源与时刻,权限 0600;inbox 的清理照微信那一套走。
    const createTimeMs = Date.now()
    const imagePaths: string[] = []
    if (images?.length) {
      const inbox = join(stateDir, 'inbox')
      mkdirSync(inbox, { recursive: true })
      images.forEach((img, i) => {
        const stem = isConverseImageMime(img.mime) ? '' : converseFileStem(img.name)
        const path = join(inbox, `app-${origin}-${createTimeMs}-${i + 1}${stem ? `-${stem}` : ''}.${CONVERSE_IMAGE_LIMITS.mimes[img.mime] ?? 'bin'}`)
        writeFileSync(path, img.bytes, { mode: 0o600 })
        imagePaths.push(path)
      })
    }
    const synthetic: InboundMsg = {
      chatId: ownerChatId,
      userId: ownerChatId,
      text,
      msgType: imagePaths.length && !text.trim() ? (images!.every(i => isConverseImageMime(i.mime)) ? 'image' : 'file') : 'text',
      createTimeMs,
      accountId: ilink.resolveAccountId(ownerChatId),
      ...(imagePaths.length ? { attachments: imagePaths.map((path, i) => ({ kind: isConverseImageMime(images![i]!.mime) ? 'image' as const : 'file' as const, path })) } : {}),
    }
    // 第四步(d):App 说的话也先过 route + consume 这张表(与微信同一份消费者实例)。消费者的
    // 回话在回复作用域里被截住交还给 App;没人吃 ⇒ 下面照常进对话。没接 appTurn(测试 /
    // 最小嵌入)⇒ 跳过。
    const appTurn = d.appTurn()
    if (appTurn) {
      // origin:这一轮里「任务」命令 / 交给 X 继续建出来的事记在哪个表面(不是微信)。
      const ctx: InboundCtx = { msg: synthetic, receivedAtMs: synthetic.createTimeMs, requestId: `app:${origin}:${synthetic.createTimeMs}`, origin: surfaceOrigin(origin) }
      const front = await withReplyScope(() => appTurn(ctx))
      log('APP_INBOUND', `origin=${origin} intent=${ctx.intent?.kind ?? '-'} consumed=${front.result.consumed ? (ctx.consumedBy ?? 'yes') : 'dispatched'}`)
      if (front.result.consumed) {
        const reply = front.replies.join('\n')
        persistAppTurn(origin, synthetic, text, reply, undefined, images)
        return { reply }
      }
    }
    // 起飞时刻:app 轮次不走入站管道(见上面的 dispatch),所以在这儿单独记一笔,
    // 并且同样用 finally 配对 —— 两条进来的路,同一套 start/stop 语义。
    d.petSignals?.noteTurnStart(ownerChatId)
    try {
      const captured = await boot.coordinator.submitTurn(synthetic, {
        within: async (dispatch) => {
          const sink = replySinks.open(ownerChatId)
          try {
            await dispatch()
            // 回复交付 daemon 模式:附件与旁白随回复交还(桌面 / 手机显示);旧路径两样都是空的。
            const extras = projectExtras(sink.extras?.())
            const reply = sink.close()
            return { reply, extras }
          } catch (err) {
            sink.close()
            throw err
          }
        },
      })
      // 「一件事」:桌面 / 手机上跟 CC 说的话和微信里的进同一条消息流(source 记表面),
      // 三个入口看到的是同一段对话。落库失败不影响这一轮。
      persistAppTurn(origin, synthetic, text, captured.reply, captured.extras, images)
      const x = captured.extras
      if (!hasExtras(x)) return { reply: captured.reply }
      return {
        reply: captured.reply,
        ...(x.attachments.length ? { attachments: withStickerImages(x.attachments, f => stickerDataUri(stickerDir, f)) } : {}),
        ...(x.narration.length ? { narration: x.narration } : {}),
      }
    } finally {
      d.petSignals?.noteTurnStop(ownerChatId)
    }
  }
  return companionConverse
}
