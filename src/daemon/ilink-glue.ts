/**
 * Ilink adapter — composition root for voice / companion / transport /
 * messaging / projects / permissions. The individual concerns live in
 * src/daemon/ilink/*; this file wires them together and exposes the
 * IlinkAdapter surface that bootstrap.ts + main.ts consume.
 *
 * History: was one 550-line closure until the v1.2 ilink-glue split
 * (RFC 02 §8.4). The split is a pure refactor — same public surface,
 * same tests — but gives Task 3 (MCP tool split) cleaner module seams.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { WECHAT_PORTS, type WechatSend, type WechatVoice, type WechatCompanionControls, type WechatAccounts, type WechatContacts, type WechatPages, type WechatPermissions, type WechatLinkStatus, type WechatWorkbenchTransport, type WechatPolling } from '../ports/wechat'
import { howToReplyLine, parsePermissionReply } from './pending-permissions'
import { buildMediaItemFromArtifact,buildMediaItemFromFile, assertSendable } from './media'
import { ilinkSendMessage, botTextMessage } from '../lib/ilink'
import { sendIlinkWorkbenchItem,sendIlinkWorkbenchText } from '../lib/ilink-workbench'
import { sendReplyOnce, chunk } from '../lib/send-reply'
import { MAX_TEXT_CHUNK } from '../lib/config'
import { log } from '../lib/log'
import {
  sharePage as docsShare,
  resurfacePage as docsResurface,
  onPdfRequest as docsOnPdfRequest,
} from '../../docs'
import { makeIlinkContext, type Account } from './ilink/context'
import { gateVoice, makeVoice } from './ilink/voice'
import { makeCompanion } from './ilink/companion'
import { makeTransport } from './ilink/transport'
import { makeOutboundHealthTracker, isProactiveWindowClosed } from './ilink/outbound-health'
import type { Db } from '../lib/db'
import type { ConversationStore } from '../ports/conversation-store'
import { makeMessagesStore } from '../lib/messages-store'
import { readJsonFile } from '../lib/read-json-file'
import { isAdmin } from '../lib/access'
import { EXPIRED_NOTIFY_TEXT, expiredNoticeRecipients } from './ilink/expired-notice'
import type { SentMedia } from './companion/media-mirror'

/**
 * Monotonic counter to keep same-millisecond outbound IDs unique. Module
 * scope is safe: makeIlinkAdapter is constructed once per daemon process
 * (multi-account routing happens inside the single adapter).
 */
let outSeq = 0

export type { Account } from './ilink/context'
/** Alias for Account — used in polling-lifecycle public API. */
export type IlinkAccount = import('./ilink/context').Account

/**
 * 整个 ilink 适配器 = 十个窄口的并集(src/ports/wechat.ts,架构终态 A6)。只有 ilink 自己(含 ilink/module.ts)和地基
 * 拿得到这一整个;别的模块经容器 needs 口名(`wechat.send` …)只拿它要的那一口(守卫:scripts/ilink-ports.guard.test.ts)。
 */
export interface IlinkAdapter extends WechatSend, WechatAccounts, WechatContacts, WechatPages, WechatPermissions, WechatLinkStatus, WechatWorkbenchTransport, WechatPolling {
  voice: WechatVoice
  companion: WechatCompanionControls
}

/** ilink 模块交给容器的窄口(ilink/module.ts 的 `ilink-adapter` 模块的 `ports`)。语音 / 开关是子对象,其余八口就是 adapter 本身、只收窄类型。 */
export const ILINK_PORTS = {
  [WECHAT_PORTS.send]: (a: IlinkAdapter): WechatSend => a,
  [WECHAT_PORTS.voice]: (a: IlinkAdapter): WechatVoice => a.voice,
  [WECHAT_PORTS.companion]: (a: IlinkAdapter): WechatCompanionControls => a.companion,
  [WECHAT_PORTS.accounts]: (a: IlinkAdapter): WechatAccounts => a,
  [WECHAT_PORTS.contacts]: (a: IlinkAdapter): WechatContacts => a,
  [WECHAT_PORTS.pages]: (a: IlinkAdapter): WechatPages => a,
  [WECHAT_PORTS.permissions]: (a: IlinkAdapter): WechatPermissions => a,
  [WECHAT_PORTS.link]: (a: IlinkAdapter): WechatLinkStatus => a,
  [WECHAT_PORTS.workbench]: (a: IlinkAdapter): WechatWorkbenchTransport => a,
  [WECHAT_PORTS.polling]: (a: IlinkAdapter): WechatPolling => a,
}

export async function loadAllAccounts(stateDir: string): Promise<Account[]> {
  const dir = join(stateDir, 'accounts')
  if (!existsSync(dir)) return []
  const out: Account[] = []
  for (const id of readdirSync(dir)) {
    // v0.5.6 — skip dedupe-archived dirs. The archiver renames any
    // duplicate-userId account dir to `<botId>.superseded.<iso>` so the
    // poll loop ignores it without losing the audit trail.
    if (id.includes('.superseded.')) continue
    const acctDir = join(dir, id)
    const metaPath = join(acctDir, 'account.json')
    const tokenPath = join(acctDir, 'token')
    if (!existsSync(metaPath) || !existsSync(tokenPath)) continue
    // BOM 容忍:PowerShell 的 Set-Content -Encoding UTF8 默认写 BOM,而裸
    // JSON.parse 会因此抛 SyntaxError 让整个 daemon fatal 退出(2026-09-01
    // Windows 真机实测)。见 lib/read-json-file.ts。
    const meta = readJsonFile<{ botId: string; userId: string; baseUrl: string }>(metaPath)
    const token = readFileSync(tokenPath, 'utf8').trim()
    const syncBufPath = join(acctDir, 'sync_buf')
    const syncBuf = existsSync(syncBufPath) ? readFileSync(syncBufPath, 'utf8').trim() : ''
    out.push({ id, botId: meta.botId, userId: meta.userId, baseUrl: meta.baseUrl, token, syncBuf })
  }
  return out
}

export function makeIlinkAdapter(opts: {
  stateDir: string
  accounts: Account[]
  db: Db
  conversationStore: ConversationStore
  /** 网络闸门(2026-10-02):语音合成 / 识别出门前问一次。 */
  networkGate?: import('../lib/network-gate').NetworkGate
  /**
   * CC 开口那道门(第三批 3a),懒取(门比 adapter 晚建)。askUser 的权限卡只用它**记账**(policy.ask,permission_ask):
   * blocking 一律放行,投递仍是下面那条 fail-fast,行为不变 —— 只是账上多一行「为什么说了」,跟工作台的卡、App 推送同一种口径。
   */
  speech?: () => Pick<import('./speech/policy').SpeechPolicy, 'ask'> | null
}): IlinkAdapter {
  const ctx = makeIlinkContext(opts)
  const speechOf = opts.speech   // askUser 的形参也叫 opts,先取出来
  const messagesStore = makeMessagesStore(opts.db)
  const { stateDir, accounts, ctxStore, conversationStore, acctStore, sessionState, pending, sweepTimer, projectsFile, resolveAccount, assertChatRoutable } = ctx

  // 媒体镜像(2026-10-18):发给主人的图 / 表情 / 语音也进 App 对话页。报不出去只记日志,绝不影响发送结果。
  let mediaSent: ((chatId: string, m: SentMedia | readonly SentMedia[]) => void) | null = null
  const reportMedia = (chatId: string, m: SentMedia | readonly SentMedia[]) => {
    if (!mediaSent) return
    try { mediaSent(chatId, m) } catch (err) { log('MESSAGES', `media mirror threw: ${err instanceof Error ? err.message : err}`) }
  }
  const gatedVoice = gateVoice(makeVoice(ctx), opts.networkGate)
  const voice: WechatVoice = {
    ...gatedVoice,
    async replyVoice(chatId, text) {
      const r = await gatedVoice.replyVoice(chatId, text)
      // 不存音频:手机点了再按这段字合成(GET /m/api/chat/voice)。
      if (r.ok) reportMedia(chatId, { kind: 'voice', text })
      return r
    },
  }
  const companion = makeCompanion(ctx)
  const outbound = makeOutboundHealthTracker({ log: (t, l) => log(t, l) })
  const windowClosed = new Map<string, string>()

  // PR4 Task 15 — when ilink rejects an account with errcode=-14 ("rebound
  // elsewhere"), tell the owner. The session is dead so the sends will mostly
  // fail; per-chat failures are logged and swallowed. Desktop badge +
  // dashboard signal (PR4 Task 16) cover the case where no admin chat has
  // messaged since boot. 只发给 admin(./ilink/expired-notice.ts):以前访客也会收到。
  //
  // PR5 Task 23: chat lookup migrated from in-memory accountChatIndex to
  // `WHERE account_id = ?` SQL — populated by mw-identity on every inbound.
  const transport = makeTransport(ctx, {
    onAccountExpired: (accountId, _reason) => {
      const all = conversationStore.chatsForAccount(accountId)
      const chats = expiredNoticeRecipients(all, isAdmin)
      for (const chatId of chats) {
        sendReplyOnce(chatId, EXPIRED_NOTIFY_TEXT, stateDir).then(r => {
          if (!r.ok) log('EXPIRED_NOTIFY', `chat=${chatId} acct=${accountId} send failed: ${r.error}`)
        }).catch(err => log('EXPIRED_NOTIFY', `chat=${chatId} acct=${accountId} threw: ${err instanceof Error ? err.message : err}`))
      }
      log('EXPIRED_NOTIFY', `acct=${accountId} told ${chats.length} admin chat(s) of ${all.length} on this account`)
    },
  })

  const adapter: IlinkAdapter = {
    async sendMessage(chatId, text, metadata) {
      // 只有空白也算空:ilink 会照发,微信那头就是一条空气泡(2026-10-02)。
      if (!text.trim()) return { msgId: `err:${Date.now()}`, error: 'empty text' }
      let reachedWire = false
      try {
        // Use the in-memory ctxStore / acctStore directly — sendReplyOnce
        // re-reads context_tokens.json from disk and would miss tokens
        // that were just captured (state-store debounces disk writes
        // 500ms). The CLI fallback still uses sendReplyOnce since it
        // runs out-of-process and has nothing in memory.
        assertChatRoutable(chatId)
        const acct = resolveAccount(chatId)
        const ctxToken = ctxStore.get(chatId)
        const chunks = chunk(text, MAX_TEXT_CHUNK)
        reachedWire = true
        for (const part of chunks) {
          await ilinkSendMessage(acct.baseUrl, acct.token, botTextMessage(chatId, part, ctxToken))
        }
        outbound.recordSuccess(new Date().toISOString())
        windowClosed.delete(chatId)
        // Record ONE row with the full pre-chunk text (fire-and-forget;
        // recording failure must never break the send result).
        void messagesStore.append({
          id: `out:${chatId}:${Date.now()}:${outSeq++}`,
          chatId,
          ts: new Date().toISOString(),
          direction: 'out',
          kind: 'text',
          text,
          // provider context is not available at the transport layer;
          // the coordinator knows the provider but sendMessage is a generic
          // send primitive called from many paths (admin, mode, onboarding,
          // AI reply). Recorded as undefined — can be enriched later if needed.
          provider: undefined,
          source: metadata?.source ?? 'live',
        }).catch(err => log('MESSAGES', `outbound record failed: ${err instanceof Error ? err.message : err}`))
        return { msgId: `sent:${Date.now()}` }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Only wire failures feed the health tracker — routing errors
        // (unroutable chat, unknown account) say nothing about the link.
        // errcode=-2(prepare failed)= 主动推送窗口已关,非链路故障,也不喂
        // (否则每次 boot 给离线用户发通知失败都误报 degraded)。见
        // isProactiveWindowClosed 的说明。
        if (reachedWire && !isProactiveWindowClosed(msg)) outbound.recordFailure(new Date().toISOString(), msg)
        if (reachedWire && isProactiveWindowClosed(msg) && !windowClosed.has(chatId)) windowClosed.set(chatId, new Date().toISOString())
        return {
          msgId: `err:${Date.now()}`,
          error: msg,
        }
      }
    },

    outboundHealth: () => outbound.snapshot(),
    proactiveClosedSince: (chatId) => windowClosed.get(chatId) ?? null,

    onMediaSent(fn) { mediaSent = fn },
    noteSentMedia: (chatId, m) => reportMedia(chatId, m),

    async sendFile(chatId, filePath, sendOpts) {
      assertSendable(filePath)
      // Fail before the CDN upload — without on-disk routing state, the
      // subsequent ilink/sendmessage will fail anyway with a less helpful
      // errcode. See unknownChatIdError() for the message.
      assertChatRoutable(chatId)
      const acct = resolveAccount(chatId)
      const item = await buildMediaItemFromFile(filePath, chatId, acct.baseUrl, acct.token)
      const ctxToken = ctxStore.get(chatId)
      await ilinkSendMessage(acct.baseUrl, acct.token, {
        to_user_id: chatId,
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: ctxToken,
      })
      if (sendOpts?.mirror !== false) reportMedia(chatId, { kind: 'file', path: filePath })
    },

    // ilink has no true edit API. We send a new message prefixed with
    // "(编辑后) " to emulate the behavior. Matches legacy server.ts.
    async editMessage(chatId, _msgId, text) {
      await adapter.sendMessage(chatId, `(编辑后) ${text}`)
    },

    async broadcast(text, accountId) {
      const allChats = Object.keys(acctStore.all())
      let ok = 0
      let failed = 0
      for (const chatId of allChats) {
        if (accountId) {
          const chatAcct = acctStore.get(chatId)
          if (chatAcct && chatAcct !== accountId) continue
        }
        const result = await sendReplyOnce(chatId, text, stateDir)
        if (result.ok) ok++
        else failed++
      }
      return { ok, failed }
    },

    async sharePage(title, content, opts) {
      const r = await docsShare(title, content, opts)
      return { url: r.url, slug: r.slug }
    },

    async resurfacePage(q) {
      const r = await docsResurface(q)
      if (!r) return null
      return { url: r.url, slug: r.slug }
    },

    async setUserName(chatId, name) {
      // Single source of truth: conversations.last_user_name (PR5 Task 21).
      // The standalone user_names.json store was retired; existing files
      // are backfilled into the conversations table on first daemon boot.
      conversationStore.upsertIdentity(chatId, { userName: name })
    },

    resolveUserName(chatId) {
      return conversationStore.getIdentity(chatId)?.last_user_name ?? undefined
    },

    resolveAccountId(chatId) {
      return resolveAccount(chatId).id
    },

    chatAccountId(chatId) {
      const persistedId = acctStore.get(chatId)
      if (!persistedId) return null
      return accounts.some(account => account.id === persistedId) ? persistedId : null
    },

    async sendWorkbenchNotice(notice, signal) {
      if (!notice.text || notice.text.length > 4000) {
        return { status: 'blocked', reason: 'invalid_text' }
      }

      // Binding is checked before selecting (and therefore reading credentials
      // from) the account. A stale notice must never drift to another account.
      if (acctStore.get(notice.ownerChatId) !== notice.accountId) {
        return { status: 'blocked', reason: 'binding_changed' }
      }
      const account = accounts.find(candidate => candidate.id === notice.accountId)
      if (!account) return { status: 'blocked', reason: 'account_unavailable' }
      const contextToken = ctxStore.get(notice.ownerChatId)
      if (!contextToken) return { status: 'deferred', reason: 'missing_context' }

      const outcome = await sendIlinkWorkbenchText({
        baseUrl: account.baseUrl,
        token: account.token,
        clientId: notice.id,
        ownerChatId: notice.ownerChatId,
        text: notice.text,
        contextToken,
        signal,
      })
      if (outcome.status === 'accepted'&&!signal?.aborted) {
        try {
          await messagesStore.append({
            id: `workbench:${notice.id}`,
            chatId: notice.ownerChatId,
            ts: new Date().toISOString(),
            direction: 'out',
            kind: 'text',
            text: notice.text,
            source: 'workbench',
          })
        } catch (err) {
          log('MESSAGES', `workbench outbound audit failed for notice=${notice.id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return outcome
    },

    async uploadWorkbenchArtifact(request,signal){
      if(acctStore.get(request.ownerChatId)!==request.accountId)return{status:'blocked',reason:'binding_changed'}
      const account=accounts.find(candidate=>candidate.id===request.accountId);if(!account)return{status:'blocked',reason:'account_unavailable'}
      if(!ctxStore.get(request.ownerChatId))return{status:'retryable',reason:'missing_context'}
      try{
        const item=await buildMediaItemFromArtifact({bytes:request.bytes,name:request.name,mime:request.mime,toUserId:request.ownerChatId,baseUrl:account.baseUrl,token:account.token,signal})
        if(acctStore.get(request.ownerChatId)!==request.accountId)return{status:'blocked',reason:'binding_changed'}
        if(!accounts.some(candidate=>candidate.id===request.accountId))return{status:'blocked',reason:'account_unavailable'}
        if(!ctxStore.get(request.ownerChatId))return{status:'retryable',reason:'missing_context'}
        return{status:'uploaded',item}
      }
      catch(error){
        const reason=error instanceof Error?error.message:'upload_failed'
        return reason==='artifact_too_large'||reason==='invalid_artifact'?{status:'blocked',reason}:{status:'retryable',reason}
      }
    },

    async sendWorkbenchArtifact(receipt,item,signal){
      if(acctStore.get(receipt.ownerChatId)!==receipt.accountId)return{status:'blocked',reason:'binding_changed'}
      const account=accounts.find(candidate=>candidate.id===receipt.accountId);if(!account)return{status:'blocked',reason:'account_unavailable'}
      const contextToken=ctxStore.get(receipt.ownerChatId);if(!contextToken)return{status:'deferred',reason:'missing_context'}
      const outcome=await sendIlinkWorkbenchItem({baseUrl:account.baseUrl,token:account.token,clientId:receipt.id,ownerChatId:receipt.ownerChatId,contextToken,item,signal})
      if(outcome.status==='accepted'&&!signal?.aborted)try{await messagesStore.append({id:`workbench:${receipt.id}`,chatId:receipt.ownerChatId,ts:new Date().toISOString(),direction:'out',kind:'file',text:receipt.name,source:'workbench'})}catch(error){log('MESSAGES',`workbench artifact audit failed for receipt=${receipt.id}: ${error instanceof Error?error.message:String(error)}`)}
      return outcome
    },

    voice,
    companion,

    async askUser(chatId, prompt, hash, timeoutMs, opts) {
      // Register pending entry first so timeout can fire even if send fails.
      const resultPromise = pending.register(hash, timeoutMs, { chatId, prompt })
      // 怎么回的那一行在这里统一加,调用方(工具权限 / 终端 hook / gemini)只描述「要批什么」。
      // 两位数码由登记处分配;手机上回「y」即可,同时几条待批才要带码。
      const code = pending.codeOf(hash)
      // 措辞和自改的拍板卡共用一个纯函数(见 pending-permissions.howToReplyLine)。
      const card = `${prompt}\n${howToReplyLine(code, hash, timeoutMs)}`
      // Schedule a sweep at the timeout boundary so the promise resolves
      // with 'timeout' even when the global 30s sweep interval hasn't fired.
      // Using setTimeout so fake-timer tests can advance past the timeout.
      const t = setTimeout(() => { pending.sweep() }, timeoutMs + 1)
      if (typeof t.unref === 'function') t.unref()
      // Deliver the approval prompt. CRITICAL (2026-08-27 用户反馈:没给权限
      // 就整轮卡死):if the prompt can't reach the approver — most often the
      // admin's proactive-push window is closed (errcode=-2), since the
      // approver is usually NOT the chat that triggered this turn — then no
      // reply can EVER come. Don't dead-wait the full 10-min timeout (which
      // races the turn's own no-activity kill → user gets nothing). Resolve
      // 'undelivered' at once so the turn ends now with an honest reason.
      // 只记账,不拦:permission_ask 是 blocking,判定表里不会推后 / 丢(整合者定的口径,#536)。
      try { speechOf?.()?.ask({ kind: 'permission_ask', chatId }, { channel: 'wechat', deliverable: true }) } catch (err) { log('PERMISSION', `speech ledger failed: ${err instanceof Error ? err.message : String(err)}`) }
      adapter.sendMessage(chatId, card).then(
        (res) => {
          const err = (res as { error?: string } | null | undefined)?.error
          if (err) {
            if (opts?.keepOnUndelivered) { log('PERMISSION', `approval prompt undelivered to ${chatId}: ${err} — kept pending for another surface (phone)`); return }
            log('PERMISSION', `approval prompt undelivered to ${chatId}: ${err} — failing fast (not waiting ${Math.round(timeoutMs / 1000)}s)`)
            pending.fail(hash)
          }
        },
        (err) => {
          const why = err instanceof Error ? err.message : String(err)
          if (opts?.keepOnUndelivered) { log('PERMISSION', `approval prompt send threw for ${chatId}: ${why} — kept pending for another surface (phone)`); return }
          log('PERMISSION', `approval prompt send threw for ${chatId}: ${why} — failing fast`)
          pending.fail(hash)
        },
      )
      return resultPromise
    },

    lastActiveChatId: transport.lastActiveChatId,
    markChatActive: transport.markChatActive,
    captureContextToken: transport.captureContextToken,
    routeChatToAccount: transport.routeChatToAccount,
    sendTyping: transport.sendTyping,
    getUpdatesForLoop: transport.getUpdatesForLoop,

    sessionState,

    probePermissionReply(text, fromChatId, quoted) {
      const parsed = parsePermissionReply(text)
      if (!parsed) return false
      const owned = (hash: string) => { const approver = pending.approverOf(hash); return approver === null || approver === fromChatId }
      if (!parsed.ref) {
        if (quoted) { const hash = pending.hashOfQuote(quoted); if (hash) return owned(hash) && pending.list().some(p => p.hash === hash) }
        return pending.list().some(p => p.chatId === fromChatId)
      }
      const hash = parsed.ref.kind === 'code' ? pending.hashOfCode(parsed.ref.value) : parsed.ref.value
      return !!hash && owned(hash) && pending.list().some(p => p.hash === hash)
    },
    handlePermissionReply(text, fromChatId, quoted) {
      const parsed = parsePermissionReply(text)
      if (!parsed) return false
      // 引用了卡片回「y」:最顺手的手机操作。引用的原文里有码就按码,截断了就按卡片正文认。
      if (!parsed.ref && quoted) {
        const hash = pending.hashOfQuote(quoted)
        if (hash) {
          const approver = pending.approverOf(hash)
          if (approver !== null && approver !== fromChatId) return false
          return pending.consume(hash, parsed.decision)
        }
        // 引用的不是待批卡片(或已经过期):按没引用处理,下面看待批条数。
      }
      // 没带码:看这个 chat 名下现在有几条待批。一条 → 就是它;零条 → 这不是拍板,
      // 是普通聊天(比如「y」是在回别的事),放行给后面的中间件;多条 → 列出来让主人带码。
      if (!parsed.ref) {
        const mine = pending.list().filter(p => p.chatId === fromChatId)
        if (mine.length === 0) return false
        if (mine.length === 1) return pending.consume(mine[0]!.hash, parsed.decision)
        const lines = mine.map(p => `${p.code}:${(p.prompt.split('\n')[0] ?? '').slice(0, 40)}`)
        void adapter.sendMessage(fromChatId ?? mine[0]!.chatId, `有 ${mine.length} 条在等你,带上码回:\n${lines.join('\n')}\n例如「y ${mine[0]!.code}」`)
        log('PERMISSION', `bare reply with ${mine.length} pending for chat=${fromChatId}: asked for a code`)
        return true
      }
      const hash = parsed.ref.kind === 'code' ? pending.hashOfCode(parsed.ref.value) : parsed.ref.value
      if (!hash) return false
      // 拍板权归当初被问的那个 chat。approverOf 返回 null = 没 meta(老条目
      // 或 hash 根本不存在)⇒ 走旧路径:不存在的 hash 由 consume 报 false。
      const approver = pending.approverOf(hash)
      if (approver !== null && approver !== fromChatId) return false
      return pending.consume(hash, parsed.decision)
    },

    listPendingPermissions() { return pending.list() },
    resolvePermission(hash, decision) { return pending.consume(hash, decision) },
    pendingPermissionCodeOf(hash) { return pending.codeOf(hash) },
    registerPendingPermission(hash, timeoutMs, meta) { return pending.register(hash, timeoutMs, meta) },
    sweepPendingPermissions() { pending.sweep() },

    async flush() {
      clearInterval(sweepTimer)
      // conversationStore.flush() is intentionally omitted — its SQLite
      // writes are immediate, and the store is owned by the daemon caller
      // (main.ts), not the adapter. The adapter only borrows it.
      await Promise.all([
        ctxStore.flush(),
        acctStore.flush(),
        sessionState.flush(),
      ])
    },
  }

  // Wire PDF delivery: docs server requests a PDF be sent to a chat.
  docsOnPdfRequest(async ({ chatId, pdfPath }) => {
    await adapter.sendFile(chatId, pdfPath)
  })

  return adapter
}

export { parsePermissionReply }
