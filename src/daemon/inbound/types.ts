// src/daemon/inbound/types.ts
import type { InboundMsg } from '../../core/prompt-format'

export type ConsumedBy = 'admin' | 'mode' | 'onboarding' | 'permission-reply' | 'guard' | 'access' | 'health'

export interface InboundCtx {
  readonly msg: InboundMsg
  readonly receivedAtMs: number
  readonly requestId: string
  consumedBy?: ConsumedBy
  attachmentsMaterialized?: boolean
  /**
   * Onboarding echo re-dispatch: the SAME message id is intentionally
   * re-entering the pipeline a second time (turn-1's trigger message,
   * fired again after the nickname exchange completes so the provider
   * actually answers it). mw-dedup honors this flag and skips its
   * isHandled short-circuit for this one pass — without it, mw-dedup
   * already marked the message handled at the end of turn 1 (same boot,
   * no restart needed) and the echo dispatch is silently swallowed.
   */
  readonly redispatch?: boolean
}

export type Middleware = (ctx: InboundCtx, next: () => Promise<void>) => Promise<void>
export type PipelineRun = (ctx: InboundCtx) => Promise<void>
