<h1 align="center">wechat-cc</h1>

<p align="center">
  <b>Reach your Claude Code session from WeChat — and let it reach back.</b>
</p>

<p align="center">
  <img alt="version"  src="https://img.shields.io/badge/cli-v0.5.0-blue">
  <img alt="desktop"  src="https://img.shields.io/badge/desktop-v0.5.0-blue">
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  <img alt="runtime"  src="https://img.shields.io/badge/runtime-Bun-black">
  <img alt="license"  src="https://img.shields.io/badge/license-MIT-green">
  <a href="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ggshr9/wechat-cc/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  English | <a href="./README.zh.md">中文</a>
</p>

---

## What is this?

`wechat-cc` is a Bun daemon that bridges your **WeChat (微信)** account to
**Claude Code** (and, since v2.0, **Codex** alongside it) running on your
computer. Once set up, you can:

- Send a text / image / file / voice message from your phone — your chosen
  agent on the desktop receives it, runs tools, and replies back into the
  chat.
- Pick a **conversation mode** per chat with `/cc` (Claude only), `/codex`
  (Codex only), `/both` (both answer in parallel), or `/chat` (they discuss
  with each other before answering you). See
  [Features §4](#4--multi-agent-cc-codex-both-chat--claude--codex-on-the-same-chat).
- Walk away from your desk and keep a long-running task moving via your phone.
- Let Claude **reach out to you**, not just respond. The Companion layer +
  the v0.4 dashboard turn it into a long-running AI presence that writes
  observations, fires milestones, and decides when to push.

It's positioned deliberately as a **personal Claude Code companion × depth ×
non-technical owner** — not a multi-IM, multi-agent broker. If you want
breadth, see [`cc-connect`](https://github.com/chenhg5/cc-connect). If you
want a single, deep WeChat × Claude Code experience that feels like a
relationship, this is it.

<p align="center">
  <img alt="Dashboard sessions detail — WeChat-replica chat in iPhone 17 Pro frame, with file + image + quote-reply" src="docs/screenshots/chat-detail.png" width="380">
</p>
<p align="center"><sub>Desktop dashboard · session detail. Every WeChat × Claude conversation lives inside a 1:1 iPhone replica — text, images, files, quote-replies, all of it. <i>(mock data — not a real conversation)</i></sub></p>

---

## Two ways to install

| | **Desktop installer** (recommended) | **Terminal** (developer) |
|---|---|---|
| Who | Anyone, including non-technical users | You're comfortable with bun + git |
| What you get | A 4-step wizard (env check → agent → QR → service install with live `(M/N) <step>` progress) + a dashboard with bound accounts, memory, sessions (with mode dropdown to switch chat mode from console), logs, one-click upgrades | Same daemon, no GUI |
| Path | Download a bundle from the [latest release](https://github.com/ggshr9/wechat-cc/releases/latest) | `git clone` + `bun install` + `wechat-cc setup` |
| Caveats | Bundles are unsigned (Apple Dev ID + Windows EV cert not yet provisioned) — first launch needs a one-time OS-warning bypass. macOS Intel not supported (Apple Silicon only). The desktop app shells out to the source-mode CLI, so you also need the source somewhere (or set `WECHAT_CC_ROOT`). | Works everywhere bun runs. |

Most people: grab the desktop bundle. Read on for the terminal path.

![Wizard environment-check step — red rows show inline fix commands with copy buttons; hard-severity reds get a left bar so the eye lands on the actually-blocking item first](docs/screenshots/wizard-doctor.png)

> Missing Claude Code? No bound WeChat? Each red row tells you the fix
> inline — copy the command and you're moving. Hard-severity rows
> (selected agent backend missing) get a left bar; soft ones (no
> account, allowlist empty) can be fixed any time after install.

---

## Quick start (terminal)

**Prerequisites:** [Git](https://git-scm.com), [Bun](https://bun.sh) 1.1+,
and [Claude Code CLI](https://github.com/anthropics/claude-code).

```bash
# Linux / macOS
curl -fsSL https://bun.sh/install | bash    # if needed
git clone https://github.com/ggshr9/wechat-cc.git ~/.claude/plugins/local/wechat
cd ~/.claude/plugins/local/wechat && bun install && bun link
wechat-cc setup       # scan the QR on your phone
wechat-cc run         # start the daemon
```

```powershell
# Windows
irm bun.sh/install.ps1 | iex                # if needed
winget install Git.Git                       # if needed
# Reopen the terminal so the new PATH takes effect.
git clone https://github.com/ggshr9/wechat-cc.git "$env:USERPROFILE\.claude\plugins\local\wechat"
cd "$env:USERPROFILE\.claude\plugins\local\wechat"
bun install ; bun link
wechat-cc setup ; wechat-cc run
```

That's it. Send a message from WeChat — Claude sees it on the desktop and
replies back into the chat.

> Each QR scan binds **one** 1:1 bot. ilink doesn't support group chat.
> Whoever scanned the QR is automatically added to the allowlist; everyone
> else is blocked by default.

<details>
<summary><b>Quick start (desktop bundle)</b></summary>

Download the bundle for your platform from the [latest release](https://github.com/ggshr9/wechat-cc/releases/latest):

| Platform | File | First-launch quirk |
|:---|:---|:---|
| **macOS (Apple Silicon)** | `*.dmg` | Right-click → **Open** (Gatekeeper warning, once). |
| **Windows (x64)** | `.exe` (NSIS) or `.msi` | SmartScreen → **More info** → **Run anyway**. |
| **Linux (x64)** | `.deb` / `.rpm` | No warning. |

The desktop app shells out to the `wechat-cc` CLI under the hood, so you
also need the source available somewhere:

```bash
git clone https://github.com/ggshr9/wechat-cc.git ~/.local/share/wechat-cc
cd ~/.local/share/wechat-cc && bun install
```

Or set `WECHAT_CC_ROOT=/some/path` in your environment.

Then launch the desktop app — the wizard walks you through environment
checks, agent picker (Claude or Codex), QR scan, and background service
install. After that you land in the dashboard.

</details>

---

## Features

### 1 · Two-way chat with the agent on your desk

Send text / images / files / voice from your phone; the agent (Claude or
Codex, picked per chat — see §4) sees everything, runs tools (Edit, Bash,
etc.), and replies back into the chat. ilink uploads media via CDN with
AES-128-ECB encryption. Voice transcription comes from ilink (displayed
inline) and untranscribed audio is saved to your inbox.

### 2 · `share_page` — long-form output you can read on your phone

WeChat can't render markdown. When Claude has a plan, spec, or review for
you, it calls `share_page({title, content})`:

1. Content written locally to `~/.claude/channels/wechat/docs/<slug>.md`
2. Local Bun server renders it via `marked` with mobile-friendly CSS
3. `cloudflared tunnel` exposes it at `*.trycloudflare.com` (auto-installed,
   no account needed)
4. URL sent to WeChat with title + preview

Each shared page has a single ✓ Approve button — tap once and the daemon
gets notified. No reject / comment fields; pushback goes through the chat.
Pages auto-clean after 7 days; `resurface_page` revives expired URLs on the
current tunnel.

### 3 · Multi-project switching

Register your projects once; switch between them from WeChat with natural
language or a slash command:

```
/project add /home/u/Documents/compass compass
切到 sidecar              ← natural language; Claude parses intent
/project switch sidecar   ← exact form
```

Each project keeps a warm Claude session in a per-project pool — switching
takes ~5 s and messages sent during the window are buffered by ilink, then
delivered after reconnect. When you reference an earlier conversation
(「刚才聊的 xxx」), Claude looks up `<target>/memory/_handoff.md` (a tiny
pointer file written on switch) and reads the source jsonl on demand —
nothing is eagerly copied across projects.

### 4 · Multi-agent (`/cc` `/codex` `/both` `/chat`) — Claude × Codex on the same chat

Pick the **conversation mode** per chat with a slash command. Each chat
remembers its choice across daemon restarts (`conversations.json`).

| Command | Mode | Who answers | What you see |
|---|---|---|---|
| `/cc`            | **Solo · Claude** | Claude only | Single reply |
| `/codex`         | **Solo · Codex**  | Codex only  | Single reply |
| `/cursor`        | **Solo · Cursor** | Cursor only (if `@cursor/sdk` + `CURSOR_API_KEY` are present) | Single reply |
| `/both`          | **Parallel** | All registered providers (or explicit list) independently | `[Claude] ...` + `[Codex] ...` + `[Cursor] ...` (one reply per participant) |
| `/cc + codex`    | **Primary + Tool** | Claude main, Codex on call | Single reply; Claude self-decides when to invoke `delegate_codex` |
| `/codex + cc`    | **Primary + Tool** | Codex main, Claude on call | Same shape, roles swapped |
| `/chat`          | **Chatroom** | All registered providers (or explicit list), multi-round dialogue | Mixed `[Claude]` / `[Codex]` / `[Cursor]` lines as they discuss, then a final answer |
| `/solo`          | revert to single-provider default | — | — |
| `/stop`          | cancel the current `/chat` loop | — | — |
| `/mode`          | show the current mode for this chat | — | — |

- **`/chat`** — chatroom mode. Multiple agents take turns under a haiku
  moderator that decides who speaks next per round. Bare `/chat` uses
  all registered providers (after cursor was added, that's claude +
  codex + cursor). Explicit form: `/chat claude codex` (2-way) or
  `/chat claude codex cursor` (3-way). P1 caps the participant list
  at 3 — extras are silently dropped with a log warning.

- **`/both`** (alias `/parallel`) — parallel mode. Same shape:
  bare → all registered, explicit → `/parallel claude cursor`. ≥2
  participants required; rejects unknown providers up front.

- **Legacy 2-way chats** — if you used `/chat` or `/both` before
  cursor was registered, your existing chats stay 2-way (claude +
  codex). The first dispatch under the new code persists this
  intent. To opt into 3-way explicitly, re-issue
  `/chat claude codex cursor`.

In **chatroom** mode (`/chat`) the assistants address each other with
line-anchored `@-tags`:

```
@user 我们一致认为是 X
@codex 你帮我 check src/foo.ts:42 这一段
```

Lines starting with `@user` (or no tag at all) are user-facing; `@codex` /
`@claude` / `@cursor` lines are routed to the relevant agent for the next
round. The loop ends when one of them just `@user`s a final answer, or when
`max_rounds=4` is hit. `/stop` aborts immediately.

The architecture is **open** — providers are an open string brand registered
through `ProviderRegistry`, not a Claude+Codex enum. **Cursor** ships as the
third provider out of the box (env-var-only, see [Cursor setup](#cursor-optional-third-provider)
below); adding a fourth SDK (Gemini / your own) is a new file in `src/core/`
plus a registry entry. See [`docs/rfc/03-multi-agent-architecture.md`](docs/rfc/03-multi-agent-architecture.md)
Appendix D.

> **Auth-agnostic for Codex.** Whether you authed via `codex login`
> (subscription) or set `OPENAI_API_KEY` (API plan), the daemon doesn't know
> or care — both paths just work.

> **Where do the tools live?** v2.0 moved all 22 tools (reply / share_page /
> memory / companion / delegate / …) into stdio MCP servers. Both providers
> talk to the same tool surface via a localhost-only daemon HTTP API
> (bearer-token, `0o600` token file, depth-header recursion guard).
> See [`docs/releases/2026-05-02-rfc03.md`](docs/releases/2026-05-02-rfc03.md).

The dashboard's **会话模式 · Conversations** card shows the current mode for
every active chat as a dropdown — change it from the console and the daemon
fires a confirmation back to that chat ("🎛 已切换到 X（来自控制台）") so the
person on their phone sees the switch. Mode flips from the chat (`/cc`,
`/codex`, etc.) and from the dashboard go through the same `coordinator.setMode`
call; SQLite `conversations` table is the single source of truth.

### 5 · Companion — the Claude that reaches out

Opt-in proactive mode. When `companion_enable` is set, the daemon runs two
schedulers:

- **Push tick** (~20 min ± jitter) — Claude reads memory + recent context,
  decides whether to push you something. Two pickable personas:
  - **小助手 (assistant)** — work-focused, strict push rules
  - **陪伴 (companion)** — warmer, lighter rules, evening check-ins
- **Introspect tick** (24 h ± jitter, **v0.4.1**) — Claude (claude-haiku-4-5,
  isolated single-shot) reviews recent activity and decides whether to write
  a new observation in `memory/<chat>/observations.jsonl`. Never pushes.
  Surface comes when you open the dashboard.

Natural-language controls:
- `开启 companion` / `关闭 companion`
- `切到陪伴` / `换回小助手`
- `别烦我` / `snooze 3 小时`

### 6 · Two mirrors of accompaniment (v0.4 dashboard)

The desktop dashboard reflects two perspectives on the same relationship:

**记忆 (Memory)** — Claude's lens
- Top: Claude's recent observations + milestone cards (the surprise mechanic
  — *打开才发现的小惊喜*; never pushed)
- Middle: editable per-chat markdown (profile.md / preferences.md / …)
- Bottom: collapsible "Claude's recent decisions" timeline (push / skip /
  observation / milestone / SDK error). Click a row to see the reasoning.

![Memory pane — observation card up top, file tree on left, preferences.md showing tool stack / PR habits / session-resume conventions, decisions timeline collapsed at the bottom](docs/screenshots/memory-pane.png)

<sub><i>Mock data. Memory is a general markdown container — shown here as project memory (tool preferences, PR habits, session resume); the same container holds Companion-mode observation notes, see §4.</i></sub>

**会话 (Sessions)** — your shared record
- Cross-session full-text search
- Project list grouped by recency (今天 / 7 天内 / 更早) with one-line LLM
  summary per project (claude-haiku-4-5, lazy-refreshed)
- Drill into any project's jsonl conversation stream; favorite / export
  markdown / delete

Milestone detector fires on each inbound message: 100/1000 turns,
first_handoff, first_push_reply, **7day_streak** (UTC date tracking via
per-chat `activity.jsonl`).

> See [`docs/specs/2026-04-29-sessions-memory-design.md`](docs/specs/2026-04-29-sessions-memory-design.md)
> for the design pillars (双面镜子 / 老朋友的随手观察 / 克制 / 留白) and
> [`docs/specs/2026-04-29-v0.4.1.md`](docs/specs/2026-04-29-v0.4.1.md) for
> SDK + activity tracking specifics.

### 7 · Hearth integration — vault governance from your phone

Capture text into a personal markdown vault, propose a `ChangePlan`, review
the rendered `share_page`, tap ✓ Approve — all without leaving WeChat. Built
on [hearth](https://github.com/ggshr9/hearth), the agent-native vault
governance layer.

```
/hearth ingest <text>      → propose a ChangePlan, send a review card
/hearth list               → 10 most recent pending plans
/hearth show <id>          → preview ops + body
/hearth apply <id>         → kernel apply (owner-direct, no token needed)
```

Owner-only (admin-gated). vault is never written by the channel — all
writes go through hearth's kernel after human approval. Setup:

```bash
git clone https://github.com/ggshr9/hearth.git ~/Documents/hearth
cd ~/Documents/hearth && bun install
bun src/cli/index.ts setup              # auto-detects Obsidian vaults
export HEARTH_VAULT=/path/to/your/vault
export HEARTH_AGENT=mock                # or "claude" with an Anthropic key
```

### 8 · Voice replies

Say "念一下 X" / "speak it" and Claude voices the response. Primary provider
is [VoxCPM2](https://huggingface.co/openbmb/VoxCPM2) via `vllm serve --omni`
(OpenAI-compatible `/v1/audio/speech`). Qwen DashScope is the cloud fallback.
Configured entirely via WeChat conversation — Claude walks you through the
API-key / base-URL setup the first time you ask.

### 9 · CLI fallback

If the daemon crashes, you can still reply from any terminal:

```bash
wechat-cc reply "I'll be back in 10 min"          # → most-recent chat
wechat-cc reply --to <chat_id> "specific user"
echo "piped text" | wechat-cc reply
```

The CLI reads the same `~/.claude/channels/wechat/` state as the running
daemon, so recipient resolution + session continuity are identical. State
files are the source of truth; you never lose a thread because the daemon
restarted.

---

## How it works

```
[your phone]                  [your desktop]
                                                 ┌─► Claude Agent SDK ─► Claude
   WeChat ──────► ilink ──► wechat-cc daemon ────┤
       │         (long-poll)        │            └─► Codex SDK ─────────► Codex
       │                            │
       │                            └─► coordinator ── mode-aware dispatch
       ▼                                              (solo / parallel /
   share_page ◄── cloudflared ◄── Bun.serve(local)     primary_tool / chatroom)
                                                ▲
   stdio MCP ────────────────────► daemon internal HTTP (localhost-only,
   (wechat tools + delegate)                            bearer token, 0o600)
```

- **Receive**: per-account long-polling `POST /ilink/bot/getupdates`
- **Send**: `POST /ilink/bot/sendmessage` (requires the user's
  `context_token` — they must message the bot first)
- **Drivers**: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, and
  (optionally, via `optionalDependencies`) `@cursor/sdk`, registered
  side-by-side via `ProviderRegistry`. Cursor is enabled when `CURSOR_API_KEY`
  is set and the SDK loads. Adding a fourth provider (Gemini / your own) is
  a new file in `src/core/`. See
  [`docs/rfc/03-multi-agent-architecture.md`](docs/rfc/03-multi-agent-architecture.md)
- **Tools**: 22 tools (reply / share_page / memory / companion / delegate /
  …) live in stdio MCP servers under `src/mcp-servers/`. Both providers
  reach them through the daemon's localhost-only internal HTTP API
- **State**: everything under `~/.claude/channels/wechat/` (see [State layout](#state-layout))
- **Companion**: two schedulers (push + introspect) with separate cadences;
  isolated SDK evals for introspect / summary so the prompt style doesn't
  leak into project sessions

---

## Permission modes

**Strict (default)** — `wechat-cc run` — every tool call prompts you on
WeChat (`y abc12` allow / `n abc12` deny, 10-min timeout). Matches the
permission relay design.

**Bypass** — `wechat-cc run --dangerously` — Claude runs tools without
WeChat prompts. Equivalent to `claude --dangerously-skip-permissions`.
Claude is trained to confirm destructive operations via natural-language
reply before acting. Use only on a personal daemon where you control the
allowlist.

> ⚠️ Don't run `--dangerously` on a bot you share with less-trusted users
> via `access.json.allowFrom[]` — any allowed chat gets bypass.

### Provider × mode interaction

The two SDKs expose permissions differently — Claude has a per-tool
`canUseTool` callback (each tool call can ping you), Codex only has a
process-level `approval_policy` (one switch per session). What this means
in practice:

| Mode (per chat) | Claude side | Codex side | Net behavior in **strict** | Net behavior in **`--dangerously`** |
|---|---|---|---|---|
| `/cc` (solo · Claude) | per-tool relay → WeChat prompt | n/a | every tool call asks you | runs without asking |
| `/codex` (solo · Codex) | n/a | `approval_policy=untrusted` (when strict) or `never` (when bypass) | Codex's own approval policy gates it; not surfaced through WeChat | runs without asking |
| `/cc + codex` (Claude main, Codex tool) | per-tool relay applies to Claude | Codex runs under `never` inside `delegate_codex` regardless of mode | Claude prompts as usual; Codex sub-call doesn't | both run without asking |
| `/codex + cc` (Codex main, Claude tool) | per-tool relay applies to delegated Claude turn | Codex's `approval_policy` | Codex policy + Claude prompts on its delegated tools | both run without asking |
| `/both` (parallel) | per-tool relay | `approval_policy` | mixed: Claude asks, Codex doesn't surface | both run without asking |
| `/chat` (chatroom) | per-tool relay each Claude turn | `approval_policy` each Codex turn | mixed (same as parallel) | both run without asking |

**Two implications worth knowing**:
1. **In strict mode, `/codex` and `/both` won't ask you on WeChat** for
   Codex tool calls — the SDK doesn't expose a per-tool callback, only
   the coarse `approval_policy`. If you need per-tool confirmation,
   stay on `/cc`.
2. **`delegate_codex` always runs `never`** — by design. The peer-as-tool
   call is a one-shot consultation, not a sub-conversation, and the
   primary agent is the one being prompted on its own tools. Bounded
   by `delegate` depth=2 (RFC 03 §4.2).

See [`docs/rfc/03-multi-agent-architecture.md` §3.5](docs/rfc/03-multi-agent-architecture.md)
for the SDK-level capability table this is derived from.

---

## WeChat commands

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

The Companion + memory features are configured via natural language, not
slash commands (`开启 companion`, `切到陪伴`, `别烦我`, etc.).

---

## Updating

```bash
wechat-cc update             # pull + reinstall deps + restart service
wechat-cc update --check     # probe only, no side effects
```

The desktop GUI calls `--check` on launch to surface a **立即升级** button.

If the daemon is running as a service (LaunchAgent / systemd / Scheduled
Task), `update` automatically stops, pulls, reinstalls deps if `bun.lock`
changed, and restarts. If you're running `wechat-cc run` in a foreground
terminal, the command refuses with `daemon_running_not_service` so it
won't kill your shell — Ctrl+C the foreground process first.

---

## State layout

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

## Access control

Allowlist-only by default. Manage from the **terminal**, not WeChat (this
prevents prompt-injection from a chat you've allowed):

```
/wechat:access                        # show policy + allowlist
/wechat:access allow <user_id>        # add a sender
/wechat:access remove <user_id>       # remove a sender
```

Users who scan the QR during `wechat-cc setup` are automatically allowed.

### Permission tiers (v0.6+)

Each chatId in `access.json` falls into one of three tiers:

- `admins`: full access — the bot runs every tool unconditionally.
- `trusted`: full access EXCEPT destructive operations (rm, git reset --hard,
  git push --force, memory_delete). Destructive ops prompt the admin chat for
  approval.
- everyone else in `allowFrom`: guest tier — can chat, read their own memory,
  and that's it. Bash/Edit/Write/Task/WebFetch/WebSearch are denied outright.

Example `access.json`:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["wxid_owner", "wxid_friend", "wxid_acquaintance"],
  "admins": ["wxid_owner"],
  "trusted": ["wxid_friend"]
}
```

Above: `wxid_owner` is admin (you), `wxid_friend` can drive most of the
agent's tools (you'll get a prompt before they delete anything), and
`wxid_acquaintance` can only chat.

Caveat: destructive Bash detection is regex-based and conservative
(matches `rm`, `git reset --hard`, `git push --force`, `git branch -D`,
`dd if=… of=…`). A determined caller can obfuscate. Don't put untrusted
people in `trusted` tier.

### Cursor (optional third provider)

To enable Cursor:

1. `bun add @cursor/sdk` (if not already installed — it's in `optionalDependencies`,
   so it usually installs by default)
2. Set `CURSOR_API_KEY` in your shell or systemd unit
3. Restart the daemon. `wechat-cc doctor` should show `cursor: ok`.
4. Send `/cursor` in WeChat to route that chat to Cursor.

You can persist Cursor as your default provider via:

```bash
wechat-cc provider set cursor --model composer-2
```

Tier behavior for Cursor follows the same [Permission tiers](#permission-tiers-v06)
above, but with one caveat — see the "Cursor tier enforcement is the coarsest"
entry under [Known limitations](#known-limitations).

---

## A2A integration (P3, opt-in)

wechat-cc is an [A2A-protocol](https://github.com/google-deepmind/a2a) node — it
can act as both **client** (calling external agents) and **server** (receiving
notifications from them).

**Receiving notifications from external agents.** The A2A HTTP server is
**off by default**. Enable it via `agent-config.json:a2a_listen`. When enabled,
it binds `127.0.0.1` unless you override `a2a_listen.host`. Each registered
agent gets its own inbound API key that must be present on every
`POST /a2a/notify` call — no shared secrets.

**Registering an external agent.** `wechat-cc agent add <url>` fetches the
Agent Card at `<url>/.well-known/agent.json`, generates an inbound API key
locally, and writes the registration to `agent-config.json`. Share the
generated key with the external agent so it can call your notify endpoint.

**Replying to a notification.** Inbound notifications appear in chat as
`[A2A:<agent-id>] …`. When you tell Claude/Codex/Cursor "tell them X", the
agent calls the MCP tool `a2a_send(agent_id, text)`, which pushes the reply
back via the A2A outbound URL.

**Tier gating.** `a2a_send` follows the same shape as the `delegate_<peer>`
tools: admin auto-allow, trusted relays through the standard WeChat permission
prompt, guest forbidden.

### CLI subcommands

```
wechat-cc daemon a2a enable [--host H] [--port P]
                                # enable inbound server (default 127.0.0.1:8717)
wechat-cc daemon a2a disable    # disable inbound server
wechat-cc daemon a2a status     # config vs runtime status (drift detection)
wechat-cc agent info            # show A2A server status + base URL (share with external agents)
wechat-cc agent inspect <url>   # fetch Agent Card, print metadata
wechat-cc agent add <url>       # register agent, generate inbound API key
wechat-cc agent list            # list all registered agents
wechat-cc agent pause <id>      # mute inbound + outbound for this agent
wechat-cc agent resume <id>     # un-mute
wechat-cc agent remove <id>     # drop registration
wechat-cc agent edit <id> [--name N] [--url U] [--outbound-key K] [--rotate-inbound-key]
                                # patch a registered agent (rotate keys / move URL) without remove + re-add
wechat-cc agent activity <id>   # recent A2A events (includes auth_failed attempts + dropped_no_operator_chat)
wechat-cc agent test <id>       # synthetic INBOUND notify → operator's WeChat chat
wechat-cc agent test <id> --outbound
                                # synthetic OUTBOUND call to <id>'s URL (verifies outbound_api_key)

# One brain, many hands (delegation) — see the section below:
wechat-cc hand invite           # HAND: mint a one-time pairing code
wechat-cc hand join <code> --id <id> --name <name>
                                # BRAIN: join a hand, auto-register both sides
wechat-cc hand list             # show paired hands + brains
wechat-cc hand ping [<id|name>] # check hand reachability
wechat-cc hand add <id> <url> --token <T>   # manual pairing (BRAIN side)
wechat-cc hand accept --token <T>           # manual pairing (HAND side)
```

### Quick start

```bash
# 1. Enable the A2A inbound server.
wechat-cc daemon a2a enable
# Restart the daemon to apply.

# 2. Get your daemon's A2A base URL (share this with external agents):
wechat-cc agent info
# A2A status: running
#   Base URL: http://127.0.0.1:8717
#   Bound:    127.0.0.1:8717
#   PID:      42718

# 3. Register an external A2A agent — the CLI fetches its Agent Card,
#    generates an inbound API key, and prints a curl example with your
#    actual base URL pre-filled.
wechat-cc agent add https://deploy-bot.example.com/a2a

# 4. (Optional) Smoke test the loop: simulate the agent calling your
#    /a2a/notify endpoint. The message should appear in your WeChat
#    chat as `[A2A:deploy-bot] test from deploy-bot via wechat-cc`.
wechat-cc agent test deploy-bot

# 5. From WeChat, tell claude/codex/cursor "reply to deploy-bot: retry"
#    — the agent uses the `a2a_send` MCP tool to push your reply back.
```

### One brain, many hands (delegate tasks to other machines)

On top of notify, a wechat-cc can **delegate a task to another wechat-cc** and
get the result back. One machine is the **brain** (holds the bot); the others
are **hands** that run a full local agent (Read/Bash) on demand. From WeChat you
say `让<name>执行 <task>` ("have <name> run <task>") and the brain dispatches it
to that hand, returning the result to your chat — so from the office you can
drive your home machine, or ask about a project that only lives there.

Pairing is one command per side — no manual token copying:

```bash
# On the HAND (bind A2A to your private Tailscale IP first):
wechat-cc daemon a2a enable --host <100.x.y.z> --port 8717   # then restart the daemon
wechat-cc hand invite                # prints a one-time pairing code (10-min TTL, single-use)

# On the BRAIN:
wechat-cc hand join <code> --id home --name home   # auto-registers both sides
wechat-cc hand ping                  # confirm the hand is reachable (fetches its Agent Card)
wechat-cc hand list                  # hands you can delegate to / brains that can delegate here
```

Then from WeChat: `让home执行 summarize ~/proj/README`.

The hand is the reachable party (it runs the A2A server); the brain only calls
out, so the brain needs **no inbound listener**. Run this only over a private
tailnet — `/a2a/exec` executes an agent on the hand.

### Threat model

- The A2A server is **off by default**; opt-in by setting `a2a_listen` in
  `agent-config.json`.
- When enabled, binds `127.0.0.1` unless `a2a_listen.host` is explicitly
  changed.
- Each registered agent has its own inbound API key, verified on every notify
  request.
- Outbound calls carry the agent-provided `outbound_api_key` from the Agent
  Card.
- `/a2a/exec` (the "hand" capability) runs a full local agent on the hand —
  treat the exec key as remote-code-execution power. Only enable it bound to a
  private Tailscale IP (`100.x.y.z`), never `0.0.0.0` or a public interface.
- Pairing codes (`hand invite`) are one-time and expire in 10 minutes; the key
  they exchange is the delegation credential, so pair only over your tailnet.
- TLS is the operator's responsibility — use a reverse proxy for HTTPS if you
  expose the endpoint publicly.

---

## Demo data (for screenshots / first impressions)

A fresh install means empty memory and zero observations. To preview what a
populated dashboard looks like:

```bash
wechat-cc demo seed                   # 3 observations + 1 milestone + 5 events
wechat-cc demo unseed                 # remove them
wechat-cc demo seed --chat-id <id>    # specific chat instead of default
```

Stable `obs_demo_*` / `ms_demo_*` ids make `unseed` reliable.

---

## Known limitations

- **First contact** — you can't message a WeChat user who hasn't sent at
  least one message to the bot first (ilink requires their `context_token`).
- **No group chat** — ilink is 1:1 only.
- **macOS Intel desktop bundle** — not yet provided. Install via terminal.
- **Desktop bundle unsigned** — first launch needs a one-time
  Gatekeeper / SmartScreen bypass.
- **Conversation continuity across daemon restart** — the WeChat chat
  history stays on your phone, but Claude doesn't replay it on restart.
  Per-project session resume keeps the *current* working session warm; it
  doesn't reconstruct earlier ones.
- **Switching agents mid-chat doesn't carry recent turns** — `/cc` and
  `/codex` each run on their own conversation. Long-term memory (notes,
  preferences, observations the companion wrote about you) is shared, so
  the new agent still knows *who you are*. But it won't know what the
  other agent just said two messages ago — if that context matters,
  paste it yourself.
- **Permission tiering is best-effort, not a security boundary** — destructive
  Bash detection is regex-based and can be bypassed by a determined caller
  (e.g. `eval` chains). Use `trusted` tier for people you'd hand the keyboard
  to. For people you wouldn't, leave them in default (guest) tier.
- **Codex tier enforcement is coarser than Claude's** — the Codex SDK has no
  per-tool callback. Trusted users on Codex get `workspace-write` sandbox +
  `never` approval, which means destructive operations *within the workspace
  cwd* are still possible. The guest tier on Codex uses `read-only` sandbox,
  which is solid.
- **Cursor tier enforcement is the coarsest of the three providers** — Cursor SDK
  has only one permission knob (`local.sandboxOptions.enabled`). Admin tier disables
  the sandbox; trusted + guest both enable it. There's no read-only-mode equivalent
  to Codex's guest tier, so a guest using Cursor can write inside the project's
  working directory. If you have guests you don't trust to write inside cwd, route
  them to Claude (whose `disallowedTools` array enforces strict per-tool blocks
  for guest tier).
- **3-participant cap** — chatroom and parallel are capped at 3
  participants in P1. The moderator's coherence with 4+ speakers is
  untested; the cap is a safety net. Raise it once we've seen real
  3-way data.
- **v0.6 sessions table schema is one-way** — migration v10 adds a `chat_id`
  column and rebuilds the primary key as `(alias, provider, chat_id)`. The
  upgrade is safe; the downgrade isn't. A v0.5 binary opening a post-v0.6
  database will see its old `(alias, provider)` query miss every new row,
  because the data is keyed under a different shape. If you need to roll
  back, restore the sessions table from a pre-upgrade backup.

---

## Troubleshooting

**`bun`, `git`, or `wechat-cc` not found after install**
Reopen your terminal. PATH changes from `bun link` or a fresh Bun/Git
install don't take effect in the current shell session.

**Reading logs on Windows — Chinese characters show as garbage**
PowerShell's default `Get-Content` reads files as ANSI (GBK). Use:
```powershell
Get-Content "$env:USERPROFILE\.claude\channels\wechat\channel.log" -Tail 60 -Encoding UTF8
```

**Windows Firewall popup on first `share_page`**
Fixed in v1.0 — `docs.ts` binds `127.0.0.1`. If you see this on an older
install, run `wechat-cc update`.

**`wechat-cc update` fails with "git not found"**
`update` runs `git pull`. Ensure Git is in PATH. Windows:
`winget install Git.Git`, then reopen the terminal.

**Bot stops responding (errcode=-14)**
Run `/health` from WeChat (admin-gated). Expired bots show up there;
respond with `清理 <bot-id>` to remove from active list. Re-scan the QR
to bind a fresh session.

**AI replies with "AI 暂时不可用…" notice (v0.5.17+)**
Your AI provider's credentials have gone stale — either OAuth tokens
expired and the long-running subprocess can't refresh, or you haven't
run `claude` interactively on this machine yet. The daemon now self-heals
on the next message (idle reset + reactive sentinel), but if you want to
force it right now, send `/reset` (or `/重置`) from your WeChat chat. The
daemon also auto-recycles a stale session for any chat that's still busy
when its access token expires, so most users won't see this notice more
than once per failure.

If you've never run `claude` on this machine: open a terminal, run
`claude /login`, complete the OAuth flow, then send any message in WeChat
— the next dispatch picks up the fresh keychain credential automatically.

**Codex provider unavailable / no codex reply (v0.5.17+)**
`wechat-cc-cli doctor` shows the installed `codex` version. If it differs
from the bundled SDK's expected version (e.g. installed 0.125 vs bundled
0.128), the boot log will say `codex provider NOT registered — version
check failed`. Fix: `npm i -g @openai/codex@<expected-version>` (the boot
log includes the exact version), or remove the older codex from PATH.
Restart the daemon. `wechat-cc setup` doesn't need to re-run.

---

## Uninstall

```bash
# Linux / macOS
rm -rf ~/.claude/plugins/local/wechat   # remove plugin source
rm -rf ~/.claude/channels/wechat        # wipe all state
```

```powershell
# Windows
Remove-Item "$env:USERPROFILE\.claude\plugins\local\wechat"
Remove-Item "$env:USERPROFILE\.claude\channels\wechat" -Recurse -Force
```

If you used the desktop bundle, also drag the app to Trash / uninstall via
the OS package manager.

---

## Use cases

- **Out and about with a long task running** — start a deploy / refactor on
  your computer, lock the screen, keep nudging it from your phone.
- **Forward a Claude-generated plan to your boss** — `share_page` produces
  a clean URL with an Approve button; non-technical reviewers don't have to
  read the chat.
- **Multi-user**: share the bot with teammates via `access.json.allowFrom[]`.
  Each person's messages route to your single Claude session.
- **A Claude that remembers you** — Companion + memory pane build a small,
  honest portrait over time. You can read it, correct it, archive things
  you don't want remembered.

---

## Versions

- **CLI / daemon**: see [`package.json`](./package.json). Latest shipped is
  **v0.5.0** — architecture cleanup (`Ref` + `wireRef` helper, `wiring/` 5-file split,
  `bootDaemon()` export, daemon e2e infra) + UX bundle (install wizard real-time
  step progress, dashboard mode-switch dropdown with WeChat confirmation back to
  the chat, clearer WSL hint). See [`docs/releases/2026-05-03-v0.5.md`](./docs/releases/2026-05-03-v0.5.md).
  Previous milestone: [RFC 03 multi-agent](./docs/releases/2026-05-02-rfc03.md)
  (Claude × Codex modes / stdio MCP / open provider registry).
- **Desktop bundle**: latest signed release is
  [`desktop-v0.5.0`](https://github.com/ggshr9/wechat-cc/releases/tag/desktop-v0.5.0).
  Version-synced with CLI v0.5.0; brings install-progress display + mode-switch
  dropdown to the dashboard. See [`docs/releases/desktop-v0.5.0.md`](./docs/releases/desktop-v0.5.0.md).
- **Per-version release notes**: [`docs/releases/`](./docs/releases/)
- **Architecture / design specs**: [`docs/specs/`](./docs/specs/)
- **Roadmap**: [`docs/rfc/02-post-v1.1-roadmap.md`](./docs/rfc/02-post-v1.1-roadmap.md)

---

## Contributing

Issues + PRs welcome at [github.com/ggshr9/wechat-cc](https://github.com/ggshr9/wechat-cc/issues).

```bash
bun install
bun x vitest run        # full test suite (currently 684 tests)
bun x tsc --noEmit      # type check
```

The `apps/desktop/` directory has a Tauri 2 GUI; for fast iteration use
`bun run shim` (browser-side mock) or `bun run dev` (real Tauri shell). See
[`apps/desktop/test-shim.ts`](./apps/desktop/test-shim.ts) for the dev
harness.

---

## Disclaimer

This is an **unofficial, community-built plugin** — not affiliated with,
endorsed by, or sponsored by Tencent or WeChat.

---

## License

MIT — see [LICENSE](./LICENSE).
