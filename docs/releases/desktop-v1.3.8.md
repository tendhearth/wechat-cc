# wechat-cc desktop v1.3.8

**Date**: 2026-08-13
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
