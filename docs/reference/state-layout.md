# State layout

> 从根 README 搬到这里(2026-09-22),README 只留门面与指路。索引见 [docs/INDEX.md](../INDEX.md)。

Override the root with `WECHAT_STATE_DIR` (legacy name `WECHAT_CC_STATE_DIR` is still honoured by the daemon). 2026-09-27: list refreshed against the code; several files below were missing before.

```
~/.claude/channels/wechat/
├── access.json            # allowlist (+ admins[])
├── agent-config.json      # provider / model / workbench knobs — only via src/lib/agent-config.ts's typed saver
├── daemon.env             # API keys written by the settings panel (0600)
├── projects.json          # registered project folders
├── context_tokens.json    # ilink context tokens (one per chat)
├── user_names.json        # chat_id → display name
├── chat_prefs.json        # per-chat /set preferences
├── conversations.json     # legacy — migrated to wechat-cc.db
├── sessions.json          # legacy — migrated to wechat-cc.db
├── session-state.json     # legacy — migrated to wechat-cc.db
├── channel.log            # rolling log (10 MB rotation) + channel.log.jsonl
├── server.pid             # single-instance lock
├── internal-token         # internal-api bearer token (trusted tier, 0600, rotated each boot)
├── internal-operator-token# desktop host's admin credential, route-scoped (0600) — see internal-api-auth.md
├── internal-api-info.json # internal-api {baseUrl, tokenFilePath, operatorTokenFilePath, pid, ts}
├── install-progress.json  # transient: written by `service install` (M/N step), read by GUI
├── stt-config.json        # inbound STT gateway
├── voice-config.json      # outbound TTS gateway
├── settings-devices.json  # paired phone device tokens (≤20): {token:{id,created_at,last_seen_at,label?}}; old {token:{created_at}} upgraded in place
├── license.json           # Pro tier
├── wechat-cc.db           # SQLite (67 migrations as of 2026-09; ~46 live tables)
├── docs/                  # share_page content (7-day TTL)
├── bin/cloudflared        # auto-downloaded (.exe on Windows)
├── inbox/                 # downloaded media (30-day TTL)
├── accounts/<bot_id>/     # per-account credentials
├── plugins/               # user plugins (default disabled)
├── self-change/           # one git worktree per `self change` run
├── companion/
│   ├── config.json        # enabled / snooze / default_chat_id / last_introspect_at
│   └── journal-seen.json  # forage-desk / phone feed watermark
└── memory/<chat_id>/      # per-chat content
    ├── memory.md          # nightly-curated long-term memory (injected every turn, 2026-09-25+)
    ├── profile.md         # daytime draft ("你眼中的 ta")
    ├── knowledge.md       # distilled plugin knowledge
    ├── persona.md · agenda.md · notes/
    ├── observations.jsonl # legacy — migrated to wechat-cc.db on first boot post-PR7
    ├── milestones.jsonl   # legacy — migrated to wechat-cc.db
    ├── events.jsonl       # legacy — migrated to wechat-cc.db
    └── activity.jsonl     # legacy — migrated to wechat-cc.db
```

All state lives under `~/.claude/` — nothing is committed to the repo. Since
v2.0.1 the JSONL files above are migration sources only; live writes go to
`wechat-cc.db`. The legacy files stay on disk for backwards compatibility
(safe to delete after first boot on v2.0.1+).

---
