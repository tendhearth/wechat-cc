# wechat-cc desktop v1.4.0

**Date**: 2026-08-18
**Tag**: `desktop-v1.4.0`
**Scope**: Six feature lines in one cut — degraded boot (reliability backlog #1 closed), the provider-layer dedup with three live bug clusters fixed, a subscription-Gemini provider via the Antigravity CLI, `/stop` working on every provider, the owner onboarding assembly (including a two-month-old first-message regression), and the guest path (in-chat approve + invite codes). No dashboard UI changes.

> Upgrading is a straight reinstall — the state directory is untouched, no QR re-scan. **Two upgrade notes:** (1) run `wechat-cc doctor` after upgrading — pre-existing installs typically have `admins` empty in access.json, which the doctor now flags with the exact fix; applying it unlocks the owner's full tool tier AND the new guest path (both are gated on real admins). (2) Non-allowlisted WeChat friends who message the bot now get one neutral reply instead of pure silence; `dmPolicy: "disabled"` remains the total-silence switch.

## What changed

### Degraded boot — optional subsystems can no longer take the daemon down

Boot used to be all-or-nothing: any optional subsystem (companion, guard, social, knowledge, a2a, mailbox, pairing, customer-review) throwing during startup killed the whole bot. A minimal `SubsystemSupervisor` now wraps the eleven optional units: failure ⇒ degraded (visible in `GET /v1/health.subsystems` and a one-shot admin WeChat summary), unconfigured ⇒ off, and the core receive-reply chain stays fail-fast. Proven end-to-end by an e2e that binds a real port under `a2a_listen` — a scenario that previously refused to boot. A failed degraded-summary send is now logged too (`ilink.sendMessage` resolves `{error}`, never rejects — the old `.catch` was dead code).

### Provider layer dedup (debt D4) + three live bug clusters

Five structurally-identical `McpStdioSpec` definitions collapsed to one; three divergent auth-fail regexes collapsed to one source with two channel profiles (model-output-safe narrow vs SDK-error wide); claude's `AsyncQueue` and per-turn bookkeeping (`TurnEmitter`) became shared modules. Along the way, three real bugs:

- **B1 — gemini tier-authz gap.** gemini's wechat MCP child never received the session's `WECHAT_SESSION_TOKEN`/`_TIER` (and inherited no `PATH`/`HOME`). Guest chats on gemini were effectively un-tiered. Fixed via the single `childEnvFor` merge helper.
- **B2 — delegation fake-success.** `supportsDelegation` was a dead field: `/gemini + cc` confirmed "它会调 `delegate_claude`" for a tool that did not exist in that session. Enforced now at three layers (mode parser, `validateMode`, capability matrix) — non-delegating primaries get a clear rejection instead of a false ✅.
- **B3 — three providers never classified auth failures.** An expired cursor/openai/gemini key surfaced raw error text to the user via the fallback-reply path. All five providers now emit `auth_failed`, and — verified against a real Kimi gateway with a deliberately bad key — classification keys on HTTP 401 status (the AI SDK's real 401s carry none of the regex phrases; it also used to swallow them behind "No output generated", now surfaced on both the dispatch and eval paths). claude's in-stream detection was deliberately reverted to its two binary sentinels after a deterministic false positive (legit text quoting "401 unauthorized" triggered a fake "login expired").

The one-shot delegate route also stopped reporting `ok: true` with an empty response when the turn ended in an error event.

### agy — subscription Gemini via the Antigravity CLI

New provider id `agy` for Gemini access through a Google AI Pro subscription (OAuth via the `agy` CLI) — no API key needed. Per-turn CLI invocation with **real resume** (`--conversation`), working `cancel()`, cheapEval on flash-low, and correct project binding (`--new-project`, without which agy executes tools in the wrong directory — a spike finding). `/agy` switches a chat; `/agy <model>` pins. Security posture, deliberately narrow for v1: the wechat MCP channel runs on a single boot-minted trusted token in agy's global config, so `/agy` is **admin/trusted-only**, agy is structurally excluded from `/both`/`/chat`, and a dispatch-time check re-verifies tier for persisted modes. The global-config write is namespaced, idempotent, atomic, never clobbers user entries (including agy's own 0-byte placeholder file, which initially bricked setup), and is removed on graceful shutdown. Registration and the config write are hard-gated away from test runners and dev-machine PATH accidents.

### `/stop` now works on every provider

cursor/openai/gemini gained real `cancel()` — and the deeper fix: `/stop` never actually reached *any* solo/parallel turn (the coordinator only knew how to abort chatroom mode). The in-flight session handle is now registered per chat and cancelled on `/stop`, with per-turn identity guards so a stale cancel can never kill the next turn.

### Owner onboarding — and a two-month-old silent regression

The headline fix: since the June sleep/wake dedup change (`7914f7b5`), **every new user's first message went unanswered** — onboarding's echo re-dispatch was swallowed by the dedup store, so the bot said "刚才你说「…」,回答下：" and then nothing, for everyone, with the only test able to catch it deleted along the way. Fixed with a scoped `ctx.redispatch` bypass and falsification-verified e2e (both restart and same-boot shapes).

The rest of the assembly: onboarding's pending state survives daemon restarts (no more re-greeting mid-conversation); the greeting now introduces the bot before asking your name, and the confirmation points at `/help` once; `setup` writes `admins` on first bind so terminal-installed owners stop landing in guest tier (doctor flags existing installs); `/help` caught up with `/gemini` `/agy` and unknown `/word` commands get a hint instead of silently becoming LLM prose; the very first startup notice is a warm hello (later restarts keep the technical line, and upgrades are not mistaken for first-runs); and two ignition prompts — a natural-moment companion offer (owner chat, only after the "刚认识" phase, guest-safe via admins-based resolution after an enable-first deadlock was caught) and a sticker cold-start unlock (tier-gated) — give 养成 a starting point.

### Guest path — request→approve + invite codes

Non-allowlisted WeChat friends (people the owner already friend-accepted) get a real path in:

- First message ⇒ one neutral reply ("我需要主人确认一下,稍等哦~") + a single owner notification carrying a 6-digit code (durable across restarts; failed sends retry; per-sender budget with throttling indistinguishable from silence).
- Owner replies **`允许 <码>`** in WeChat ⇒ allowFrom append (and only allowFrom — never admins/trusted), the guest gets welcomed, and their original question is answered through the normal onboarding flow. **`拒绝 <码>`** is permanent and silent toward the guest. **`邀请码`** mints a single-use 48h code the owner can send a friend for zero-wait entry (an invite overrides a prior denial). **`待批准`** lists the queue.
- The whole approval chain is deterministic and pre-LLM (the guest's text never influences the decision and never enters a prompt), identity-gated on `isAdmin`, and the entire machinery requires a real `admins` list — on legacy installs where `isAdmin` falls back to allowFrom (which would have let approved guests approve others), the guest path stays off until doctor's one-line fix is applied.
- `/help` is now tier-aware: guests only see what their tier can actually use.

Terminal `/wechat:access` remains the full management surface.

### Re-cut: bundle boot crash with a refused/absent Codex CLI (issue #86)

The first v1.4.0 tag was cut and drafted but never published; it is re-cut with this fix (same posture as the v1.3.8 re-cut). On the compiled bundle, when the codex version gate refused registration — or codex simply wasn't installed — the delegate layer still constructed the codex provider, whose SDK resolves its CLI eagerly and cannot do so inside a single-file bundle: boot died for claude-only users with no opt-out. The codex delegate is now conditional on a verified CLI (mirroring the openai branch), a missing peer fails cleanly at call time (`unknown_peer: codex`), and the version-mismatch guidance no longer advises a background auto-fix that is unreachable on bundles. Reported externally against 1.3.8 with a precise root cause — thank you.

## Known / deferred

- agy's wechat-MCP live round (an `/agy` message exercising real tools) is the one leg pending real-device verification; token `routeAllow` narrowing follows it.
- A June `feat/reminders` branch (multi-user precise-time reminders, 679 lines) was never merged and needs a migration-position-aware port — tracked as follow-up, not in this release.
- Deferred minors are recorded per-feature in the specs under `docs/superpowers/specs/2026-08-1*`.
