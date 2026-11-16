# 这句该谁答 PR 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 结构不明时有限兜底；歧义绑定原句；纠正不重复投递。
**Architecture:** 沿 PR 2 共用 route + consume 接入内存中的十分钟原句/候选与投递回执。便宜判断复用生产 turnJudge/cheapEval；原句只有一次提交机会，协调器开跑时核回执。
**Tech Stack:** TypeScript、Vitest。
**Spec:** `docs/superpowers/specs/2026-11-16-who-answers-design.md` 第 2 节及 PR 3；本次用户指令细化纠正为单次。

## Global Constraints

只改指定 worktree；不 push、不建 PR；不跑 UI、真 daemon、live API；不读生产库；不输出环境变量或主人原文。测试只增不减。模型候选仅注册且可用的 provider；非法、超时、不确定回 CC。持久切换与已有控制仍优先。

## Review Focus

- 候选移除或不可用后不能投给另一家。
- 重复选择和跨入口选择不能重放原句。
- 排队期间纠正只改尚未提交的目标。
- 已提交但尚无回复时保守阻止重放，并明确送达状态。
- 否定、引用和仅讨论模型不能付出模型调用或误投。

### Task 1: 有限便宜模型与共用路由

**Files:** `src/daemon/inbound/answer-target.ts`、新 `answer-fallback.ts` 及测试、`mw-route.ts`、`src/daemon/wiring/pipeline-deps.ts`。
**Interfaces:** `AnswerJudge({text, candidates}) -> Promise<string|null>`；候选为 `AnswerProvider[]`。
- [x] 先增测试：语义前置筛、一次调用、受限编号、非法/超时回 CC、两入口同判；运行应红。
- [x] 实现严格编号解析与 2500ms 上限，生产按调用取得 turnJudge；结构已有结果不调。
- [x] 定向 Vitest 应绿。

### Task 2: 歧义、纠正与回执

**Files:** 新 `answer-routing.ts` 及测试、`build.ts`、`mw-task-reference.ts`、`src/domain/answer-target.ts`、`prompt-format.ts`、`src/app/coordinator/index.ts`、`solo.ts`。
**Interfaces:** 路由内存回执含原 requestId、目标、pending/submitted/sent/cancelled；协调器读取实时目标并声明提交，真正交给执行者前记 sent。
- [x] 先增测试：两个候选问一句、名字/编号/你来、十分钟到期与答非所问、原句附件仅一次；退出事项焦点、已送出不重放、排队纠正只改单句；运行应红。
- [x] 共用 route 状态与 consume 通知；给 task-reference 增加 clearFocus；协调器在开跑时核回执。
- [x] 定向 Vitest 应绿。

### Task 3: 验证和交付

- [x] 运行根 typecheck、depcheck、相关 Vitest 与全部可运行守卫；沙盒 listen/UI/重型检查按本次限制记未验。
- [x] 独立只读评审正确性并处理重要问题，记录红绿。
- [x] 中文提交，附指定 Co-Authored-By；短报告写用户指定 scratchpad，包含基线、提交、已验与未验。

## 执行记录

基线 `75f4543d0`。独立只读评审发现的候选误代换、讨论模型误判、事项提醒/探针等待时纠正竞态与 App 历史身份冲突均有红绿回归。送达只认执行者事件；工作台缺接收确认时保守记已提交。562 项相关测试与 697 项守卫通过（守卫另 2 项既有跳过）；根 typecheck 通过，depcheck 0 错误/16 既有警告。按用户限制未跑 UI、真实模型、需 listen 的真实形状沙盒与全量 verify。保留本分支，仅本地提交。
