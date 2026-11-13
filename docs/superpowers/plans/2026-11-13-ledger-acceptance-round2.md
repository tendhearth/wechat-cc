# 记录本接力第二轮修复计划

> **For agentic workers:** 使用 superpowers:executing-plans，逐项红/绿；本工作区只由主执行者写入。

**Goal:** 修正接力误路由、额度确认优先级与对话审批的取消、展示、限流和来源边界。

**Architecture:** 指称解析保持纯函数，由入站接线注入真实登记的执行者名字和网关别名。审批展示与每轮状态放在共享层，三家适配器消费同一份规则。

**Tech Stack:** TypeScript、Vitest、Bun。

**Spec:** 用户 2026-11-13 第二轮复核任务；[记录本设计](../specs/2026-11-12-one-matter-many-agents-design.md)。

## 全局约束

- 只写 wt-ledger-fix / ledger-acceptance-fixes；先 rebase origin/dev，追加提交、不 push。
- 不碰真机 daemon、live API、生产库、全局配置、已安装 App；不输出环境变量。
- 每条先红后绿；负载小于 12 才 verify；不在主机跑重型构建或 UI 测试。

## 复核重点

- 已登记别名与未登记同名词必须分开，执行者名不能命中长词内部。
- 否定、修饰名词和跨分句的动词/名字不能构成接力。
- 显式 8 位 ID 的停止、文件、补充命令不能丢失。
- 停止中的迟到批准不能执行工具，也不能污染下一轮历史。
- 持久会话从主人入站轮切到后台轮时不能继承出卡权限或限流状态。

## 执行任务

### Task 1: P1-1 接力判定

文件：task-reference.ts、task-command.ts、mode-commands.ts、pipeline-deps.ts 及其测试。

- [ ] 将全部复核句子及上一轮三句原话写成表驱动用例，逐条断言解析和真实入站走向。
- [ ] 运行相关测试，确认误伤/漏判为红。
- [ ] 注入真实 registry 名字/显示名/别名，限定同分句近邻语式、词界、否定与名词修饰。
- [ ] 同一命令/指称测试全部绿；提交。

### Task 2: P1-2 offer 优先

文件：mw-task-reference.ts 及测试。

- [ ] 测试「交给 Claude」「是」「好,交给 Claude」确认已有 offer。
- [ ] 观察红，再将 offer 检查前移、确认限定为 offer 的执行者。
- [ ] 测试绿；提交。

### Task 3: P2-1 停止与历史

文件：openai-gate.ts、openai-session.ts、审批接线及测试。

- [ ] pending askUser 不回时取消，断言立即拒、卡失效、下一轮历史成对。
- [ ] 观察红，接入 abort race 和卡撤销；测试绿；提交。

### Task 4: P2-2 卡文本

文件：共享审批渲染、Claude/OpenAI gate 及测试。

- [ ] 大参数和敏感字段卡内容测试先红。
- [ ] 复用 Claude 同一个有界/打码渲染函数；测试绿；提交。

### Task 5: P2-3 每轮限流

文件：共享审批层、三家适配器及测试。

- [ ] 三家测试：拒后重复不出卡、默认第 4 张不出卡、下一轮重置。
- [ ] 观察红，实现共享每轮预算与拒绝记忆；测试绿；提交。

### Task 6: P2-4 后台来源

文件：SpawnContext、会话/协调器来源接线、OpenAI adapter 及测试。

- [ ] 后台 admin 请求审批测试先红；核实主动消息、简报、定时动作、delegate 各调用链。
- [ ] 仅主人入站轮允许出卡；后台维持 deny；测试绿；提交。

### 收尾

- [ ] 负载检查后 bun run verify，记录实际结果与限制。
- [ ] 独立只读复核权限改动，必要修复仍先红后绿。
- [ ] 用户指定报告追加「第二轮」，提交所有修复，保持不 push。
