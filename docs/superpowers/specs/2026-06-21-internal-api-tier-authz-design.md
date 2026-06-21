# Internal-API per-session tier authorization

**Date**: 2026-06-21
**Status**: Design — approved, pending spec review
**Scope**: Server-side authorization for the daemon's internal-api. End-state ("全面接管"): every route enforces the caller's tier, derived from a per-session, provider-agnostic token. Closes the escalation gap where a `trusted` agent's shell reads the daemon-wide token file and curls admin-only routes (e.g. `daemon_restart`).

---

## 1. Problem & threat model

The internal-api authenticates **one daemon-wide bearer token** (`<stateDir>/internal-token`, 0600). It proves "I am an MCP child of this daemon" — nothing about *which chat / tier* is calling. The admin-only daemon-control routes (`/v1/daemon/restart`, `/v1/sessions/release`, `/v1/model`, the diagnostic reads) are currently gated only by (a) the wechat MCP server registering those tools for admin sessions and (b) claude's `canUseTool`.

**Threat (confirmed: shared bot, semi-trusted users).** A `trusted`-tier chat's agent has `Bash`/`Read` and runs as the **same OS user** as the daemon. It can read the token file by path and `curl POST /v1/daemon/restart` directly — bypassing both the MCP-registration gate (which only affects *its own* MCP child) and `canUseTool` (which codex doesn't even have). The goal is to enforce the initiating session's tier **at the route layer**, so no shell-curl path escalates.

## 2. Core security model

**A shell-readable credential grants no more privilege than the least-trusted process that can read it.** A `trusted` agent has shell access as the daemon's OS user, so **any file-based token is at most a `trusted` credential.** There is no CLI command that mints admin which the agent cannot also run (it has `Bash`). Therefore:

> **Admin capability originates only from the daemon minting an admin-tier *session token* for a chat that `access.json` resolves to `admin`** — delivered **env-only** into that session's MCP children, which a separate agent process cannot read. The daemon-wide **file token is capped at `trusted`**.

Consequences:
- A `trusted` agent's shell-curl with the **file token** is capped at `trusted` — it cannot reach `admin` routes. The *trivial* one-liner escalation (`cat internal-token` → curl) is closed.
- **Honest limit (Linux):** an `admin` *session* token lives in that MCP child's env, and on Linux a same-uid process can read `/proc/<pid>/environ`. A determined trusted agent could enumerate `/proc`, locate a **concurrent** admin session's wechat MCP child, and lift its token. This design **raises the bar substantially** (targeted introspection during a concurrent admin session, vs. a one-line file read) but does **not** fully close a same-uid shell-capable adversary. Full closure needs OS-level isolation (running the agent's tool execution under a different uid / sandbox) — out of scope here, noted as the true end-state in §11.
- Self-healing works on **any** provider, because the token-injection seam is provider-agnostic.
- **The operator CLI is capped at `trusted`.** Admin-level actions happen through the **bot's admin chat** (an admin session), not `wechat-cc <cmd>`. This is consistent with the AI-native model — the admin acts *through* the bot. (Escape hatch for genuine CLI-admin — interactive operator auth — is out of scope; see §10.)

## 3. Architecture

Three components plus a lifecycle.

### 3.1 Token registry (daemon, in-memory)

A map `token (hex) → { tier: 'admin'|'trusted'|'guest', origin: 'file'|'session', sessionKey?: string }`, owned by the internal-api.

- The boot **file token** is registered once as `{ tier: 'trusted', origin: 'file' }`. (Its on-disk file + per-boot rotation are unchanged; only its *granted tier* is now explicit and capped.)
- Each **session spawn** mints a fresh random session token registered as `{ tier: <session's resolved tier>, origin: 'session', sessionKey }`.
- `authResolve(req) → { tier, origin } | null`: timing-safe lookup of the presented bearer against the registry. Replaces today's single-token `authOk`.

### 3.2 Provider-agnostic injection seam

The minted session token must reach **every** provider's stdio MCP children via env (never a file).

- `SpawnContext` gains `sessionToken: string` (the daemon mints it in `SessionManager.acquire` / the spawn path, from the chat's resolved tier).
- Each `AgentProvider.spawn` is responsible for merging `{ WECHAT_SESSION_TOKEN: ctx.sessionToken }` into the env of **its** stdio MCP children (wechat + delegate):
  - **claude** — bootstrap's `sdkOptionsForProject` already builds MCP env per-spawn; merge there.
  - **codex** — `spawn()` already applies `opts.mcpServers` into `config.mcp_servers` per-spawn; merge the env there (small, provider-local change).
  - **cursor** — same per-spawn merge at `Agent.create`.
  - **gemini / future** — implement the merge when the provider is added; the `SpawnContext` field is the contract.
- This **replaces** the `WECHAT_SESSION_ADMIN` boolean. The wechat MCP child now reads `WECHAT_SESSION_TOKEN` and sends it as the bearer for daemon-control calls; tool **registration** is gated on the token's tier being `admin` (the child learns its tier from a cheap `GET /v1/whoami` at startup, or the daemon bakes the tier alongside the token — see §6 open item O1).

### 3.3 Route tier table + enforcement

Every route declares a **minimum tier**. The request layer resolves the caller's tier via `authResolve` and rejects below the minimum with `403 { error: 'forbidden', required: <tier> }`.

- `RouteTable` changes from `Record<string, handler>` to `Record<string, { minTier: UserTier; handler }>` (or a parallel `ROUTE_MIN_TIER` map keyed by `"METHOD /path"`). The dispatcher in `index.ts` reads it after `authResolve` and before invoking the handler.
- **Default-deny:** a route with no declared tier is treated as `admin` (fail-closed) — a new route can't accidentally ship world-open.
- Min tiers are **derived from the corresponding ToolKind's tier policy** where one exists (single source of truth with `user-tier.ts`), and assigned explicitly for operator routes that have no tool. Concrete table in §5.

### 3.4 Token lifecycle

- **Mint** at session spawn (`SessionManager.acquire`).
- **Invalidate** on session close / `release` / LRU-evict / shutdown — the registry entry keyed by `sessionKey` is removed, so a leaked-but-stale token stops working.
- **File token**: minted at boot, rotated per boot (unchanged), registered at `trusted`.
- Tokens are random 32-byte hex, compared timing-safe (as today).

## 4. Provider injection details

| Provider | MCP env built | Change |
|---|---|---|
| claude | per-spawn (`sdkOptionsForProject`) | merge `WECHAT_SESSION_TOKEN` (replaces `WECHAT_SESSION_ADMIN`) |
| codex | construction-time spec, **applied per-spawn** in `spawn()` | merge env into `config.mcp_servers[*].env` in `spawn()` |
| cursor | per-spawn `Agent.create` | merge env there |
| gemini | n/a (not implemented) | contract is `SpawnContext.sessionToken`; implement on add |

The seam keeps providers generic: the daemon supplies the token via `SpawnContext`; the provider only knows "merge this env into my MCP children." No provider learns about tiers or wechat specifics.

## 5. Route tier table

Derivation rule: **`minTier` = the lowest tier whose `TierProfile` *allows or relays* the ToolKind the route corresponds to**; explicit assignment for operator/infra routes with no tool. Default-deny (`admin`) for anything unlisted.

| Route(s) | minTier | Basis |
|---|---|---|
| `GET /v1/health` | guest | liveness; ops fields are low-sensitivity counts |
| `POST /v1/wechat/reply`, `reply_voice`, `GET /v1/memory/list`, `POST /v1/memory/read`, `POST /v1/share/page`, `POST /v1/share/resurface`, `GET /v1/companion/status` | guest | `reply` / `memory_read` / `share_page` are guest-allowed |
| `POST /v1/wechat/broadcast`, `send_file`, `edit_message`, `POST /v1/memory/write`, `POST /v1/user/set_name`, `POST /v1/voice/save_config`, `POST /v1/companion/{enable,disable,snooze}`, `POST /v1/conversation/set-mode`, `POST /v1/projects/{add,remove,switch}`, `GET /v1/projects/list`, all `GET\|POST /v1/a2a/*`, `POST /v1/delegate` | trusted | operator/agent ops; reachable by the CLI (capped at trusted) |
| `POST /v1/memory/delete` | trusted | `memory_delete` relays-for-admin but is within trusted's (relayed) reach |
| `GET /v1/turns`, `GET /v1/sessions`, `GET /v1/model` | admin | `daemon_introspect` |
| `POST /v1/sessions/release`, `POST /v1/model`, `POST /v1/daemon/restart` | admin | `daemon_remediate` |

(The exact line for each route is finalized in implementation against this rule; the rule, not the row, is the contract.)

## 6. CLI

The CLI authenticates with the **file token = `trusted`**. Audit (`doctor`, `agent`/a2a, projects, memory) and ensure every CLI-invoked route's `minTier ≤ trusted`. Per §5 the a2a/projects/memory routes the CLI uses are `trusted`, so the CLI keeps working. Any CLI command that genuinely needs `admin` is **not supported** post-change — the operator performs it via the bot's admin chat.

**Open item O1 — how the wechat MCP child learns its tier (for tool registration):** either (a) the daemon bakes `WECHAT_SESSION_TIER` alongside `WECHAT_SESSION_TOKEN` in the env (simple, the tier is non-secret), or (b) the child calls `GET /v1/whoami` at startup and reads `{ tier }`. Recommend **(a)** — one less round-trip, and the tier is not a secret (the *token* is). Registration of the daemon-control tools happens iff tier === `admin`.

## 7. Delegate MCP child

The `delegate` child (RFC 03 P4) calls `POST /v1/delegate`. It is tokenized identically — it receives the spawning session's `WECHAT_SESSION_TOKEN`, so its calls carry that session's tier. `/v1/delegate` is `trusted` (§5).

## 8. Backward compatibility & migration

- The file token keeps working (now `trusted`), so the CLI and any external script using it keep working for `≤ trusted` routes.
- MCP children switch from reading `WECHAT_INTERNAL_TOKEN_FILE` to sending `WECHAT_SESSION_TOKEN` for authenticated calls; they may keep the file token as a fallback during rollout, but the daemon-control routes will reject it (it's `trusted`).
- `WECHAT_SESSION_ADMIN` is removed; its two consumers (bootstrap injection, wechat MCP registration gate) move to the token + `WECHAT_SESSION_TIER`.
- No on-disk format change; the registry is in-memory and rebuilt each boot.

## 9. Testing

- **Token registry** (unit): mint/resolve/invalidate; file token resolves `trusted`; unknown token → null; timing-safe.
- **Route enforcement** (unit, over the dispatcher): a `trusted` token → `403` on an `admin` route; an `admin` session token → `200`; default-deny for an unlisted route.
- **Provider seam** (unit per provider): `spawn` merges `WECHAT_SESSION_TOKEN` into each stdio MCP child's env; claude/codex/cursor each covered.
- **End-to-end (real surface, the headline threat):** boot a real daemon; with the *file* token, `curl POST /v1/daemon/restart` → `403`; with an admin *session* token (as the wechat child would send) → `200`. This is the test that proves the shell-curl gap is closed — run it like the round-2 verification.
- **Integration:** wechat MCP child registers daemon tools only for an `admin`-tier token; not for `trusted`/`guest`, on every provider.

## 10. Out of scope / future

- **OS-level agent isolation — the true end-state.** This token design raises the bar but cannot fully stop a same-uid shell-capable agent (§2, §11). The complete fix is to run the agent's tool execution (Bash/Edit/etc.) under a *different, less-privileged uid* or in a sandbox, so it cannot read the daemon's / MCP child's memory, env, or fds at all. Architectural, platform-specific, and complementary to (not replaced by) this work. Tracked as separate future work.
- **Genuine admin-from-CLI** (operator passphrase / OS-keychain / peer-cred unix socket). Deliberately excluded — adds real complexity for a workflow the bot's admin chat already covers. Revisit only with a concrete need.
- Per-route **rate limiting / audit log** of denied calls (nice-to-have; the existing `log` hook already records 4xx).
- Tightening `memory_delete` / `broadcast` to `admin` if the operator wants stricter — a one-line table change later.

## 11. Risks

- **Scope:** ~40 routes get a tier; the seam touches every provider. Mitigation: default-deny + derive-from-ToolKind keep the table mechanical; providers share one contract.
- **A missed CLI route** that needed `> trusted` would break an operator command. Mitigation: the §6 audit + tests over the CLI's actual call set.
- **Token leakage via env inspection** (a process that can read another's env — e.g. same-user `/proc`): on Linux a same-uid process *can* read `/proc/<pid>/environ`. This narrows but does not fully eliminate the gap on Linux for a shell-capable agent that enumerates the MCP child's pid. Documented honestly; mitigations (short-lived tokens, per-call nonce) are future hardening, not v1.
