# CC Motion Native Validation and Daily Rollout

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Root is the sole integrator, installer and deployer. Helpers are read-only.

**Goal:** Complete available macOS native checks, integrate the motion candidate into current dev, and install the complete signed desktop app for the owner's daily trial.

**Architecture:** Start with authoritative remote dev `4c9c1308`; squash the reviewed motion branch `2d0751a9` into an owned candidate, preserving both sides of integration conflicts. Validate before advancing dev. The desktop frontend and Rust are embedded in the whole app, so sidecar-only deployment is insufficient. Preserve the entire previous signed app and use a serial maintenance boundary with full rollback.

**Tech Stack:** Tauri/Rust, JavaScript, Vitest, Playwright, macOS codesign/launchd, existing self ship and selftests.

**Spec:** `../specs/2026-10-29-cc-motion-expansion-design.md`; owner's 2026-10-29 instruction explicitly authorizes native validation, dev integration and daily installation.

## Global constraints

- Root alone writes the integration workspace and performs production actions. Other existing workspaces, including the existing dev checkout, remain read-only.
- Owned integration source store: a separate local Git clone; candidate worktree is `codex/cc-motion-rollout`, initially based on remote dev. Native worktree registration does not support this independent store, so use a recorded manual Git worktree fallback.
- Preserve frozen art, Light/Dark semantics, candidate art status, production bundle identifier, signing Team and existing app data.
- No master merge, release tag, public release, private design board, updater private key or credential disclosure.
- No forced OS sleep. Physical Windows/mixed-DPI checks require corresponding hardware; distinguish available Mac validation from unexecuted environments.
- Do not install while user tasks or another deployment are running. Inspect status and deployment locks without removing live locks.
- Keep a whole-app rollback. A sidecar `.prev` cannot restore an old embedded frontend or Rust executable.

## Review focus

- A fresh completion after quiet recovery must play; quiet-period completion must not replay.
- Use the actually applied quiet button and notified behavior, not merely computed preference state.
- Actual native dragging, zoom, reset and reopen must preserve reachable geometry and saved placement.
- Latest dev's daemon discovery/request registration must survive integration alongside asynchronous companion placement.
- Installed GUI and daemon must both originate from the validated commit; a daemon SHA alone does not prove the frontend was replaced.

## Tasks

- [x] Inspect current daily app, authoritative remote dev and repository deployment paths. Create an owned isolated integration workspace without modifying another checkout.
- [x] Resolve `.gitignore` by union and native module declarations by retaining both `daemon_info` and `companion_placement`; preserve automatic merge of the current daemon request API.
- [x] Install pinned dependencies in the owned workspace and run the integrated verification gates.
- [ ] Build an isolated native QA app from the integrated tree; verify quiet recovery/new completion, Light/Dark, current permission/error facts, native drag/placement/zoom/reset/reopen and relevant small sizes. Record actual observations and gaps.
- [x] Obtain an independent integration review; resolve concrete defects with regression evidence if discovered.
- [ ] Build the complete production app with the existing Developer ID identity and a local-only override disabling updater artifacts. Verify nested signatures, identifier, Team, entitlements, source SHA and app hashes.
- [ ] Advance the owned dev branch, push without force and wait for dev CI. Reconcile any remote movement before deploying.
- [ ] Confirm production idle/guard/locks; back up the complete existing app. Quit only its GUI, use controlled service stop, atomic whole-bundle replacement and service start, preserving app data and signing identity.
- [ ] Run the standard ship/selftest gate on the installed app, check fresh health and exact SHA, and restore the complete previous app if rollout fails.
- [ ] Open the installed daily GUI and verify actual new motion and controls. Deliver trial instructions, verified version and remaining hardware/owner checks.

## Pre-installation findings

- Integrated full verification passes, including the existing internal-mock guard. Companion controller tests now exercise the real controller and modules through native/browser boundaries.
- A real macOS drag exposed the Wry 0.54.4 file-reference pasteboard panic. Upgrade to Tauri 2.12.5 and locked Wry 0.57.1, containing the published upstream fix; disable file-drop handling on the companion window as well. Native replay remains an installation gate.
- The new runtime enforces local IPC origins. Native argument-validation tests now use their actual mock webview URL rather than a Windows-specific URL. All 78 native library tests pass, retaining the argument and decoder assertions.
- Real layout regressions reproduced the wrapped main-entry label and clipped open settings panel. Both are corrected; 26 browser checks pass, including open settings at 200/240px width and 250px height. Motion regressions ignore only the development reload transport, which source-generating checks can otherwise interrupt.
- Independent integration and follow-up reviews found no remaining actionable issues. The current dev daemon discovery/request registration and the motion placement module are both preserved.
- The isolated native app already demonstrated quiet-period completion suppression followed by one genuine new completion. Final replay on the upgraded runtime and the signed daily GUI remain separate checks.
