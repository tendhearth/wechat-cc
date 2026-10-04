/**
 * fallback-reply.ts — wraps the IlinkAdapter's sendMessage envelope
 * (`{ msgId, error? }`) into the coordinator's expected
 * `(chatId, text) => Promise<void>` shape, with diagnostic logging at
 * each outcome.
 *
 * Why a dedicated wrapper:
 *
 * v0.5.1/0.5.2 had a 3-layer silent error swallow on the FALLBACK_REPLY
 * path. (1) `sendReplyOnce` returns `{ ok: false, error }` instead of
 * throwing (CLI back-compat). (2) `ilink-glue.sendMessage` packages
 * that into `{ msgId, error? }` (MCP `reply` tool back-compat).
 * (3) The bootstrap wrapper used to be:
 *   `async (chatId, text) => { await deps.ilink.sendMessage(chatId, text) }`
 * — `await`-and-discard, with no log of the envelope. Result: a real
 * production case on 2026-05-05 where the daemon generated a fallback
 * reply, ilink retried 3 times for ~65s due to a stale keep-alive
 * connection, and the FAILED case (had retries kept failing) would have
 * shipped to the user with zero diagnostic visibility. The only
 * evidence was `[RETRY]` lines deep inside ilink.ts that the
 * dashboard's Logs panel didn't surface in the inbound flow.
 *
 * v0.5.3: this wrapper logs `[FALLBACK_REPLY_SENT]` on success and
 * `[FALLBACK_REPLY_FAIL]` on either an error envelope or a thrown
 * exception (which it then re-raises so the coordinator's outer
 * handling stays intact).
 */

export type SendMessageResult = { msgId: string; error?: string }

export interface FallbackReplyDeps {
  /** ilink adapter's sendMessage. Undefined when there's no ilink wired (test harnesses). */
  sendMessage: ((chatId: string, text: string) => Promise<SendMessageResult>) | undefined
  log: (tag: string, line: string) => void
  /**
   * App-conversation-channel reply-sink capture (session-serialization
   * design, Task 2 Part B) — mirrors the `POST /v1/wechat/reply` route's
   * sink check (routes.ts). When an app turn's agent emits plain
   * assistant text instead of calling the `reply` tool, this fallback
   * path is the ONLY place that text surfaces; without this check it
   * would leak straight to WeChat via `sendMessage` while the app caller
   * that opened the sink is left waiting on an empty reply. Returns true
   * when a sink was open and the text was captured there (caller must
   * NOT ilink-send); false when no sink is open (WeChat path unchanged).
   * Undefined ⇒ same as "no sink ever open" (tests / embeddings that
   * don't wire replySinks stay byte-identical to before this feature).
   */
  capture?: (chatId: string, text: string) => boolean
  /**
   * 旁听(不改道)—— 见 outbound-taps.ts。这条 fallback 路径也要接:模型
   * 不调 reply 而直接输出正文时,这里是那段文字唯一的出口,漏接就等于
   * 「这次打猎没记上」,而且没有任何迹象。
   */
  observe?: (chatId: string, text: string) => void
  /**
   * 回复交付 shadow(spec 2026-10-03 §5.1 第 3 项):legacy 出口实际发出的每一条都交一份给
   * reply-delivery 的 observeLegacy,和「按新路会发什么」比。放在接收器截流**之前** —— app 这一轮
   * 被截走的回复也是 legacy 交付的结果。没开 shadow 轮时是一次 Map 查找。
   */
  shadow?: (chatId: string, text: string) => void
}

export type SendAssistantText = (chatId: string, text: string) => Promise<void>

export function makeSendAssistantText(deps: FallbackReplyDeps): SendAssistantText | undefined {
  if (!deps.sendMessage) return undefined
  const send = deps.sendMessage
  return async (chatId, text) => {
    deps.shadow?.(chatId, text)
    if (deps.capture?.(chatId, text)) return
    deps.observe?.(chatId, text)
    let result: SendMessageResult
    try {
      result = await send(chatId, text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log('FALLBACK_REPLY_FAIL', `chat=${chatId} threw: ${msg}`)
      throw err
    }
    if (result.error) {
      deps.log('FALLBACK_REPLY_FAIL', `chat=${chatId} error=${result.error}`)
      return
    }
    deps.log('FALLBACK_REPLY_SENT', `chat=${chatId} msgId=${result.msgId}`)
  }
}

/**
 * 系统通知(认证失败 / 超时 / 守护拒绝 / spawn 失败 / 本轮出错……)的出口 —— 回复交付 spec §4.3 末段
 * 「系统通知分家」:和 agent 的话分开记(NOTICE_SENT / NOTICE_FAIL,不是 FALLBACK_REPLY_*),
 * 不进打猎旁听(一句「登录过期」不是战利品),也不进 shadow 比对。app 接收器照样接 —— 通知在
 * app 里也要看得见。
 */
export function makeSendNotice(deps: FallbackReplyDeps): SendAssistantText | undefined {
  if (!deps.sendMessage) return undefined
  const send = deps.sendMessage
  return async (chatId, text) => {
    if (deps.capture?.(chatId, text)) return
    let result: SendMessageResult
    try {
      result = await send(chatId, text)
    } catch (err) {
      deps.log('NOTICE_FAIL', `chat=${chatId} threw: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
    if (result.error) {
      deps.log('NOTICE_FAIL', `chat=${chatId} error=${result.error}`)
      return
    }
    deps.log('NOTICE_SENT', `chat=${chatId} msgId=${result.msgId}`)
  }
}
