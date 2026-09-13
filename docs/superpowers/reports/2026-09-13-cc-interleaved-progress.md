# Interleaved replies and execution activity

## Behavior

The workbench now renders one chronological timeline. Assistant progress and
final replies remain between the operations that produced them. Active-run
operations are visible; adjacent operation groups fold at their original
positions after the run ends. Failures remain visible. Earlier runs stay folded
while another run executes. A reader's current event and viewport offset survive
folding above it; an operation group being read remains open.

Codex app-server supplies native item starts/completions and message deltas.
The completed message replaces its partial text without a duplicate reply.
Claude SDK assistant blocks retain their original order; tool results update
the corresponding tool-use row. Claude rich events are enabled only for
workbench sessions, leaving normal companion chat behavior unchanged.

Native item identity is scoped to task + dispatch run + event kind. Updates keep
the first-arrival event ID, timestamp and position. SQLite migration v51 is
additive and preserves old/imported history and provenance. Missing operation
completion is marked interrupted/cancelled when the run ends, never inferred
successful from the final assistant reply. Active run identity remains available
during cleanup; accepting new input is independently disabled at that point.

## Verification

- New storage, service, adapter and UI tests failed before their implementations.
- Final relevant suite: 36 files, 526 passing tests; full typecheck and whitespace
  checks pass. Includes workbench storage/service, native adapters, permissions,
  history/handovers, DB upgrades, desktop proxy and workbench UI regressions.
- Native installed Codex 0.153.4 schema verified for collabAgentToolCall. The
  newer documented collabToolCall discriminator is accepted without assuming
  that successful child launch means the child completed its task.
- Two real read-only tasks used distinct temporary fixture directories through
  the isolated development runtime: Codex `bd1a58d7`, Claude `7e25968d`.
  Both first runs persisted user → progress reply → completed file read → final
  reply. Browser inspection confirmed the operation folded between both replies,
  expanded correctly, and remained readable after refreshing.
- A subsequent Codex turn waited 25 seconds in a foreground command and read
  the fixture; its single operation updated to completed and folded in place.
- Active/completed renderer states were separately verified in Chromium, with
  keyboard expansion and no horizontal overflow at 1100×860. Geometric reading
  tests retained a reply offset within 0.11 px while content above collapsed;
  an operation being read retained exactly its prior position.
- The development backend was restarted only when its tasks had ended. The
  existing release companion daemon and its bundle were not replaced.

## Limits

This change records native subagent operations and explicitly reported
relationships/states. It is not a persistent monitor of independently running
background agents. Claude task_notification handling and detached-task results
are not implemented here. A second Claude delay experiment returned a background
launch acknowledgment instead of waiting for its result; that experiment is not
claimed as successful background-task tracking.

Text remains bounded to the existing 40,000-character per-event limit. Activity
details retain only bounded names, paths and reported identities/states, not raw
tool arguments, output or private reasoning. The current UI still polls for
updates; this is not a new server-push transport.

The public [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
documents the event mechanism. CC's grouping and folding are implemented here;
this report does not claim that the entire Codex desktop UI is open source.
