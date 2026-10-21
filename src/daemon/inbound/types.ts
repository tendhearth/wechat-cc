// src/daemon/inbound/types.ts
import type { InboundMsg } from '../../core/prompt-format'
import type { Intent } from './intent'
import type { MatterOrigin } from '../../core/matters/store'

export type ConsumedBy = 'admin' | 'mode' | 'onboarding' | 'permission-reply' | 'command' | 'guard' | 'access' | 'health' | 'workbench'

export interface InboundCtx {
  readonly msg: InboundMsg
  readonly receivedAtMs: number
  readonly requestId: string
  consumedBy?: ConsumedBy
  /** 路由阶段(mw-route)算出来的意图;闸门之前是 undefined。 */
  intent?: Intent
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
  /**
   * App 一轮(桌面 / 手机说的话过同一张消费者表)才有:这一轮里建出来的事从哪个表面来(2026-10-19)。
   * 省略 ⇒ 真的是微信入站(wechat);null ⇒ 是 App 一轮但分不清 App / 浏览器,不写出生地。
   */
  readonly origin?: MatterOrigin | null
}

export type Middleware = (ctx: InboundCtx, next: () => Promise<void>) => Promise<void>
export type PipelineRun = (ctx: InboundCtx) => Promise<void>
