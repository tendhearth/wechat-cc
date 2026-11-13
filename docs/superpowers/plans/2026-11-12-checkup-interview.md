# CC 面试体检实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 保留上一轮运行骨架，把题和评语换成版本化的日常故事。
**Architecture:** 纯函数生成同一故事各时间点的累积对话快照，隔离 provider 每次只接一个快照，避免后端自己的压缩改变试卷。动作由环回假 MCP 记录，七项品质独立计数；结果和补法由协议包统一呈现。
**Tech Stack:** TypeScript / Bun / Vitest / 现有 provider evaluation seam。
**Spec:** ../specs/2026-11-12-butler-checkup-interview-design.md

## Global Constraints

- 全离线，不读真实记忆、话题、对话；人设只投影称呼、自称、名字、固定口头习惯及受限口吻。
- 不出现对外「管家」；不调裁判模型；没有执行者不考派活。
- 失败和取消保留档案；后端不支持隔离须说明原因，不记弱。
- 只由本 agent 写此 worktree；子 agent 只读。用户已确认设计并授权完整实现，直接执行，不重复设计审批。
- 不连 mini、不跑 UI、不 push。verify 同命令先判 load <8 且无 CivilizationVII。

## Review Focus

- 人设混有真实记忆：仅严格独立字段通过，不将整段人设送出。
- 无执行者：删派活动作与口风评分，办事仍考回话和问一句。
- 某品质失败：只影响自己的分项，动作错误独立记办事。
- 日子先失败后恢复：可靠线不得跨过失败档。
- 不支持后端：保留上次完整档案，提供可读原因。

### Task 1: 故事、动作评分与评语

**Files:** src/domain/checkup-interview.ts, src/domain/checkup-persona.ts, packages/protocol/src/checkup.ts, packages/protocol/src/checkup-review.ts；对应新增测试。
**Interfaces:** buildInterviewPlan、scoreInterview、summarizeInterview；CheckupProfile.interview；checkupReview、CHECKUP_CARE。
- [x] 写同种子、骨架、逐项故障、人设边界、补法映射测试并观察红。
- [x] 实现故事 v1，短版一天/一周，完整版五档；每项至少两次；自然回话、问一句、派活假动作。
- [x] 定向测试绿。

### Task 2: 接运行器、服务与人设

**Files:** src/features/checkup/{runner,service,module}.ts；现有生命周期测试和真实形状沙盒。
**Interfaces:** 新 CheckupSample interview 分支，service 可注入 persona/executors，runner 只拿已投影的系统提示。
- [x] 增加隔离系统提示和动作测试，观察红。
- [x] 采用 buildSystemPrompt（buildInstructions 的纯组装器），接现有人设读取；保留旧题工具用于既有小探针。
- [x] 保留全部失败、取消、端点和档案测试，改假模型以答新卷；定向绿。

### Task 3: 三端、夹具、验证和交付

**Files:** CLI、desktop butler-status、App ButlerStatus/view/i18n、离线夹具、维护文档。
**Interfaces:** 三端共用 checkupReview，标题为名字+当前模型；兼容已有旧档案。
- [x] 增加统一评语与后端不支持测试，观察红；同步三个端及夹具。
- [x] 只读独立评审，只修正确性问题。
交付门：满足负载门后 bun run verify 全绿；记录无新增 skip；提交含 Co-Authored-By；指定路径报告。结果另记交付报告。
