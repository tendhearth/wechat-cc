/**
 * internal-api social route — agent-social M1 (T7b-core). Mirrors
 * routes-a2a.ts's `/v1/a2a/send` shape: 503 when the broker isn't wired
 * (social_enabled + social_disclosure_policy not both configured), else
 * delegate straight to the broker. Split into its own file (rather than
 * appended to routes-a2a.ts) since agent-social is a distinct
 * capability/trust surface from the bare a2a exec/notify/pair routes — see
 * docs/superpowers/specs/2026-07-12-agent-social-m1-intent-brokering-design.md.
 *
 * P4 派心愿 (docs/superpowers/specs/2026-07-20-p4-seek-confirm-design.md)
 * replaced the one-shot POST /v1/social/seek with propose→confirm/cancel:
 * propose gates + persists a redacted preview WITHOUT broadcasting; confirm
 * flips it to foraging (broadcasts the stored redacted wording verbatim,
 * WYSIWYG); cancel voids a still-`proposed` row. The deprecated `seek()`
 * bridge lives on in the broker for other pre-split callers until Task 7.
 */
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import { toPublicEcho } from '../../core/social-echo-store'
import type { InternalApiDeps, RouteTable } from './types'
import { applySocialSwitch } from '../../cli/social-enable'

export function socialRoutes(deps: InternalApiDeps): RouteTable {
  return {
    // P4 派心愿 — propose→confirm split (replaces the deleted one-shot
    // POST /v1/social/seek). All three are inline-validated (no
    // REQUEST_SCHEMAS entry), mirroring the pair/inbound routes' precedent;
    // results are passed through verbatim — no notify here (that lives in
    // the broker/wire-social layer).
    'POST /v1/social/seek/propose': async (_q, body) => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      const { topic, city } = (body ?? {}) as { topic?: string; city?: string }
      if (typeof topic !== 'string' || topic.length === 0) return { status: 400, body: { error: 'missing_topic' } }
      const r = await deps.social.broker.propose(topic, city ? { city } : undefined)
      return { status: 200, body: r }
    },
    'POST /v1/social/seek/confirm': async (_q, body) => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id.length === 0) return { status: 400, body: { error: 'missing_id' } }
      return { status: 200, body: await deps.social.broker.confirmSeek(id) }
    },
    'POST /v1/social/seek/cancel': async (_q, body) => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id.length === 0) return { status: 400, body: { error: 'missing_id' } }
      return { status: 200, body: await deps.social.broker.cancelSeek(id) }
    },
    // 觅食台 P2 — read routes over P1's stored rows (dashboard/CLI listing).
    'GET /v1/social/seeks': async () => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      return { status: 200, body: { seeks: deps.social.seekStore.list() } }
    },
    // peer_agent_id / relay_via / relay_token are server-side only pre-reveal
    // (spine spec) — project through toPublicEcho's allowlist so the real
    // identity behind peer_masked can't leak to the frontend before the
    // owner's friend double-opt-in reveals it.
    'GET /v1/social/echoes': async () => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      return { status: 200, body: { echoes: deps.social.echoStore.listAll().map(toPublicEcho) } }
    },
    // 觅食台 P2 Task 3 — inbound on/off toggle over a2a_listen, replacing the
    // "hand-edit agent-config.json" instruction. restart_required: true
    // because the A2A server binds a2a_listen at boot (bootstrap/index.ts);
    // live rebind is out of scope for this pass.
    'GET /v1/social/inbound': async () => {
      const l = loadAgentConfig(deps.stateDir).a2a_listen
      return { status: 200, body: l ? { enabled: true, host: l.host, port: l.port } : { enabled: false } }
    },
    // 社交总开关。**刻意不依赖 deps.social** —— 社交没开时那个字段根本不存在,
    // 而"没开"恰恰是唯一需要这条路由的时候。它只读写 agent-config.json,与
    // `wechat-cc social enable` 共用 applySocialSwitch 那一份逻辑。
    //
    // 为什么需要它:此前桌面端三处入口(配对面板、笔友信箱、寄信)在社交未
    // 启用时只会说「先在命令行运行 wechat-cc social enable」—— 一个桌面产品
    // 把人踢回终端。被朋友拉来试用的人基本必然卡死在这一步。
    'POST /v1/social/enable': async (_q, body) => {
      const enabled = !!((body ?? {}) as { enabled?: unknown }).enabled
      const r = applySocialSwitch(deps.stateDir, enabled)
      // 配对引擎/社交接线都在 boot 时完成,所以两个方向都要重启才生效。
      return { status: 200, body: { ...r, restart_required: true } }
    },
    'POST /v1/social/inbound': async (_q, body) => {
      // `body` is null on an empty/`null` request body (readJsonBody) — guard
      // it (as the sibling inline-validated POST routes do) so a missing body
      // reads as `enabled:false` instead of throwing a 500.
      const enabled = !!((body ?? {}) as { enabled?: unknown }).enabled
      const cfg = loadAgentConfig(deps.stateDir)
      const updated = enabled
        ? { ...cfg, a2a_listen: { host: '127.0.0.1', port: 8717 } }
        : (() => { const { a2a_listen, ...rest } = cfg; return rest })()
      saveAgentConfig(deps.stateDir, updated)
      return { status: 200, body: { enabled, restart_required: true } }
    },
    // async foraging spine — the answerer's pledge rows (mirrors GET echoes).
    'GET /v1/social/pledges': async () => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      return { status: 200, body: { pledges: deps.social.pledgeStore.list() } }
    },
    // 揭晓 — desktop reveal buttons. id comes in the BODY (router is exact-match,
    // no :id path params). null outcome ⇒ no such row ⇒ 404.
    'POST /v1/social/echoes/reveal': async (_q, body) => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id.length === 0) return { status: 400, body: { error: 'missing_id' } }
      const outcome = await deps.social.revealer.revealEcho(id)
      if (outcome === null) return { status: 404, body: { error: 'not_found' } }
      return { status: 200, body: { outcome } }
    },
    'POST /v1/social/pledges/reveal': async (_q, body) => {
      if (!deps.social) return { status: 503, body: { error: 'social_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id.length === 0) return { status: 400, body: { error: 'missing_id' } }
      const outcome = await deps.social.revealer.revealPledge(id)
      if (outcome === null) return { status: 404, body: { error: 'not_found' } }
      return { status: 200, body: { outcome } }
    },
  }
}
