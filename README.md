<h1 align="center">wechat-cc</h1>

<p align="center">
  <b>An AI companion and one place to work with Claude, Codex and API models — on desktop and WeChat.</b>
</p>

<p align="center">
  <a href="https://github.com/tendhearth/wechat-cc/releases"><img alt="latest release" src="https://img.shields.io/github/v/release/tendhearth/wechat-cc?display_name=tag"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  <img alt="runtime"  src="https://img.shields.io/badge/runtime-Bun-black">
  <img alt="license"  src="https://img.shields.io/badge/license-MIT-green">
  <a href="https://github.com/tendhearth/wechat-cc/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/tendhearth/wechat-cc/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  English | <a href="./README.zh.md">中文</a>
</p>

<p align="center">
  <sub>Docs: <a href="./docs/INDEX.md">index</a> · <a href="./docs/roadmap.md">roadmap</a> · <a href="./docs/architecture.md">architecture</a> · <a href="./docs/maintainer/README.md">maintainer</a></sub>
</p>

---

## What is this?

**CC is an AI companion with a shared workspace for getting things done.** It brings Claude Code, Codex and configured API models into one desktop entry, with WeChat access to the same tasks when you step away.

- **Now:** see what CC is doing, with room for quiet companionship.
- **Together:** start tasks, read the full conversation, handle questions and permissions, inspect results, and continue work without juggling separate agent windows.
- **Memories:** return to earlier moments, drawings, journal entries and postcards. Personal companion memory stays separate from work-task context.

Projects have separate task records, drafts, conversations and artifacts. Conflicting work in the same directory queues; explicit Claude ↔ Codex handoffs preserve the selected context and result versions. WeChat can create tasks in known projects, supply input, handle requests, opt into notifications and retrieve saved results.

**Current scope:** Claude/Codex use specialized native adapters. The configured API task adapter handles text/image materials and new text artifacts with a narrower tool set. Existing Cursor/agy chat connections are **not** yet admitted as managed workbench executors. CC does not claim complete feature parity with every CLI or app, or live-process transfer between computers.

> This describes the current **dev branch**, not a newly released installer. Start with the [workspace guide and capability boundaries](docs/cc-workbench.md), the [reference projects and sources](docs/research/2026-09-14-cc-agent-workbench-references.md), and the [batch delivery record](docs/superpowers/reports/2026-09-14-cc-workbench-wrapup.md). These three documents are written in Chinese.

Task records are stored locally. Material needed for a task is sent to the AI service you select; local storage does not mean local inference.

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
| Path | Download a bundle from the [latest release](https://github.com/tendhearth/wechat-cc/releases/latest) | `git clone` + `bun install` + `wechat-cc setup` |
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
git clone https://github.com/tendhearth/wechat-cc.git ~/.claude/plugins/local/wechat
cd ~/.claude/plugins/local/wechat && bun install && bun link
wechat-cc setup       # scan the QR on your phone
wechat-cc run         # start the daemon
```

```powershell
# Windows
irm bun.sh/install.ps1 | iex                # if needed
winget install Git.Git                       # if needed
# Reopen the terminal so the new PATH takes effect.
git clone https://github.com/tendhearth/wechat-cc.git "$env:USERPROFILE\.claude\plugins\local\wechat"
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

Download the bundle for your platform from the [latest release](https://github.com/tendhearth/wechat-cc/releases/latest):

| Platform | File | First-launch quirk |
|:---|:---|:---|
| **macOS (Apple Silicon)** | `*.dmg` | Drag to Applications; when the first launch is blocked: **System Settings → Privacy & Security → Open Anyway** (once). |
| **Windows (x64)** | `.exe` (NSIS) or `.msi` | SmartScreen → **More info** → **Run anyway**. |
| **Linux (x64)** | `.deb` / `.rpm` | No warning. |

The desktop app shells out to the `wechat-cc` CLI under the hood, so you
also need the source available somewhere:

```bash
git clone https://github.com/tendhearth/wechat-cc.git ~/.local/share/wechat-cc
cd ~/.local/share/wechat-cc && bun install
```

Or set `WECHAT_CC_ROOT=/some/path` in your environment.

Then launch the desktop app — the wizard walks you through environment
checks, agent picker (Claude or Codex), QR scan, and background service
install. After that you land in the dashboard.

</details>

---

## Features

Ten things it does. **Full detail with screenshots and examples: [docs/reference/features.md](docs/reference/features.md).**

| | |
|---|---|
| **Two-way chat with the agent on your desk** | WeChat in, Claude Code / Codex / Cursor out — the agent runs on your machine, in your repos |
| **`share_page`** | long-form output becomes a page you can read on your phone |
| **Multi-project switching** | one bot, many repos (`/project add|list|switch`) |
| **Multi-agent** | `/cc` `/codex` `/both` `/chat` — Claude × Codex on the same chat, including a chatroom debate |
| **Companion** | the Claude that reaches out first, with memory that outlives any one provider |
| **Two mirrors of accompaniment** | the dashboard: what you did, and what CC noticed |
| **Hearth integration** | govern your markdown vault from your phone |
| **Voice replies** | outbound TTS through your own gateway |
| **CLI fallback** | everything the bot does, you can do from a terminal |
| **Your own terminal sessions, on WeChat** | `wechat-cc hook` pushes a local claude / codex session's results to WeChat and lets you approve from there |

Beyond chat there is a **desktop workbench** — hand a folder to an executor and watch the diff, the permission cards and the waiting line: [docs/cc-workbench.md](docs/cc-workbench.md).

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

**Strict (default)** — `wechat-cc run` — every tool call asks you on WeChat (`y abc12` / `n abc12`, 10-minute timeout).
**Bypass** — `wechat-cc run --dangerously` — tools run without asking.

> ⚠️ The desktop wizard / `service install` path launches the daemon with `--dangerously`, because an unattended service has nobody to answer prompts. That is safe only because **the allowlist is empty by default** — keep it to people you trust, or run `wechat-cc run` in the foreground for strict prompting.

Per-provider behaviour (Claude relays each tool, Codex uses its own `approval_policy`, delegated turns differ) is a table in **[docs/reference/permission-modes.md](docs/reference/permission-modes.md)**.

## WeChat commands

`/help` lists them in chat. The ones you'll actually use:

| Command | What |
|---|---|
| `/status` · `/health` | is the bot alive · is its brain reachable |
| `/project add <path> <alias>` · `/project switch <alias>` | many repos, one bot |
| `/cc` · `/codex` · `/both` · `/chat` | which agent answers, or all of them |
| `/set` | the graphical settings panel (you don't have to memorise commands) |
| `/reset` | start the conversation over |

Full list including `@all`, `/users`, `/hearth`, and 让&lt;name&gt;执行: **[docs/reference/wechat-commands.md](docs/reference/wechat-commands.md)**.

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

Everything lives on your machine, under `~/.local/state/wechat-cc` (macOS: `~/Library/Application Support/wechat-cc`): sessions, memory, access list, keys (0600), plugin data. Nothing is uploaded.

The file-by-file map is in **[docs/reference/state-layout.md](docs/reference/state-layout.md)**.

## Access control

- The allowlist is **empty by default** — a fresh bot answers nobody but you.
- Strangers can ask to be let in (request → your approval) or use an invite code; a denial is permanent.
- Three tiers: **admin** / **trusted** / **guest** — they differ in which tools and providers they can reach.
- Cursor and the OpenAI-compatible provider are opt-in, and cursor is closed to guests by design.

Tier-by-tier permissions, the v1 limitations you should read before trusting a tier with anything sensitive, and the CLI (`access list|add|remove`): **[docs/reference/access-control.md](docs/reference/access-control.md)**.

## A2A integration (P3, opt-in)

Other agents (or your other machines) can send this bot notifications, and it can delegate tasks back to them — one brain, many hands. The HTTP server is **off by default** (`agent-config.json:a2a_listen`), and `a2a_send` is tier-gated like any other tool.

Setup, CLI subcommands, and the delegate-to-another-machine walkthrough: **[docs/reference/a2a.md](docs/reference/a2a.md)**.

## Demo data (for screenshots / first impressions)

A seeded demo state for screenshots and first-run demos: **[docs/reference/demo-data.md](docs/reference/demo-data.md)**.

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
- **OpenAI-compatible provider has no sandbox at all** — see
  [OpenAI-compatible provider](#openai-compatible-provider-opt-in) above.
  The tier gate is the only barrier; there's no mid-turn relay confirmation
  and no session resume across a restart in v1.
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

Most reports are one of these: command not found after install · bot stopped answering (`errcode=-14`, or the outbound ticket expired — send it a message and it heals) · "AI 暂时不可用" (the brain, not the channel) · codex provider not registered · garbled logs / firewall popups on Windows.

Each with its fix: **[docs/reference/troubleshooting.md](docs/reference/troubleshooting.md)**. For the maintainer-side loop (deploy, selftest, CI) see [docs/maintainer/README.md](docs/maintainer/README.md).

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

- **Current source versions:** [CLI/daemon package](package.json) and [desktop bundle configuration](apps/desktop/src-tauri/tauri.conf.json). This batch does not bump or publish a release.
- **Installers and release status:** [GitHub Releases](https://github.com/tendhearth/wechat-cc/releases). The dev workbench described above may be newer than the latest installer.
- **Release notes:** [docs/releases](docs/releases/); the [next desktop draft](docs/releases/desktop-v1.6.7.md) is not a release announcement.
- **Current architecture and delivery evidence:** [architecture](docs/architecture.md), [workbench guide](docs/cc-workbench.md) (Chinese).

---

## Contributing

Issues + PRs welcome at [github.com/tendhearth/wechat-cc](https://github.com/tendhearth/wechat-cc/issues).

```bash
bun install
bun --bun vitest run    # full test suite
bun run typecheck      # type check
```

Maintainer commands (macOS, launchd) live in
[`docs/maintainer/`](docs/maintainer/README.md) — including `wechat-cc self
change "<request>"`, which lets CC change its own source: a dedicated clone,
tests + an independent review + CI, your approval on WeChat, then merge,
deploy and self-test (rollback if the self-test goes red). See
[`docs/maintainer/self-change.md`](docs/maintainer/self-change.md) (Chinese).

The `apps/desktop/` directory has a Tauri 2 GUI. One dev server backs every
mode ([`apps/desktop/test-shim.ts`](./apps/desktop/test-shim.ts)), all with
live reload:

- `bun run dev` — the real Tauri shell (starts the dev server for you)
- `bun run dev:web` — plain browser against the real CLI + real daemon
- `bun run dev:mock` — mock state, what Playwright drives
- `bun run dev:unsafe` — same as `dev:web` with the safety valve off

In the three browser modes the dev server only forwards CLI commands it knows
to be read-only; anything that would mutate real state is refused with a hint
(`dev:unsafe` turns that off and the banner goes red). `bun run dev` is the
real app: invoke goes through Rust IPC, so the valve does not apply there.

---

## Disclaimer

This is an **unofficial, community-built plugin** — not affiliated with,
endorsed by, or sponsored by Tencent or WeChat.

---

## License

MIT — see [LICENSE](./LICENSE). 代码是 MIT;**CC 角色形象与桌宠美术资产不是**,见 [ASSETS-LICENSE.md](./ASSETS-LICENSE.md)。
