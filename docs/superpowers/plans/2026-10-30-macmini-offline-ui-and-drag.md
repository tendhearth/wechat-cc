# Mac mini offline UI lab and native drag repair

User authorizes preparing the Mac mini for offline UI tests and remote control, then repairing and verifying native dragging before installing daily CC. The primary Mac's mouse, focus and desktop must not be used for automated tests. Root integrates and deploys serially.

## Boundaries

- Primary Mac: source editing and coordination; protected production daemon and final deployment only. No local graphical automation or heavyweight test/build work.
- Dedicated Mac mini (`homes-mac-mini`): test snapshots, isolated native QA application, headless web tests and native UI runner. No production CC daemon, models, WeChat login, credentials, private databases or production plugin directories.
- Native automation uses Appium Mac2/XCTest on the mini. Its servers bind loopback only; commands use existing authenticated SSH. No relaxed security, AppleScript execution feature, public listener or protection bypass.
- The existing local computer-use tool remains unused: SSH does not rebind its desktop target. OS permission prompts on the mini require the owner's action if encountered.
- Transfer a tracked source snapshot, not repository history, private ignored files or account configuration. Use dedicated paths and empty daemon/workbench state.
- Preserve the complete old signed daily app. The previous candidate is already on dev but must not be installed after the owner's reported drag failure. Resume deployment only after real native geometry proves the repair.

## Tasks

- [x] Create an owned feature worktree from current dev `a4b8b254`.
- [x] Prepare mini-only Node/Appium Mac2 runtime, native compiler and isolated source snapshot; record exact versions and receipts.
- [ ] Establish mini-only UI sessions and prove clicks, screenshots and input occur on the mini. Confirm loopback binding and no production CC process/account traffic.
- [ ] Reproduce dragging with native input and independently observed native window geometry; distinguish driver input failures from application failures.
- [ ] Implement the smallest evidence-supported repair. Verify actual displacement, unchanged size, release/click/double-click behavior, reachable controls and placement persistence.
- [x] Add a reusable remote UI runner and document the primary-Mac exclusion in root AGENTS.md. Keep meaningful regressions and offline boundaries under test.
- [ ] Run affected/native/browser/full integration checks on the mini, obtain independent review, and merge/push the verified repair through the owned integration workspace.
- [ ] Build the complete new signed app, await dev CI, install with whole-app rollback, run protected production selftests and verify exact deployed provenance. Do not use the primary desktop for graphical acceptance.

## Diagnostic hypotheses

The existing JavaScript drag transition and resolved IPC do not prove native movement. Tao obtains `NSApp.currentEvent` after WebKit IPC; nil is a successful no-op and the current event need not be the original mouse-down. Its numeric special case is raw `0x15` (21), not the public ApplicationDefined constant (15). An async-only trial did not establish a fix and was reverted.

Remote RED/GREEN must observe native mouse input and target-window frame changes. A native local-event monitor scoped to the test window can establish original event provenance. Apple's documented mouseDown/mouseDragged/mouseUp window tracking is a candidate only if observations establish the need; do not replace the native drag API speculatively.

## Current checkpoint

See [the lab runbook](../../maintainer/macmini-ui-lab.md). The mini's QA bundle builds offline; protocol6/6, native Rust79/79 and headless browser26/26 have passed. SSH status confirms the correct machine, loopback Appium3.9.0 and a locked console. The actual WDA session is blocked by Enable UI Automation authentication. The owner will not remote desktop or physically confirm now; do not keep asking or bypass the system prompt. Locked `native-smoke` exits2 before any input. No real native drag reproduction/fix/acceptance or daily deployment is complete.
