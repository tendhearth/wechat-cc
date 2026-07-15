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

**Build now (all data is real & persisted):**
- The 心愿 list (from `/seeks`), with `kind` and `status` badges.
- The 明信片 list grouped per wish (from `/echoes`).
- The inbound toggle (with the restart-required note).
- Empty/503/未启用 states.

**Do NOT build yet — gated on the async-foraging rework (a separate backend project):**
- **The "揭晓牵线" reveal action.** P1's `broker.seek()` is *synchronous one-shot*
  (discover→send→dual-confirm→return in one call). There is **no** "reveal later"
  endpoint — dual-confirm already happened inside the original seek. So render
  `status:'connected'` / `echo.status:'revealed'` as *state*, but **do not add a
  reveal button** — there's nothing to call. Leave a placeholder/disabled affordance
  at most.
- **The live "觅食中 · trickle-back" animation.** Seeks/echoes are written at seek
  time, not streamed. Poll `/seeks`+`/echoes` on an interval (like the other
  pollers) for freshness; don't promise real-time trickle.
- **Creating a wish from the desktop.** No write route exists yet (seeks are created
  by the bot via WeChat/tooling). The "派心愿" input in the mockup is **display-only
  for P3** unless/until a `POST /seek`-from-desktop story is added. Either omit the
  input or wire it to the existing `POST /v1/social/seek` **knowing it blocks** (it
  runs the full synchronous seek) — recommend omitting for P3.

When the async rework lands, the reveal action + a non-blocking create + live trickle
all become buildable; this page should be structured so they slot in.

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
