# CC embedded WebKit UI verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run application-internal Tauri tests on the dedicated Mac mini, repair companion dragging from reproducible evidence, then integrate and deploy only the verified app.

**Architecture:** Extend the existing owned feature workspace and isolated QA bundle. An explicit debug-only Cargo feature registers the published embedded WebDriver plugin on loopback; the existing SSH executor launches only the QA identity with empty state, no application arguments and a sanitized environment. A small Node HTTP client drives WebKit and records independent native window geometry. Default/release builds omit the driver.

**Tech Stack:** Tauri 2.12.5, `tauri-plugin-wdio-webdriver =1.5.1`, Node 26, existing Bun/Vitest/Playwright and Rust tests, macOS26.6.2 on `homes-mac-mini`.

**Spec:** Owner's 2026-10-30 instruction in this chat approving application-internal testing first, dragging verified before dev integration/daily deployment; previous environment plan `2026-10-30-macmini-offline-ui-and-drag.md` supplies machine boundaries.

## Global Constraints

- No primary Mac GUI automation, screenshots, focus changes, test windows, heavy builds or tests. Only lightweight source editing/SSH/transfer and eventual protected signing/deployment there.
- All runtime/build/test work on `homes-mac-mini`, inside `/Users/home/cc-ui-lab/cc-motion-drag-20261030`.
- No real CC daemon, model/WeChat accounts, credentials, databases, production plugins or signing keys on mini. Public dependency preparation may download tools; actual tests use existing outbound-deny/loopback-only process profile.
- No system-authentication bypass or security setting changes. Existing Appium path remains blocked and unused.
- Embedded server only in explicit QA debug builds, QA identifier and dedicated mini checked before registration; loopback port fixed4199. No server in default/release builds.
- Root is sole writer/integrator in owned `codex/cc-macmini-ui-drag-fix` workspace. Other workspaces read-only until assigned serial integration.
- W3C actions are synthetic DOM pointer/mouse events, not hardware input. Report that distinction. Acceptance checks actual NSWindow movement/size/persistence, never animation or resolved IPC alone.
- No new daily installation before drag regression, integration verification, review and full-app rollback preparation.

## Review Focus

- A normal/release application must not expose a test server or acquire test permissions.
- Locked mini may render/process differently; prove real WebKit and native commands run rather than assuming readiness.
- Mouse-up/blur/cancel during pending IPC cannot leave stale moves or animate a permanent drag.
- Coordinates across scaling/monitors must use one documented unit system; a successful call is not settled geometry.
- Synthetic input does not exercise trusted OS drag capture; test the application contract and label physical-input coverage honestly.

### Task 1: QA-only embedded driver and mini smoke

**Files:** `apps/desktop/src-tauri/Cargo.toml`, `Cargo.lock`, `src/lib.rs`, new QA gate module/tests, `apps/desktop/scripts/macmini-ui-protocol.mjs`, its tests, `macmini-ui-remote.mjs`, new `macmini-embedded-ui.mjs`.

**Interfaces:** bounded SSH command `embedded`; QA feature `qa-webdriver`; loopback `127.0.0.1:4199`; W3C `browserName=tauri`, `wdio:tauriServiceOptions.windowLabel=main`; artifact report includes source/build identity, isolated state, screenshots and native frame readings.

- [x] Write gate/transport tests rejecting primary identity, production app, non-debug mode and wrong endpoints; run RED on mini.
- [x] Add optional pinned plugin, register only through explicit QA/mini gate, reject daemon/CLI execution in that QA mode. Keep production config unchanged.
- [x] Prepare dependencies on mini; build debug QA offline and run on mini under loopback-only profile with per-run empty state.
- [x] Verify real main WebKit content, button events, open/resize/reopen companion, native window rect and owned-webview screenshot. Record any locked-session limitations.
- [x] Run relevant guards/Rust tests and commit the independently working harness.

### Task 2: Drag diagnosis, repair and regression

**Files:** existing companion gesture/placement sources and tests as evidence dictates; same embedded mini runner.

**Interfaces:** preserve ordinary click/double-click/control behavior; movement measured in native frame points, persistence read after settled position; no dependence on a different app's mouse event.

- [ ] Record baseline stage mouse sequence, native frame and current drag-command outcome; reproduce reported no-move behavior with the application test.
- [ ] Select smallest repair after tracing the failing boundary. Add failing behavioral tests before implementation.
- [ ] Verify multiple displacement samples, unchanged dimensions, release/blur/cancel, pending-command ordering, no movement from click/double-click, reachable controls and close/reopen position.
- [ ] Run affected browser/native checks on mini and get independent correctness review. Record the limits of synthetic versus hardware input.

### Task 3: Integration and protected daily deployment

**Files:** owned dev integration workspace and existing deployment/rollback ledger only after previous gates.

- [ ] Integrate verified commits serially; validate merged source on mini. Resolve known full-suite process-inspection limitations without silently skipping failures or weakening offline tests.
- [ ] Build full application on mini without signing keys, transfer for protected primary signing, await dev CI.
- [ ] Preserve complete old signed app, deploy whole new app with rollback and production selftests. No graphical acceptance on primary.
