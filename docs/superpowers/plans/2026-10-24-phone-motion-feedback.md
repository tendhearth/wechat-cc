# Phone Motion and Quiet Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

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
- Foundation agent does not modify locale files or pages; root owns localized close label injection if needed (use existing artifacts.close).

- [x] Write meaningful failing component/lifecycle tests; watch RED.
- [x] Implement interfaces, official Lucide icon PNG export with license, and lifecycle-safe CC timelines.
- [x] Test reduced/background/blur, stable event IDs, dark static, reconnect, native asset resolution; run App tests/typecheck.
- [x] Commit and return exact commits plus results; no shared deployment/push.

### Task 2: Chat, voice and safe status refresh

**Owner/workspace:** root, `mobile-motion-feedback`, branch `codex/mobile-motion-feedback`.
**Files:** `state/useChat.ts`, related tests, `app/chat.tsx`, `ui/HoldToTalk.tsx`, `i18n/{en,zh-Hans}.ts`, `app/(tabs)/index.tsx`, approval page.
**Consumes:** Task 1 interfaces.
**Produces:** `useChat` adds `refresh(): Promise<void>`, `loading: boolean`, retaining error data; only GET via existing query.

- [x] Test query-only refresh (zero chatSay), unresolved/read failure, draft preservation, voice cancellation/time-limit and event dedup before behavior changes.
- [x] Convert chat state sentences into message/input status entries, separate refresh and explicit retry, preserve existing requestId logic.
- [x] Replace SendTalkButton text faces with accessible icons and existing controller behavior; retain actionable permission/configuration problems.
- [x] Wire canonical CC event keys and one-shot home/approval motion to real signals; baseline first snapshots.
- [x] Run targeted component/state tests and App suite; commit.

### Task 3: Remaining status and expansion consistency

**Owner:** root or a dedicated separate-worktree implementer, never concurrent writes to Task 1/2 files.
**Files:** `ui/ConnectionNotice.tsx`, `ui/Sheet.tsx`, `ui/CompanionCard.tsx`, `ui/InputReceipts.tsx`, list loading screens and selected information-only placeholders in progress page.
**Consumes:** Task 1 interfaces; root centrally owns locale changes and resolves added copy requests.

- [x] Test stale/revoked visibility, expand/seen invariants and status detail accessibility before functional changes.
- [x] Keep necessary phase, permission, stale/partial/blocked labels; fold only redundant explanations into StatusHint.
- [x] Use shared BusyIndicator for loading; do not turn load failure into empty success.
- [x] Run relevant tests and App suite; commit.

### Task 4: Integration, review and handoff

- [x] Integrate dedicated commits serially into root's isolated branch, resolve by reviewing actual diffs.
- [x] Run App tests, full `bun run test`, `npm run test:node`, `bun run typecheck`, `bun run depcheck`, and `apps/app` export:check; record all failures by name.
- [x] Fresh whole-branch review; fix material findings with failing regression then green tests.
- [x] Review native/simulator availability without touching shared installed phone pairing; report exact validation boundary and commit/branch.
- [x] Update maintainer-facing App README/design references; deliver a reviewable branch/PR without shared dev deploy/push.


## 验证记录与交付

原生实现验收头：`b25d34c1`，基于本地 `dev` 的 `8a1b9f33`；独立分支 `codex/mobile-motion-feedback`。收尾文档提交不改运行代码。没有合入共享 dev、部署 daemon 或发布手机包。

| 验证 | 最终结果 |
| --- | --- |
| App 全套（2 workers，test 20s / hook 40s） | 105 文件、1,192 测试通过 |
| `bun run test -- --maxWorkers=6` | 1,001 文件、13,267 测试通过；既有 2 文件 / 14 测试跳过 |
| `npm run test:node -- --maxWorkers=4` | 843 文件、11,294 测试通过；既有 4 文件 / 17 测试跳过 |
| `bun run typecheck` | 根目录、mobile、relay、app 均通过 |
| `bun run depcheck` | 0 错误；18 条既有警告 |
| App `export:check` | iOS / Android 均通过，包含全部本地图标与许可 |
| 独立全分支审查 | 发现的首页订阅、消息身份、录音播报和发现卡收起问题均修复并复核；无剩余问题 |
| 原始资产 / 依赖 | 两张 CC PNG、依赖声明和 lockfile 与基线一致 |

最初并行检查中，`image-upload`、`artifact-download` 与 `service-rewind` 有失败，已停止该轮，之后完整复跑通过。Node 首轮 `guard/bx` 的真实临时子进程状态断言失败，独立 20 项复测及降低并行度后的完整 Node 套件均通过；没有修改这些无关测试或生产逻辑。

新建隔离 iPhone 17 Pro / iOS 27 模拟器，只安装现有 Debug 壳，不复制其他模拟器的数据或配对。聊天发送图标、回复位置加载与回复后移除、权限原始操作、展开 / 收起、允许后返回进展的演示流程通过。已关闭本次模拟器与独立预览服务。

演示模式的 CC 按规则保持 Dark；真实在线动作由组件生命周期与真实首页订阅回归覆盖，未据此宣称真连接或物理 iPhone 手感已验收。复用的旧 Debug 壳缺少麦克风权限说明，本次没有实际采集录音；当前原生包录音及 Android 运行仍需设备复验。
