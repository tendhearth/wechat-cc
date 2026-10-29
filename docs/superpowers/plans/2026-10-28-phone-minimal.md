# 手机端极简接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Track completion below.

**Goal:** 将用户已批准的极简设计接入原生手机端全部现有页面，保留真实状态和操作边界。

**Architecture:** 基于现有 Expo / React Native 页面与状态钩子，集中统一视觉组件，再分页面调整层级。不换协议、路由或状态模型。独立分支并行工作，根执行者串行整合到本功能分支，最后统一验证；不合入或部署共享 dev。

**Tech Stack:** Expo 57、React Native、TypeScript、Vitest、现有本地 PNG 图标与 design-tokens。

**Spec:** `docs/superpowers/specs/2026-10-28-phone-minimal-design.md`

## Global Constraints

- 暖纸、深绿、手机衬线字体和正式 CC；真实连接决定 CC 明暗；保留减少动态效果。
- 所有字符串有 en / zh-Hans；图标动作至少 44pt，有本地化读屏标签。
- 保留原始命令首行、cwd、授权范围和确认结果；核对不重发；旧数据不是在线；“做完”不都代表成功。
- 每个实现者只写自己的独立 worktree。根执行者负责功能分支整合和验证；无共享 dev 部署／推送。
- 低风险纯排版不加镜像实现测试；状态与交互变化先加有意义的行为测试。

## Review Focus

- 未知／部分／断线时完成数字不可装成完整事实：Task 2 验证详情入口和真实范围。
- 允许某一步后仍可继续做，不能被画成任务完成：Task 3 复用并运行批准和事项测试。
- 未确认原文、核对与恢复不得混用聊天／事项草稿：Task 3、4 跑恢复与回执行为测试。
- 列表完成组包含失败、停止与本轮回复：Task 2 验证差异可读。
- 精简后入口和隐私披露仍可到达：Task 4 与最终全页面演示验收。

## Task 1: 共用视觉基础（根执行者）

Files: `apps/app/src/ui/{Icon,IconButton,TopBar,TabBar,Rows,Card,StatusPill}.tsx`、本地 icons 资产及相关测试。

Interfaces: `Icon` 增加 back/settings/monitor/plus/search/more/shield/book/mail/folder 等本地图标；`IconButton({name,label,onPress,testID?,disabled?,busy?})`；`TopBar` 保留旧参数并增加可选 `actions: ReactNode`；无 `onAvatar` 时不画设置入口。`LinkRow` 旧接口不变，可选 icon/detail。保持其他 API 兼容，子任务不改这些文件。

- [x] 对新的图标按钮标签、触控区及无多余设置按钮行为先写测试并观察失败。
- [x] 实现本地图标、边界、纯文字底栏、平面行与单层容器。
- [x] 跑对应 UI 测试、App typecheck，提交可供子任务复用的基础提交。

## Task 2: 此刻与一起做（根执行者）

Files: `apps/app/src/app/(tabs)/*`、必要 `ui` 小组件、`state/home-motion.test.ts`、`state/quiet-lists.test.ts` 及对应页面测试。

- [x] 先测试紧凑完成入口的真实数据范围、未知／部分数据、菜单导航与不同完成结果。
- [x] 按已批准的最简稿调整首页、直接分组列表、菜单、完成详情；保留动效与终端入口。
- [x] 跑此刻／列表／动效测试及 typecheck，提交。

## Task 3: 聊天、事项和授权（独立 worktree 实现者）

Files: `apps/app/src/app/{chat,chat-model,chat-search,compose}.tsx`、`matter/[id].tsx`、`approval/[id].tsx`、`terminal/[id].tsx`、专属 view/state 测试。可改 `ui/Artifacts.tsx`、`ui/ReplyExtras.tsx`，不可改 Task 1 共用文件或共享 i18n 表。

- [x] 在独立工作区检查现有测试，行为变化先加回归测试。
- [x] 图标化熟悉操作、精简重复提示、事项成果和请求优先，折叠执行信息；所有真实授权、草稿、回执和终端边界不变。
- [x] 如需新字符串写到独立 `i18n/minimal-conversation.ts`（同时 en / zh-Hans），根执行者整合共享表；不得写死可见文案。
- [x] 跑拥有的测试与 typecheck，提交并返回基线、提交号、结果。

## Task 4: 记忆、设置与次级页面（独立 worktree 实现者）

Files: 其余 `apps/app/src/app` 页面：memory/settings/connections/devices/jobs/activity/letters/sessions/inputs/share/welcome/pair/licences；专属测试。不可改 Task 1、2、3 文件或共享 i18n 表。

- [x] 检查当前语义，导航或折叠行为变化先补测试。
- [x] 事实先于推测，入口短标签，统一行、标题和低层级操作；保留导入出处、待办捞回、收回记忆、设备限制、删除确认与隐私全文。
- [x] 新字符串如必要写独立 `i18n/minimal-secondary.ts` 双语模块，交根执行者整合。
- [x] 跑专属测试与 typecheck，提交交付。

## Task 5: 整合与验收（根执行者）

- [x] 串行 cherry-pick 已完成页面提交，合并新文案模块；检查所有路由与入口、状态说明和测试。
- [x] 跑 App 全套测试，`bun run verify`、iOS/Android 静态导出及隔离演示 UI 验收。
- [x] 全分支独立评审，修复实质问题并验证，提交，更新本文完成记录并交付分支与限制。

## 分工基线

基线 `origin/dev` = `d3691340`，前轮轻动效已由 `6a5fc89a` 合入。根工作区 `phone-minimal-integration` / `codex/phone-minimal-ui`。用户已明确要求按确认稿接入；本计划直接执行，不重复请求视觉批准或执行方式选择。

## 完成记录

产品代码0808d5ff；App1221/1221、最终verify、iOS/Android导出、独立原生模拟器验收均通过。完整记录见 `docs/superpowers/reports/2026-10-28-phone-minimal-acceptance.md`。未合入／部署共享dev，保留功能分支供指定整合者复核。
