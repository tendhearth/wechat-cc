# A2A integration

> 从根 README 搬到这里(2026-09-22),README 只留门面与指路。索引见 [docs/INDEX.md](../INDEX.md)。

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

## CLI subcommands

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

## Quick start

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

## One brain, many hands (delegate tasks to other machines)

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

## Threat model

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
