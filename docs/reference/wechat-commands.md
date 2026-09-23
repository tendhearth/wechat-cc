# WeChat commands

> 从根 README 搬到这里(2026-09-22),README 只留门面与指路。索引见 [docs/INDEX.md](../INDEX.md)。

| Command | Effect |
|:---|:---|
| `/help` | Show available commands |
| `/status` | Connection health + version + update probe |
| `/ping` | Connectivity test |
| `/users` | Online users |
| `/project add <path> <alias>` | Register a project (admin) |
| `/project list` | List registered projects |
| `/project switch <alias>` | Switch (admin) |
| `/project status` | Current project + cwd |
| `/project remove <alias>` | Unregister (admin) |
| `@all <msg>` | Broadcast |
| `@<name> <msg>` | Forward to a specific user |
| `/health` | Bot health (admin) — surfaces expired bots, cleanup hints |
| `/health ai` | AI provider status (admin) — per-provider session age, zero token |
| `/reset` or `/重置` | Drop AI sessions for this chat (admin) — next message starts fresh from current keychain |
| `/hearth ingest|list|show|apply` | Vault governance (admin, hearth-enabled) |
| `让<name>执行 <task>` / `派<name>跑 <task>` | Delegate a task to a paired hand machine (admin) — see [A2A integration](#a2a-integration-p3-opt-in) |

The Companion + memory features are configured via natural language, not slash
commands (`开启 companion`, `切到陪伴`, `别烦我`, etc.).

**Memory (admin).** Say `整理记忆` ("organize memory") and the bot synthesizes
your local Claude per-project memory (work) plus its WeChat observations (life)
into one overview it reads to understand you. Say `看记忆` / `你对我的理解`
("what's your understanding of me") to read that overview back. From the
terminal: `wechat-cc memory synthesize` regenerates it and `wechat-cc memory
status` shows its freshness + how much source memory is available to fold in.

**Self-diagnosis & self-healing (admin).** When something seems off, just ask
the bot — "你怎么不回消息了，检查下" / "why did this chat stop replying, fix it".
It can inspect its own per-turn outcomes (did the last turn time out? error?),
see which agent sessions are live or wedged, and check daemon health — then
remediate: release a wedged session (the next message starts a fresh
subprocess), switch the pinned model, or restart the daemon, each confirmed
back to you. These tools are **admin-only**, enforced two ways: they aren't
registered for non-admin chats, *and* the daemon's internal API checks the
caller's tier on every route — so even a shell-capable trusted/guest agent that
reads the token file and calls the route directly gets a `403`, not access.
(Each session carries a per-tier token; routes are default-deny.) Switching the
model this way takes effect on the next turn — no daemon restart needed.

---
