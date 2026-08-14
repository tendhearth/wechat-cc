# A2A proto_version — Design Spec

**Date:** 2026-07-17
**Status:** Approved (brainstorming), ready for implementation plan
**Feature:** Add a protocol version to the A2A agent card, record it at
pair/install time, and surface mismatch as a warning — the foundation for
protocol evolution, laid while the network is still two or three machines.

## Why

The A2A wire protocol (notify/exec/pair/intent/reveal) has no version
negotiation. Spec #2 (forwarding hop) did backward compatibility by schema
superset — which works, but is ad-hoc: when a genuinely breaking change ships,
an old peer gets mysterious failures instead of a diagnosable "protocol
mismatch." Adding the version now costs minutes; retrofitting it onto a grown
network costs much more. (2026-07-16 architecture review, recommendation #3.)

## Scope

**In scope:**
- `A2A_PROTO_VERSION = 1` shared constant.
- Agent card (`GET /.well-known/agent.json`) advertises `proto_version`.
- Card consumers treat a **missing `proto_version` as 1** (the backward-compat
  rule — every existing peer's card lacks the field).
- The pair/install flow records the peer's `proto_version` into the registry
  (`A2AAgentRecord`, optional field).
- The preview flow surfaces `proto_version` + a `proto_mismatch` boolean to the
  desktop client.
- **Mismatch warns, never refuses** — today the whole network is v1; refusal
  semantics are designed when a real incompatible change exists.

**Out of scope (YAGNI):**
- Per-request version headers/fields; runtime enforcement; version ranges or
  semver. A single integer, "same = compatible, different = warn," is the whole
  contract until a v2 exists.

## Design

- `src/core/a2a-intent.ts` (the wire-schema home) exports
  `A2A_PROTO_VERSION = 1` with a doc comment stating the rules: integer;
  bumped only on an incompatible wire change; missing-in-card means 1;
  mismatch = best-effort interop + warn.
- `src/core/a2a-server.ts`: the `agentCard` object gains
  `proto_version: A2A_PROTO_VERSION`.
- `src/core/a2a-client.ts`: the `AgentCard` type gains
  `proto_version?: number`; `fetchAgentCard` leaves it absent when the peer
  omits it (consumers apply the default-1 rule, so old cards keep working).
- `src/lib/agent-config.ts`: `A2AAgentRecord` gains
  `proto_version: z.number().int().optional()`.
- `src/daemon/internal-api/routes-a2a.ts`:
  - `POST /v1/a2a/preview` response gains `proto_version` (the card's value or
    1 when absent) and `proto_mismatch` (`!==` our `A2A_PROTO_VERSION`).
  - `POST /v1/a2a/install` (verified: it does NOT fetch the card today — it
    registers straight from the desktop-forwarded body) gains a **best-effort
    card fetch**: `fetchAgentCard(url)` in a try/catch; on success record
    `proto_version` (default 1 when the card lacks it) on the registry record
    and log a warning on mismatch; on any fetch failure leave the field unset
    and install exactly as before (offline-install semantics unchanged). This
    keeps the feature fully daemon-side — no desktop change required.
  - Peers registered via the brain-invite `/a2a/pair` flow keep `proto_version`
    unset (unknown = treated as 1 by the default rule) — extending that flow is
    out of scope.
- No route tier changes (preview/install keep their existing tiers).

## Error handling

None new — a card without the field is valid (defaults to 1); mismatch is a
log + response flag, never an error path.

## Testing

- Card serves `proto_version: 1` (a2a-server test).
- `fetchAgentCard` on a card lacking the field → `proto_version` undefined,
  consumer default applies (a2a-client test).
- Preview response carries `proto_version` + `proto_mismatch` for both a
  matching and a mismatching card (internal-api test, stubbed client).
- Registry round-trips the optional field (agent-config test).
- All in existing test files' idiom; `bun run test` (vitest), typecheck,
  depcheck green.

## Follow-up (not this spec)
- Refusal/downgrade semantics — designed when the first incompatible change
  (a real v2) is proposed.
