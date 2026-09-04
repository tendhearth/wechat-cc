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
  /** I1 — MUST be the own-channel-only handler (`SocialWiring.onMailboxLetter`),
   *  NEVER the HTTP `socialOnLetter` (which falls through to
   *  letterRelay.routeLetter for non-own channels). */
  onMailboxLetter: A2AServerOpts['onLetter']
  relays: string[]
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
    dispatch: makeEnvelopeDispatch({ onLetter: deps.onMailboxLetter, log: deps.log }),
    cursors: makeCursorStore(deps.stateDir), log: deps.log,
  })
  const scheduler = startCompanionScheduler({
    name: 'mailbox', intervalMs: 120_000, jitterRatio: 0.3,
    shouldRun: deps.shouldRun,
    onTick: async () => { await poller.onTick() },
    log: deps.log,
  })
  let stopped = false
  return {
    name: 'mailbox-poller',
    stop: async () => { if (!stopped) { stopped = true; await scheduler.stop() } },
  }
}
