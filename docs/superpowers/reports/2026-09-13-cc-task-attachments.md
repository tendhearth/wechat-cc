# Task attachments: delivery and verification

Date: 2026-09-13. Worktree `wechat-cc-cc-kit`, branch `codex/cc-workbench-v1`, baseline `7f0d16c5`. This extends the unified task-entry goal; it does not establish full Claude/Codex CLI or App parity.

## What the user can do

Choose files, paste an image or drop material into the existing task composer. Send images without an accompanying text message, add files during a task or on continuation, and open/download submitted material from its message. Uploads belong to the originating draft even if the user switches tasks before they finish. Pending or failed uploads cannot silently disappear from a submitted request.

Submitted material is a task-owned snapshot, with ordered names and SHA256 identities stored on the user event and durable input receipt. Removing an unsent attachment does not remove a submitted version. Queueing and restarting retain material identity; a restart preview distinguishes retained material from omitted history. Another executor receives only explicitly selected original inputs, copied to its task with the same bytes. Returning review comments reuses that recorded selection rather than selecting newer inputs accidentally.

| Input | Claude | Codex |
| --- | --- | --- |
| PNG / JPEG / GIF / WebP | Native image content block | Native image input containing a data URL |
| PDF | Native document content block | Immutable file reference for native file tools |
| UTF-8 text/code and supported Office files | Immutable file reference for native file tools | Immutable file reference for native file tools |

A file reference does not prove that an executor has read the file, extracted an Office document or interpreted its contents. A PDF filename is not advertised as visual PDF input on Codex. Unsupported/missing image bytes fail explicitly instead of silently becoming a path-only message.

## Implementation boundaries

- The shared optional attachment argument preserves text-only provider callers. Claude's existing next-turn queue and Codex's active-turn steering remain distinct.
- Uploading stages material; accepting a message atomically claims its references for one task. Retry identity includes text and ordered attachments. Wrong task/draft references, changed snapshots and reused request IDs with different material are rejected.
- Schema v53 adds attachment metadata and ordered attachment JSON on events/live-input receipts. Snapshot bytes stay outside SQLite under the state directory; native file tools receive a task-specific `.cc-workbench-inputs` copy. Public metadata does not expose the private storage path.
- File operations use opened directory descriptors and refuse symbolic-link traversal. Snapshot hashes are checked again before dispatch. The macOS ARM64 `openat` call requires a small C wrapper; the compiled Bun fixture verifies that its bundled source works outside the source checkout.
- The HTTP API, browser proxy, native proxy and operator credential each keep explicit route grants. Browser JavaScript does not receive the desktop operator token. Upload bodies are bounded before decoding, including requests without a Content-Length header.
- Per-message limits are 8 files / 24 MiB; per file 8 MiB, per image 5 MiB. Unsubmitted drafts expire after 7 days. The initial snapshot store is capped at 256 MiB and collects only blobs with no remaining attachment references. Claimed/shared snapshots are preserved. These are CC limits, not provider maxima; storage management remains a follow-up for sustained large-file use.

## Verification

The integration uses generated material, temporary projects/databases, isolated native configuration and owned loopback endpoints. It does not use account credentials, user MCP servers, real model APIs or real WeChat traffic, and it does not restart the user's bot.

### Installed native executors

Repeatable fixture: `bun scripts/workbench-native-attachments-smoke.ts --run`.

Verified with Codex **0.153.4**, Claude Code **2.1.267** and Claude Agent SDK **0.2.116**:

- Initial images and image-only continuation carry actual decoded image bytes to the model request.
- Closing/resuming keeps the native session identity, previous visual history and newly appended images.
- Codex active image-only steering receives the real acknowledgement; stale steering is rejected.
- Claude forwards the owned PDF as a native document with matching bytes.
- The fixture removes the original image file paths before sending, so a successful pathname read cannot masquerade as image transport.

The endpoint replies are synthetic. This proves native transport/session retention, not visual comprehension or semantic quality of any model.

### Compiled storage and desktop integration

`bun scripts/workbench-attachment-storage-smoke.ts` compiles and runs an isolated executable. Upload, binding, snapshot read and native materialization succeed with matching bytes and `0600` file permissions.

`bun scripts/workbench-attachments-browser-smoke.ts` uses the production workbench module, browser proxy, real internal HTTP API, restricted host operator credential, SQLite and task service. Only the AgentProvider is replaced by a recorder so final material bytes can be asserted without launching a real task. The final run passed with **2 tasks and 5 dispatches**: actual file chooser, image/text input, preview/download, a delayed upload during task switching, reload, attachment-only continuation, queued material with the original receipt run identity, and database reopen. Screenshots at 1280, 760 and 430 pixels were inspected.

Evidence directory: `/private/var/folders/yc/y9bc_lbd69z5_3_dqbt5bn6c0000gn/T/cc-attachments-browser-evidence-3nUh3I`. A copy of its result is retained in [the browser record](2026-09-13-cc-task-attachments-browser.json); the script reproduces fresh evidence. One best-effort discard was refused after a receipt had already claimed the attachment. The fixture accepts only that exact response and verifies the referenced ID is still task-owned with unchanged bytes; other HTTP errors fail.

Final affected verification: **48 Vitest files / 723 tests passed**, **4 Rust workbench-proxy tests passed**, full `bun run typecheck` and `git diff --check` passed. This is the affected set, not an all-repository test claim. The Vitest run emitted the existing missing `marked.bundle.mjs.map` warning; it did not fail tests.

### Review corrections

Independent review and the real desktop-to-service seam found issues that narrower passing tests did not cover:

1. Restart history reversed two attachments in the same message. Retained attachments now preserve the user's order.
2. An attachment-only handoff incorrectly described itself as providing text only. The preview now describes the pinned original inputs.
3. Attachment domain errors became generic server failures. Scope, changed version and size errors have explicit response codes.
4. The host operator credential lacked the three new attachment routes. The real browser fixture reproduced `route_not_allowed`; the API regression now uses the actual restricted operator token for upload/read/discard.
5. Revision UI offered editable attachment selection although revision must reuse the original packet.
6. Terminal continuation needed the same persistent retry identity as active input to avoid duplicate dispatch after a lost response/reload.
7. Overlapping submissions could prematurely release an attachment's in-flight protection.
8. The development proxy buffered an oversized upload before the daemon rejected it. Limits must apply at each transport boundary.
9. Bun 1.3.14 could return an empty HTTP 400 on the next request after rejecting a chunked upload, before that request reached the route. A separate minimal fixture reproduced the connection issue; a close header alone was insufficient. The daemon now explicitly ends that connection after the 413 response finishes. The focused regression passed eight consecutive runs before the final combined run.

All listed corrections are included in the final verification. Terminal retry coverage also preserves its original continuation identity when another window has advanced the task to a different run; a failed retry cannot silently become a new request. Initial imported-session resumption still uses its separate, single-use external-close confirmation flow.

## Reference decisions

- [Paseo's Claude adapter](https://github.com/getpaseo/paseo/blob/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/server/src/server/agent/providers/claude/agent.ts) and [ordinary-file formatter](https://github.com/getpaseo/paseo/blob/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/server/src/server/agent/prompt-attachments.ts) distinguish actual visual blocks from file references. CC retains that distinction.
- [Orca's mobile attachment state](https://github.com/stablyai/orca/blob/fe4237cd41e4d48793fd135640939ef8aa5418e0/mobile/src/session/mobile-native-chat-image-attachment.ts) separates uploaded identity from preview state. CC uses its typed native adapters instead of terminal paste.
- [Codex user-input protocol](https://github.com/openai/codex/blob/1715e55076737158ba61d43158ede504de6d4ce1/codex-rs/protocol/src/user_input.rs) was checked against the installed app-server schema. Installed protocol evidence, not a generic OpenAI-compatible API label, determines the input mapping.

## What this does not establish

No complete App replacement is claimed. Task model controls, plugin/OAuth setup, complete background-agent lifecycle, more execution providers and multi-host/phone material workflows remain separate gaps. Windows attachment storage is currently unsupported and fails explicitly; Linux has implementation paths but was not verified by this macOS run. Frozen CC artwork is unchanged.
