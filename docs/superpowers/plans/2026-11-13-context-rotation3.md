# 上下文轮换第三轮修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking。

**Goal:** 关闭复核的十项问题，保留红/绿证据，验证后追加提交，不推送。

**Architecture:** 共享轮换策略负责硬顶、夜间时效和强制恢复；provider 集中分类超长并报告真实窗口；canonical 消息负责接续。体检与非主人保持 dev 合同。

**Tech Stack:** TypeScript、Bun、Vitest、临时 SQLite、离线假 provider。

**Spec:** `docs/superpowers/specs/2026-11-13-context-rotation-design.md`，本轮用户要求优先。

## Global Constraints

- 唯一写入者在指定 context-rotation worktree；代理只读。先 rebase origin/dev。
- 不操作 daemon、live API、生产数据库、安装 App、UI 或 mini。
- 每条先红后绿；测试只增不减，无新增 skip；日志与报告不输出环境变量。
- verify 同命令检查 load < 8 且无 CivilizationVII，门禁最多等30分钟；绿后提交含 Co-Authored-By，不 push。

## Review Focus

- 超长重试只执行一次，绕过记账与8轮限制，同时保留原文。
- 未测首请求的旧 resume 不得将整段当固定开销。
- 夜间请求不可越过完成整理后的轮间窗口。
- 已退休 provider/alias 不告警，parallel/chatroom 在用段不 forget。
- 两条已落库入站排队时，第一条仍得到此前主动原文。

### Task 1: 预算、状态和轮换生命周期

- [x] 红测：32k/12k硬顶27200、无基线只用比例、窗口存取错误可见、夜间一次评估、死段清理。
- [x] 实现 context-rotation/checkup-store/wiring；超长恢复接口返回接续并清空旧段。
- [x] 定向测试绿。

### Task 2: provider窗口与超长恢复

- [x] 红测：真实SDK result的后缀和别名、集中错误分类、真实 coordinator 超长一次重试及重试失败。
- [ ] 实现窗口归一化/200k回退、实测上界持久化、solo重试。
- [x] 强化40轮跨预算和未知窗口断言，定向测试绿。

### Task 3: dev合同、主动原文与短会话

- [x] 红测：非主人冷启动、体检默认与显式模型优先、各provider定时动作、双入站主动原文真实接线。
- [x] 恢复dev行为，限制短会话到可回收provider；修复canonical边界。
- [x] 定向测试绿，同步设计稿与错误码表。

### Task 4: 验收交付

- [ ] 只读正确性复核，修复重要发现；运行主Mac门禁与bun run verify。
- [ ] 报告写用户指定scratchpad，绿后追加提交，附基线/红绿/验证/限制，不push。
