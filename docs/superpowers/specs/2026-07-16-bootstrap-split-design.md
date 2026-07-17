# Bootstrap Composition-Root Split — Design Spec

**Date:** 2026-07-16
**Status:** Approved (brainstorming), ready for implementation plan
**Feature:** Split the 1773-line `src/daemon/bootstrap/index.ts` composition root
into per-subsystem wiring modules. **Zero behavior change** — a pure structural
refactor whose verification property is "existing tests unchanged and green."

## Why

`bootstrap/index.ts` is the daemon's single composition root and its biggest
gravity well: every feature lands wiring here (the social stack alone added
~250 lines this month), every change requires reading 1773 lines, and blocks
communicate through closure-shared `let`s whose data flow is invisible. The
2026-07-16 whole-architecture review ranked splitting it the highest-value
structural fix. The repo already has the target pattern: `bootstrap/` holds six
extracted leaf modules (`delegate.ts`, `fallback-reply.ts`, `mcp-specs.ts`,
`session-paths.ts`, `codex-version-check.ts`, `social-finish-seek.ts`) and
`daemon/wiring/` holds post-boot assembly — this refactor continues that
pattern, it does not invent a new one.

## Scope

**In scope (one pass, five extractions):**
- `types.ts` — the `BootstrapDeps` + `Bootstrap` interfaces (~260 lines).
- `providers.ts` — the five provider registration blocks (~400 lines).
- `wire-social.ts` — the agent-social wiring block (~260 lines).
- `wire-a2a-server.ts` — a2a server construction + onNotify + pair/auth-failed
  + `a2a-info.json` (~200 lines).
- `index.ts` keeps: small glue (a2aRegistry/client/eventsStore construction,
  `resolveOperatorChatId`, the guarded 乙 v2 block, `sendAssistantText`,
  turn-record wiring), the assembly order, and the return object. Target ≈500
  lines that read as the boot sequence.

**Out of scope:**
- A2A `proto_version` (deliberately NOT bundled — a protocol feature inside a
  zero-behavior refactor would destroy the refactor's verification property; it
  ships as its own tiny follow-up).
- Any behavior change, any new feature, any test additions (see Testing).
- `daemon/wiring/` (post-boot assembly) and the small helpers at the top of
  index.ts (`resolveClaudeBinary` etc.) — the helpers may move only if a module
  extraction naturally carries them; no standalone churn.
- The desktop app; anything outside `src/daemon/bootstrap/`.

## Architecture — the wire-function pattern

Each extracted module exports one function taking a **narrow, explicit deps
interface** (exactly what that block consumes) and returning **exactly what
downstream assembly needs**. `buildBootstrap` remains the only orchestrator: it
calls the wire functions in boot order and threads their outputs. This matches
the codebase idiom (`makeXStore(db)`, `buildPipelineDeps(opts)`).

Rejected alternatives:
- **Mutable BootstrapContext object** threaded through modules: implicit state,
  invisible writes, worse testability, not the repo idiom.
- **Move-lines-only split** (files import each other's intermediates): spreads
  the tangle across files without an interface boundary; no benefit.

## Module contracts

### `bootstrap/types.ts`
`BootstrapDeps`, `Bootstrap`, and the small event/callback types they reference
move verbatim (doc comments included). **`index.ts` re-exports them** so every
existing import site (`main.ts`, tests, wiring/) keeps its import path — zero
test-file edits is a hard requirement.

### `bootstrap/providers.ts`
`registerProviders(deps): ProviderWiring` — the claude/codex/cursor/openai/
gemini registration blocks move here, byte-preserved in registration ORDER
(cheapEval preference and default-provider resolution are order-sensitive).
Returns everything later blocks consume, explicitly:
`{ registry, defaultProviderId, agentProviderKind, currentClaudeModel, claudeBin, … }`
(the implementation plan enumerates the exact set by reading the real
consumers; nothing is exported "just in case" — YAGNI).

### `bootstrap/wire-social.ts`
`wireSocial(deps): SocialWiring` — the whole social block (grounded judge,
broker, forwarder, revealer, relay reconciler, 3-beat notify, pledge-on-answer)
moves here. Returns
`{ onIntent?, onReveal?, social?, resumeForaging(): void }`.
- Inputs include `a2aRegistry`, `a2aClient`, `sendAssistantText`,
  `resolveOperatorChatId`, `currentClaudeModel`, `claudeBin`, `pluginMcp`,
  `defaultProviderId`, `db`, `stateDir`, `log`, `configuredAgent`.
- **The one genuine cycle** — `selfIdentity()` reads `a2aServer.baseUrl()`, but
  the server is constructed *after* this block (it consumes `onIntent`/
  `onReveal`) — is resolved by passing a thunk
  `getServerBaseUrl: () => string | null` that `index.ts` backs with its
  `a2aServer` variable. Lazy resolution is preserved; no circular import.
- Boot-resume stops being loose code: `resumeForaging()` is returned and
  `index.ts` calls it **after** `a2aServer.start()`, making the ordering a code
  structure instead of a comment.
- When social is unconfigured the function returns
  `{ onIntent: undefined, onReveal: undefined, social: undefined,
  resumeForaging: no-op }` — the inert-when-unconfigured behavior is unchanged.

### `bootstrap/wire-a2a-server.ts`
`wireA2aServer(deps): { a2aServer: A2AServer | null, a2aDeps }` — the
`createA2AServer` call (onNotify, onExec, onPair, onAuthFailed, and the
passed-through `onIntent`/`onReveal`), `await start()`, the `a2a-info.json`
write, and the `a2aDeps` assembly move here. Consumes the social wiring's
handlers as plain parameters.

### `index.ts` after the split
Reads as the boot sequence: stores → plugin MCP → sessions →
`registerProviders` → sendAssistantText/turn-records → a2a infra (3 lines) →
`wireSocial` → `wireA2aServer` → `resumeForaging()` → 乙 v2 → return object.
Closure-shared `let`s that crossed block boundaries are eliminated in favor of
the wire functions' explicit inputs/outputs.

## Data flow / shared-state policy

Everything that previously crossed blocks via closure now crosses via
parameter or return value — with the single documented exception of the
`getServerBaseUrl` thunk (a deliberate lazy binding, commented at both ends).
No module imports another wire module; only `index.ts` composes them
(dependency-cruiser's `no-circular` rule verifies this mechanically).

## Error handling

None to design — no behavior change. Every try/catch, fail-closed guard, log
line, and message string moves verbatim.

## Testing / verification (the crux)

1. **Existing test files: zero edits, all green.** `bootstrap.test.ts`'s
   integration suite is the behavioral lock; the types re-export keeps every
   import path valid. If an extraction forces a test edit, the extraction is
   wrong — restructure it, don't touch the test.
2. `bun run typecheck` clean tree-wide after every task.
3. `bunx depcruise` (the existing dependency-cruiser config) clean after every
   task — `no-circular` + `no-orphans` mechanically verify the split introduced
   no cycle and left no dead file.
4. **No new tests.** The wire modules are pure composition covered by the
   existing integration suite; unit-testing a move is scope creep.
5. One commit per extracted module; the full suite green at every commit, so
   the refactor can stop safely at any point.

## Task shape (for the plan)

One task per module, in dependency order:
1. `types.ts` (pure type move + re-export) — lowest risk, proves the pattern.
2. `providers.ts`.
3. `wire-social.ts`.
4. `wire-a2a-server.ts` (+ `resumeForaging()` call-site move).
5. Final sweep: index.ts ordering/comments, dead imports, depcruise + broad
   suite + LOC report.

## Risks

- **Concurrent session:** the desktop session pushes to dev but does not touch
  `src/daemon/bootstrap/` — rebase-before-merge covers the residual risk.
- **Hidden order-sensitivity** (e.g. provider registration order, judge
  fallback order): mitigated by byte-preserving move order within each module
  and the integration suite; any reordering is a bug, not a cleanup.
- **The live daemon** runs from a separate stale checkout — unaffected until
  its owner updates it.

## Follow-up (not this spec)
- A2A `proto_version` negotiation (agent card field + handshake) — small,
  immediately after this merges.
