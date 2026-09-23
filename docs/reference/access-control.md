# Access control

> 从根 README 搬到这里(2026-09-22),README 只留门面与指路。索引见 [docs/INDEX.md](../INDEX.md)。

Allowlist-only by default. Manage from the **terminal**, not WeChat (this
prevents prompt-injection from a chat you've allowed):

```
/wechat:access                        # show policy + allowlist
/wechat:access allow <user_id>        # add a sender
/wechat:access remove <user_id>       # remove a sender
```

Users who scan the QR during `wechat-cc setup` are automatically allowed.

New in-WeChat path for friends you share the bot with: a stranger's first
message gets a neutral reply and you (the admin chat) get a notify with a
6-digit code — reply 「允许 &lt;code&gt;」or 「拒绝 &lt;code&gt;」, or send
「邀请码」to hand out a one-time invite code. Either way it only ever appends
to `allowFrom` — `admins`/`trusted` are still terminal-only. Want total
silence instead (no neutral reply, no notify, nothing)? Set
`access.json.dmPolicy` to `"disabled"`.

## Permission tiers (v0.6+)

Each chatId in `access.json` falls into one of three tiers:

- `admins`: full access — the bot runs every tool unconditionally. Admins also
  get the daemon self-diagnosis / self-healing tools (inspect turns & sessions,
  release a wedged session, switch model, restart the daemon); the mutating
  ones ask for an "are you sure?" confirmation first.
- `trusted`: full access EXCEPT destructive operations (rm, git reset --hard,
  git push --force, memory_delete) and the admin-only daemon-control tools.
  Destructive ops prompt the admin chat for approval.
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

## Cursor (optional third provider)

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

## OpenAI-compatible provider (opt-in)

This section describes the **companion chat** adapter. The [managed workbench API adapter](docs/cc-workbench.md#api-任务执行者) (Chinese) uses separate tools, task approval and persisted transcripts; it does not inherit the shell or companion MCP described below.

`openai` is a fourth provider id that talks to any **OpenAI-compatible
chat-completions API** (DeepSeek, Kimi, Qwen, GLM, OpenRouter, local Ollama,
…) via the [Vercel AI SDK](https://sdk.vercel.ai/). Unlike claude/codex/cursor
it isn't a full agent host — wechat-cc owns the tool-calling loop itself
(read/write/edit/bash + the same WeChat companion MCP tools), so it's a much
lighter, pay-per-token chat backend.

To enable it:

1. Set `WECHAT_OPENAI_API_KEY` in your shell or systemd unit. The key is
   env-only by design — it never lands in `agent-config.json`.
2. Configure the endpoint + model in `agent-config.json` (under your state
   dir — see [State layout](#state-layout)):
   ```json
   {
     "provider": "openai",
     "openaiBaseUrl": "https://api.deepseek.com/v1",
     "openaiModel": "deepseek-chat"
   }
   ```
   (`wechat-cc provider set` doesn't accept `openai` yet — edit
   `agent-config.json`'s `provider` field directly alongside the two
   `openai*` fields shown above.)
3. Restart the daemon. The boot log prints `openai: base_url + model +
   WECHAT_OPENAI_API_KEY present — provider registered` once it's live.

**v1 limitations — read before trusting it with sensitive tiers:**

- **No OS/SDK sandbox.** Claude/Codex/Cursor each have some sandboxing
  underneath; `openai` has none — the [tier gate](#permission-tiers-v06) is
  the *only* barrier between a chat and `fs_write`/shell. Treat `trusted`
  tier on this provider exactly like handing someone a shell.
- **Relay-classified tools are denied, not relayed, in strict mode.** The
  owned loop doesn't yet support the mid-turn WeChat confirmation round-trip
  (`y abc12` / `n abc12`) that Claude/Codex/Cursor use for `relay` tools —
  a `relay`-tier tool call collapses to an outright deny.
- **No session resume across a daemon restart.** Conversation history lives
  in memory for the life of the process; restarting the daemon starts a
  fresh session (same caveat as the "Conversation continuity" entry under
  [Known limitations](#known-limitations), but `openai` has no
  partial-resume path at all).

---
