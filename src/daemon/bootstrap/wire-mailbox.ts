/**
 * wire-mailbox.ts — mounts the mailbox poller on the companion-scheduler tick
 * (~2 min jitter). Gated on social_enabled + a configured mailbox_relays list
 * by the caller (bootstrap/index.ts only constructs the deps when both hold);
 * inert otherwise — main.ts simply never registers this lifecycle. New daemon
 * wiring goes here, not index.ts. See spec §3.3.
 */
import { loadMailboxIdentity } from '../../core/mailbox-crypto'
import { makeMailboxClient } from '../../core/mailbox-client'
import { makeEnvelopeDispatch } from '../../core/mailbox-dispatch'
import { makeMailboxPoller } from '../../core/mailbox-poller'
import { makeCursorStore } from '../../core/mailbox-cursor-store'
import { startCompanionScheduler } from '../companion/scheduler'
import type { Lifecycle } from '../../lib/lifecycle'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { A2AServerOpts } from '../../core/a2a-server'

export interface MailboxPollerDeps {
  stateDir: string
  a2aRegistry: A2ARegistry
  onReveal: A2AServerOpts['onReveal']
  /** I1 — MUST be the own-channel-only handler (`SocialWiring.onMailboxLetter`),
   *  NEVER the HTTP `socialOnLetter` (which falls through to
   *  letterRelay.routeLetter for non-own channels). */
  onMailboxLetter: A2AServerOpts['onLetter']
  /** v2 (Task 8) — same onIntent/onEcho the HTTP /a2a/intent + /a2a/echo
   *  routes use; a mailbox-dropped envelope replays into the identical
   *  handler (bearer-verified via the registry, same as HTTP). Undefined ⇒
   *  makeEnvelopeDispatch drops the envelope, same posture as every other
   *  optional capability. */
  onIntent?: A2AServerOpts['onIntent']
  onEcho?: A2AServerOpts['onEcho']
  relays: string[]
  /** 补投未送达的揭晓(`revealer.retryUndelivered`)。挂在取件同一拍上:
   *  这一拍本来就是网络恢复后第一个动的东西,而「我同意了、但揭晓没送
   *  出去」的行如果没人自动补,owner 屏幕上写的是「已连接」,他根本不会
   *  再点一次 —— 能重试而没人重试等于没修。见 social-reveal.ts。 */
  retryUndeliveredReveals?: () => Promise<number>
  shouldRun: () => boolean
  log: (tag: string, line: string) => void
}

export function registerMailboxPoller(deps: MailboxPollerDeps): Lifecycle {
  const identity = loadMailboxIdentity(deps.stateDir)
  const poller = makeMailboxPoller({
    identity,
    relays: deps.relays,
    // 失败原因直接进日志:超时 / HTTP 状态码 / 网络错误原文。混成一句
    // 「取件失败」在真机上就是查不下去 —— 见 mailbox-client.ts 的 onError。
    client: makeMailboxClient({ onError: (op, reason) => deps.log('MAILBOX', `${op} 失败: ${reason}`) }),
    dispatch: makeEnvelopeDispatch({ registry: deps.a2aRegistry, onReveal: deps.onReveal, onLetter: deps.onMailboxLetter, onIntent: deps.onIntent, onEcho: deps.onEcho, log: deps.log }),
    cursors: makeCursorStore(deps.stateDir), log: deps.log,
  })
  const scheduler = startCompanionScheduler({
    name: 'mailbox', intervalMs: 120_000, jitterRatio: 0.3,
    shouldRun: deps.shouldRun,
    onTick: async () => {
      await poller.onTick()
      if (!deps.retryUndeliveredReveals) return
      // 绝不让补投打断取件:补投抛了也只是一条日志,下一拍再来。
      try {
        const n = await deps.retryUndeliveredReveals()
        if (n > 0) deps.log('MAILBOX', `补投揭晓 ${n} 条(此前投递失败,本地已同意)`)
      } catch (err) {
        deps.log('MAILBOX', `补投揭晓失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    log: deps.log,
  })
  let stopped = false
  return {
    name: 'mailbox-poller',
    stop: async () => { if (!stopped) { stopped = true; await scheduler.stop() } },
  }
}
