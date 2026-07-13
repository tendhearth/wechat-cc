import type { Middleware } from './types'

export interface ActivityMwDeps {
  recordInbound(chatId: string, when: Date): Promise<void>
  /**
   * Proactive-care design §6 — any inbound from the chat resets its
   * no-reply streak (the user is talking to us again). Optional: absent
   * ⇒ existing embeddings/tests are unaffected. Sync + void because
   * CareLedger.resetNoReply is a synchronous, best-effort write-through.
   */
  resetCareNoReply?: (chatId: string) => void
  log: (tag: string, line: string) => void
}

export function makeMwActivity(deps: ActivityMwDeps): Middleware {
  return async (ctx, next) => {
    await next()
    if (ctx.consumedBy) return
    // poll-loop normalises a missing ilink timestamp to 0; treat 0 as "missing"
    // and fall back to receivedAtMs (matches legacy main.ts `createTimeMs || Date.now()`).
    const when = new Date(ctx.msg.createTimeMs || ctx.receivedAtMs)
    deps.recordInbound(ctx.msg.chatId, when).catch(err =>
      deps.log('ACTIVITY', `record failed for ${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`),
    )
    try { deps.resetCareNoReply?.(ctx.msg.chatId) } catch (err) {
      deps.log('ACTIVITY', `resetCareNoReply failed for ${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`)
    }
  }
}
