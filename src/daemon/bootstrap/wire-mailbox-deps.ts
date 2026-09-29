/**
 * wire-mailbox-deps.ts — content-blind mailbox 轮询器的 deps(main.ts 据此决定挂不挂
 * registerMailboxPoller)。从 bootstrap/index.ts 逐字搬出(2026-09-27 bootstrap 拆分,
 * spec 2026-09-27-bootstrap-split-design);块内逻辑与注释不变,只参数化:
 * deps.stateDir/log → ctx.*,configuredAgent → ctx.configuredAgent,a2aRegistry /
 * socialWiring.onMailboxLetter / readAgentConfig 走 parts.*。
 */
import type { A2ARegistry } from '../../core/a2a-registry'
import type { Bootstrap, BootstrapCtx } from './types'
import type { SocialWiring } from './wire-social'
import type { ModelOptionsSlice } from './wire-model-options'

export function wireMailboxDeps(
  ctx: Pick<BootstrapCtx, 'stateDir' | 'log' | 'configuredAgent'>,
  parts: { a2aRegistry: A2ARegistry; onMailboxLetter: SocialWiring['onMailboxLetter']; readAgentConfig: ModelOptionsSlice['readAgentConfig'] },
): Bootstrap['mailboxPollerDeps'] {
  // Content-blind mailbox transport (sub-project B, Task 8) — the poller's
  // deps, constructed only when social wiring is live AND at least one relay
  // is configured. main.ts mounts `registerMailboxPoller(mailboxPollerDeps)`
  // on the companion scheduler iff this is present; otherwise the feature
  // stays fully inert (no poll timer, no relay traffic). I1: `onMailboxLetter`
  // is `socialWiring.onMailboxLetter` (own-channel-only) — the only inbound
  // arm a bearer-less mailbox drop may reach.
  const mailboxRelays = ctx.configuredAgent.mailbox_relays ?? []
  return (ctx.configuredAgent.social_enabled && mailboxRelays.length > 0 && parts.onMailboxLetter)
    ? {
        stateDir: ctx.stateDir,
        a2aRegistry: parts.a2aRegistry,
        onMailboxLetter: parts.onMailboxLetter,
        relays: mailboxRelays,
        // Re-checked at every tick (mtime-cached read) so a `/set` toggle of
        // social_enabled takes effect without a daemon restart, same posture
        // as the companion schedulers' shouldRun gates.
        shouldRun: () => parts.readAgentConfig().social_enabled === true,
        log: ctx.log,
      }
    : undefined
}
