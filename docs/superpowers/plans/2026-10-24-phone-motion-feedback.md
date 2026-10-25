# Phone Motion and Quiet Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入用户批准的 CC 轻动作和图标反馈，收敛手机原生端重复状态说明。
**Architecture:** 共享 UI 基础负责图标、可访问说明、生命周期和短动效；既有控制器继续负责请求、草稿、回执、录音及权限。聊天核对仅刷新读取，不新增协议。
**Tech Stack:** Expo 57 / React Native 0.86 / Animated / bundled transparent PNG icons / Vitest.
**Spec:** `docs/superpowers/specs/2026-10-24-phone-motion-feedback-design.md`

## Global Constraints

- CC 只用现有 canonical 两张原图，不改角色、几何和 PNG 字节。
- 系统减少动态效果、App 后台、页面失焦时停止动作；事件以稳定身份去重，历史回填不重播。
- 核对只读取 `GET /m/api/chat`；读失败或没有新证据继续不确定，不自动重发或清草稿。
- 录音小点静止；转写只进草稿；达到时限后原来的松手不能变成发送。
- 不确定与失败分开；保留原始命令、工作目录、撤销修复、陈旧/部分结果提示和已有提交锁。
- 所有用户文案进 en/zh-Hans 表；颜色/字体沿用 tokens；无新的原生或动画依赖。
- 每个写入者独立 worktree；根代理串行整合到自己的开发分支，不改共享 dev。

## Review Focus

- 只读刷新失败仍正常 resolve，不得显示成功。
- 新草稿/配对世代与迟到响应相遇时，不清新稿、不复活旧身份。
- 字体加载、首次历史、页面恢复、轮询同一事件不触发重复入场。
- 录音准备/转写/取消/时限分别保持现有语义，图标不能丢失恢复入口。
- 旧列表/部分结果/已撤销不能因删文案而看成实时或可再次提交。

### Task 1: Native UI foundations and CC motion

**Owner/workspace:** delegated implementer, dedicated `mobile-motion-primitives` worktree, branch from dev `8a1b9f33`.
**Files:** create `apps/app/src/ui/Icon.tsx`, `motion.tsx`, `StatusHint.tsx`, bundled assets and tests; modify `CCFigure.tsx`.
**Interfaces produced:**
- `IconName = 'arrowUp' | 'mic' | 'stop' | 'close' | 'help' | 'check' | 'chevronDown' | 'chevronRight' | 'refresh' | 'info' | 'alert' | 'clock' | 'pause'`.
- `Icon({ name, size?: number, color?: string, testID?: string })` decorative image.
- `BusyIndicator({ label: string, size?: number, color?: string, testID?: string })` accessible spinner, static when motion disabled.
- `useMotionEnabled(): boolean` respects reduced motion, foreground and route focus; handles unavailable accessibility read conservatively.
- `MotionView({ children, eventKey?: string | number, kind?: 'enter' | 'status', style?, testID? })`: undefined key is static; new explicit key enters 180/120ms, at most 2px.
- `StatusHint({ label: string, description: string, icon?: IconName, shortLabel?: string, testID?: string, children? })`: 44pt icon or compact label entry opens accessible native modal with description and optional explicit recovery controls; does not perform writes by itself.
- `CCFigure` preserves old props and adds `behavior?: 'idle' | 'receive' | 'done' | 'wait'`, `eventKey?: string | number`.
- Foundation agent does not modify locale files or pages; root owns localized close label injection if needed (use existing common.close).

- [ ] Write meaningful failing component/lifecycle tests; watch RED.
- [ ] Implement interfaces, official Lucide icon PNG export with license, and lifecycle-safe CC timelines.
- [ ] Test reduced/background/blur, stable event IDs, dark static, reconnect, native asset resolution; run App tests/typecheck.
- [ ] Commit and return exact commits plus results; no shared deployment/push.

### Task 2: Chat, voice and safe status refresh

**Owner/workspace:** root, `mobile-motion-feedback`, branch `codex/mobile-motion-feedback`.
**Files:** `state/useChat.ts`, related tests, `app/chat.tsx`, `ui/HoldToTalk.tsx`, `i18n/{en,zh-Hans}.ts`, `app/(tabs)/index.tsx`, approval page.
**Consumes:** Task 1 interfaces.
**Produces:** `useChat` adds `refresh(): Promise<void>`, `loading: boolean`, retaining error data; only GET via existing query.

- [ ] Test query-only refresh (zero chatSay), unresolved/read failure, draft preservation, voice cancellation/time-limit and event dedup before behavior changes.
- [ ] Convert chat state sentences into message/input status entries, separate refresh and explicit retry, preserve existing requestId logic.
- [ ] Replace SendTalkButton text faces with accessible icons and existing controller behavior; retain actionable permission/configuration problems.
- [ ] Wire canonical CC event keys and one-shot home/approval motion to real signals; baseline first snapshots.
- [ ] Run targeted component/state tests and App suite; commit.

### Task 3: Remaining status and expansion consistency

**Owner:** root or a dedicated separate-worktree implementer, never concurrent writes to Task 1/2 files.
**Files:** `ui/ConnectionNotice.tsx`, `ui/Sheet.tsx`, `ui/CompanionCard.tsx`, `ui/InputReceipts.tsx`, list loading screens and selected information-only placeholders in progress page.
**Consumes:** Task 1 interfaces; root centrally owns locale changes and resolves added copy requests.

- [ ] Test stale/revoked visibility, expand/seen invariants and status detail accessibility before functional changes.
- [ ] Keep necessary phase, permission, stale/partial/blocked labels; fold only redundant explanations into StatusHint.
- [ ] Use shared BusyIndicator for loading; do not turn load failure into empty success.
- [ ] Run relevant tests and App suite; commit.

### Task 4: Integration, review and handoff

- [ ] Integrate dedicated commits serially into root's isolated branch, resolve by reviewing actual diffs.
- [ ] Run App tests, full `bun run test`, `npm run test:node`, `bun run typecheck`, `bun run depcheck`, and `apps/app` export:check; record all failures by name.
- [ ] Fresh whole-branch review; fix material findings with failing regression then green tests.
- [ ] Review native/simulator availability without touching shared installed phone pairing; report exact validation boundary and commit/branch.
- [ ] Update maintainer-facing App README/design references; deliver a reviewable branch/PR without shared dev deploy/push.
