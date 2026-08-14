# wechat-cc desktop v1.3.8

**Date**: 2026-08-14
**Tag**: `desktop-v1.3.8`
**Scope**: Knowledge Kernel — the owner's knowledge moves from `..`-reading plugin sidecars into a daemon-owned in-process substrate. Plus a styled macOS installer window. No dashboard UI changes.

> Upgrading is a straight reinstall — the state directory (`~/.claude/channels/wechat/`) is untouched, so no QR re-scan.

## What changed

### Knowledge Kernel (the bulk of this release)

The understanding layer used to be three Python plugins (`wxfacts`, `wxperson`, `wxgraph`) reaching across `..` into each other and into wxvault's decrypted output. That's gone. The daemon now owns a knowledge substrate directly:

1. **Phase 0/1 — substrate + semantic search.** `source.db` + `semantic.db` behind an admin-only Knowledge API, a source adapter that decodes and normalises wxvault's output once (WAL-safe immutable open), an in-process indexer driving a plain Python embed subprocess over JSONL, and TS cosine + FTS + RRF search with provenance built in. Vectors are isolated by `model_id`, so mixed-dimension corruption is structurally impossible.

2. **Agent-facing search.** A `knowledge_search` MCP tool (admin-only) plus query embedding on `/v1/knowledge/search`. One daemon-owned singleton embedder serves both the indexer and the query path, so index and query always embed with the same model by construction. The prompt bullet is gated on the embedder actually being available.

3. **Graph layer in-process.** A numeric-faithful port of `wxgraph`'s closeness / edges / owner-resolution / queries, reading source in-process; `graph.db` rebuilds on the cycle. Enriched source now covers all message types plus `kind` / `is_group` / `mentions` / contacts.

4. **Facts + person layers in-process.** Agent-driven fact extraction and the unified person brief move off `wxfacts` / `wxperson`; companion-ingest auto-extraction is re-pointed at the in-process `FactsApi`.

5. **Consumers re-pointed off the retired plugins.** The agent-social grounded judge now does an in-process kernel fact fetch fed to `cheapEval` — provider-agnostic, no subprocess spawn, no tier hack. `distillOwnerKnowledge` (the `knowledge.md` social-state digest) moves onto `FactsApi.findFacts` + `GraphQueryApi.topContacts`, fixing a silent `knowledge.md` regression introduced by the plugin retirement.

6. **Hardening.** `upsertFact` merge uses `||` rather than `??` for `kind` / `related_contact` / `time_ref`, so re-recording an empty string no longer clobbers a filled value. The social judge's grounding call is wrapped so a synchronously-throwing `ground()` degrades to "judge runs blind" instead of escaping — fail-closed, safety-critical.

### Upgrade crash on databases from a pre-merge dev build (issue #79)

A database that ran the customer-review feature branch before it merged stores `user_version=21` meaning "customer-review analysis metadata applied", while the released migration runner reads 21 as "social forwarding hop applied" and resumes at v22 — which ALTERs `social_relay`, a table that database never created. The daemon then crash-looped on boot with `no such table: social_relay`.

The runner now detects that specific state before the migration loop and rewinds to the fork point so the normal v19–v28 migrations rebuild what is missing, preserving the customer-review rows already written. It could not be an appended migration: the crash happens at v22, so the loop never reaches one.

**Scope, because the issue overstates it:** installs that only ever ran published releases are unaffected — migrations v1–v21 are byte-identical between `desktop-v1.3.2` and today apart from one comment's wording. Only databases that passed through the pre-merge branch build carry the mismatch.

A new guard pins the schema each released migration produces, so a branch cut from a stale base fails in CI rather than on a user's machine.

### codex: stop refusing a CLI that is only a patch ahead

Two independent fixes for "I upgraded codex and wechat-cc stopped talking to it":

1. **The SDK auto-realign never ran.** It spawns `bun add` to match the bundled SDK to your CLI, but spawned a bare `bun` and relied on PATH — and the daemon runs with a minimal launchd/systemd PATH that does not include `~/.bun/bin`. Every attempt failed with `bun not found on PATH`. bun is now resolved by absolute path across the same install locations the codex binary already searched.
2. **The version gate was too strict.** It required exact equality, so a CLI that self-updated 0.144.5 → 0.144.7 lost the codex provider entirely. Measured across four real dispatches — every combination of SDK/CLI 0.144.4 and 0.144.5, both mismatch directions — a patch gap does not break the wire protocol. The gate now tolerates patch differences within the same major.minor. Minor and major gaps stay refused (the original silent-failure report was a minor gap), and prereleases still require exact equality.

The standalone installer OpenAI recommends self-updates on startup, so this happened to users without them doing anything.

### federated source (opt-in)

wechat-cc can expose a slim `federated_query`-only MCP surface to hearth, gated behind an explicit consent grant (`authorize`/`deauthorize`/`status` CLI, 0700 state dir, 0600 grant file, operator-token minting scoped to the grant). Off unless you authorize it.

### agent-social

Seeker-side discover and forward fan-out are now ranked by peer interaction closeness (recency + volume + reciprocity, read from the existing `a2a_events` log) instead of an arbitrary `slice(0, 5)`. Pseudonymous — no wxid involved, observability data only. Eligibility filters and the disclosure gate are unchanged.

### memory-infra Phase 1 (off by default)

wechat-cc can distill its WeChat knowledge into a hearth ChangePlan and push it into hearth's markdown vault over MCP, with hearth governing validation / apply / citations / audit. Feature-detected and opt-in: `hearth_enabled=false` is the default and means zero behaviour change.

### macOS installer

The `.dmg` now opens to a real install window — background artwork, 660×400, app on the left, Applications on the right — instead of a bare Finder listing. Root cause of the old bare dmg: `tauri-bundler` appends `--skip-jenkins` to `bundle_dmg.sh` whenever `CI=true`, which skipped the entire Finder/AppleScript step that applies background and icon positions.

**First-launch instructions changed.** The bundle is ad-hoc signed and not notarised, and "right-click → Open" stopped working for unnotarised apps in macOS 15. The real path is **System Settings → Privacy & Security → Open Anyway**. The dmg background says so, in Chinese and English.

## Notes

- **Retired plugins.** `wxfacts`, `wxperson` and `wxgraph` no longer supply tools; their capabilities are in-process. `wxvault` is unaffected and still required.
- **Semantic search availability.** `knowledge_search` and the corresponding prompt bullet appear only when the embedder is genuinely available; without it the rest of the kernel still works.
- **Windows / Linux.** No platform-specific changes this release; bundles are rebuilt against the current CLI.

## Install

| Platform | File | First launch |
|:---|:---|:---|
| macOS (Apple Silicon) | `*.dmg` | Drag to Applications, then System Settings → Privacy & Security → **Open Anyway** (once) |
| Windows (x64) | `.exe` (NSIS) or `.msi` | SmartScreen → More info → **Run anyway** |
| Linux (x64) | `.deb` / `.rpm` | No warning |
