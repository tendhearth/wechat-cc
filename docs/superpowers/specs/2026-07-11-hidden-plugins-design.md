# Design: Hidden (infrastructure) plugins

Date: 2026-07-11
Status: approved design → implementation
Origin: demote wxvault from a user-facing plugin to hidden decryption infrastructure — users care about outcomes (search/relationships/transcribe), not the decryption plumbing; also shrinks the "wechat-cc cracks WeChat" narrative/attention surface (NOT a legal shield — decryption still happens). See [[architecture-direction-2026]].

## 1. What

A `hidden?: boolean` flag on a plugin manifest. Hidden plugins are **loaded and run exactly as today** (so wxvault still decrypts + serves as a dependency of the value plugins) but are **excluded from every user-facing discovery surface** (dashboard plugin list + marketplace/registry). Users never see wxvault; the value plugins (wxsearch/wxfacts/wxgraph/wxmedia) are the visible surface.

## 2. Locked decisions

- **Manifest**: `PluginManifest.hidden?: boolean` (default false/absent = visible). `parseManifest` accepts + passes it through (no new validation beyond boolean-if-present).
- **Loading unchanged**: `loadPlugins`/registry still load + run hidden plugins (bundled default-enabled). A hidden plugin's MCP tools still work (its dependents rely on it). Hiding is a DISCOVERY-surface concern only.
- **Filter at the two discovery routes** (`routes-plugins.ts`), server-side so both desktop pane + CLI benefit:
  - `GET /v1/plugins/list` (dashboard): exclude `p.manifest.hidden === true`.
  - `GET /v1/plugins/registry` (marketplace catalog): exclude hidden entries.
- **Toggle route unchanged**: `POST /v1/plugins/toggle` still works by name (not locked — just not surfaced). A hidden bundled plugin stays enabled by default; nothing to toggle in the UI.
- **wxvault manifest** (`~/Documents/wxvault/wechat-cc.plugin.json`): set `"hidden": true`.
- Phase-2 (NOT here): retire wxvault's raw agent MCP tools as curated plugins replace them; reframe owner decrypt-setup as "开启微信历史功能".

## 3. Non-goals

Locking/force-enabling hidden plugins; removing wxvault's agent tools; the owner-setup reframing UX; any change to plugin loading/execution/tier gating.

## 4. Testing

- `parseManifest`: a manifest with `hidden: true` parses + carries it; absent ⇒ undefined/false; a non-boolean `hidden` is rejected or coerced per the file's convention.
- `GET /v1/plugins/list`: a loaded hidden plugin is absent from the returned `plugins[]`; a non-hidden one is present (mirror existing plugin-route tests).
- `GET /v1/plugins/registry`: hidden catalog entry excluded.
- Loading unaffected: registry still returns the hidden plugin as loaded/enabled (it runs) — only the discovery routes filter it.
- Full daemon suite + e2e green.
