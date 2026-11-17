# 上下文轮换第二轮实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在容量压力前保留主人聊天连贯性，未知时不换、记账追赶不挡回复。

**Architecture:** 共享策略只读最后请求占用；预算由窗口、首请求固定开销和历史下限共同决定。provider 报请求级观测，窗口按实际目标持久化；接续统一读取 canonical 对话及工具记录。

**Tech Stack:** TypeScript / Bun / Vitest，离线临时数据库和假 provider。

**Spec:** `docs/superpowers/specs/2026-11-13-context-rotation-design.md`，参数以本轮用户要求为准。

## Global Constraints

- 只在指定 worktree 写；代理只读核查；不启动 daemon、不调用真实模型、不碰生产数据及 UI。
- 最近最多 6 轮 / 12000 字符；默认未知窗口 32k、比例 .6、实测夹在 [.2,.8]；历史下限 max(24k,window*.15)。
- 按量轮换至少隔 8 轮；未知占用不按量换；夜间占用低于预算一半不换。
- 每条修复增加主人连贯性正向测试；不减少测试、不新增 skip。

## Review Focus

- 多工具请求不得将计费累计当上下文占用；大系统提示不单独触发轮换。
- 重启/idle 后原生 resume 不再插重复接续。
- 主动消息原文保留，访客/群短会话行为保持原合同。
- 追赶失败不得拖回复，持续失败通过现有健康通道单次提示。
- transcript 只回收不再续接且过期的旧段，当前段保持。

### Task 1: 预算与请求占用

- [x] 先写离线红测试：未知、比例 0、固定开销、8轮节流、40轮工具聊天、窗口重启持久化。
- [x] 修改 context-rotation、session-manager、Claude/OpenAI 观测、checkup store/bootstrap 的预算接口。
- [x] 跑定向测试验证绿并保留红日志。

### Task 2: 接续与异步记账

- [x] 红测试固定6轮/12000字符、长消息头尾、主动原文/附件/工具摘要、回复先于假抽取完成。
- [x] 修改 continuation / wire / solo；记账没齐仅登记待追赶，交付后异步执行；状态记录次数与原因。
- [x] 验证绿及来源授权 work/workAllowed 一致。

### Task 3: 短会话与保留期

- [x] 红测试主人短会话接续、访客不改、列表隐藏内部 alias、8天旧段清扫、resume 不重复。
- [x] 修改 tick-dispatch、transcript 保留清扫与会话列表边界。
- [x] 跑定向回归；更新设计稿。

### Task 4: 验收与提交

- [x] 独立只读正确性评审并处理重要发现。
- [x] 同一命令 load<8 且无 CivilizationVII 后运行 bun run verify；最多等待30分钟。
- [x] 写指定报告，绿后带 Co-Authored-By 追加提交；不 push。
