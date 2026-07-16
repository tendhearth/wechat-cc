# 觅食台 P3 — Desktop Page Handoff

> **Audience:** the session that owns the desktop app (`apps/desktop`). This is a
> handoff, not a plan. The backend (P1 state layer + P2 read/toggle routes) is
> **shipped to `dev`**; this doc hands you everything to build the visible page.
> Written 2026-07-15 by the backend session.

## The one-paragraph "why"

The Agent page (`apps/desktop/src/modules/a2a-agents.js`) is being reframed from a
**contact list of friends' bots** into a **觅食台 (forager's desk)**. The insight
(user-driven): you can already reach a friend on WeChat — the A2A network's value
is reaching *through* it to people/things you can't see directly (six-degrees),
behind a privacy/proxy layer. Your bot forages the social graph on your behalf
(travel-frog), anonymously; identities are revealed only on mutual dual-confirm.
So the page is **派心愿 → 带回明信片 → 揭晓牵线**, not a contact list.

- **Design spec:** `docs/superpowers/specs/2026-07-15-forage-desk-agent-page-design.md`
- **Approved visual mockup** ("就这个味"): https://claude.ai/code/artifact/28adff51-a8aa-48d3-bf13-48aee7087c9f
  (3 blocks: 心愿 / 明信片 / 折叠的觅食网+入站 toggle; warm storybook + travel-frog;
  degree bar left in for multi-hop-ready, but 1-hop today.)
- **Vision memory:** `[[forage-desk-social-direction]]`, `[[keep-desktop-ui-simple]]`.

## What's shipped for you (the contract you consume)

All via the existing desktop api client — `import { invokeApi } from '../api.js'`,
exactly as `a2a-agents.js` already calls `/v1/a2a/*`. Port/token/IPC plumbing is
handled for you; you just call the route. All four routes are **admin-tiered**
(the desktop session token is admin — no extra work), and the two read routes +
`POST /seek` return **503 `{error:'social_not_wired'}`** when the social broker
isn't configured (handle it as an empty/"未启用" state, same as `/v1/a2a/info`'s
`.catch(() => null)` pattern).

### Read the wishes — `GET /v1/social/seeks`
```
{ seeks: SeekRow[] }   // newest first (ORDER BY created_at DESC)
SeekRow = {
  id: string
  kind: 'seek' | 'fun'                                   // 求物求人 | 朋友间小乐趣
  topic: string                                          // the wish text
  status: 'foraging' | 'echoed' | 'connected' | 'closed' // 觅食中 | 有回声 | 已牵线 | 已关闭
  hop: number                                            // 1 today (multi-hop-ready)
  peers_asked: number
  created_at: string  // ISO
  updated_at: string  // ISO
}
```

### Read the postcards — `GET /v1/social/echoes`
```
{ echoes: EchoRow[] }  // newest first, ALL echoes across all seeks
EchoRow = {
  id: string
  seek_id: string       // join back to a SeekRow.id
  peer_masked: string    // anonymized peer label — show as-is, never un-mask client-side
  degree: number         // hops away (1 today)
  content: string        // the postcard body
  status: 'pending' | 'revealed' | 'declined'
  created_at: string
}
```
Group echoes under their seek by `seek_id` for the "明信片" block.

### Inbound on/off — `GET` / `POST /v1/social/inbound`
```
GET  -> { enabled: true, host, port } | { enabled: false }
POST { enabled: boolean } -> { enabled, restart_required: true }
```
This is the folded "觅食网" toggle at the bottom of the mockup. **`restart_required`
is always true** — the A2A listen socket binds at daemon boot, so flipping the
toggle does NOT take effect until the daemon restarts. You MUST surface that in the
UI (e.g. a "需重启生效" note after toggling) — do not imply it's live. Empty/malformed
POST body reads as `enabled:false` (guarded server-side).

## Buildable now vs. gated — the honest boundary

> **UPDATED 2026-07-15:** the **async foraging spine shipped to `dev`** (`bd1b025..e045cf9`),
> so the reveal action below is **now buildable** — earlier this section said "no reveal
> button; nothing to call." The reveal ROUTES now exist. See the new reveal contract.

**Build now (all data is real & persisted):**
- The 心愿 list (from `/seeks`), with `kind` and `status` badges. Status is now a real
  async lifecycle: `foraging`(觅食中) → `echoed`(有回声) → `connected`(已牵线) / `closed`.
- The 明信片 list grouped per wish (from `/echoes`).
- **The "揭晓牵线" reveal action — NOW LIVE.** For a `pending` echo, add a 揭晓 button →
  `POST /v1/social/echoes/reveal { id }` (id = the echo's `id`, i.e. `intent_id:peer_agent_id`).
  Answerer-side pledges reveal via `POST /v1/social/pledges/reveal { id }`. Response
  `{ outcome: { state } }` where `state` ∈ `connected` | `awaiting_peer` | `peer_unreachable`;
  404 `{error:'not_found'}` on an unknown id. **The model is mutual async ("双向异步互揭"):
  your click IS your consent; the backend only asks the peer. So render three states —
  `awaiting_peer`("已揭晓,等对方回揭"), `connected`(the echo's `peer_masked` is now the
  real name — swapped server-side only on mutual), `peer_unreachable`(retryable). Not
  every reveal instantly connects.**
- The 觅食网 inbound toggle (with the restart-required note above).
- Empty/503/未启用 states.
- **`GET /v1/social/pledges`** → `{ pledges: PledgeRow[] }` — the answerer side ("我回应了别人
  的心愿"). `PledgeRow = { id, intent_id, seeker_agent_id, topic, self_revealed_at,
  peer_revealed_at, created_at }`. Optional block; pledge reveals use the pledges/reveal route.

**Still gated / defer:**
- **Live real-time "觅食中" trickle.** Echoes are persisted as the background forage lands
  them, not streamed. **Poll** `/seeks`+`/echoes` on an interval (like the other pollers)
  for the trickle-in feel; there's no push channel.
- **Creating a wish from the desktop.** No desktop write route yet — seeks are created by
  the bot via WeChat/`social_seek` tooling. `POST /v1/social/seek` exists but is the bot's
  path. Keep the mockup's "派心愿" input **display-only for P3** (or omit) until a desktop
  create story lands. (`seek()` is now non-blocking, so a future desktop create won't hang —
  but the route/UX isn't specced yet.)
- **Multi-hop ("朋友的朋友").** 1-hop today; `degree` is in the data model but forwarding is
  spec #2. Show `degree` if you like, but expect `1`.

## Guardrails (from prior coordination)

- **Isolated git worktree off `dev`.** The repo's main checkout is the *other*
  session's live daemon — don't disturb it.
- **`desktop-e2e` CI is persistently red** (Playwright drawer timeouts, non-required)
  — `[[desktop-e2e-persistent-red]]`. Don't let it block you, but don't add new
  drawer-timeout flakiness either.
- **Keep it simple** — `[[keep-desktop-ui-simple]]`: prefer reworking the existing
  `a2a-agents.js` module in place over new panes/routing.
- Match the mockup's warmth but respect the repo's existing desktop styles/tokens.

## Open questions for you

1. Keep the "派心愿" input as display-only, omit it, or wire it to the blocking
   `POST /seek` for P3? (Recommend: omit or display-only until async rework.)
2. Poll interval for freshness — match `conversations-poller.js`?
3. Does the degree/hop bar earn its place at 1-hop, or hide until multi-hop ships?
