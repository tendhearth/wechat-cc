# Implementation Plan: Bootstrap Composition-Root Split

**REQUIRED SUB-SKILL: `superpowers:executing-plans`** — execute this plan task-by-task,
running the per-task verification cycle and committing after each task before moving on.

**Date:** 2026-07-16
**Spec:** `docs/superpowers/specs/2026-07-16-bootstrap-split-design.md`

## Goal

Split the 1773-line `src/daemon/bootstrap/index.ts` composition root into four
per-subsystem modules (`types.ts`, `providers.ts`, `wire-social.ts`,
`wire-a2a-server.ts`), leaving `index.ts` (`buildBootstrap`) as a ~500-line
orchestrator that reads as the boot sequence. **Zero behavior change** — this is a
pure structural refactor whose verification property is "existing test files
unchanged and green."

## Architecture — the wire-function pattern

Each extracted module exports **one function** taking a narrow, explicit deps
interface (exactly what that block consumes) and returning exactly what downstream
assembly needs. `buildBootstrap` remains the only orchestrator: it calls the wire
functions in boot order and threads their outputs. No wire module imports another
wire module — only `index.ts` composes them (dependency-cruiser `no-circular`
verifies this mechanically). `types.ts` holds the two public interfaces; `index.ts`
re-exports them so every existing import path stays valid.

**Verbatim-move mechanism (READ THIS FIRST).** Each wire function's parameter is
named `deps`, so the original `deps.log` / `deps.stateDir` / `deps.db` / `deps.ilink`
accesses stay byte-identical. Every name that was a *bare local* in `buildBootstrap`
(e.g. `registry`, `claudeBin`, `sdkOptionsForProject`, `a2aRegistry`,
`resolveOperatorChatId`) is re-materialized as a bare local via a **destructure of
`deps`** at the top of the wire function — so the moved block bodies need no edits.
Where a destructured field's original bare-local name differs from the interface
field name, use a rename in the destructure (`const { onIntent: socialOnIntent } = deps`)
to keep the block body byte-exact. Only two lines in the entire refactor are
intentionally NOT verbatim; both are called out explicitly (the `selfIdentity` url
line in Task 3, and — nothing else; the `onIntent`/`onReveal` spread lines are kept
verbatim via destructure-rename).

## Tech Stack

TypeScript (strict, NO `noUnusedLocals`), Bun runtime, Vitest. tsconfig has
`resolveJsonModule: true` (the `with { type: 'json' }` imports stay valid in any
module they move to).

## Global Constraints

1. **HARD RULE — existing test files get ZERO edits.** `bootstrap.test.ts`,
   `bootstrap.a2a.test.ts`, and every `src/daemon/wiring/*.test.ts` are the
   behavioral lock. They import `buildBootstrap` + `resolveAdminChatId` from
   `'./bootstrap'` and `type { Bootstrap }` from `'../bootstrap'` /
   `'../bootstrap/index'`. If any extraction would force a test edit, the extraction
   is wrong — restructure it (keep the symbol exported/re-exported from `index.ts`).
2. **No new tests.** The wire modules are pure composition covered by the existing
   integration suite. Unit-testing a move is scope creep.
3. **Byte-preserve order.** Provider registration order and social judge/reveal
   order are order-sensitive. Move blocks wholesale; never reorder lines within a
   moved block. Two behavior-neutral *cross-block* reorders are explicitly permitted
   and noted (Task 4: `a2a-info.json` write now precedes `resumeForaging()`; both
   are independent fire-and-forget side effects).
4. **`resolveAdminChatId` and `buildBootstrap` stay exported from `index.ts`**
   (tests import them by name from `'./bootstrap'`). `Bootstrap` + `BootstrapDeps`
   are re-exported from `index.ts` (Task 1).
5. **One commit per task.** The full suite is green at every commit, so the refactor
   can stop safely at any point.
6. **These STAY in `index.ts`** (per spec): `resolveClaudeBinary`,
   `hydrateClaudeAuthEnvFromUserSettings`, `resolveAdminChatId`,
   `wrapCheapEvalWithAuthFailCheck`, `buildCanUseTool`, `sdkOptionsForProject`, the
   `wechatStdio*`/`delegateStdio*`/`pluginMcp*` spec locals, `currentClaudeModel` /
   `currentModelFor`, `buildInstructions`, `sessionManager` / `sessionStore` /
   `conversationStore`, `recordTurn` / `sendAssistantText` / `coordinator`,
   `dispatchDelegate`, the a2a infra construction (`a2aRegistry` / `a2aClient` /
   `a2aEventsStore`), `resolveOperatorChatId`, the guarded 乙 v2 block, and the return
   object.

## Verification cycle (run for EVERY task after the edits)

Define these three commands (used verbatim in each task):

- **SUITE:** `bun run test src/daemon/bootstrap.test.ts src/daemon/bootstrap.a2a.test.ts src/daemon/wiring`
  → expect Vitest to end with `Test Files  N passed (N)` / `Tests  … passed`, exit 0,
  ZERO failures.
- **TYPECHECK:** `bun run typecheck` (= `tsc --noEmit`) → expect no output, exit 0.
- **DEPCHECK:** `bun run depcheck` (= `depcruise --config .dependency-cruiser.cjs src cli.ts setup.ts docs.ts log-viewer.ts`)
  → expect `✔ no dependency violations found (… modules, … dependencies cruised)`,
  exit 0. This mechanically proves `no-circular` (no new cycle) and `no-orphans` (the
  new file is imported).

`strict: true` is on but `noUnusedLocals` is OFF, so a briefly-unused import will not
fail typecheck — final import cleanup is Task 5. Still, remove a moved symbol's now-
dead imports in the same task when it is unambiguous.

---

## Task 0 — Baseline (no edits)

Prove the tree is green before touching anything.

1. Run **SUITE** — record the passing file/test counts.
2. Run **TYPECHECK** — expect clean.
3. Run **DEPCHECK** — expect clean.
4. `wc -l src/daemon/bootstrap/index.ts` → expect **1775** (the starting size; report
   it in the final task).

Do not commit (no changes).

---

## Task 1 — Extract `bootstrap/types.ts` (pure type move + re-export)

Lowest-risk task; proves the pattern. Move the two public interfaces verbatim; make
`index.ts` re-export them.

### Import-site proof (why the re-export list is exactly these two)

`git grep` for external importers of these types (run to confirm before/after):

```
git grep -nE "from '(\.\.?/)*bootstrap(/index)?'" -- 'src/**/*.ts'
```

Current external importers (must keep working unchanged):
- `src/daemon/main.ts` → `import { buildBootstrap } from './bootstrap'` (value; unaffected).
- `src/daemon/bootstrap.test.ts` → `import { buildBootstrap, resolveAdminChatId } from './bootstrap'`.
- `src/daemon/bootstrap.a2a.test.ts` → `import { buildBootstrap } from './bootstrap'`.
- `src/daemon/wiring/index.ts`, `wiring/lifecycle-deps.ts`, `wiring/pipeline-deps.ts`,
  `wiring/tick-bodies.ts` → `import type { Bootstrap } from '../bootstrap'`.
- `src/daemon/wiring/pipeline-deps-converse.test.ts`,
  `wiring/pipeline-deps-social-dispatch.test.ts` → `import type { Bootstrap } from '../bootstrap/index'`.

`git grep -n "BootstrapDeps" -- 'src/**/*.ts'` returns **only** matches inside
`bootstrap/index.ts` → `BootstrapDeps` has no external importer, but is re-exported
anyway (harmless; `index.ts` itself still references `BootstrapDeps['log']` and
`deps: BootstrapDeps`). Re-export set is therefore exactly **`{ Bootstrap, BootstrapDeps }`**.
All external paths resolve to `bootstrap/index.ts`, so the re-export there keeps every
one valid — zero test edits.

### 1a. Create `src/daemon/bootstrap/types.ts`

Full imports (every type the two interfaces reference; `formatInbound` is a value
import because `Bootstrap` does `typeof formatInbound`):

```ts
import type { SessionManager } from '../../core/session-manager'
import type { TierProfile } from '../../core/user-tier'
import type { ProviderRegistry } from '../../core/provider-registry'
import type { ConversationCoordinator, TurnRecord } from '../../core/conversation-coordinator'
import type { ConversationStore } from '../../core/conversation-store'
import { formatInbound } from '../../core/prompt-format'
import type { ProviderId } from '../../core/conversation'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { WechatProjectsDep, WechatVoiceDep, WechatCompanionDep } from '../wechat-tool-deps'
import type { Db } from '../../lib/db'
import type { AgentConfig, AgentProviderKind } from '../../lib/agent-config'
import type { AppendInput } from '../../core/a2a-events-store'
import type { YiHub } from '../../core/yi-hub'
import type { DelegateDispatch } from './delegate'
import type { SendAssistantText } from './fallback-reply'
import type { SeekOutcome } from '../../core/social-broker'
import type { Revealer } from '../../core/social-reveal'
```

(Inline `import('…')` type references inside the interfaces — `SessionStore`,
`A2ARegistry`, `A2AClient`, `A2AEventsStore`, `A2AServer`, `UserTier`, `SeekStore`,
`EchoStore`, `PledgeStore` — move verbatim with the interface text; they need no
top-level import.)

Then paste **verbatim** the two interface blocks (doc comments included):

- **`BootstrapDeps`** — MOVE VERBATIM.
  First lines:
  ```
  export interface BootstrapDeps {
    stateDir: string
  ```
  Last lines:
  ```
    replySinks?: { capture: (chatId: string, text: string) => boolean }
  }
  ```
- **`Bootstrap`** — MOVE VERBATIM.
  First lines:
  ```
  export interface Bootstrap {
    sessionManager: SessionManager
  ```
  Last lines:
  ```
      revealer: Revealer
    }
  }
  ```

### 1b. Edit `src/daemon/bootstrap/index.ts`

1. **Delete** the two interface blocks (the `export interface BootstrapDeps { … }`
   and `export interface Bootstrap { … }` bodies).
2. Add near the top of the import block (after the existing relative imports):
   ```ts
   import type { BootstrapDeps, Bootstrap } from './types'
   export type { BootstrapDeps, Bootstrap } from './types'
   ```
   (The first line brings the names into local scope — `index.ts` still uses
   `BootstrapDeps['log']`, `deps: BootstrapDeps`, `Promise<Bootstrap>`. The second
   re-exports them for external importers.)
3. Leave every other import in `index.ts` as-is for now. Several imports become used
   *only* by the type interfaces that just left (e.g. `TurnRecord`, `WechatProjectsDep`,
   `SeekOutcome`, `Revealer`, `YiHub`, `AppendInput`, `SendAssistantText`,
   `DelegateDispatch`) — but `noUnusedLocals` is off, and most are still used by
   value/other-type sites in `index.ts` at this stage. **Do NOT hunt imports here**;
   the sweep is Task 5.

### 1c. Verify + commit

Run **SUITE**, **TYPECHECK**, **DEPCHECK** — all green. Then:

```
git add src/daemon/bootstrap/types.ts src/daemon/bootstrap/index.ts
git commit -m "refactor(bootstrap): extract BootstrapDeps + Bootstrap into types.ts"
```

---

## Task 2 — Extract `bootstrap/providers.ts` (`registerProviders`)

Move the five provider registration blocks + codex-autofix + the two codex-detection
helpers. Preserve registration ORDER byte-exactly.

### Deps interface (derived from the block's reads)

The moved region (index.ts lines ~715–1069) reads, via `deps.*`: `deps.log`,
`deps.stateDir`, `deps.ilink.askUser`, `deps.ilink.companion.status()`,
`deps.agentProviderKind`. It reads these **bare locals** (all defined ABOVE the
region in `buildBootstrap`, all staying in `index.ts`): `configuredAgent`,
`permissionMode`, `conversationStore`, `sdkOptionsForProject`, `claudeBin`,
`currentClaudeModel`, `resolveAdminChatId`, `pluginMcp`, and the codex/cursor/openai/
gemini stdio specs. It also uses `HOME` (currently `const HOME = homedir()` at line
713) — computed fresh inside `registerProviders` instead of threaded (it's only used
by the register blocks' `canResume` closures).

### Return set (derived from later consumers)

`git grep` inside `index.ts` for post-region uses proves exactly four outputs are
consumed downstream:
- `registry` → `sessionManager` (`new SessionManager({ registry })`), `coordinator`
  (`registry`, `registry.getCheapEval()`, `registry.getStrongEval()`), the social
  block (`registry.getCheapEval()`), and the `Bootstrap` return.
- `defaultProviderId` → `buildInstructions`, `coordinator`, the social block, and the
  return (`defaultProviderId` + `agentProviderKind`).
- `codexBinary` + `codexVersionCheck` → `dispatchDelegate`
  (`...(codexBinary && codexVersionCheck?.ok ? { codexPathOverride: codexBinary } : {})`).

Nothing else from the region escapes it. `ProviderWiring = { registry,
defaultProviderId, codexBinary, codexVersionCheck }` — nothing "just in case".

### 2a. Create `src/daemon/bootstrap/providers.ts`

Full imports:

```ts
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { createProviderRegistry, type ProviderRegistry } from '../../core/provider-registry'
import { createClaudeAgentProvider } from '../../core/claude-agent-provider'
import { createCodexAgentProvider } from '../../core/codex-agent-provider'
import { buildSystemPrompt } from '../../core/prompt-builder'
import { assertMatrixComplete, capabilitiesFor, capabilityProviderIds } from '../../core/capability-matrix'
import type { ProviderId } from '../../core/conversation'
import type { PermissionMode } from '../../core/capability-matrix'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ConversationStore } from '../../core/conversation-store'
import type { AgentConfig, AgentProviderKind } from '../../lib/agent-config'
import type { Access } from '../../lib/access'
import type { CompanionConfig } from '../companion/config'
import { loadAccess } from '../../lib/access'
import { loadCompanionConfig } from '../companion/config'
import { findOnPath, probeBinaryVersion } from '../../lib/util'
import { findCodexBinary } from '../../lib/find-codex-binary'
import { checkCodexVersion } from './codex-version-check'
import { attemptCodexAutofix } from '../../lib/codex-autofix'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { McpStdioSpec } from './mcp-specs'
import type { BootstrapDeps } from './types'
import codexCliPkg from '@openai/codex/package.json' with { type: 'json' }
```

Note `capabilityProviderIds` — imported because `capabilitiesFor` +
`capabilityProviderIds` also appear in `index.ts` (they stay there too; both files
import from the same module, no conflict). `Access` / `CompanionConfig` are imported
so the `resolveAdminChatId` dep can be typed.

Interface + skeleton (the destructure is what keeps the moved block verbatim):

```ts
export interface ProviderDeps {
  log: BootstrapDeps['log']
  stateDir: string
  ilink: Pick<BootstrapDeps['ilink'], 'askUser' | 'companion'>
  agentProviderKind?: AgentProviderKind
  configuredAgent: AgentConfig
  permissionMode: PermissionMode
  conversationStore: ConversationStore
  sdkOptionsForProject: (alias: string, path: string, tierProfile: import('../../core/user-tier').TierProfile, chatId: string, mcpEnv?: Record<string, string>, appendInstructions?: string) => Options
  claudeBin: string | undefined
  currentClaudeModel: () => string
  resolveAdminChatId: (access: Access, companion: CompanionConfig, initiatingChatId?: string | null) => string | null
  pluginMcp: Record<string, McpStdioSpec>
  wechatStdioForCodex: McpStdioSpec | null
  delegateStdioForCodex: McpStdioSpec | null
  wechatStdioForCursor: McpStdioSpec | null
  delegateStdioForCursor: McpStdioSpec | null
  wechatStdioForOpenai: McpStdioSpec | null
  delegateStdioForOpenai: McpStdioSpec | null
  wechatStdioForGemini: McpStdioSpec | null
}

export interface ProviderWiring {
  registry: ProviderRegistry
  defaultProviderId: ProviderId
  codexBinary: string | null
  codexVersionCheck: ReturnType<typeof checkCodexVersion> | null
}

export async function registerProviders(deps: ProviderDeps): Promise<ProviderWiring> {
  // Re-materialize the bare locals the moved blocks reference, so their bodies
  // stay byte-identical to the original buildBootstrap code.
  const {
    configuredAgent, permissionMode, conversationStore, sdkOptionsForProject,
    claudeBin, currentClaudeModel, resolveAdminChatId, pluginMcp,
    wechatStdioForCodex, delegateStdioForCodex, wechatStdioForCursor,
    delegateStdioForCursor, wechatStdioForOpenai, delegateStdioForOpenai,
    wechatStdioForGemini,
  } = deps
  const HOME = homedir()

  // ─── MOVE VERBATIM: index.ts lines ~715–1069 ───
  // First moved line:
  //   const defaultProviderId: ProviderId = deps.agentProviderKind
  //     ?? (process.env.WECHAT_AGENT_PROVIDER === 'codex' ? 'codex' : configuredAgent.provider)
  // ...through the five register blocks (claude, codex+autofix, cursor, openai,
  // gemini) in order...
  // Last moved lines:
  //   // would silently slip past and only throw at first use in production.
  //   assertMatrixComplete(registry.list())
  // ─── END VERBATIM ───

  return { registry, defaultProviderId, codexBinary, codexVersionCheck }
}
```

Also MOVE VERBATIM into this file (from the top of `index.ts`) the two codex-detection
helpers **with their doc comments** — the region from the comment beginning
`// Locate the wechat-cc source-mode install root …` through the close of
`detectUserCodexOnPath`:

- `wechatCcRepoRoot()` — first line `function wechatCcRepoRoot(): string | null {`,
  last line `}` (returns `null` in `catch`).
- `detectUserCodexOnPath()` — first line
  `function detectUserCodexOnPath(): { path: string | null; version: string | null } {`,
  last line `}`.

These two functions are used only by the codex-autofix call inside the moved region,
so they belong here.

### 2b. Edit `src/daemon/bootstrap/index.ts`

1. **Cut** lines ~715–1069 (the `const defaultProviderId …` through
   `assertMatrixComplete(registry.list())`) — this is the region moved verbatim into
   `registerProviders`.
2. **Cut** the `const HOME = homedir()` line (currently line 713); keep the preceding
   `const sessionStore = makeSessionStore(…)` line — `sessionStore` stays.
3. **Cut** the two helper functions `wechatCcRepoRoot` and `detectUserCodexOnPath`
   (with their doc comments) from the top-of-file helper region. Keep
   `resolveClaudeBinary`, the `CLAUDE_AUTH_ENV_KEYS` const, and
   `hydrateClaudeAuthEnvFromUserSettings` (they stay).
4. **Insert** the call site where the cut region was (right after `sessionStore` /
   before `sendAssistantText`):
   ```ts
   const { registry, defaultProviderId, codexBinary, codexVersionCheck } = await registerProviders({
     log: deps.log,
     stateDir: deps.stateDir,
     ilink: deps.ilink,
     agentProviderKind: deps.agentProviderKind,
     configuredAgent,
     permissionMode,
     conversationStore,
     sdkOptionsForProject,
     claudeBin,
     currentClaudeModel,
     resolveAdminChatId,
     pluginMcp,
     wechatStdioForCodex,
     delegateStdioForCodex,
     wechatStdioForCursor,
     delegateStdioForCursor,
     wechatStdioForOpenai,
     delegateStdioForOpenai,
     wechatStdioForGemini,
   })
   ```
5. Add the import: `import { registerProviders } from './providers'`.
6. Remove imports that are now dead in `index.ts` *only if unambiguous*:
   `createClaudeAgentProvider` (keep `tierProfileToClaudeSdkOpts` from the same line —
   still used by `sdkOptionsForProject`), `createCodexAgentProvider`, `findCodexBinary`,
   `checkCodexVersion`, `attemptCodexAutofix`, `createProviderRegistry` +
   `type ProviderRegistry`, `probeBinaryVersion` (was used only by the moved helper +
   the moved version check), and the `codexCliPkg` json import. **Keep** `findOnPath`
   (still used by `resolveClaudeBinary`), `buildSystemPrompt` (still used by
   `buildInstructions`), `capabilitiesFor` / `capabilityProviderIds` (still used by
   `delegateStdioByProvider` + `buildInstructions`), `assertMatrixComplete` moves out
   (drop from index). If unsure whether a symbol has another use, leave it — Task 5
   sweeps. Confirm the edited line
   `import { createClaudeAgentProvider, tierProfileToClaudeSdkOpts } from …` becomes
   `import { tierProfileToClaudeSdkOpts } from …`.

### 2c. Verify + commit

Run **SUITE**, **TYPECHECK**, **DEPCHECK** — all green (the provider integration
assertions in `bootstrap.test.ts` are the lock here). Then:

```
git add src/daemon/bootstrap/providers.ts src/daemon/bootstrap/index.ts
git commit -m "refactor(bootstrap): extract 5 provider registrations into providers.ts"
```

---

## Task 3 — Extract `bootstrap/wire-social.ts` (`wireSocial`)

Move the whole agent-social block + the boot-resume loop. Resolve the one genuine
cycle (`selfIdentity` reads `a2aServer.baseUrl()`, but `a2aServer` is built after this
block) via a `getServerBaseUrl` thunk.

### Deps interface

The moved block reads, via `deps.*`: `deps.log`, `deps.stateDir`, `deps.db`. It reads
these **bare locals** (all stay in `index.ts`, passed in): `registry`,
`defaultProviderId`, `pluginMcp`, `currentClaudeModel`, `claudeBin`, `configuredAgent`,
`resolveOperatorChatId`, `sendAssistantText`, `a2aRegistry`, `a2aClient`. Plus the new
thunk `getServerBaseUrl: () => string | null` replacing the closure read of
`a2aServer`. `applyFinishSeek` (used once, at the broker's `finishSeek`) moves as an
import — confirmed only used here (`git grep "applyFinishSeek"` hits only
`bootstrap/index.ts` + `social-finish-seek.ts` + its own test).

### Return set

`SocialWiring = { onIntent, onReveal, social, resumeForaging }`:
- `onIntent` = `socialOnIntent` (`A2AServerOpts['onIntent']`, possibly `undefined`).
- `onReveal` = `socialOnReveal` (`A2AServerOpts['onReveal']`, possibly `undefined`).
- `social` = the `Bootstrap['social']` object (or `undefined` when unconfigured) —
  assembled here from `socialBroker`/`socialSeekStore`/`socialEchoStore`/
  `socialPledgeStore`/`socialRevealer`, matching the original return spread.
- `resumeForaging(): void` — the boot-resume loop, a no-op when unconfigured.

### 3a. Create `src/daemon/bootstrap/wire-social.ts`

Full imports (the social makers + a2a-delegate helpers + the finish-seek helper):

```ts
import { randomUUID } from 'node:crypto'
import { makeJudge } from '../../core/social-judge'
import { makeAnswerIntent } from '../../core/social-answer'
import { makeBroker, type SeekOutcome } from '../../core/social-broker'
import { makeSeekStore } from '../../core/social-seek-store'
import { makeEchoStore } from '../../core/social-echo-store'
import { makePledgeStore } from '../../core/social-pledge-store'
import { makeRevealer, type Revealer, type RevealBeat, type NotifyCtx, type PeerIdentity } from '../../core/social-reveal'
import { makeForwarder } from '../../core/social-forwarder'
import { makeRelayStore } from '../../core/social-relay-store'
import { makeSeenIntentStore } from '../../core/social-seen-intent-store'
import { makeRelayReconciler } from '../../core/social-relay-reveal'
import { intentUrl, revealUrl } from '../../core/a2a-delegate'
import { MatchReceiptSchema } from '../../core/a2a-intent'
import { applyFinishSeek } from './social-finish-seek'
import type { A2AServerOpts } from '../../core/a2a-server'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { A2AClient } from '../../core/a2a-client'
import type { ProviderRegistry } from '../../core/provider-registry'
import type { ProviderId } from '../../core/conversation'
import type { AgentConfig } from '../../lib/agent-config'
import type { Db } from '../../lib/db'
import type { McpStdioSpec } from './mcp-specs'
import type { SendAssistantText } from './fallback-reply'
import type { BootstrapDeps } from './types'

export interface SocialDeps {
  log: BootstrapDeps['log']
  stateDir: string
  db: Db
  configuredAgent: AgentConfig
  registry: ProviderRegistry
  defaultProviderId: ProviderId
  pluginMcp: Record<string, McpStdioSpec>
  currentClaudeModel: () => string
  claudeBin: string | undefined
  resolveOperatorChatId: () => string | null
  sendAssistantText: SendAssistantText | undefined
  a2aRegistry: A2ARegistry
  a2aClient: A2AClient
  /** Lazy read of the a2a server's base url — the server is constructed AFTER
   *  wireSocial runs (it consumes onIntent/onReveal), so selfIdentity reads it
   *  through this thunk. index.ts backs it with its `a2aServer` variable. */
  getServerBaseUrl: () => string | null
}

export interface SocialWiring {
  onIntent: A2AServerOpts['onIntent']
  onReveal: A2AServerOpts['onReveal']
  social?: {
    broker: { seek(topic: string, opts?: { city?: string }): Promise<SeekOutcome> }
    seekStore: import('../../core/social-seek-store').SeekStore
    echoStore: import('../../core/social-echo-store').EchoStore
    pledgeStore: import('../../core/social-pledge-store').PledgeStore
    revealer: Revealer
  }
  resumeForaging: () => void
}

export async function wireSocial(deps: SocialDeps): Promise<SocialWiring> {
  const {
    registry, defaultProviderId, pluginMcp, currentClaudeModel, claudeBin,
    configuredAgent, resolveOperatorChatId, sendAssistantText, a2aRegistry,
    a2aClient, getServerBaseUrl,
  } = deps

  // ─── MOVE VERBATIM: index.ts lines ~1304–1571 ───
  // First moved lines:
  //   // ── Agent-social M1 wiring (async foraging spine) ───────────────────────
  //   // Gated on BOTH social_enabled and social_disclosure_policy — absent
  //   ...
  //   let socialOnIntent: A2AServerOpts['onIntent']
  //   ...through the `if (configuredAgent.social_enabled && …) { … }` block...
  // Last moved lines:
  //       socialForage = (intentId, topic, opts) => broker.forage(intentId, topic, opts)
  //     }
  //   }
  //
  // ONE INTENTIONAL EDIT inside this verbatim block — the selfIdentity url read:
  //   BEFORE:  url: a2aServer ? a2aServer.baseUrl() : '',
  //   AFTER:   url: getServerBaseUrl() ?? '',
  // ─── END VERBATIM ───

  // Boot-resume loop, wrapped as a returnable closure (was index.ts ~1668–1681).
  // MOVE VERBATIM the loop body:
  const resumeForaging = (): void => {
    if (socialForage && socialSeekStore) {
      const forage = socialForage
      for (const row of socialSeekStore.list()) {
        if (row.status === 'foraging') {
          // M3: social_seek doesn't persist `city`, so a resumed forage sends
          // without it — safe degradation, city is an optional discovery hint.
          void forage(row.id, row.topic).catch(err => deps.log('SOCIAL_REC', `resume forage failed intent=${row.id}: ${err instanceof Error ? err.message : String(err)}`))
        }
      }
    }
  }

  return {
    onIntent: socialOnIntent,
    onReveal: socialOnReveal,
    ...(socialBroker
      ? { social: { broker: socialBroker, seekStore: socialSeekStore!, echoStore: socialEchoStore!, pledgeStore: socialPledgeStore!, revealer: socialRevealer! } }
      : {}),
    resumeForaging,
  }
}
```

Notes for the implementer:
- The `let socialOnIntent … let socialRevealer` hoists (index.ts ~1312–1319) move
  INTO `wireSocial` verbatim (they are the holders the `if` block assigns; the return
  reads them). `socialForage` + `socialSeekStore` are likewise `let`s the resume
  closure reads.
- The dynamic `await import('../social/grounded-judge')` inside the block is why
  `wireSocial` is `async`.
- The `notify` / `selfIdentity` / `postPeerReveal` / `postReveal` / `revealer` /
  `relayReconciler` / `socialOnReveal` / `answerLocally` / `socialOnIntent` /
  `broker` definitions all move verbatim (only the one `selfIdentity` url line changes).

### 3b. Edit `src/daemon/bootstrap/index.ts`

1. **Cut** the social block (~1304–1571) and the boot-resume loop (~1668–1681).
2. Declare the server holder BEFORE the wireSocial call (needed by the thunk and by
   Task 4's assignment):
   ```ts
   let a2aServer: import('../../core/a2a-server').A2AServer | null = null
   ```
   (This replaces the later `let a2aServer = null` that Task 4 removes from the a2a
   block. If Task 4 is not yet applied, keep the original `let a2aServer` where it is
   and instead declare the holder here — but since tasks run in order, declare it here
   now; the a2a block still assigns to it in this task's tree, so leave the original
   `let a2aServer: ReturnType<typeof createA2AServer> | null = null` UNTOUCHED for now
   and just reference it via the thunk. The cleaner single-`let` form lands in Task 4.)

   **Concrete for Task 3:** do NOT move the a2a block yet. Insert the `wireSocial` call
   where the social block was, and have the thunk read the existing (later-declared)
   `a2aServer` var. Because `a2aServer` is a function-scoped `let` (hoisted), the
   thunk `() => a2aServer ? a2aServer.baseUrl() : null` closes over it fine even
   though the `let` textually appears below the call — it is only *invoked* at
   runtime, after boot.
3. Insert the call site (where the social block was):
   ```ts
   const socialWiring = await wireSocial({
     log: deps.log,
     stateDir: deps.stateDir,
     db: deps.db,
     configuredAgent,
     registry,
     defaultProviderId,
     pluginMcp,
     currentClaudeModel,
     claudeBin,
     resolveOperatorChatId,
     sendAssistantText,
     a2aRegistry,
     a2aClient,
     getServerBaseUrl: () => a2aServer ? a2aServer.baseUrl() : null,
   })
   ```
4. In the `createA2AServer({ … })` opts, the social passthrough lines stay byte-exact
   as long as `socialOnIntent`/`socialOnReveal` names exist — replace their source:
   change
   ```ts
   ...(socialOnIntent ? { onIntent: socialOnIntent } : {}),
   ...(socialOnReveal ? { onReveal: socialOnReveal } : {}),
   ```
   to read from `socialWiring`:
   ```ts
   ...(socialWiring.onIntent ? { onIntent: socialWiring.onIntent } : {}),
   ...(socialWiring.onReveal ? { onReveal: socialWiring.onReveal } : {}),
   ```
   (Task 4 will fold this into `wireA2aServer`'s params; for Task 3 this keeps the tree
   compiling.)
5. Replace the boot-resume loop (just after `await a2aServer.start()` / the server
   `if` block, where the loop used to be) with:
   ```ts
   socialWiring.resumeForaging()
   ```
6. Replace the `Bootstrap` return's social spread — change
   ```ts
   ...(socialBroker ? { social: { broker: socialBroker, seekStore: socialSeekStore!, echoStore: socialEchoStore!, pledgeStore: socialPledgeStore!, revealer: socialRevealer! } } : {}),
   ```
   to
   ```ts
   ...(socialWiring.social ? { social: socialWiring.social } : {}),
   ```
7. Add import: `import { wireSocial } from './wire-social'`.
8. Remove now-dead social imports from `index.ts` (unambiguous — all their uses just
   left): `makeJudge`, `makeAnswerIntent`, `makeBroker` (+ `type SeekOutcome`),
   `makeSeekStore`, `makeEchoStore`, `makePledgeStore`, `makeRevealer` (+ `Revealer`,
   `RevealBeat`, `NotifyCtx`, `PeerIdentity`), `makeForwarder`, `makeRelayStore`,
   `makeSeenIntentStore`, `makeRelayReconciler`, `intentUrl`, `revealUrl`,
   `MatchReceiptSchema`, `randomUUID`, `applyFinishSeek`. **Keep** `A2AServerOpts`
   for now (still used by the `createA2AServer` block until Task 4) — actually it is
   no longer referenced in `index.ts` after step 4 (the `let socialOnIntent:
   A2AServerOpts[...]` declarations left with the block); drop it too if `git grep`
   confirms no remaining `A2AServerOpts` use in `index.ts`. If in doubt, leave it for
   Task 5.

### 3c. Verify + commit

Run **SUITE** (the social foraging + reveal assertions in `bootstrap.test.ts` and the
`wiring/pipeline-deps-social-dispatch.test.ts` are the lock), **TYPECHECK**,
**DEPCHECK** — all green. Then:

```
git add src/daemon/bootstrap/wire-social.ts src/daemon/bootstrap/index.ts
git commit -m "refactor(bootstrap): extract agent-social wiring into wire-social.ts"
```

---

## Task 4 — Extract `bootstrap/wire-a2a-server.ts` (`wireA2aServer`)

Move `routeA2ANotify`, the `createA2AServer` construction + `await start()`, the
`a2a-info.json` write, and the `a2aDeps` assembly. `resolveOperatorChatId` STAYS in
`index.ts` (it's also a `wireSocial` dep) and is passed in.

### Deps interface

The moved region reads, via `deps.*`: `deps.log`, `deps.stateDir`. Bare locals passed
in: `a2aRegistry`, `a2aClient`, `a2aEventsStore`, `dispatchDelegate`,
`resolveOperatorChatId`, `sendAssistantText`, `configuredAgent`. Plus the social
handlers `onIntent`/`onReveal` (destructured back to `socialOnIntent`/`socialOnReveal`
so the opts-spread lines stay byte-exact). `verifyAndConsumeInvite`, `createA2AServer`,
`NotifyEvent`, and `selfPkg` move as imports.

- `onExec` closes over `dispatchDelegate`. `onPair` closes over `a2aRegistry`,
  `a2aEventsStore`, `deps.stateDir`, `deps.log` (`verifyAndConsumeInvite`). `onAuthFailed`
  closes over `a2aEventsStore`. `routeA2ANotify` closes over `resolveOperatorChatId`,
  `sendAssistantText`, `a2aEventsStore`, `deps.log`. `a2aDeps` closes over
  `a2aRegistry`, `a2aClient`, `a2aEventsStore`, `configuredAgent.a2a_listen`,
  `a2aServer`.

### Return set

`{ a2aServer: A2AServer | null, a2aDeps }` — `a2aServer` feeds the `Bootstrap` return
+ backs `index.ts`'s `let a2aServer` (for the `getServerBaseUrl` thunk); `a2aDeps`
feeds the return.

### 4a. Create `src/daemon/bootstrap/wire-a2a-server.ts`

Full imports:

```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createA2AServer, type NotifyEvent, type A2AServerOpts, type A2AServer } from '../../core/a2a-server'
import { verifyAndConsumeInvite } from '../../lib/a2a-pairing'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { A2AClient } from '../../core/a2a-client'
import type { A2AEventsStore, AppendInput } from '../../core/a2a-events-store'
import type { DelegateDispatch } from './delegate'
import type { SendAssistantText } from './fallback-reply'
import type { AgentConfig } from '../../lib/agent-config'
import type { BootstrapDeps } from './types'
import selfPkg from '../../../package.json' with { type: 'json' }

export interface A2aServerDeps {
  log: BootstrapDeps['log']
  stateDir: string
  configuredAgent: AgentConfig
  a2aRegistry: A2ARegistry
  a2aClient: A2AClient
  a2aEventsStore: A2AEventsStore
  dispatchDelegate: DelegateDispatch
  resolveOperatorChatId: () => string | null
  sendAssistantText: SendAssistantText | undefined
  onIntent: A2AServerOpts['onIntent']
  onReveal: A2AServerOpts['onReveal']
}

export interface A2aServerWiring {
  a2aServer: A2AServer | null
  a2aDeps: Bootstrap['a2aDeps']
}

export async function wireA2aServer(deps: A2aServerDeps): Promise<A2aServerWiring> {
  const {
    a2aRegistry, a2aClient, a2aEventsStore, dispatchDelegate,
    resolveOperatorChatId, sendAssistantText, configuredAgent,
    onIntent: socialOnIntent, onReveal: socialOnReveal,
  } = deps

  // ─── MOVE VERBATIM: index.ts routeA2ANotify (~1573–1596) ───
  //   First:  async function routeA2ANotify(event: NotifyEvent): Promise<void> {
  //   Last:   })  (the a2aEventsStore.append({ … status: 'ok' }) call)
  // ─── END VERBATIM ───

  // ─── MOVE VERBATIM: index.ts a2a server construction (~1598–1666) ───
  //   First:  let a2aServer: ReturnType<typeof createA2AServer> | null = null
  //   Last:   deps.log('A2A', `server listening on http://${configuredAgent.a2a_listen.host}:${a2aServer.port()}`)
  // (the `...(socialOnIntent ? { onIntent: socialOnIntent } : {})` +
  //  `...(socialOnReveal ? { onReveal: socialOnReveal } : {})` lines stay byte-exact
  //  because we destructured onIntent→socialOnIntent, onReveal→socialOnReveal above)
  // ─── END VERBATIM ───

  // ─── MOVE VERBATIM: index.ts a2a-info.json write (~1683–1701) ───
  //   First:  const a2aInfoPath = join(deps.stateDir, 'a2a-info.json')
  //   Last:   } catch { /* non-fatal: CLI falls back to internal-api lookup */ }
  // ─── END VERBATIM ───

  // ─── MOVE VERBATIM: index.ts a2aDeps assembly (~1703–1710) ───
  //   First:  const a2aDeps = {
  //   Last:   }
  // ─── END VERBATIM ───

  return { a2aServer, a2aDeps }
}
```

`A2aServerWiring.a2aDeps` is typed as `Bootstrap['a2aDeps']` — add
`import type { Bootstrap } from './types'` to the imports above (append to the
`./types` import). The `AppendInput` import is needed because the moved `a2aDeps`
uses `(event: AppendInput) => a2aEventsStore.append(event)`.

### 4b. Edit `src/daemon/bootstrap/index.ts`

1. **Cut** `routeA2ANotify` (~1573–1596), the server construction block
   (~1598–1666), the `a2a-info.json` write (~1683–1701), and the `a2aDeps` assembly
   (~1703–1710).
2. Ensure the single server holder exists (from Task 3): `let a2aServer:
   import('../../core/a2a-server').A2AServer | null = null` declared BEFORE the
   `wireSocial` call. Remove the now-cut original `let a2aServer = null` (it lived in
   the server block, now moved).
3. Insert the call site (after `wireSocial`, since it consumes the social handlers):
   ```ts
   const { a2aServer: builtA2aServer, a2aDeps } = await wireA2aServer({
     log: deps.log,
     stateDir: deps.stateDir,
     configuredAgent,
     a2aRegistry,
     a2aClient,
     a2aEventsStore,
     dispatchDelegate,
     resolveOperatorChatId,
     sendAssistantText,
     onIntent: socialWiring.onIntent,
     onReveal: socialWiring.onReveal,
   })
   a2aServer = builtA2aServer
   socialWiring.resumeForaging()
   ```
   (Assigning the outer `let a2aServer` makes the `getServerBaseUrl` thunk resolve the
   live server at runtime. `resumeForaging()` now runs after the `a2a-info.json` write
   that moved inside `wireA2aServer` — a **behavior-neutral cross-block reorder**: both
   are independent fire-and-forget side effects, no shared state, no observable order.)
4. Remove the Task-3 stopgap opts-spread edit — the `createA2AServer` block is gone,
   so nothing to keep. The `Bootstrap` return already reads `a2aServer` and `a2aDeps`
   (now the local `const a2aDeps` + the outer `a2aServer` var) — unchanged names, so
   the return object needs no edit.
5. Add import: `import { wireA2aServer } from './wire-a2a-server'`.
6. Remove now-dead imports from `index.ts`: `createA2AServer` (+ `NotifyEvent`,
   `A2AServerOpts`), `verifyAndConsumeInvite`, `writeFileSync`, and `AppendInput` (its
   last `index.ts` use — the `a2aDeps` `recordEvent` — just moved). **Keep**
   `createA2ARegistry`, `createA2AClient`, `makeA2AEventsStore` (a2a infra
   construction stays), and `selfPkg` (still used by `loadPlugins({ hostVersion:
   selfPkg.version })`).

### 4c. Verify + commit

Run **SUITE** (`bootstrap.a2a.test.ts` is the direct lock: a2aServer null vs. started,
agent-card reachability, a2aDeps always present), **TYPECHECK**, **DEPCHECK** — all
green. Then:

```
git add src/daemon/bootstrap/wire-a2a-server.ts src/daemon/bootstrap/index.ts
git commit -m "refactor(bootstrap): extract a2a server construction into wire-a2a-server.ts"
```

---

## Task 5 — Final sweep

Tighten `index.ts` and run the full gates.

### 5a. Dead-import + comment sweep in `index.ts`

1. Run `bunx tsc --noEmit --noUnusedLocals src/daemon/bootstrap/index.ts` is NOT
   reliable in isolation; instead grep each import symbol for a remaining use:
   ```
   for each named import in index.ts: git grep -n "<symbol>" src/daemon/bootstrap/index.ts
   ```
   Remove any import whose only remaining hit is its own `import` line. Expected
   removals still lingering after Tasks 2–4 (if any): `type ProviderRegistry`,
   `assertMatrixComplete`, `A2AServerOpts`, `AppendInput`, `NotifyEvent`,
   `probeBinaryVersion`, `codexCliPkg`. Expected KEEPERS (spot-check they still have a
   real use): `tierProfileToClaudeSdkOpts`, `findOnPath`, `buildSystemPrompt`,
   `capabilitiesFor`, `capabilityProviderIds`, `createA2ARegistry`, `createA2AClient`,
   `makeA2AEventsStore`, `createYiHub`/`YiHub`/`createYiWsServer`, `selfPkg`,
   `makeSessionStore`, `makeConversationStore`, `SessionManager`, everything the
   `sdkOptionsForProject` / `buildCanUseTool` / `coordinator` / 乙-v2 blocks use.
2. Tighten the boot-order comments so `index.ts` reads as: stores → plugin MCP →
   sessions → `registerProviders` → `sendAssistantText`/`recordTurn`/`coordinator` →
   `dispatchDelegate` → a2a infra (registry/client/eventsStore + `resolveOperatorChatId`)
   → `wireSocial` → `wireA2aServer` → `resumeForaging()` → 乙 v2 → return. Update the
   top-of-file `buildBootstrap` doc block's "Helpers extracted for readability" list to
   add `./types.ts`, `./providers.ts`, `./wire-social.ts`, `./wire-a2a-server.ts`.
3. Confirm no leftover `let` that existed only for cross-block sharing remains — the
   `let social*` holders are gone (moved into `wireSocial`); the only remaining `let`s
   in `buildBootstrap` should be `cachedOperatorChatId` (inside `resolveOperatorChatId`),
   `a2aServer` (the thunk-backed holder), and `yiHub` (乙 v2). Anything else is a bug.

### 5b. Full gates

- **Broad suite:** `bun run test src/core src/daemon src/lib` → all green.
- **TYPECHECK:** `bun run typecheck` → clean.
- **DEPCHECK:** `bun run depcheck` → `✔ no dependency violations found`.
- **Import-path invariants (prove tests/main untouched):**
  ```
  git grep -n "from './bootstrap'" src/daemon/main.ts src/daemon/bootstrap.test.ts src/daemon/bootstrap.a2a.test.ts
  git grep -nE "from '\.\./bootstrap(/index)?'" src/daemon/wiring
  ```
  → unchanged from Task 0 (main.ts + all tests still import from `'./bootstrap'` /
  `'../bootstrap'` / `'../bootstrap/index'`).
- **LOC report:** `wc -l src/daemon/bootstrap/index.ts` → target ≈500; **report the
  actual number** (and the new modules' line counts:
  `wc -l src/daemon/bootstrap/{types,providers,wire-social,wire-a2a-server}.ts`).

### 5c. Commit

```
git add -A src/daemon/bootstrap/
git commit -m "refactor(bootstrap): final sweep — dead imports, boot-order comments, LOC report"
```

---

## Task map (dependency order)

| # | Module | Extracts | Verbatim region (index.ts) | New public fn |
|---|--------|----------|----------------------------|---------------|
| 0 | — | baseline green | — | — |
| 1 | `types.ts` | `BootstrapDeps` + `Bootstrap` | ~168–412 | (interfaces + re-export) |
| 2 | `providers.ts` | 5 provider registrations + codex autofix + 2 helpers | ~715–1069 (+ helper fns) | `registerProviders` |
| 3 | `wire-social.ts` | agent-social block + boot-resume | ~1304–1571, ~1668–1681 | `wireSocial` |
| 4 | `wire-a2a-server.ts` | routeA2ANotify + server + a2a-info + a2aDeps | ~1573–1596, ~1598–1666, ~1683–1710 | `wireA2aServer` |
| 5 | `index.ts` | sweep only | — | — |

## Notes on what deliberately STAYS in `index.ts`

The 乙 v2 block, `sendAssistantText`, `recordTurn`/turn-record wiring,
`a2aRegistry`/`a2aClient`/`a2aEventsStore` construction, `resolveOperatorChatId`,
`resolveClaudeBinary`, `hydrateClaudeAuthEnvFromUserSettings`, `resolveAdminChatId`
(exported — tests import it), `wrapCheapEvalWithAuthFailCheck`, `buildCanUseTool`,
`sdkOptionsForProject`, `currentClaudeModel`/`currentModelFor`, `buildInstructions`,
`sessionManager`/`coordinator`, `dispatchDelegate`, and the return object. A2A
`proto_version` is explicitly out of scope (ships as its own follow-up).
