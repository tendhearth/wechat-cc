import type { UserTier } from '../../core/user-tier'

/**
 * route-tiers — the minimum tier each internal-api route requires. The
 * dispatcher resolves the caller's tier from its token (token-registry.ts) and
 * rejects anything below the route's minimum. Anything NOT listed defaults to
 * `admin` via minTierFor (fail-closed: a new route can't ship world-open).
 *
 * Tiers track the corresponding ToolKind's policy in user-tier.ts where one
 * exists; operator/infra routes are assigned explicitly. See
 * docs/superpowers/specs/2026-06-21-internal-api-tier-authz-design.md §5.
 */
export const TIER_RANK: Record<UserTier, number> = { guest: 0, trusted: 1, admin: 2 }

export function tierMeets(have: UserTier, need: UserTier): boolean {
  return TIER_RANK[have] >= TIER_RANK[need]
}

export const ROUTE_MIN_TIER: Record<string, UserTier> = {
  // guest — liveness + read/reply
  'GET /v1/health': 'guest',
  'POST /v1/wechat/reply': 'guest',
  'POST /v1/wechat/reply_voice': 'guest',
  'POST /v1/memory/read': 'guest',
  'GET /v1/memory/list': 'guest',
  'POST /v1/share/page': 'guest',
  'POST /v1/share/resurface': 'guest',
  'GET /v1/companion/status': 'guest',
  // send_sticker draws only from the curated sticker lib (pre-approved
  // images, no arbitrary-path read) and has no exfiltration surface —
  // same trust class as reply/reply_voice, so it's guest not trusted.
  'POST /v1/wechat/send_sticker': 'guest',
  'GET /v1/stickers': 'guest',
  // trusted — operator/agent ops (also reachable by the CLI, capped at trusted)
  'POST /v1/wechat/broadcast': 'trusted',
  'POST /v1/wechat/send_file': 'trusted',
  'POST /v1/wechat/edit_message': 'trusted',
  'POST /v1/memory/write': 'trusted',
  'POST /v1/memory/delete': 'trusted',
  'POST /v1/user/set_name': 'trusted',
  'POST /v1/voice/save_config': 'trusted',
  'GET /v1/voice/status': 'trusted',
  'POST /v1/stt/save_config': 'trusted',
  'GET /v1/stt/status': 'trusted',
  'POST /v1/companion/enable': 'trusted',
  'POST /v1/companion/disable': 'trusted',
  'POST /v1/companion/snooze': 'trusted',
  'POST /v1/companion/import-local': 'trusted',
  'POST /v1/conversation/set-mode': 'trusted',
  'GET /v1/projects/list': 'trusted',
  'POST /v1/projects/add': 'trusted',
  'POST /v1/projects/remove': 'trusted',
  'POST /v1/projects/switch': 'trusted',
  'GET /v1/a2a/list': 'trusted',
  'GET /v1/a2a/info': 'trusted',
  'GET /v1/a2a/activity': 'trusted',
  'POST /v1/a2a/preview': 'trusted',
  'POST /v1/a2a/install': 'trusted',
  'POST /v1/a2a/remove': 'trusted',
  'POST /v1/a2a/pause': 'trusted',
  'POST /v1/a2a/send': 'trusted',
  'POST /v1/a2a/test': 'trusted',
  'GET /v1/plugins/list': 'trusted',
  'POST /v1/plugins/toggle': 'trusted',
  'GET /v1/plugins/registry': 'trusted',
  'POST /v1/plugins/install': 'trusted',
  'POST /v1/plugins/upgrade': 'trusted',
  'GET /v1/license/status': 'trusted',
  'POST /v1/license/activate': 'trusted',
  'POST /v1/license/deactivate': 'trusted',
  'POST /v1/delegate': 'trusted',
  'POST /v1/chat-prefs': 'trusted',
  // POST /v1/stickers writes an arbitrary sourcePath into the lib — same
  // trust class as send_file, so it's trusted not guest.
  'POST /v1/stickers': 'trusted',
  // trusted (RESOLVED, P4 spec §3.3) — the CLI (social propose/confirm/cancel)
  // holds only the daemon-wide FILE token (→ trusted); an admin-tiered route
  // would 403 every CLI call. internal-api is 127.0.0.1 + 0600 file token = the
  // owner. confirm IS the real "broadcast to strangers" step, so FLAG all three
  // for the release security review. See docs/superpowers/specs/2026-07-20-p4-seek-confirm-design.md.
  'POST /v1/social/seek/propose': 'trusted',
  'POST /v1/social/seek/confirm': 'trusted',
  'POST /v1/social/seek/cancel': 'trusted',
  // admin — owner-only same-session power: drives a real turn on the
  // owner's own chat session and returns the reply to the caller (app
  // conversation channel, voice arc Stage 0). Same trust class as the
  // other admin daemon-control routes below.
  'POST /v1/companion/converse': 'admin',
  // admin — same trust class as converse above (voice arc Stage 1): synths
  // reply audio for the owner's app-conversation-channel session.
  'POST /v1/companion/speak': 'admin',
  // admin — voice arc Stage 2: transcribes inbound app-channel audio to text.
  'POST /v1/companion/transcribe': 'admin',
  // admin — daemon-control (daemon_introspect / daemon_remediate)
  'GET /v1/turns': 'admin',
  'GET /v1/sessions': 'admin',
  'GET /v1/model': 'admin',
  'POST /v1/sessions/release': 'admin',
  'POST /v1/model': 'admin',
  'POST /v1/daemon/restart': 'admin',
  // admin — on-demand file locate over the owner's computer (file_locate)
  'GET /v1/locate': 'admin',
  // trusted — 觅食台 read surface + inbound toggle. DEMOTED admin→trusted
  // 2026-07-22: the desktop's ONLY credential is the daemon-wide FILE token
  // (= trusted; `daemon api-info` hands out the file token, and the admin
  // operator token is route-scoped to converse/speak) — admin here 403'd
  // every real-daemon 觅食台 read, silently rendering "社交觅食未启用"
  // even when wired. Found by live visual acceptance; same root cause as
  // the earlier reveal-route demotion below. Trust analysis: these expose
  // the owner's own stored seeks/echoes/pledges to a local caller who
  // already holds the credential that can pair, propose+confirm seeks and
  // send letters — the read is the weaker capability. localhost-only,
  // 0600 file token. ⚠️ RELEASE-REVIEW FLAG (surface at next dev→master).
  'GET /v1/social/seeks': 'trusted',
  'GET /v1/social/echoes': 'trusted',
  'GET /v1/social/inbound': 'trusted',
  'POST /v1/social/inbound': 'trusted',
  'GET /v1/social/pledges': 'trusted',
  // trusted, not admin — despite living in the same "async foraging spine"
  // batch as the admin-tiered routes above. Reveal acts on an ALREADY
  // established seek/pledge (double opt-in on a match), not a new broadcast —
  // same trust class as POST /v1/a2a/send ("reply to an established peer",
  // trusted, in the operator/agent-ops block above), not the admin-tiered
  // read routes above (GET seeks/echoes/pledges/inbound, which expose the
  // owner's full stored history rather than acting on one row). This also
  // has to be trusted because it's the write half of `wechat-cc social reveal`
  // (docs/superpowers/specs/2026-07-17-cli-social-surface-design.md), and the
  // CLI only ever holds the daemon-wide FILE token (registerFileToken →
  // trusted, see token-registry.ts) — an admin-tiered route here would
  // silently 403 every CLI reveal (caught by cli-routes.test.ts).
  'POST /v1/social/echoes/reveal': 'trusted',
  'POST /v1/social/pledges/reveal': 'trusted',
  // trusted — 配对码 (spec §7). Same trust class as a2a/send + social reveal:
  // internal-api is 127.0.0.1 + 0600 file token; the CLI holds the FILE token
  // (trusted). Acts on an operator-driven pairing, not a world-open broadcast.
  'POST /v1/pair/start': 'trusted',
  'POST /v1/pair/accept': 'trusted',
  // 笔友信箱(spec 2026-07-22-penpal-mailbox-desktop)。读=admin(P2
  // seeks/echoes 读路由先例:桌面 token 是 admin)。发信=trusted —
  // ⚠️ RELEASE-REVIEW FLAG(下次 dev→master 发布时在 PR body surface):
  // 作用于已互揭的既有信道(同 reveal / a2a/send 类),不产生新广播或
  // 新关系;localhost-only internal-api + 0600 文件 token。顺带解锁
  // 未来的 CLI 回信入口。
  // (2026-07-22 same-day demotion: reads were born admin copying the P2
  // precedent — which the live acceptance above proved wrong for the
  // desktop's trusted file token. All four are trusted now.)
  'GET /v1/penpal/channels': 'trusted',
  'GET /v1/penpal/letters': 'trusted',
  'POST /v1/penpal/letters': 'trusted',
  'POST /v1/penpal/letters/read': 'trusted',
  'POST /v1/penpal/letters/resend': 'trusted',
}

export function minTierFor(routeKey: string): UserTier {
  return ROUTE_MIN_TIER[routeKey] ?? 'admin'
}
