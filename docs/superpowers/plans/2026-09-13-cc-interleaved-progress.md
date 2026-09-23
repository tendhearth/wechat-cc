# CC interleaved execution progress

The owner approved a single chronological conversation: progress replies stay
between operations while execution is active; adjacent operation records fold
in place at the end of their run. Replies remain readable. Native subagents are
activities within their parent task, not separate CC handoffs.

## Implementation

1. Fix native development icon cache invalidation; rebuild the debug bundle and
   verify embedded icon bytes without replacing the running release companion.
2. Add optional activity lifecycle and text-item updates to AgentEvent. Codex
   app-server uses native item IDs and statuses. Claude enables rich events only
   for workbench sessions and preserves assistant content order.
3. Persist updates against task + run + native item identity, keeping the first
   arrival position. Older/imported events remain supported. Settle unfinished
   activities as interrupted or cancelled, never infer successful completion.
4. Render one timeline. Active-run operations are visible; finished runs use
   compact, expandable groups at their original positions. Preserve reading
   position, drafts, accessible controls and task-scoped permissions.

## Validation

Test lifecycle correlation, text-delta replacement, cross-task/run isolation,
cancellation, compatibility of normal Claude chat, chronological rendering and
folding. Run relevant workbench/provider/desktop tests and typecheck. Inspect
active and completed views in a browser; preserve the live companion daemon.

## Interface

AgentActivity contains id, type, status, label and optional bounded detail,
parentId and agentIds. TaskEvent adds optional runId and activity. Text AgentEvent
may include itemId and textMode append/replace. The service supplies a unique
runId independently of native IDs. No raw tool inputs or private reasoning are
included. Tool completion updates the original event rather than adding a
second operation row.
