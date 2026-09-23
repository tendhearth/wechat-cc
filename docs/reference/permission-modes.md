# Permission modes

> 从根 README 搬到这里(2026-09-22),README 只留门面与指路。索引见 [docs/INDEX.md](../INDEX.md)。

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

> ℹ️ **Note on the recommended install.** The bare `wechat-cc run` is strict,
> but the desktop wizard / `service install` path launches the daemon with
> `--dangerously` by default — an unattended background service has no human to
> answer per-tool prompts. This is safe because the allowlist is **empty by
> default** (only chat IDs you add in `access.json.allowFrom[]` can reach the
> bot at all), but be aware the installed service runs in bypass mode. Keep the
> allowlist to people you trust, or run `wechat-cc run` in the foreground for
> strict prompting.

## Provider × mode interaction

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
