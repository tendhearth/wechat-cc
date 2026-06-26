/**
 * mw-dedup — processing-level dedup for redelivered inbound messages.
 *
 * Placed right after the access gate (so only allow-listed senders are
 * tracked) and BEFORE every side-effecting middleware (messages, typing,
 * command routing, dispatch), so its `await next()` wraps the WHOLE turn.
 *
 *   1. Compute the message id (same scheme as mw-messages / the messages table).
 *   2. If it's already marked handled → short-circuit, run nothing downstream.
 *      This is what stops the macOS sleep/wake "re-reply the same message" bug:
 *      the long-poll cursor is at-least-once and can redeliver an already-
 *      answered message, but we won't run the agent for it again.
 *   3. Otherwise run the pipeline, and mark handled ONLY after it settles
 *      without throwing. A turn that crashes before replying is left unmarked
 *      so it is reprocessed on redelivery (crash recovery preserved).
 */
import type { Middleware } from './types'
import { inboundMessageId, inboundFallbackMessageId } from '../../lib/messages-store'

/** Default give-up threshold for a persistently-throwing ("poison") message. */
export const DEFAULT_MAX_ATTEMPTS = 5

export interface DedupMwDeps {
  isHandled(id: string): boolean | Promise<boolean>
  markHandled(id: string): void | Promise<void>
  /**
   * Optional poison-message bound: record one processing attempt, return the
   * new total. When wired, mw-dedup gives up (marks handled) once attempts
   * exceed `maxAttempts`, so a message whose turn keeps throwing can't
   * reprocess forever across restarts. Omit to disable the bound.
   */
  recordAttempt?(id: string): number | Promise<number>
  maxAttempts?: number
  log: (tag: string, line: string) => void
}

export function makeMwDedup(deps: DedupMwDeps): Middleware {
  return async (ctx, next) => {
    const id = ctx.msg.createTimeMs
      ? inboundMessageId(ctx.msg.userId, ctx.msg.createTimeMs)
      : inboundFallbackMessageId(ctx.msg.userId, ctx.msg.text)

    if (await deps.isHandled(id)) {
      deps.log('DEDUP', `skip redelivered message ${id} (${ctx.msg.chatId}) — already handled`)
      return
    }

    // Poison-message bound: count this attempt up front (persisted, so it
    // survives the crash/restart that redelivery rides on). Past the threshold
    // we stop re-running a turn that keeps throwing and mark it handled — a
    // dropped reply beats an infinite reprocess loop. Within a single process a
    // throwing turn is already dropped (poll-loop advances the cursor); this
    // only bites a message redelivered repeatedly across restarts.
    if (deps.recordAttempt) {
      const attempts = await deps.recordAttempt(id)
      const max = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
      if (attempts > max) {
        deps.log('DEDUP', `giving up on poison message ${id} (${ctx.msg.chatId}) after ${attempts - 1} failed attempts — marking handled`)
        await deps.markHandled(id)
        return
      }
    }

    await next()

    // Reached only if no downstream middleware threw — i.e. the turn completed
    // and a reply was sent (or the message was consumed as a command).
    await deps.markHandled(id)
  }
}
