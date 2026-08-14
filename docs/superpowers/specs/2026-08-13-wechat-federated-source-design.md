# wechat-cc as a hearth federated source — authorized launcher — Design

**Date**: 2026-08-13
**Status**: Design (brainstorm 2026-08-13; authorization model = option B, user-approved). Cross-repo: wechat-cc (this repo, the work) + a hearth-side sources.json registration (no hearth code). North star: memory note `hearth-memory-infra`.

## The direction

hearth (the memory-infra front door) already federates to a local **files** province (Spotlight) and gates it per-consumer via its Phase-3 permission broker. To complete "documents + wechat cross-domain federation," wechat-cc must become hearth's **second real federated source** — exposing its `federated_query` (reshaped semantic search over the owner's message history) to hearth over MCP.

**Why this is a real slice, not a config line (proven empirically):** `federated_query` calls `POST /v1/knowledge/search`, which the daemon's internal-api gates at **`admin` tier** (`route-tiers.ts`). Probing the live daemon: the standing **operator** token → `403 route_not_allowed` (operator is route-scoped to control-plane, not data); the **trusted** file token → `403 forbidden, required: admin`. There is **no standing admin token** on disk — admin-tier tokens are minted per-session by the daemon (`mintSessionToken('admin', key)`) and handed only to admin-authorized sessions. So reaching `federated_query` from an external process requires wechat-cc to add an **authorized way to obtain an admin-tier token**.

## The trust chain (why this is safe)

**owner → hearth (full) → consumer (scoped).** This slice only makes wechat **reachable** to hearth; it does NOT decide who may use it. hearth's Phase-3 broker independently gates which consumer (codex, etc.) may query the `wechat` source. So the "full access" this slice grants is owner→hearth on the owner's own machine; every third-party app is still scoped by hearth. This slice's job is to open the owner→hearth door **deliberately and revocably**, with least privilege.

## Authorization model — option B (explicit, owner-authorized; user-approved)

Minting an admin data-token must NOT be an ambient capability of the operator token (that would collapse the deliberate operator/admin = control/data separation the probe confirmed). Instead:

- **Explicit grant.** The owner runs `wechat-cc federated-source --authorize` ONCE. This records a consent grant (a `federated-grant.json`, mode 0600, in the daemon state dir `~/.claude/channels/wechat/`) — the deliberate, revocable act of opening wechat to hearth. `--deauthorize` (or deleting the file) revokes.
- **Gated mint.** A new internal-api route `POST /v1/federation/mint` is added to the **operator-route allowlist** (so the operator token — proving owner-on-machine, loopback — may call it) AND its handler **requires the grant to exist**. Without the grant → `403 federation_not_authorized`, even with a valid operator token. So: operator-token-alone cannot mint admin; the grant is the unlock. With both → the handler calls `mintSessionToken('admin', 'hearth-federated')` and returns a **short-lived** admin-tier session token.
- **Short-lived, never stored.** The admin token is minted fresh per launcher spawn and lives only for that process; nothing durable-admin is written to disk.

**Threat model (honest):** the grant file is owner-writable (0600), so an attacker who already has BOTH the operator token AND owner filesystem-write could create the grant and mint. That is a fully-compromised machine — outside this boundary. What option B buys over option (a): a leaked operator token **alone** (e.g. via a control-path bug, without owner fs-write) cannot reach data; and granting hearth access is a deliberate, auditable, revocable owner action rather than a silent operator power.

*One clarification on the launcher's blast radius (from the whole-branch review):* the run-mode launcher reads the **operator token** into memory to perform the mint. So a launcher compromised mid-run could exfiltrate the operator token — whose routeAllow is broader than the scoped 5-min search token it produces (it also reaches `companion/converse` etc.). This does **not** cross the trust boundary: reading `operatorTokenFilePath` (0600) already requires owner-level filesystem access, which a same-OS-user compromised launcher inherently has. So the "maximum damage = the scoped 5-min token" claim is the *credential the launcher hands to hearth*, not a hard bound on a launcher that is itself compromised at the OS-user level. On a single-owner machine (the target), this is the accepted option-B posture.

## Scope

### A. wechat-cc internal-api — the gated mint route (`src/daemon/internal-api/`)
1. **Grant helpers** (`routes-federation.ts`, new, or a small `federation-grant.ts`): `grantPath(stateDir)`, `writeGrant(stateDir)` (0600, `{ integration:'hearth', ts }`), `readGrant(stateDir)` → grant|null, `revokeGrant(stateDir)`.
2. **Route `POST /v1/federation/mint`**: register in `routes.ts`; add its routeKey to the **operator-route allowlist** (the set checked at `index.ts:180` route-allow gate — currently only operator/control routes) so the operator token passes the route-allow gate; set its `minTierFor` appropriately (it is operator-gated, not session-tiered — follow how existing operator routes are expressed). Handler: if `readGrant()` is null → `403 { error:'federation_not_authorized' }` (audited); else `token = mintSessionToken('admin','hearth-federated')` → `200 { token }` (audited: `event:'federation.mint'`). **Never logs the token value.**
3. Audit both the grant creation and each mint (append to the daemon's existing audit path) so the owner can see when hearth federation was authorized and used.

### B. wechat-cc CLI — `wechat-cc federated-source` subcommand (`cli.ts` + a small module)
- `wechat-cc federated-source --authorize` → resolves the state dir from `~/.claude/channels/wechat/internal-api-info.json` (its dirname), calls `writeGrant()`; prints a clear confirmation + how to revoke. (Writes the grant locally; the daemon reads it at mint time — no restart needed.)
- `wechat-cc federated-source --deauthorize` → `revokeGrant()`.
- `wechat-cc federated-source --status` → prints whether the grant exists + the daemon baseUrl/pid (no token values).
- `wechat-cc federated-source` (run mode, what hearth spawns): (1) read `internal-api-info.json` (baseUrl + operatorTokenFilePath); (2) `POST {baseUrl}/v1/federation/mint` with the operator token as bearer → get the admin token (fail-fast with a clear stderr message if the daemon is down or the grant is missing → tells the owner to run `--authorize`); (3) run a **slim stdio MCP** exposing ONLY `federated_query` (see C), with env `WECHAT_INTERNAL_API=baseUrl`, `WECHAT_SESSION_TOKEN=<minted admin>`, `WECHAT_SESSION_TIER=admin`.

### C. The slim federated-source MCP (`src/mcp-servers/wechat/federated-main.ts`, new — least privilege)
A minimal stdio MCP server that registers ONLY the existing `registerFederatedQueryTool(server, client)` (from `tools-federated.ts`) over a `WechatInternalClient` built from `WECHAT_INTERNAL_API` + the session token — **no** daemon-control / knowledge-write / other admin tools. So hearth (and thereby any consumer hearth authorizes) can reach exactly `federated_query` and nothing else. stdout stays clean (MCP transport); all logging to stderr. Reuses the existing `tools-federated.ts` + `client.ts` unchanged.

### D. hearth-side registration (no hearth code — a docs/config step, run in the post-task gate)
`~/.hearth/sources.json` gains a `wechat` entry: `{ id:'wechat', transport:{ kind:'stdio', command:'wechat-cc', args:['federated-source'] }, query_tool:'federated_query' }`. hearth spawns it per query (per the Phase-2a fail-open+timeout federated client); the launcher mints, serves one query, exits.

## Architecture

```
owner runs once:  wechat-cc federated-source --authorize  → writes federated-grant.json (0600)
                                                                       │ (consent, revocable)
hearth vault_query{federate:true, consumer=C granted 'wechat'}         ▼
  → hearth spawns:  wechat-cc federated-source  (sources.json)
        │  read internal-api-info.json (baseUrl + operator token)
        │  POST /v1/federation/mint  (operator token) ──► daemon: grant present? → mintSessionToken('admin','hearth-federated')
        │                                              ◄── { token } (short-lived admin)
        │  serve slim MCP: federated_query ONLY, bearer = admin token
        └► federated_query → POST /v1/knowledge/search (admin OK now) → semanticSearch → reshaped hits
   hearth merges wechat hits (verified_by 'wechat') with files hits, broker-scoped to C, audited.
```

## Verification

- **Unit — grant helpers:** write/read/revoke round-trip; `federated-grant.json` is 0600; `readGrant` on missing → null.
- **Unit — mint route authz:** with a grant present + operator token → `200 { token }` and `mintSessionToken('admin', ...)` was called; **no grant + operator token → `403 federation_not_authorized`** and mint NOT called; non-operator token → blocked by the existing route-allow/tier gates (reuse the internal-api test harness / `internal-api-tier-authz` e2e patterns). Assert the token value is never logged.
- **Unit — slim MCP:** round-trip (InMemoryTransport) with an injected internal-api client returning fake semantic results → `federated_query({question})` returns hearth-shaped `{hits}` (string `claim_text`); assert NO other tool is registered (ListTools has exactly `federated_query`).
- **Unit — CLI:** `--authorize`/`--deauthorize`/`--status` drive the grant helpers against a temp state dir; run mode, with an injected mint-fetch + a fake internal-api, serves the slim MCP.
- **VERIFY-AGAINST-REAL (owner machine, the point):** against the live daemon — `wechat-cc federated-source --authorize`; register the `wechat` source in the real `~/.hearth/sources.json` (alongside `files`); run an owner `vault_query{federate:true}` for a term present in BOTH docs and wechat → hits from BOTH sources merged, each `verified_by` its source (files / wechat), raw wechat messages never entering hearth's vault; audit shows `sources_consulted:['files','wechat']`. Then `--deauthorize` and confirm the launcher now fails closed (mint 403) → the `wechat` source returns nothing (fail-open), `files` still works.

## Non-goals
- **Standing/durable admin token** — tokens are minted per-spawn, short-lived; nothing durable-admin on disk.
- **Exposing any wechat tool beyond `federated_query`** — the slim MCP is federated-query-only (least privilege).
- **Per-consumer scope inside wechat** (which chats/tiers a hearth consumer sees) — hearth's broker scopes at the source granularity; intra-wechat scope is a future refinement.
- **Interactive/OS-keychain consent** — v1 uses the 0600 grant file as the consent record; a stronger interactive/keychain confirmation is a follow-on.
- **hearth code changes** — hearth consumes the source via the existing federated-client contract; only sources.json changes.

## Risks
- **Security-sensitive internal-api change:** a new mint route touches the daemon's auth core. Mitigation: operator-route-allowlist + grant-required (fail-closed: no grant → no mint), short-lived tokens, least-privilege slim MCP, full audit, and reuse of the existing `mintSessionToken`/tier machinery rather than a new token type.
- **Concurrent dmg session on wechat-cc's working tree:** build in the git worktree (`scratchpad/wc-fed-wt`, branch `feat/wechat-federated-source` off dev); never checkout branches in the shared tree.
- **Daemon-down / grant-missing at query time:** the launcher fails closed with a clear stderr message; hearth's federated client is already fail-open (a dead/erroring source contributes nothing, `files` still answers). The owner is told to run `--authorize` / start the daemon.
- **Mint latency per query:** hearth spawns the launcher per query → one mint round-trip per query. Acceptable for v1 (loopback, fast); a keep-alive/caching launcher is a later optimization if needed.
