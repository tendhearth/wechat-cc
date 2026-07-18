# 觅食台 P3 — Desktop Forage-Desk Page (Agent pane rework)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the desktop **Agent (A2A)** pane into the approved **觅食台 (forager's desk)** — hero (living forage status) + ① 我派出去的心愿 (wish cards) + ② 带回来的明信片 (postcards + reveal) + ③ 你的觅食网 (folded net: inbound toggle + connected peers + add-peer + depth note) — wired to the P2 social routes. This is a **transcription-from-mockup + data-wiring** task: the steps below carry the literal `fd-`-prefixed HTML/CSS/JS, not descriptions of it.

**Architecture:** Rework `apps/desktop/src/modules/a2a-agents.js` **in place**, keeping its exported names (`initA2AAgentsTab`, `refresh`) so `main.js` needs no change. `refresh()` fetches four routes (`/v1/a2a/list`, `/v1/social/seeks`, `/v1/social/echoes`, `/v1/social/inbound`), assembles `{agents, seeks, echoes, inbound}`, and calls a new pure-ish `renderForageDesk(data)`. The existing agent-management flow (Add / pause / remove / activity / test) is **preserved verbatim and folded into §③** — the `<ul id="a2a-agents-list">` + `.a2a-agent-card` rendering + the delegated `onCardAction` handler + all three reused dialogs stay intact.

**Tech Stack:** Vanilla ES modules (`// @ts-check` JSDoc), Vitest (jsdom-free DOM stubs, mirroring `modules/dashboard.test.ts`), the daemon internal-api via `invokeApi` from `../api.js`.

---

## Global Constraints

- **CSS var strategy — RESOLVED (do not reopen):** introduce the mockup's forage-specific palette as **pane-scoped `--fd-*` vars** under `[data-pane="a2a-agents"]` (e.g. `--fd-ground:#FBF6EA; --fd-amber:#DDA23F; --fd-clay:#D2794A; --fd-sage:#8AA36F; --fd-card:#FFFDF8; …`). The forage-desk keeps the mockup's **exact** warmth without redefining the app's global tokens. **Every** mockup class is renamed with an `fd-` prefix (`.fd-wish`, `.fd-pulse`, `.fd-postcard`, `.fd-toggle`, `.fd-btn`, …) so it cannot collide with existing app CSS (the app already owns bare `.btn`, `.pulse`, etc.). The `fd-` prefix is applied **consistently across HTML + CSS + JS render code**.
- **Hero numbers — sourced, not fabricated (state each):**
  - `连着 N 位朋友的 bot` → `N = agents.length` from `/v1/a2a/list` (real).
  - `替你问过 M 个` → `M = Σ seek.peers_asked` across all seeks (real). **Adapted from the mockup's "今天替你问过 12 个": the "今天" (per-day) qualifier is DROPPED** — there is no cheap per-day timestamp filter on peers_asked. The label reads `替你问过 M 个`, honest about being a running total.
  - `X 条带回音了` → `X = echoes.length` from `/v1/social/echoes` (real).
  - When social routes are unwired (503 `social_not_wired` → `null`), the counts fall back to a static-but-honest `—` and a "社交功能未启用" note; the agent count still renders from `/v1/a2a/list`.
- **Preserve the agent-management flow.** The pane's Add / pause / remove / activity / test flows and the three reused top-level dialogs (`#a2a-add-modal`, `#a2a-test-modal`, `#a2a-activity-drawer`) MUST stay. They are moved (not deleted) into §③'s net-body. `initA2AAgentsTab` + `refresh` keep their exported signatures (`main.js:35` imports them; `refreshA2AAgents()` on pane-show `:450`, `initA2AAgentsTab()` at `:1215`). **Verify main.js needs no edit.**
- **Reveal is echo-only here.** Clicking 揭晓牵线 → `POST /v1/social/echoes/reveal { id }` where `id` = the echo's `id`. Render the three async outcomes (`connected` / `awaiting_peer` / `peer_unreachable`). **Do NOT add a pledges surface** (`GET /v1/social/pledges`, `POST /v1/social/pledges/reveal`) — this page is the seeker's desk, not the answerer's.
- **Creating a wish is display-only for P3.** No desktop write route is specced. The hero's `＋ 撒一个新心愿` button does NOT POST; on click it shows an inline WeChat-first hint (`在微信里跟 CC 说「帮我悄悄找…」`). Non-crashing.
- **Multi-hop is 1-hop today.** `hop`/`degree` are in the data model but forwarding isn't shipped. The degree bar renders 第 1 度 lit, 第 2/3 度 as dashed `next` ("待开"). It earns its place as multi-hop-ready and renders honestly at `第 {hop} 度`.
- **desktop-e2e (Playwright) is persistently red + non-required.** Do NOT block on it or chase it. Task 1 preserves the structural anchors it (and the required `shim.e2e.test.ts`) rely on. **Note:** `apps/desktop/playwright/a2a.spec.ts` asserts `.a2a-agent-card` **visibility**; those cards now live inside a folded `<details>`, so that non-required suite may need a `summary` click added later — **out of P3 scope, flag it, don't fix it here.** The **required** anchor guard is the id-string check in `shim.e2e.test.ts`, which is visibility-agnostic and is updated in Task 1.
- **Do NOT touch** the `plugins` pane or any non-`a2a-agents` pane (the other session's live area). All edits are confined to: `index.html` (the `a2a-agents` article + its nav link + the `shim.e2e.test.ts` anchor list), `styles.css` (append only), `modules/a2a-agents.js`, and the new `modules/a2a-agents.test.ts`.

---

## Route contract consumed (from P2, shipped to `dev`)

All via `import { invokeApi } from '../api.js'`. All admin-tiered (desktop token is admin). Read routes return **503 `{error:'social_not_wired'}`** when the broker isn't configured → handle with `.catch(() => null)`.

```
GET  /v1/a2a/list              -> { agents: A2AAgent[] }         // already used by the module
GET  /v1/social/seeks          -> { seeks: SeekRow[] }           // newest first
GET  /v1/social/echoes         -> { echoes: PublicEchoRow[] }    // newest first, ALREADY MASKED
GET  /v1/social/inbound        -> { enabled, host, port } | { enabled:false }
POST /v1/social/inbound {enabled}         -> { enabled, restart_required:true }
POST /v1/social/echoes/reveal {id}        -> { outcome:{ state } }  state ∈ connected|awaiting_peer|peer_unreachable ; 404 {error:'not_found'}

SeekRow        = { id, kind:'seek'|'fun', topic, status:'foraging'|'echoed'|'connected'|'closed', hop, peers_asked, created_at, updated_at }
PublicEchoRow  = { id, seek_id, peer_masked, degree, content, status:'pending'|'revealed'|'declined', created_at }
```

**Privacy:** `PublicEchoRow` is already masked server-side — it carries **no** `peer_agent_id`. The render path reads `peer_masked` only and never un-masks client-side. Post-mutual-reveal the server swaps `peer_masked` to the real name; the client shows it as-is.

---

## File Structure

- **Modify** `apps/desktop/src/index.html` — rework the `data-pane="a2a-agents"` `<article>` (~`:577`) into the 觅食台 structure; relabel the nav link (~`:336`, `Agent`) to `觅食`; keep the three reused dialogs (`:622`, `:651`, `:671`) untouched.
- **Modify** `apps/desktop/shim.e2e.test.ts` — extend the `requiredIds` list (~`:87`) with the new stable `fd-*` + preserved `a2a-*` anchors.
- **Modify** `apps/desktop/src/styles.css` — append the `fd-`-prefixed 觅食台 stylesheet (pane-scoped `--fd-*` vars + reduced-motion guard) after the existing A2A block (~`:5027`).
- **Modify** `apps/desktop/src/modules/a2a-agents.js` — add `renderForageDesk(data)` + helpers, rewire `refresh()`, add reveal + inbound-toggle handlers, keep the agent-mgmt functions and exports.
- **Create** `apps/desktop/src/modules/a2a-agents.test.ts` — module render + action tests (mirror `dashboard.test.ts`).
- **Verify (no edit)** `apps/desktop/src/main.js` — imports/calls unchanged.

---

## Task 1: DOM + nav relabel + shim anchors (static structure)

**Files:**
- Modify: `apps/desktop/src/index.html`
- Modify: `apps/desktop/shim.e2e.test.ts`

**Interfaces:**
- Produces (stable ids the JS targets): `fd-hero-status`, `fd-sow`, `fd-sow-hint`, `fd-wishes`, `fd-wishes-count`, `fd-postcards`, `fd-postcards-count`, `fd-net`, `fd-net-summary`, `fd-peers`, `fd-peers-count`, `fd-inbound-toggle`, `fd-inbound-note`, `fd-social-note`.
- Preserves (agent-mgmt anchors, must not be renamed): `a2a-add-btn`, `a2a-server-banner`, `a2a-agents-list`, and the dialog ids.

- [ ] **Step 1: Relabel the nav link.** In `index.html` (~`:336`) change the `Agent` label inside `<button class="dash-nav-link" data-pane="a2a-agents">` — keep the `data-pane` and the icon, change only the text span:

```html
            <button class="dash-nav-link" data-pane="a2a-agents">
              <span class="ic" data-hg-icon="settings-01" data-hg-size="16"></span>
              <span>觅食</span>
            </button>
```

- [ ] **Step 2: Replace the pane `<article>` body.** Replace the whole `<article class="dash-pane" data-pane="a2a-agents" hidden>…</article>` block (~`:577`–`:591`) with the forage-desk structure below. Static placeholder text is fine — `renderForageDesk()` (Task 3) overwrites the live regions. The topbar keeps `#a2a-add-btn` (always-visible; the existing wiring + non-required Playwright add-flow use it) but is relabeled. `#a2a-server-banner` and `#a2a-agents-list` move **inside §③'s net-body** so the agent-mgmt cards render there.

```html
          <!-- ── pane: a2a-agents → 觅食台 (forager's desk) ─────────────── -->
          <article class="dash-pane" data-pane="a2a-agents" hidden>
            <div class="topbar">
              <span class="crumb">觅食台</span>
              <div class="actions">
                <button id="a2a-add-btn" class="btn"><span class="ic" data-hg-icon="add-01" data-hg-size="16"></span> 连一个朋友的 bot</button>
              </div>
            </div>

            <div class="a2a-agents-body fd-body">
              <div class="fd-wrap">
                <!-- HERO = living foraging state -->
                <header class="fd-hero">
                  <div class="fd-eyebrow">觅食台 · 你 bot 的秘密交易台</div>
                  <h1 class="fd-h1">你的 bot 正在替你，悄悄地找。</h1>
                  <div class="fd-status" id="fd-hero-status">
                    <svg class="fd-frog" viewBox="0 0 30 30" fill="none" aria-hidden="true">
                      <ellipse cx="15" cy="19" rx="10" ry="8" fill="#8AA36F"/>
                      <circle cx="10" cy="10" r="4.2" fill="#8AA36F"/><circle cx="20" cy="10" r="4.2" fill="#8AA36F"/>
                      <circle cx="10" cy="10" r="2" fill="#fff"/><circle cx="20" cy="10" r="2" fill="#fff"/>
                      <circle cx="10.6" cy="10.4" r="1" fill="#3B3125"/><circle cx="20.6" cy="10.4" r="1" fill="#3B3125"/>
                      <path d="M11 20 q4 3 8 0" stroke="#3B3125" stroke-width="1.3" stroke-linecap="round"/>
                    </svg>
                    <span class="fd-status-line">加载中…</span>
                    <button class="fd-btn fd-btn-primary fd-sow" id="fd-sow" type="button">＋ 撒一个新心愿</button>
                  </div>
                  <div class="fd-sow-hint" id="fd-sow-hint" hidden>在微信里跟 CC 说「帮我悄悄找…」，它会替你撒出去</div>
                  <div class="fd-social-note" id="fd-social-note" hidden></div>
                </header>

                <div class="fd-wave" aria-hidden="true"><svg viewBox="0 0 920 12" preserveAspectRatio="none"><path d="M0 6 Q 23 0 46 6 T 92 6 T 138 6 T 184 6 T 230 6 T 276 6 T 322 6 T 368 6 T 414 6 T 460 6 T 506 6 T 552 6 T 598 6 T 644 6 T 690 6 T 736 6 T 782 6 T 828 6 T 874 6 T 920 6" stroke="currentColor" stroke-width="2" fill="none"/></svg></div>

                <!-- ① 我派出去的心愿 -->
                <section class="fd-section">
                  <div class="fd-sec-head"><h2>我派出去的心愿</h2><span class="fd-count" id="fd-wishes-count"></span><span class="fd-hint">出面的是 bot，不是你 · 成交前谁都不露脸</span></div>
                  <div class="fd-wishes" id="fd-wishes"></div>
                </section>

                <!-- ② 带回来的明信片 -->
                <section class="fd-section">
                  <div class="fd-sec-head"><h2>带回来的明信片</h2><span class="fd-count" id="fd-postcards-count"></span><span class="fd-hint">两边都点「揭晓」，才互相亮身份</span></div>
                  <div class="fd-postcards" id="fd-postcards"></div>
                </section>

                <!-- ③ 你的觅食网（折叠底座）— agent-management folded here -->
                <section class="fd-net" id="fd-net">
                  <details>
                    <summary id="fd-net-summary">你的觅食网<span class="fd-net-sub" id="fd-peers-count">连着 0 位朋友的 bot</span>
                      <span class="fd-peers" id="fd-peers"></span>
                      <span class="fd-chev">›</span></summary>
                    <div class="fd-net-body">
                      <div class="fd-net-row">
                        <div class="fd-txt"><div class="fd-t">让朋友的 bot 能找到我</div><div class="fd-s">开着，别人的心愿才能传到你这、也才有来有往</div></div>
                        <div class="fd-toggle" id="fd-inbound-toggle" role="switch" aria-checked="false" tabindex="0"></div>
                      </div>
                      <div class="fd-inbound-note" id="fd-inbound-note" hidden></div>
                      <div class="fd-net-row fd-net-row-peers">
                        <div class="fd-txt fd-txt-full">
                          <div class="fd-t">连着的朋友 bot</div>
                          <div id="a2a-server-banner" class="a2a-server-banner"></div>
                          <ul id="a2a-agents-list" class="a2a-agents-list"></ul>
                        </div>
                      </div>
                      <div class="fd-depth-note"><span class="fd-pill">现在：第 1 度</span>你的 bot 目前只问直接好友的 bot。<b>第 2、3 度觅食</b>（朋友的朋友的 bot）即将开放 —— 到时这些心愿会自己走得更远。</div>
                    </div>
                  </details>
                </section>
              </div>
            </div>
          </article>
```

Note: the mockup's `＋ 连一个朋友的 bot` add-peer link is realized as the topbar `#a2a-add-btn` (kept visible + already wired to `openAddModal`). The `#a2a-agents-list` cards each carry their own `data-action` buttons (rendered in Task 3) — that's the per-peer pause/remove/activity/test surface, preserved inside the net.

- [ ] **Step 3: Leave the three reused dialogs untouched.** Do NOT edit `#a2a-add-modal` (`:622`), `#a2a-test-modal` (`:651`), `#a2a-activity-drawer` (`:671`). They remain top-level siblings.

- [ ] **Step 4: Update the shim structural-anchor list.** In `apps/desktop/shim.e2e.test.ts`, append to the `requiredIds` array (~`:133`, before the closing `]`) a forage-desk block:

```ts
      // 觅食台 (forage-desk) pane — live regions renderForageDesk() targets,
      // plus the preserved agent-mgmt anchors folded into §③.
      'fd-hero-status', 'fd-wishes', 'fd-postcards',
      'fd-inbound-toggle', 'fd-inbound-note', 'fd-peers', 'fd-net',
      'a2a-add-btn', 'a2a-server-banner', 'a2a-agents-list',
```

- [ ] **Step 5: Verify.**
  - `cd apps/desktop && bun run test shim.e2e.test.ts` → PASS (all `requiredIds` present in served HTML).
  - `bun run typecheck` → no new errors (HTML-only change; JS untouched this task).
  - Confirm `main.js` still imports `initA2AAgentsTab, refresh as refreshA2AAgents` and references `#a2a-agents-list` only through the module — **no edit required.**

---

## Task 2: CSS (append the `fd-` stylesheet; no JS)

**Files:**
- Modify: `apps/desktop/src/styles.css` (append after the existing A2A block, ~`:5027`)

**Interfaces:** consumes the pane selector `[data-pane="a2a-agents"]`; produces all `fd-` classes used in Task 1's HTML + Task 3's render.

- [ ] **Step 1: Append the transcribed stylesheet.** Every mockup rule is reproduced with `fd-` class names and `--fd-*` vars scoped to the pane. The mockup's `.postcards` two-column grid + `@media(max-width:680px)` single-column are preserved. Reduced-motion disables the pulse ring.

```css
/* ── 觅食台 (forage-desk) — pane-scoped; transcribed from the approved
      mockup. All classes are fd-prefixed and all palette vars are --fd-*
      scoped under the pane so nothing collides with the app's global
      tokens or existing .btn/.pulse/etc. ─────────────────────────────── */
[data-pane="a2a-agents"] {
  --fd-ground:#FBF6EA; --fd-ground-2:#F4ECD9; --fd-card:#FFFDF8;
  --fd-ink:#3B3125; --fd-ink-soft:#7B6F5B; --fd-ink-faint:#A99C84;
  --fd-line:#EADFC7; --fd-line-soft:#F0E8D6;
  --fd-amber:#DDA23F; --fd-amber-deep:#B9821F; --fd-amber-wash:#F8ECD1;
  --fd-sage:#8AA36F; --fd-sage-wash:#E9F0DD;
  --fd-clay:#D2794A; --fd-clay-deep:#B75F32; --fd-clay-wash:#F7DFCD;
  --fd-shadow:0 1px 2px rgba(59,49,37,.05), 0 8px 22px -12px rgba(59,49,37,.14);
  --fd-radius:18px;
}

/* pane surface: paint the desk with the mockup ground instead of --app-bg */
.a2a-agents-body.fd-body { background: var(--fd-ground); color: var(--fd-ink); padding: 0; }
.fd-wrap { max-width: 920px; margin: 0 auto; padding: 38px 28px 80px;
  font-family: "PingFang SC","Hiragino Sans GB",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  line-height: 1.6; }

/* hero */
.fd-hero { margin-bottom: 8px; }
.fd-eyebrow { font-size:12.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--fd-amber-deep); font-weight:700; margin-bottom:10px; }
.fd-h1 { font-size:34px; line-height:1.15; margin:0 0 14px; letter-spacing:-.01em; font-weight:800; color:var(--fd-ink); }
.fd-status { display:flex; align-items:center; gap:12px; flex-wrap:wrap; color:var(--fd-ink-soft); font-size:15px; }
.fd-status-line { display:inline-flex; align-items:center; gap:12px; flex-wrap:wrap; }
.fd-status b { color:var(--fd-ink); font-weight:600; }
.fd-status .fd-num { font-variant-numeric: tabular-nums; }
.fd-frog { width:30px; height:30px; flex:none; }
.fd-dot-sep { width:3px; height:3px; border-radius:50%; background:var(--fd-ink-faint); display:inline-block; }
.fd-sow { margin-left:auto; }
.fd-sow-hint { margin-top:10px; font-size:12.5px; color:var(--fd-ink-faint); }
.fd-social-note { margin-top:10px; font-size:13px; color:var(--fd-ink-soft); background:var(--fd-ground-2); border:1px solid var(--fd-line); border-radius:10px; padding:10px 12px; }

/* fd buttons (do NOT reuse the app's global .btn) */
.fd-btn { border:0; cursor:pointer; font-family:inherit; font-size:14px; font-weight:600; border-radius:12px; padding:11px 18px; transition:.16s; }
.fd-btn-primary { background:var(--fd-amber); color:#3a2c0c; box-shadow:0 1px 0 rgba(255,255,255,.4) inset,0 6px 14px -8px var(--fd-amber); }
.fd-btn-primary:hover { background:var(--fd-amber-deep); color:#fff; }
.fd-btn-ghost { background:transparent; color:var(--fd-ink-soft); border:1.5px solid var(--fd-line); }
.fd-btn-ghost:hover { border-color:var(--fd-amber); color:var(--fd-ink); }

.fd-wave { height:12px; margin:26px 0 34px; color:var(--fd-line); }
.fd-wave svg { width:100%; height:12px; display:block; }

.fd-section { margin-bottom:44px; }
.fd-sec-head { display:flex; align-items:baseline; gap:12px; margin-bottom:18px; }
.fd-sec-head h2 { font-size:19px; margin:0; font-weight:700; position:relative; padding-bottom:3px; color:var(--fd-ink); }
.fd-sec-head h2::after { content:""; position:absolute; left:-2px; right:-2px; bottom:-1px; height:7px; background:var(--fd-amber-wash); border-radius:6px; z-index:-1; transform:rotate(-.4deg); }
.fd-sec-head .fd-count { color:var(--fd-ink-faint); font-size:13px; font-weight:600; }
.fd-sec-head .fd-hint { margin-left:auto; color:var(--fd-ink-faint); font-size:12.5px; }

/* ① wish cards */
.fd-wishes { display:flex; flex-direction:column; gap:14px; }
.fd-wish { background:var(--fd-card); border:1px solid var(--fd-line); border-radius:var(--fd-radius); padding:18px 20px; box-shadow:var(--fd-shadow); display:grid; grid-template-columns:1fr auto; gap:6px 16px; align-items:start; }
.fd-kind { font-size:11.5px; font-weight:700; letter-spacing:.04em; padding:3px 9px; border-radius:999px; display:inline-block; grid-column:1/2; justify-self:start; }
.fd-kind.fd-seek { background:var(--fd-amber-wash); color:var(--fd-amber-deep); }
.fd-kind.fd-fun { background:#EDE7F3; color:#7a5ea6; }
.fd-wish .fd-title { font-size:16.5px; font-weight:600; color:var(--fd-ink); margin:9px 0 4px; grid-column:1/2; }
.fd-wish .fd-meta { grid-column:1/2; color:var(--fd-ink-faint); font-size:13px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.fd-lock { font-size:12px; color:var(--fd-ink-soft); display:inline-flex; align-items:center; gap:4px; }
.fd-rightcol { grid-column:2/3; grid-row:1/4; display:flex; flex-direction:column; align-items:flex-end; gap:10px; justify-content:space-between; height:100%; }
.fd-forage { display:flex; align-items:center; gap:9px; color:var(--fd-ink-soft); font-size:12.5px; font-weight:600; }
.fd-pulse { width:8px; height:8px; border-radius:50%; background:var(--fd-amber); position:relative; }
.fd-pulse::after { content:""; position:absolute; inset:-5px; border-radius:50%; border:2px solid var(--fd-amber); opacity:.5; animation:fd-ring 1.9s ease-out infinite; }
@keyframes fd-ring { 0%{transform:scale(.5);opacity:.55} 100%{transform:scale(1.5);opacity:0} }
.fd-degree { display:flex; align-items:center; gap:5px; }
.fd-deg-track { display:flex; gap:4px; align-items:center; }
.fd-deg { width:22px; height:5px; border-radius:3px; background:var(--fd-line); }
.fd-deg.fd-lit { background:var(--fd-amber); }
.fd-deg.fd-next { background:repeating-linear-gradient(90deg,var(--fd-line) 0 4px,transparent 4px 8px); }
.fd-deg-cap { color:var(--fd-ink-faint); font-size:12px; }
.fd-echo-badge { background:var(--fd-sage-wash); color:#4f6b39; font-size:12px; font-weight:700; padding:5px 11px; border-radius:999px; display:inline-flex; align-items:center; gap:6px; white-space:nowrap; }

/* empty states */
.fd-empty { background:var(--fd-card); border:1px dashed var(--fd-line); border-radius:var(--fd-radius); padding:26px 20px; text-align:center; color:var(--fd-ink-faint); font-size:13.5px; }

/* ② postcards */
.fd-postcards { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
@media (max-width:680px) { .fd-postcards { grid-template-columns:1fr; } .fd-wrap { padding:28px 18px 60px; } }
.fd-postcard { background:var(--fd-card); border:1px solid var(--fd-clay-wash); border-radius:16px; padding:20px 20px 18px; position:relative; box-shadow:var(--fd-shadow); overflow:hidden; }
.fd-postcard::before { content:""; position:absolute; inset:0; background:repeating-linear-gradient(45deg,transparent 0 11px,rgba(210,121,74,.045) 11px 12px); pointer-events:none; }
.fd-postcard.fd-connected { border-color:var(--fd-sage); }
.fd-stamp { position:absolute; top:14px; right:14px; font-size:10.5px; font-weight:800; letter-spacing:.06em; color:var(--fd-clay-deep); border:1.5px dashed var(--fd-clay); border-radius:8px; padding:5px 8px; transform:rotate(4deg); text-align:center; line-height:1.25; background:rgba(255,255,255,.5); }
.fd-pc-eyebrow { font-size:12px; font-weight:700; color:var(--fd-clay-deep); letter-spacing:.02em; margin-bottom:12px; display:flex; align-items:center; gap:7px; }
.fd-masked { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
.fd-mask-av { width:44px; height:44px; border-radius:50%; flex:none; background:radial-gradient(circle at 35% 30%,#efe4d3,#dcccae); display:grid; place-items:center; color:var(--fd-ink-faint); font-size:20px; filter:blur(.4px); }
.fd-masked.fd-revealed .fd-mask-av { filter:none; background:radial-gradient(circle at 35% 30%,#e9f0dd,#c7d8ad); }
.fd-masked .fd-who { font-size:15px; font-weight:600; color:var(--fd-ink); }
.fd-masked .fd-who small { display:block; color:var(--fd-ink-faint); font-weight:500; font-size:12.5px; margin-top:1px; }
.fd-pc-body { font-size:14.5px; color:var(--fd-ink-soft); margin:0 0 16px; line-height:1.55; }
.fd-pc-body b { color:var(--fd-ink); }
.fd-pc-actions { display:flex; gap:10px; align-items:center; }
.fd-btn-reveal { background:var(--fd-clay); color:#fff; box-shadow:0 6px 14px -8px var(--fd-clay); flex:1; text-align:center; }
.fd-btn-reveal:hover { background:var(--fd-clay-deep); }
.fd-btn-wait { background:transparent; color:var(--fd-ink-soft); border:1.5px solid var(--fd-line); }
.fd-btn-wait:hover { border-color:var(--fd-ink-faint); }
.fd-reveal-note { font-size:11.5px; color:var(--fd-ink-faint); margin-top:11px; display:flex; gap:6px; align-items:center; }
.fd-outcome { font-size:12.5px; font-weight:600; color:#4f6b39; margin-top:4px; }
.fd-outcome.fd-wait { color:var(--fd-amber-deep); }
.fd-outcome.fd-retry { color:var(--fd-clay-deep); }

/* ③ foraging network (folded) */
.fd-net { background:var(--fd-ground-2); border:1px solid var(--fd-line); border-radius:var(--fd-radius); padding:6px 20px; }
.fd-net summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:12px; padding:15px 0; font-size:15px; font-weight:600; color:var(--fd-ink); }
.fd-net summary::-webkit-details-marker { display:none; }
.fd-net-sub { color:var(--fd-ink-faint); font-weight:500; font-size:13.5px; }
.fd-chev { margin-left:auto; color:var(--fd-ink-faint); transition:.2s; }
.fd-net details[open] .fd-chev, .fd-net[open] .fd-chev { transform:rotate(90deg); }
.fd-net details[open] summary .fd-chev { transform:rotate(90deg); }
.fd-peers { display:flex; align-items:center; }
.fd-peer { width:26px; height:26px; border-radius:50%; border:2px solid var(--fd-ground-2); margin-left:-8px; background:radial-gradient(circle at 35% 30%,#f0e6d4,#d8c7a8); display:grid; place-items:center; font-size:11px; color:var(--fd-ink-soft); font-weight:700; }
.fd-peer:first-child { margin-left:0; }
.fd-net-body { padding:4px 0 20px; border-top:1px dashed var(--fd-line); margin-top:2px; }
.fd-net-row { display:flex; align-items:center; gap:14px; padding:14px 0; }
.fd-net-row + .fd-net-row { border-top:1px solid var(--fd-line-soft); }
.fd-net-row-peers { align-items:flex-start; }
.fd-txt { flex:1; }
.fd-txt-full { flex:1; width:100%; }
.fd-txt .fd-t { font-weight:600; font-size:14.5px; color:var(--fd-ink); }
.fd-txt .fd-s { color:var(--fd-ink-faint); font-size:12.5px; }
.fd-toggle { width:44px; height:26px; border-radius:999px; background:var(--fd-sage); position:relative; flex:none; cursor:pointer; }
.fd-toggle::after { content:""; position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.2); transition:.18s; }
.fd-toggle.fd-on::after { left:21px; }
.fd-toggle:not(.fd-on) { background:var(--fd-line); }
.fd-inbound-note { font-size:12px; color:var(--fd-amber-deep); background:var(--fd-amber-wash); border-radius:8px; padding:8px 10px; margin:2px 0 0; }
.fd-add-peer { display:inline-flex; align-items:center; gap:7px; color:var(--fd-amber-deep); font-weight:600; font-size:14px; cursor:pointer; padding:12px 0; }
.fd-depth-note { margin-top:8px; font-size:12.5px; color:var(--fd-ink-faint); display:flex; gap:8px; align-items:center; line-height:1.5; }
.fd-depth-note b { color:var(--fd-ink-soft); }
.fd-depth-note .fd-pill { background:var(--fd-amber-wash); color:var(--fd-amber-deep); font-weight:700; font-size:11px; padding:2px 8px; border-radius:999px; white-space:nowrap; }

@media (prefers-reduced-motion:reduce) { .fd-pulse::after { animation:none; } }
```

- [ ] **Step 2: Verify.** `cd apps/desktop && bun run typecheck` (CSS doesn't typecheck, but confirm no build regressions). Optionally `bun run shim` and eyeball the pane against the mockup — this is design-fidelity only, not a gate. The gating checks for this task are Task 1's shim anchors (still green) + Task 3/4's module tests.

---

## Task 3: `renderForageDesk` + refresh rewire + module test

**Files:**
- Modify: `apps/desktop/src/modules/a2a-agents.js`
- Create: `apps/desktop/src/modules/a2a-agents.test.ts`

**Interfaces:**
- Produces: `export function renderForageDesk(data)` where `data = { agents, seeks, echoes, inbound }` (any field may be `null`/`[]`). Renders hero status, `#fd-wishes`, `#fd-postcards`, `#fd-peers`/`#fd-peers-count`, `#fd-inbound-toggle`, `#a2a-agents-list` (via preserved `renderAgents`), `#a2a-server-banner`, section counts, `#fd-social-note`.
- Consumes: `invokeApi` (already imported).
- Keeps exports `initA2AAgentsTab`, `refresh`, and all agent-mgmt functions.

- [ ] **Step 1: Write the failing test** — create `apps/desktop/src/modules/a2a-agents.test.ts`, mirroring `dashboard.test.ts` (DOM stub, `fakeEl()`, import module after stub). Mock `../api.js` so `invokeApi` is a spy (Task 4 uses it; here we call `renderForageDesk` directly with data, so fetch isn't hit).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api.js', () => ({ invokeApi: vi.fn() }))

beforeEach(() => {
  // @ts-expect-error minimal getElementById stub before import
  globalThis.document = { getElementById: () => null }
  class NodeStub { static TEXT_NODE = 3 }
  // @ts-expect-error stub Node
  globalThis.Node = NodeStub
})

const { renderForageDesk } = await import('./a2a-agents.js')
const { invokeApi } = await import('../api.js')

function fakeEl() {
  return {
    textContent: '', innerHTML: '', hidden: false, disabled: false, title: '',
    dataset: {} as Record<string, string>, childNodes: [] as any[],
    classList: {
      values: new Set<string>(),
      add(c: string) { this.values.add(c) },
      remove(c: string) { this.values.delete(c) },
      toggle(c: string, f?: boolean) { f ? this.values.add(c) : this.values.delete(c) },
      contains(c: string) { return this.values.has(c) },
    },
    setAttribute(k: string, v: string) { (this as any)[k] = v },
    appendChild(n: any) { this.childNodes.push(n); return n },
    querySelector() { return null },
    addEventListener: vi.fn(),
    closest: () => null,
  }
}

function installDom(extra: Record<string, any> = {}) {
  const ids = ['fd-hero-status','fd-wishes','fd-postcards','fd-wishes-count',
    'fd-postcards-count','fd-peers','fd-peers-count','fd-inbound-toggle',
    'fd-inbound-note','fd-social-note','fd-sow','fd-sow-hint',
    'a2a-agents-list','a2a-server-banner']
  const byId: Record<string, any> = {}
  for (const id of ids) byId[id] = fakeEl()
  Object.assign(byId, extra)
  globalThis.document = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: () => fakeEl(),
  } as unknown as typeof document
  return byId
}

const foragingSeek = { id: 's1', kind: 'seek', topic: '找个会修老相机的师傅', status: 'foraging', hop: 1, peers_asked: 5, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
const echoedSeek   = { id: 's2', kind: 'seek', topic: '转让布偶猫', status: 'echoed', hop: 1, peers_asked: 4, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
const pendingEcho  = { id: 's2:peerX', seek_id: 's2', peer_masked: '三度外的某人', degree: 3, content: '我家布偶刚生了一窝', status: 'pending', created_at: new Date().toISOString() }

describe('renderForageDesk — wishes', () => {
  it('foraging seek renders 觅食中 + pulse + degree bar + peers-asked', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [foragingSeek], echoes: [], inbound: { enabled: false } })
    const html = el['fd-wishes'].innerHTML
    expect(html).toContain('觅食中')
    expect(html).toContain('fd-pulse')
    expect(html).toContain('fd-deg')
    expect(html).toContain('第 1 度')
    expect(html).toContain('问了 5 个')
    expect(html).toContain('求物求人')     // kind:'seek'
  })

  it('echoed seek renders the 有回音 badge (not the forage ribbon)', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [echoedSeek], echoes: [], inbound: { enabled: false } })
    const html = el['fd-wishes'].innerHTML
    expect(html).toContain('fd-echo-badge')
    expect(html).toContain('有回音')
    expect(html).not.toContain('fd-pulse')
  })

  it('fun kind renders 朋友间小乐趣 chip', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [{ ...foragingSeek, kind: 'fun' }], echoes: [], inbound: null })
    expect(el['fd-wishes'].innerHTML).toContain('朋友间小乐趣')
  })

  it('empty seeks → warm empty state', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null })
    expect(el['fd-wishes'].innerHTML).toContain('fd-empty')
  })
})

describe('renderForageDesk — postcards', () => {
  it('pending echo renders 揭晓牵线 + masked identity + degree stamp', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [echoedSeek], echoes: [pendingEcho], inbound: null })
    const html = el['fd-postcards'].innerHTML
    expect(html).toContain('揭晓牵线')
    expect(html).toContain('三度外的某人')
    expect(html).toContain('从第 3 度')        // stamp
    expect(html).toContain('data-action="reveal"')
    expect(html).toContain('data-id="s2:peerX"')
    expect(html).toContain('转让布偶猫')        // joined seek topic
  })

  it('revealed echo renders connected treatment (peer_masked now real name)', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [echoedSeek], echoes: [{ ...pendingEcho, status: 'revealed', peer_masked: '老张' }], inbound: null })
    const html = el['fd-postcards'].innerHTML
    expect(html).toContain('老张')
    expect(html).toContain('已牵线')
    expect(html).not.toContain('揭晓牵线')
  })

  it('privacy: render never reads/emits peer_agent_id', () => {
    const el = installDom()
    const dirty = { ...pendingEcho, peer_agent_id: 'SECRET-agent-42' }
    renderForageDesk({ agents: [], seeks: [echoedSeek], echoes: [dirty], inbound: null })
    expect(el['fd-postcards'].innerHTML).not.toContain('SECRET-agent-42')
  })

  it('empty echoes → warm empty state', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null })
    expect(el['fd-postcards'].innerHTML).toContain('fd-empty')
  })
})

describe('renderForageDesk — hero + net', () => {
  it('hero status shows agent count, summed peers-asked, echo count', () => {
    const el = installDom()
    renderForageDesk({
      agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      seeks: [foragingSeek, echoedSeek], echoes: [pendingEcho], inbound: { enabled: true },
    })
    const html = el['fd-hero-status'].innerHTML
    expect(html).toContain('2 位')          // agents.length
    expect(html).toContain('9')             // 5 + 4 peers_asked
    expect(html).toContain('1')             // echoes.length
  })

  it('inbound toggle reflects enabled state', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: { enabled: true } })
    expect(el['fd-inbound-toggle'].classList.contains('fd-on')).toBe(true)
    expect(el['fd-inbound-toggle']['aria-checked']).toBe('true')
  })

  it('inbound off → toggle not lit', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: { enabled: false } })
    expect(el['fd-inbound-toggle'].classList.contains('fd-on')).toBe(false)
  })

  it('peers summary derives avatars from agent names', () => {
    const el = installDom()
    renderForageDesk({ agents: [{ id: 'a', name: '老王' }, { id: 'b', name: '小李' }], seeks: [], echoes: [], inbound: null })
    expect(el['fd-peers'].innerHTML).toContain('王')
    expect(el['fd-peers-count'].textContent).toContain('连着 2 位')
  })

  it('social routes unwired (null) → 未启用 note, agent count still shows', () => {
    const el = installDom()
    renderForageDesk({ agents: [{ id: 'a', name: 'A' }], seeks: null, echoes: null, inbound: null })
    expect(el['fd-social-note'].hidden).toBe(false)
    expect(el['fd-social-note'].textContent).toContain('未启用')
    expect(el['fd-hero-status'].innerHTML).toContain('1 位')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/desktop && bun run test src/modules/a2a-agents.test.ts` → FAIL (`renderForageDesk` not exported).

- [ ] **Step 3: Implement.** In `apps/desktop/src/modules/a2a-agents.js`:

  (a) **Extract** the current per-agent card loop from `refresh()` into a reusable `renderAgents(agents, list)` (verbatim markup — keep `.a2a-agent-card`, `data-action`, ids). The server-banner block also becomes `renderServerBanner(info)`.

  (b) **Add helpers** (module-local):

```js
/** @param {string} iso */
function fdRelTime(iso) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 172800) return '昨天'
  return `${Math.floor(s / 86400)} 天前`
}
/** @param {number} n → "朋友 → 的朋友 → …" */
function fdDegreePath(n) {
  const parts = ['朋友']
  for (let i = 1; i < n; i++) parts.push('的朋友')
  return parts.join(' → ')
}
/** @param {number} n */
function fdDegBar(n) {
  // 1-hop today: deg 1 lit, 2/3 dashed "next" (待开).
  return [1, 2, 3].map(d =>
    `<i class="fd-deg ${d <= n ? 'fd-lit' : 'fd-next'}"></i>`).join('')
}
```

  (c) **Add `renderForageDesk(data)`** (exported). Reads ids, tolerates `null` fields:

```js
/**
 * Render the whole 觅食台 from live data.
 * @param {{ agents:Array<any>|null, seeks:Array<any>|null, echoes:Array<any>|null, inbound:any }} data
 */
export function renderForageDesk(data) {
  const agents = Array.isArray(data.agents) ? data.agents : []
  const seeks  = Array.isArray(data.seeks) ? data.seeks : []
  const echoes = Array.isArray(data.echoes) ? data.echoes : []
  const socialWired = data.seeks != null || data.echoes != null
  const seekById = new Map(seeks.map(s => [s.id, s]))

  // ── hero status ──────────────────────────────────────────────────────
  const status = document.getElementById('fd-hero-status')
  if (status) {
    const n = agents.length
    const asked = seeks.reduce((sum, s) => sum + (Number(s.peers_asked) || 0), 0)
    const echoCount = echoes.length
    const frog = status.querySelector?.('.fd-frog')  // keep the inline SVG if present
    const askFrag = socialWired
      ? `<span>替你问过 <b class="fd-num">${asked}</b> 个</span><i class="fd-dot-sep"></i>` +
        `<span><b style="color:var(--fd-clay-deep)">${echoCount}</b> 条带回音了</span>`
      : `<span>社交觅食未启用</span>`
    status.innerHTML =
      `<svg class="fd-frog" viewBox="0 0 30 30" fill="none" aria-hidden="true">` +
      `<ellipse cx="15" cy="19" rx="10" ry="8" fill="#8AA36F"/>` +
      `<circle cx="10" cy="10" r="4.2" fill="#8AA36F"/><circle cx="20" cy="10" r="4.2" fill="#8AA36F"/>` +
      `<circle cx="10" cy="10" r="2" fill="#fff"/><circle cx="20" cy="10" r="2" fill="#fff"/>` +
      `<circle cx="10.6" cy="10.4" r="1" fill="#3B3125"/><circle cx="20.6" cy="10.4" r="1" fill="#3B3125"/>` +
      `<path d="M11 20 q4 3 8 0" stroke="#3B3125" stroke-width="1.3" stroke-linecap="round"/></svg>` +
      `<span class="fd-status-line"><span>连着 <b>${n} 位</b>朋友的 bot</span><i class="fd-dot-sep"></i>${askFrag}</span>` +
      `<button class="fd-btn fd-btn-primary fd-sow" id="fd-sow" type="button">＋ 撒一个新心愿</button>`
    void frog
  }
  const note = document.getElementById('fd-social-note')
  if (note) {
    if (socialWired) { note.hidden = true; note.textContent = '' }
    else { note.hidden = false; note.textContent = '社交觅食功能未启用 —— 在 §③ 打开「让朋友的 bot 能找到我」并重启守护进程即可。' }
  }

  // ── ① wishes ─────────────────────────────────────────────────────────
  const wishes = document.getElementById('fd-wishes')
  const wishCount = document.getElementById('fd-wishes-count')
  if (wishes) {
    if (seeks.length === 0) {
      wishes.innerHTML = `<div class="fd-empty">还没有派出去的心愿。在微信里跟 CC 说「帮我悄悄找…」，它就会替你撒出去。</div>`
    } else {
      wishes.innerHTML = seeks.map(s => renderWish(s)).join('')
    }
  }
  if (wishCount) {
    const active = seeks.filter(s => s.status === 'foraging').length
    wishCount.textContent = seeks.length ? `${active} 条在外面` : ''
  }

  // ── ② postcards ──────────────────────────────────────────────────────
  const postcards = document.getElementById('fd-postcards')
  const pcCount = document.getElementById('fd-postcards-count')
  if (postcards) {
    if (echoes.length === 0) {
      postcards.innerHTML = `<div class="fd-empty">还没有带回明信片。你的 bot 一有回音，就会出现在这里。</div>`
    } else {
      postcards.innerHTML = echoes.map(e => renderPostcard(e, seekById.get(e.seek_id))).join('')
    }
  }
  if (pcCount) {
    const pending = echoes.filter(e => e.status === 'pending').length
    pcCount.textContent = pending ? `${pending} 张待你揭晓` : (echoes.length ? '已处理' : '')
  }

  // ── ③ net: inbound toggle + peers summary + agent cards ──────────────
  const toggle = document.getElementById('fd-inbound-toggle')
  if (toggle) {
    const on = !!(data.inbound && data.inbound.enabled)
    toggle.classList.toggle('fd-on', on)
    toggle.setAttribute('aria-checked', on ? 'true' : 'false')
  }
  const peers = document.getElementById('fd-peers')
  const peersCount = document.getElementById('fd-peers-count')
  if (peers) {
    const shown = agents.slice(0, 4)
    let html = shown.map(a => `<span class="fd-peer">${escapeHtml(firstGlyph(a.name || a.id))}</span>`).join('')
    if (agents.length > 4) html += `<span class="fd-peer">+${agents.length - 4}</span>`
    peers.innerHTML = html
  }
  if (peersCount) peersCount.textContent = `连着 ${agents.length} 位朋友的 bot`

  // preserved agent-management surface
  const list = document.getElementById('a2a-agents-list')
  if (list) renderAgents(agents, list)
}

/** @param {any} s */
function renderWish(s) {
  const kindCls = s.kind === 'fun' ? 'fd-fun' : 'fd-seek'
  const kindTxt = s.kind === 'fun' ? '朋友间小乐趣' : '求物求人'
  const echoed = s.status === 'echoed' || s.status === 'connected'
  const right = echoed
    ? `<span class="fd-echo-badge">🎉 有回音！</span><div class="fd-deg-cap">↓ 见下方明信片</div>`
    : `<div class="fd-forage"><span class="fd-pulse"></span>觅食中</div>` +
      `<div class="fd-degree"><span class="fd-deg-track">${fdDegBar(Number(s.hop) || 1)}</span></div>` +
      `<div class="fd-deg-cap">第 ${Number(s.hop) || 1} 度 · 问了 ${Number(s.peers_asked) || 0} 个</div>`
  return `<div class="fd-wish">` +
    `<span class="fd-kind ${kindCls}">${kindTxt}</span>` +
    `<div class="fd-title">${escapeHtml(s.topic || '')}</div>` +
    `<div class="fd-meta"><span class="fd-lock">🔒 匿名传播</span><i class="fd-dot-sep"></i><span>撒出去 ${escapeHtml(fdRelTime(s.created_at))}</span></div>` +
    `<div class="fd-rightcol">${right}</div>` +
    `</div>`
}

/** @param {any} e  @param {any} seek */
function renderPostcard(e, seek) {
  const deg = Number(e.degree) || 1
  const topic = seek ? seek.topic : ''
  const bodyTopic = topic ? `回应了你的「<b>${escapeHtml(topic)}</b>」——` : ''
  if (e.status === 'revealed') {
    return `<div class="fd-postcard fd-connected">` +
      `<div class="fd-stamp">从第 ${deg} 度<br>带回</div>` +
      `<div class="fd-pc-eyebrow">🎉 已牵线</div>` +
      `<div class="fd-masked fd-revealed"><div class="fd-mask-av">✓</div><div class="fd-who">${escapeHtml(e.peer_masked || '')}<small>身份已互相亮出</small></div></div>` +
      `<p class="fd-pc-body">${bodyTopic}「${escapeHtml(e.content || '')}」</p>` +
      `<div class="fd-outcome">已牵线 · 可以直接联系了</div>` +
      `</div>`
  }
  if (e.status === 'declined') {
    return `<div class="fd-postcard">` +
      `<div class="fd-stamp">从第 ${deg} 度<br>带回</div>` +
      `<div class="fd-masked"><div class="fd-mask-av">?</div><div class="fd-who">${escapeHtml(e.peer_masked || `${deg}度外的某人`)}<small>${escapeHtml(fdDegreePath(deg))}</small></div></div>` +
      `<p class="fd-pc-body">${bodyTopic}「${escapeHtml(e.content || '')}」</p>` +
      `<div class="fd-outcome fd-retry">这条已谢绝</div>` +
      `</div>`
  }
  // pending
  return `<div class="fd-postcard" data-echo-id="${escapeHtml(e.id)}">` +
    `<div class="fd-stamp">从第 ${deg} 度<br>带回</div>` +
    `<div class="fd-pc-eyebrow">🐸 你的 bot 带回一张明信片</div>` +
    `<div class="fd-masked"><div class="fd-mask-av">?</div><div class="fd-who">${escapeHtml(e.peer_masked || `${deg}度外的某人`)}<small>${escapeHtml(fdDegreePath(deg))}</small></div></div>` +
    `<p class="fd-pc-body">${bodyTopic}「${escapeHtml(e.content || '')}」</p>` +
    `<div class="fd-pc-actions"><button class="fd-btn fd-btn-reveal" data-action="reveal" data-id="${escapeHtml(e.id)}">揭晓牵线</button><button class="fd-btn fd-btn-wait" data-action="wait">再等等</button></div>` +
    `<div class="fd-reveal-note">🔒 你点了之后，对方也点「同意」，才互相亮身份和联系方式</div>` +
    `</div>`
}

/** first visible glyph of a name (handles surrogate pairs) */
function firstGlyph(s) { return Array.from(String(s || '?'))[0] || '?' }
```

  IMPORTANT: `renderPostcard` reads **only** `e.id / e.seek_id / e.degree / e.content / e.status / e.peer_masked` — the `PublicEchoRow` fields. It never references `peer_agent_id`. This is the privacy contract the test asserts.

  (d) **Rewire `refresh()`** to fetch all four routes (503 → `null`) and render:

```js
export async function refresh() {
  const wishes = document.getElementById('fd-wishes')
  if (wishes && !wishes.innerHTML) wishes.innerHTML = '<div class="fd-empty">加载中…</div>'

  const [listResp, seeksResp, echoesResp, inbound] = await Promise.all([
    /** @type {Promise<{agents?:Array<any>}|null>} */ (invokeApi('GET', '/v1/a2a/list').catch(() => null)),
    /** @type {Promise<{seeks?:Array<any>}|null>}  */ (invokeApi('GET', '/v1/social/seeks').catch(() => null)),
    /** @type {Promise<{echoes?:Array<any>}|null>} */ (invokeApi('GET', '/v1/social/echoes').catch(() => null)),
    /** @type {Promise<any>}                        */ (invokeApi('GET', '/v1/social/inbound').catch(() => null)),
  ])

  // keep the server-status banner (best-effort, as before)
  const banner = document.getElementById('a2a-server-banner')
  if (banner) {
    const info = /** @type {Record<string, any>} */ (await invokeApi('GET', '/v1/a2a/info').catch(() => null))
    renderServerBanner(info, banner)
  }

  renderForageDesk({
    agents: listResp ? (listResp.agents ?? []) : null,
    seeks:  seeksResp ? (seeksResp.seeks ?? []) : null,
    echoes: echoesResp ? (echoesResp.echoes ?? []) : null,
    inbound,
  })
}
```

  Note: when `/v1/a2a/list` itself fails, pass `agents:null`; `renderForageDesk` coerces to `[]` for rendering but `socialWired` is driven by seeks/echoes only, so the "未启用" note is about the social broker, not the agent list.

  (e) **`renderAgents` + `renderServerBanner`** are the extracted verbatim bodies of the old `refresh()` loop / banner block (unchanged markup). Keep the empty-state text `No agents registered…` for the agent list (Playwright a2a.spec depends on `.empty`).

- [ ] **Step 4: Run to verify it passes** — `cd apps/desktop && bun run test src/modules/a2a-agents.test.ts` → PASS. Then `bun run typecheck` (module is `// @ts-check`) → clean.

- [ ] **Step 5: Regression** — `cd apps/desktop && bun run test shim.e2e.test.ts` still PASS (ids unchanged).

---

## Task 4: Wire actions (reveal, inbound toggle, preserved agent-mgmt) + final gates

**Files:**
- Modify: `apps/desktop/src/modules/a2a-agents.js`
- Modify: `apps/desktop/src/modules/a2a-agents.test.ts` (extend)

**Interfaces:**
- Consumes: `POST /v1/social/echoes/reveal {id}` → `{outcome:{state}}`; `POST /v1/social/inbound {enabled}` → `{enabled, restart_required}`.
- Produces: reveal state transitions on the postcard; the inbound restart-required note; preserved Add/pause/remove/activity/test still reachable inside §③.

- [ ] **Step 1: Extend `initA2AAgentsTab` wiring** (all handlers attached ONCE, appended after the existing wiring block; do NOT touch the existing agent-mgmt wiring / dialogs). Delegated reveal handler on `#fd-postcards`, toggle handler on `#fd-inbound-toggle`, sow-hint on `#fd-sow`:

```js
  // 觅食台 — reveal (delegated), inbound toggle, sow hint.
  document.getElementById('fd-postcards')?.addEventListener('click', onPostcardAction)
  document.getElementById('fd-inbound-toggle')?.addEventListener('click', onInboundToggle)
  document.getElementById('fd-inbound-toggle')?.addEventListener('keydown', (e) => {
    if (e instanceof KeyboardEvent && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onInboundToggle() }
  })
  // #fd-sow / #a2a-add-btn are re-rendered by renderForageDesk, so the sow
  // hint is delegated from the hero container instead of bound to the node.
  document.getElementById('fd-hero-status')?.addEventListener('click', (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('#fd-sow')) {
      const hint = document.getElementById('fd-sow-hint')
      if (hint) hint.hidden = false
    }
  })
```

  Note: `#a2a-add-btn` stays wired to `openAddModal` from the existing block (it lives in the always-present topbar, not re-rendered). It is the mockup's "连一个朋友的 bot" affordance.

- [ ] **Step 2: Implement the reveal handler** (echo-only; three outcomes + non-crashing errors):

```js
/** @param {MouseEvent} e */
async function onPostcardAction(e) {
  const target = e.target
  if (!(target instanceof HTMLButtonElement)) return
  const action = target.dataset.action
  const card = target.closest('.fd-postcard')
  if (action === 'wait') {
    // "再等等" — passive; collapse the actions with a soft note.
    if (card) {
      const actions = card.querySelector('.fd-pc-actions')
      if (actions) actions.remove()
      const note = card.querySelector('.fd-reveal-note')
      if (note) note.textContent = '好，先放着 —— 有进展你的 bot 会再提醒你。'
    }
    return
  }
  if (action !== 'reveal') return
  const id = target.dataset.id
  if (!id || !card) return
  target.disabled = true
  target.textContent = '揭晓中…'
  try {
    const r = /** @type {{outcome?:{state?:string}, error?:string}} */ (
      await invokeApi('POST', '/v1/social/echoes/reveal', { id }))
    const state = r?.outcome?.state
    const actions = card.querySelector('.fd-pc-actions')
    const note = card.querySelector('.fd-reveal-note')
    if (state === 'connected') {
      if (actions) actions.remove()
      card.classList.add('fd-connected')
      if (note) { note.className = 'fd-outcome'; note.textContent = '🎉 已牵线 · 对方也同意了，可以直接联系了' }
    } else if (state === 'awaiting_peer') {
      if (actions) actions.remove()
      if (note) { note.className = 'fd-outcome fd-wait'; note.textContent = '已揭晓，等对方回揭 —— 对方同意后就会互相亮身份' }
    } else if (state === 'peer_unreachable') {
      target.disabled = false
      target.textContent = '再试一次揭晓'
      if (note) { note.className = 'fd-outcome fd-retry'; note.textContent = '暂时联系不上对方的 bot，等下再试' }
    } else {
      target.disabled = false
      target.textContent = '揭晓牵线'
      if (note) { note.className = 'fd-reveal-note'; note.textContent = `揭晓失败：${escapeHtml(String(r?.error ?? '未知错误'))}` }
    }
  } catch (err) {
    target.disabled = false
    target.textContent = '揭晓牵线'
    const note = card.querySelector('.fd-reveal-note')
    if (note) { note.className = 'fd-reveal-note'; note.textContent = `揭晓失败：${escapeHtml(err instanceof Error ? err.message : String(err))}` }
  }
}
```

- [ ] **Step 3: Implement the inbound toggle** (POST + surface `restart_required`):

```js
async function onInboundToggle() {
  const toggle = document.getElementById('fd-inbound-toggle')
  const note = document.getElementById('fd-inbound-note')
  if (!toggle) return
  const next = !toggle.classList.contains('fd-on')
  try {
    const r = /** @type {{enabled?:boolean, restart_required?:boolean, error?:string}} */ (
      await invokeApi('POST', '/v1/social/inbound', { enabled: next }))
    const enabled = !!r?.enabled
    toggle.classList.toggle('fd-on', enabled)
    toggle.setAttribute('aria-checked', enabled ? 'true' : 'false')
    if (note) {
      note.hidden = false
      note.textContent = r?.restart_required
        ? (enabled ? '已开启 —— 需重启守护进程后，别人的心愿才能真正传到你这。' : '已关闭 —— 需重启守护进程后生效。')
        : (enabled ? '已开启。' : '已关闭。')
    }
  } catch (err) {
    if (note) { note.hidden = false; note.textContent = `切换失败：${err instanceof Error ? err.message : String(err)}` }
  }
}
```

- [ ] **Step 4: Extend the module test** — mock `invokeApi` per-call and assert the reveal transition + toggle POST. Add to `a2a-agents.test.ts`:

```ts
const { initA2AAgentsTab } = await import('./a2a-agents.js')

describe('reveal action', () => {
  it('connected outcome swaps the card to 已牵线 and removes the buttons', async () => {
    ;(invokeApi as any).mockResolvedValueOnce({ outcome: { state: 'connected' } })
    // Build a card with a reveal button + note + actions, wired via the handler.
    const btn = fakeEl(); btn.dataset.action = 'reveal'; btn.dataset.id = 's2:peerX'
    const actions = fakeEl(); const note = fakeEl()
    const card = { ...fakeEl(), querySelector: (sel: string) => sel === '.fd-pc-actions' ? actions : sel === '.fd-reveal-note' ? note : null }
    ;(btn as any).closest = (sel: string) => sel === '.fd-postcard' ? card : null
    // Simulate: HTMLButtonElement guard — install a stub so instanceof passes.
    // (See test note below on the instanceof shim.)
    await (await import('./a2a-agents.js')).__onPostcardActionForTest?.({ target: btn })
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/social/echoes/reveal', { id: 's2:peerX' })
    expect(card.classList.contains('fd-connected')).toBe(true)
    expect(note.textContent).toContain('已牵线')
  })
})

describe('inbound toggle', () => {
  it('POSTs the flipped state and surfaces restart-required', async () => {
    ;(invokeApi as any).mockResolvedValueOnce({ enabled: true, restart_required: true })
    const toggle = fakeEl(); const note = fakeEl()
    installDom({ 'fd-inbound-toggle': toggle, 'fd-inbound-note': note })
    await (await import('./a2a-agents.js')).__onInboundToggleForTest?.()
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/social/inbound', { enabled: true })
    expect(toggle.classList.contains('fd-on')).toBe(true)
    expect(note.textContent).toContain('需重启')
  })
})
```

  **Test-seam note:** `onPostcardAction`/`onInboundToggle` use `instanceof HTMLButtonElement`/`HTMLElement`/`KeyboardEvent` guards that don't exist under the bare DOM stub. Two low-risk options — pick one and apply consistently:
  1. Export thin test seams `export const __onPostcardActionForTest = onPostcardAction` / `__onInboundToggleForTest = onInboundToggle` **and** stub the constructors in the test's `beforeEach` (`globalThis.HTMLButtonElement = class {}`, etc.) so the `instanceof` guard is satisfiable by giving the fake button that prototype. (Mirrors dashboard.test.ts's `Node`/`navigator` stubbing.)
  2. Replace the `instanceof HTMLButtonElement` guard with a duck-typed check (`target?.dataset?.action`) so no constructor stub is needed. Prefer **(2)** for the button guards (simpler, no seam export needed) and keep the delegated handlers reading `dataset` directly; keep `onInboundToggle` parameterless so it's directly callable. Update the test to call the exported seam accordingly. The reveal/toggle assertions (POST args + resulting class/text) are the contract; the exact seam is an implementation detail — the implementer resolves it when the guards are finalized, keeping the assertions above.

- [ ] **Step 5: Final gates.**
  - `cd apps/desktop && bun run test src/modules/a2a-agents.test.ts` → PASS (render + reveal + toggle).
  - `cd apps/desktop && bun run test shim.e2e.test.ts` → PASS (anchors intact).
  - `cd apps/desktop && bun run typecheck` → clean.
  - `bun run test src/modules/dashboard.test.ts` → still PASS (no shared-module regressions).
  - **desktop-e2e (Playwright):** do NOT run/chase (persistently red, non-required). Confirm only that no structural **id** was renamed. Flag in the PR body that `playwright/a2a.spec.ts` visibility assertions may need a `summary` click since the cards now sit inside the folded §③ `<details>` — a follow-up for the e2e-owning session, not this PR.

---

## Done-when

- The `a2a-agents` pane renders as 觅食台: hero living-status (agent count + summed peers-asked + echo count), ① wish cards with 觅食中/pulse/degree or 有回音 badge, ② postcards with masked identity + degree stamp + 揭晓牵线 → three outcomes, ③ folded net with a working inbound toggle (restart note) + the preserved agent-management cards + add-peer + depth note.
- All render + action logic is covered by `modules/a2a-agents.test.ts`; the privacy regression (no `peer_agent_id` in the echo render path) is asserted.
- `shim.e2e.test.ts` anchor list is updated and green; `typecheck` clean; `main.js` unchanged.
- No edits outside the four files (+ the shim test) named in File Structure; `plugins` pane untouched.
