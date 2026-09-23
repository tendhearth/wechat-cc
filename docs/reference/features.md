# Features in full

> 从根 README 搬到这里(2026-09-22),README 只留门面与指路。索引见 [docs/INDEX.md](../INDEX.md)。

## 1 · Two-way chat with the agent on your desk

Send text / images / files / voice from your phone; the agent (Claude or
Codex, picked per chat — see §4) sees everything, runs tools (Edit, Bash,
etc.), and replies back into the chat. ilink uploads media via CDN with
AES-128-ECB encryption. Voice transcription comes from ilink (displayed
inline) and untranscribed audio is saved to your inbox.

## 2 · `share_page` — long-form output you can read on your phone

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

## 3 · Multi-project switching

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

## 4 · Multi-agent (`/cc` `/codex` `/both` `/chat`) — Claude × Codex on the same chat

Pick the **conversation mode** per chat with a slash command. Each chat
remembers its choice across daemon restarts (`conversations.json`).

| Command | Mode | Who answers | What you see |
|---|---|---|---|
| `/cc`            | **Solo · Claude** | Claude only | Single reply |
| `/codex`         | **Solo · Codex**  | Codex only  | Single reply |
| `/cursor`        | **Solo · Cursor** | Cursor only — cursor-agent CLI（订阅登录）是首选路径，对话与工作台都走 ACP；`CURSOR_API_KEY` + `@cursor/sdk` 仍是兜底 | Single reply |
| `/both`          | **Parallel** | All registered providers (or explicit list) independently | `[Claude] ...` + `[Codex] ...` + `[Cursor] ...`, then a 🎯 synthesis |
| `/cc + codex`    | **Primary + Tool** | Claude main, Codex on call | Single reply; Claude self-decides when to invoke `delegate_codex` |
| `/codex + cc`    | **Primary + Tool** | Codex main, Claude on call | Same shape, roles swapped |
| `/chat`          | **Chatroom** | All registered providers (or explicit list); anonymized debate | `[Claude]` / `[Codex]` / `[Cursor]` lines as they discuss, then a 🎯 verdict + 📊 peer-review line |
| `/solo`          | revert to single-provider default | — | — |
| `/stop`          | cancel the current `/chat` loop | — | — |
| `/mode`          | show the current mode for this chat | — | — |

- **`/chat`** — chatroom mode. Bare `/chat` uses all registered
  providers; explicit form `/chat claude codex` (2-way) or
  `/chat claude codex cursor` (3-way). Capped at 3 participants —
  extras are dropped with a log warning.

  The pipeline (`chatroom-conductor.ts`):

  1. **开场** — every participant answers independently, knowing who
     else is at the table.
  2. **争点地图** — one cheap eval asks what they actually disagree
     about. **No real disagreement ⇒ the whole cross-talk round is
     skipped** and the verdict is written straight from the openings
     (the verdict says so, so a skipped round doesn't read like a bug).
  3. **互驳** — anonymized. Nobody sees which model wrote which answer,
     because a name badge buys deference: models are gentler on
     `[Claude]` than on `Response B`. Each participant is assigned a
     distinct critical lens (事实与证据 / 假设与推理 / 遗漏与代价) so
     three agents don't produce three versions of the same paragraph,
     and each returns a `#RANK:` line rating the answers.
  4. **裁决** — also anonymized, told to take a side rather than list
     "two perspectives", with a one-line peer-review footer
     (`📊 互评`, Borda-counted, **self-votes excluded**).

  Why anonymized peer review: borrowed from
  [karpathy/llm-council](https://github.com/karpathy/llm-council).
  Why heterogeneity matters: the 2026 evidence
  ([arXiv 2502.08788](https://arxiv.org/abs/2502.08788),
  [2605.00914](https://arxiv.org/html/2605.00914v1)) is that *unguided
  homogeneous* debate does **not** beat one model with more compute —
  model heterogeneity is the factor that does. wechat-cc's panel is
  genuinely cross-vendor (Claude in-process SDK · Gemini via Antigravity ·
  Codex · Cursor · any OpenAI-compatible endpoint), which is the case
  where debate actually pays.

- **`/both`** (alias `/parallel`) — parallel mode: everyone answers
  independently, no cross-talk, and a short 🎯 synthesis closes it out
  (anonymized inputs; skipped when fewer than two answers came back).
  Bare → all registered, explicit → `/parallel claude cursor`. ≥2
  participants required; rejects unknown providers up front.
  Cheaper and faster than `/chat` — use `/chat` when the answers are
  likely to *conflict*, `/both` when you just want two takes.

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

## 5 · Companion — the Claude that reaches out

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

## 6 · Two mirrors of accompaniment (v0.4 dashboard)

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

## 7 · Hearth integration — vault governance from your phone

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

## 8 · Voice replies

Say "念一下 X" / "speak it" and Claude voices the response. Primary provider
is [VoxCPM2](https://huggingface.co/openbmb/VoxCPM2) via `vllm serve --omni`
(OpenAI-compatible `/v1/audio/speech`). Qwen DashScope is the cloud fallback.
Configured entirely via WeChat conversation — Claude walks you through the
API-key / base-URL setup the first time you ask.

## 9 · CLI fallback

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

## 10 · Your own terminal sessions, on WeChat (hooks)

The daemon's own agent sessions already relay permissions to WeChat. With
hooks installed, the `claude` / `codex` sessions **you** run in a terminal get
the same treatment:

```bash
wechat-cc hook install            # writes ~/.claude/settings.json + $CODEX_HOME/hooks.json (idempotent)
wechat-cc hook status             # what's installed, which command line
wechat-cc hook uninstall          # removes only wechat-cc's own entries
```

- **Presence is a machine signal, not a setting.** The hook reports how long
  ago the last keyboard/mouse input was on that machine. Under 2 min → you're
  there: a native desktop notification, nothing on WeChat. Otherwise → WeChat.
  Activity on your phone is deliberately *not* a signal (you may not reply for
  hours).
- **Long turn finished while you were away** → one WeChat message: which CLI,
  which machine (`那边(win-test)` when it's another box), which project,
  session short-id, and the full last assistant message (markdown stripped;
  very long ones get a `share_page` link). Held 45 s and dropped if you type
  again; quick turns (< 90 s) and repeated stops without a new prompt from
  you never notify (harness-generated prompts such as `/loop` wake-ups don't
  count as you typing). Several sessions finishing together → one digest.
- **Waiting for approval** → the request goes to WeChat as a card: reply
  `y <code>` / `n <code>` and the terminal proceeds (120 s window; then the
  terminal asks as usual).
- **Talk back**: `看 <code>` renders that session's recent turns to a page;
  `@<code> <text>` resumes the session (`claude -p --resume` /
  `codex exec resume`) with your text and posts the result back.
- **Brain / hands**: on a hand (paired with `hand join`, re-pair once to get
  the callback), all of the above is forwarded to the brain, which owns the
  WeChat side; `看` / `@` for a hand's session are dispatched back to it.
- Sessions spawned by the daemon itself never loop back (`WECHAT_CC_DAEMON_CHILD=1`).
  The hook never blocks the CLI: no daemon, no network → silent exit 0.

Both CLIs speak the same hook contract (`Stop` / `UserPromptSubmit` /
`SessionEnd` / `PermissionRequest`), so one implementation covers Claude Code
and Codex. Design: `docs/superpowers/specs/2026-09-09-cli-hook-push-design.md`.

---
