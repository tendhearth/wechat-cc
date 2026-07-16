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
  // admin — agent-social M1 (social_seek is ADMIN_ONLY in user-tier.ts;
  // actively broadcasts an intent to external A2A agents, unlike a2a_send's
  // reply-to-an-established-peer). Would default to admin anyway (unlisted
  // routes fail-closed) — listed explicitly for documentation.
  'POST /v1/social/seek': 'admin',
  // admin — same trust class as social_seek above (觅食台 P2): read-only,
  // but exposes the owner's stored seeks/echoes (topics + peer exchanges).
  'GET /v1/social/seeks': 'admin',
  'GET /v1/social/echoes': 'admin',
  // admin — inbound on/off toggle (觅食台 P2 Task 3): writes a2a_listen in
  // agent-config.json, the same trust surface as hand-editing the config.
  'GET /v1/social/inbound': 'admin',
  'POST /v1/social/inbound': 'admin',
  // admin — async foraging spine: read the answerer's pledges + trigger reveals.
  'GET /v1/social/pledges': 'admin',
  'POST /v1/social/echoes/reveal': 'admin',
  'POST /v1/social/pledges/reveal': 'admin',
}

export function minTierFor(routeKey: string): UserTier {
  return ROUTE_MIN_TIER[routeKey] ?? 'admin'
}
