# Task attachments across the CC workbench

Date: 2026-09-13. Baseline `7f0d16c5`. Continues the unified task-entry goal; this slice does not establish complete CLI/App parity.

## User outcome and design

Select, drop or paste files into the existing task composer. The same material must reach the native executor, stay associated with the submitted message, and survive queueing, continuation and an explicit cross-executor handoff. No new permanent panel or attachment configuration form.

Images use real native image blocks. Ordinary files are immutable snapshots materialized under the task's `.cc-workbench-inputs` directory so native file tools can read them. A pathname is not evidence that image pixels reached a model. Claude PDF blocks require an owned native fixture before being described as direct document input. Input content is reference material, not added authorization.

Uploads have a stable UUID, a per-window draft UUID and optional existing-task scope. SHA256 snapshots retain the bytes selected by the user. Sending claims staged uploads for exactly one task. Subsequent messages can reuse that task's inputs; another task must receive an explicit handoff copy. Public metadata never exposes the private snapshot path. Bounded request buffering, strict base64, MIME/signature checks and safe descriptor-relative file access apply before native execution.

Public attachment metadata is `{id,name,mime,size,sha256}`. Composer requests add `attachmentIds: string[]` and `draftId: string`; upload is `POST /v1/workbench/attachment` with `{id,draftId,taskId?,name,mime,base64}`. Task-scoped read uses `GET /v1/workbench/attachment?taskId=...&id=...`; discard of unclaimed uploads uses `POST /v1/workbench/discard-attachment` with `{id,draftId}`. CC initially bounds one input to 8 files / 24 MiB total, each file to 8 MiB and each image to 5 MiB. These are CC product bounds, not claims about provider maxima.

User events and durable live-input receipts retain ordered attachment metadata. Receipt identity includes attachments. The original accepted run remains immutable when Claude drains an input into a new dispatch run. Restart previews include attachment identities and explicitly list retained/omitted material. Handoff selections pin original bytes and are recorded with the existing handoff packet. Removing an unsent chip does not remove already submitted material.

## Implementation sequence

1. Add immutable upload storage, task claiming/copying/materialization and migration; test corruption, task/draft isolation, type/size checks and immutable copies.
2. Add optional structured attachments to native dispatch/steer, preserving all text-only callers. Prove image payloads using actual installed Claude/Codex executors against owned loopback endpoints, including continuation and live steer.
3. Connect service acceptance, durable receipts, user events, restart/handoff and bounded HTTP transport. Test queued input ownership, idempotent retries, cancellation/restart, and pinned handoff material.
4. Add composer attachment chips and file/paste/drop controls, task-scoped drafts and receipt identity. Async upload completion must update the initiating draft even after navigation; pending/failed uploads prevent an incomplete send. Add message attachment reading and handoff selection.
5. Run affected suites, full typecheck, native fixtures, desktop/browser transport checks and an independent review. Commit independently reviewable changes; do not push or restart the user's real bot.

## References already inspected

- Paseo's native Claude/Codex adapters distinguish image blocks from ordinary uploaded-file paths; retain that distinction.
- Orca retains host upload identity separately from preview state. Its terminal-paste transport is not appropriate for CC's typed native interfaces.
- Installed Codex 0.153.4 start/steer schemas accept image inputs, not generic file/document inputs. Installed Claude Agent SDK 0.2.116 accepts image/document content blocks.
- Protocol evidence and native fixture plan: `/tmp/cc-native-attachment-protocol-research.md` (local audit; not a production dependency).

The broader goal remains open: native capability fidelity, model controls, complete background-agent lifecycle, additional execution providers and richer phone/multi-host workflows still need separate implementation and verification.
