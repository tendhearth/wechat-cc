# CC agent workspace interaction preview

**Goal:** Turn the approved in-progress three-column image into an interactive design sample, including provider-owned subagents.

**Scope:** Isolated browser prototype under `apps/desktop/art/cc-agent-workspace/`. No changes to production UI, runner, database, frozen assets or provider configuration. All execution content is synthetic; no network calls or real approvals. Existing single-provider event records cannot truthfully supply subagent lineage.

**Design:** Left project/task navigation, central user/CC conversation with major assignments and explicit handoff receipts, right selected execution detail. Provider-owned subagents nest inside assignments and carry a parent identity. Finished subagents collapse; unresolved children remain discoverable via summary. No assumed parent completion. Raw output is optional. Drafts, selection, disclosures and scenario state are project-local. A stop request is separate from its acknowledgement; child stop does not stop siblings. Permission denial and disconnected execution must not appear successful. Four explicit preview scenarios: running, permission, completed, disconnected.

## Delivery steps

- [x] Define synthetic fixtures and a pure interaction state model. Before implementation, test project-local selection/drafts, descendant-only cancellation, stop acknowledgement, blocked child aggregation, and unknown connection state. Use `bun --bun vitest run apps/desktop/art/cc-agent-workspace/model.test.js`.
- [x] Build `preview.html`, `preview.css`, `preview.js`, `fixtures.js`, `model.js`. Preview controls sit outside application chrome and explicitly say that models are not connected. Use project-local existing static server on 4186. CSP rejects API requests. Full keyboard operation, labelled buttons, responsive detail panel and reduced-motion support.
- [x] Inspect the actual browser: expand Claude/Codex children; open handoff; change selected child; simulate permission and cancellation acknowledgement; switch projects and retain drafts; inspect completed artifacts and disconnected state; check 1440px and narrow layouts. Run syntax checks and focused model tests; record results in README. Commit only this sample and plan, do not push.

## Data boundary for later real integration

Nodes need explicit provider/session/parent identities and authoritative lifecycle events. Handoffs need sender, receiver, requested work, artifact version and receipt. Missing provider child events must say unavailable, not be reconstructed from prose. UI controls need provider-specific capability checks and acknowledgement. The prototype demonstrates this contract, but it is not a production protocol or an implemented multi-agent manager.
