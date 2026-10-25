/**
 * wire-pairing.ts — construct the 配对码 engine from real daemon deps (spec §7:
 * "配对执行体在 daemon 内"). Built ONLY when mailbox_relays is configured — the
 * rendezvous uses the daemon's own mailbox_relays[0] as the meeting relay, so
 * with no relay the feature is inert (boot.pairing stays undefined, mirroring
 * boot.social/boot.penpal).
 *
 * selfId is NOT resolved here. bootstrap/index.ts resolves it exactly ONCE
 * (resolveSelfAgentId) and threads the SAME constant into wireSocial,
 * wirePairing, and pipeline-deps' exec/hands delegate path, so every
 * outbound seam self-reports the identical agent_id. resolveSelfAgentId
 * persists on its generate/grandfather branch; calling it again here (let
 * alone lazily, per pairing-engine tick) would re-enter that persistence and
 * risk a slug-minting daemon broadcasting two different identities.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { makePairing, type PairingEngine } from '../../app/pairing'
import { makeMailboxClient } from '../../adapters/mailbox/mailbox-client'
import { loadMailboxIdentity } from '../../adapters/mailbox/mailbox-crypto'
import { makeChannelStore } from '../../adapters/store/penpal-channel-store'
import { generateKeypair } from '../../adapters/mailbox/penpal-crypto'
import type { A2ARegistry } from '../../adapters/a2a/a2a-registry'
import type { AgentConfig } from '../../lib/agent-config'
import type { Db } from '../../lib/db'
import { makeTellOwnerAs, type TellOwnerDeps } from '../../features/social'

export interface PairingWireDeps {
  stateDir: string
  configuredAgent: AgentConfig
  a2aRegistry: A2ARegistry
  /** 配对即开信道(spec 2026-09-04-wish-postcard §2)所需的持久层。 */
  db: Db
  /** Resolved ONCE by bootstrap/index.ts (resolveSelfAgentId) — shared with
   *  wireSocial + pipeline-deps' delegate path. Never re-resolved here. */
  selfId: string
  /** This daemon's own a2a_listen base url, when configured. Carried on the
   *  self-card (spec §5: "url <a2a_listen 可达地址，可缺省>") so a peer that
   *  pairs with us can ALSO reach us over push — the registry's forwarding
   *  filters treat a mailbox-transport record that carries a url as
   *  forward-eligible (see wire-social's forwardTargets). undefined when
   *  a2a_listen isn't configured; the resulting peer record is then fully
   *  url-less (pure NAT'd mailbox peer).
   */
  url?: string
  /**
   * 配对的结果(「连上了 ✓」「配对码过期了」)经 CC 开口那道门告诉主人:kind = pairing(requested —— 主人自己说了「配对」
   * 在等这一句,不是等他拍板)。门取不到 ⇒ 不发、记一行,不退回直接发(social-tell.ts)。
   */
  tellOwner: TellOwnerDeps
  log: (tag: string, msg: string) => void
}

export function wirePairing(deps: PairingWireDeps): PairingEngine | undefined {
  const tellPairing = makeTellOwnerAs('pairing', deps.tellOwner)
  const relays = deps.configuredAgent.mailbox_relays
  if (!relays?.length) return undefined

  const mailbox = loadMailboxIdentity(deps.stateDir) // idempotent read; persists on first ever use
  const engine = makePairing({
    client: makeMailboxClient(),
    registry: deps.a2aRegistry,
    self: { mailbox_addr: mailbox.addr, mailbox_enc_pub: mailbox.enc_pub, relays },
    selfId: () => deps.selfId,
    name: () => deps.configuredAgent.bot_name ?? 'wechat-cc',
    url: () => deps.url,
    now: () => Date.now(),
    mintKey: () => randomBytes(24).toString('hex'), // 48 chars, >= 16
    genCode: () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
    genNonce: () => randomBytes(8).toString('hex'),
    notify: (msg) => { void tellPairing(msg) },
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); if (typeof t.unref === 'function') t.unref(); return { cancel: () => clearTimeout(t) } },
    log: (m) => deps.log('PAIR', m),
    channelStore: makeChannelStore(deps.db),
    genChannel: () => { const kp = generateKeypair(); return { channelId: randomUUID(), pubkey: kp.publicKey, privkey: kp.privateKey } },
  })
  deps.log('BOOT', `pairing: wired (rendezvous relay ${relays[0]})`)
  return engine
}

/**
 * 配对是一个模块(第三批 3b 第 5 步):开关是 `mailbox_relays`(不看 social_enabled,是刻意的)。
 * 停法经 `own` 登记 —— 以前由 runtime/shutdown 经 boot() 停,开机没走完时停不到。
 */
export function pairingModule(deps: PairingWireDeps): import('../modules/container').DaemonModule<PairingEngine> {
  return {
    name: 'pairing',
    optional: true,
    enabled: () => !!deps.configuredAgent.mailbox_relays?.length,
    init(m) {
      const engine = wirePairing(deps)
      if (!engine) throw new Error('pairing: no mailbox relays')   // enabled() 已经挡过,到不了
      m.own('engine', () => engine.stop())
      return engine
    },
  }
}
