# CLI Social Surface — Design Spec

**Date:** 2026-07-17
**Status:** Approved (brainstorming), ready for implementation plan
**Feature:** `wechat-cc social {seeks,echoes,pledges,reveal}` — a terminal surface
for the shipped 觅食台 social stack, so the owner can finally SEE their wishes and
echoes and act on them.

## Why

The social backend (P1 state layer → P2 read surface → async foraging spine →
forwarding hop) is complete and released, but **it is invisible**: the only
surfaces are WeChat (notification beats + `揭晓 <id>`) and raw HTTP. There is no
way to list your seeks or echoes — so the feature cannot be dogfooded or
diagnosed. The desktop 觅食台 page (P3) is the designed product surface, but it is
a separate, larger piece; the CLI is the cheapest path to *usable today*, and it
matches this project's standing preference: "default new capabilities to CLI
subcommands + WeChat commands" ([[keep-desktop-ui-simple]]).

## Scope

**In scope — four leaf commands under a `social` subcommand tree** (mirrors the
existing `agent` tree in `cli.ts`):

```
wechat-cc social seeks   [--limit N] [--json]
wechat-cc social echoes  [--seek <intent-id>] [--limit N] [--json]
wechat-cc social pledges [--limit N] [--json]
wechat-cc social reveal  <id> [--json]
```

**Out of scope (YAGNI):**
- **Seeding from the CLI** (`social seek "..."`). Sowing is the bot's job; the
  designed owner-facing entry point is the WeChat flow (P4). Not built here.
- `watch`/`tail`/live refresh; rich rendering. Output stays plain, like
  `agent activity`.
- Any change to the daemon, the routes, or the stores.

## Design

### Read commands (`seeks` / `echoes` / `pledges`) — direct db, no daemon
Follow the established read-only CLI pattern (`agent activity` →
`src/cli/agent.ts`, `openWechatDb(stateDir)`): open the daemon's SQLite file and
read through the existing core stores (`makeSeekStore` / `makeEchoStore` /
`makePledgeStore`). Consequences, all desirable:
- **Works whether or not the daemon is running** (post-mortem friendly).
- Respects the `cli-must-not-depend-on-daemon` dependency rule — the stores live
  in `src/core/`, which the CLI may import.

**Privacy — the one real hazard in this design.** Reading echoes straight from
the store yields `EchoRow`, which carries `peer_agent_id` / `relay_via` /
`relay_token` — the server-side-only fields that the 2026-07-17 review had us
mask out of `GET /v1/social/echoes`. The CLI **MUST** project through the
existing allowlist helper before printing:

```ts
import { toPublicEcho, type PublicEchoRow } from '../core/social-echo-store'
// PublicEchoRow = { id, seek_id, peer_masked, degree, content, status,
//                   created_at, self_revealed_at, peer_revealed_at }
```

Printing a raw `EchoRow` would silently re-open the leak the masking fix closed.
This applies to both the human and the `--json` output.

### Write command (`reveal <id>`) — must go through the daemon
Reveal performs A2A network calls and fires notification beats, so it cannot be
done from a short-lived CLI process reading the db. Follow the existing
daemon-calling CLI pattern (`mode set` in `cli.ts`): read
`STATE_DIR/internal-api-info.json` (baseUrl + token file) and POST. Daemon not
running / 401 / 5xx → clear message, exit 1.

**Echo-or-pledge auto-detection:** the id may be an echo id
(`intent:peer` or `intent:relay_via:relay_token`) or a pledge id
(`intent:seeker`). Mirror the WeChat `揭晓` semantics exactly: POST
`/v1/social/echoes/reveal` first; on **404 `not_found`** fall back to
`/v1/social/pledges/reveal`. If both 404 → "没找到这条" style error, exit 1.

Print the outcome state: `connected` / `awaiting_peer` / `peer_unreachable`
(these are the shipped `RevealOutcome.state` values) in human-readable form.

### Output
Plain text by default (one row per line, newest first — the stores already order
`created_at DESC, rowid DESC`); `--json` prints a JSON envelope, matching the
existing CLI convention. `--limit` defaults: 20 (like `agent activity`).

## Error handling
- Read commands: db missing/unreadable → clear message + exit 1 (the existing
  `openWechatDb` path already surfaces this).
- `reveal`: daemon-not-running, auth failure, unknown id → distinct messages, all
  exit 1. No silent success.

## Testing
- One unit test per read command, injecting stores (mirror `src/cli/agent.ts`'s
  test idiom) — including an **assertion that `peer_agent_id` / `relay_via` /
  `relay_token` never appear in `echoes` output** (the privacy regression lock).
- `reveal`: the echo-hit path, the 404→pledge-fallback path, the both-404 path,
  and the daemon-not-running path (mirror `mode set`'s test approach).
- Gates: `bun run test <paths>` (vitest — not `bun test`), `bun run typecheck`,
  `bun run depcheck` (the CLI→daemon boundary rule must stay green).

## Follow-up (not this spec)
- P3 desktop 觅食台 page — the designed product surface (approved mockup + spec +
  handoff already on `dev`); user has authorized me to build it after this.
