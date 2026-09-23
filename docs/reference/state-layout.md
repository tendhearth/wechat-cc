# State layout

> 从根 README 搬到这里(2026-09-22),README 只留门面与指路。索引见 [docs/INDEX.md](../INDEX.md)。

```
~/.claude/channels/wechat/
├── access.json            # allowlist
├── context_tokens.json    # ilink context tokens (one per chat)
├── user_names.json        # chat_id → display name
├── sessions.json          # project_alias → { session_id, last_used_at, summary? }
├── session-state.json     # bot health (errcode tracking)
├── channel.log            # rolling log (10 MB rotation)
├── server.pid             # single-instance lock
├── internal-token         # internal-api bearer token (mode 0600, rotated each boot)
├── internal-api-info.json # internal-api {baseUrl, tokenFilePath, pid, ts} for CLI discovery
├── install-progress.json  # transient: written by `service install` (M/N step), read by GUI
├── wechat-cc.db           # SQLite (sessions / conversations / activity / milestones / events / observations / avatar)
├── docs/                  # share_page content (7-day TTL)
├── bin/cloudflared        # auto-downloaded (.exe on Windows)
├── inbox/                 # downloaded media (30-day TTL)
├── accounts/<bot_id>/     # per-account credentials
├── companion/
│   └── config.json        # enabled / snooze / default_chat_id / last_introspect_at
└── memory/<chat_id>/      # per-chat content
    ├── profile.md         # editable user-facing notes
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
