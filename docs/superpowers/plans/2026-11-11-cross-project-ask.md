# Cross-project ask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 主人可只读查询按窗口分组的真实项目记录。
**Architecture:** 纯聚合函数统一时间、排序和上限；memory reader取SQL白名单与#890当前投影；MCP和eval复用它。
**Tech Stack:** TypeScript、SQLite、Zod、Vitest/Bun。
**Spec:** docs/superpowers/specs/2026-11-11-cross-project-ask-design.md

## Global Constraints

只改指定worktree；不碰live/模型/daemon/UI。窗口[since,until)，ISO带时区；12项目、各3历史/3条目/3当前、12000字符。private/远端/子agent/临时与归属歧义排除；owner admin；不写seen/bubble。

## Review Focus

历史轮次后来换仓库不可倒灌；旧等待与历史窗分开；私密与其他owner完全不可见；缺记录不编造；上限截断不误导为完整结果。各项由Task1/2测试覆盖。

### Task 1: 纯聚合与安全reader

- [x] 写domain/projects-activity.test.ts与features/memory/projects-activity.test.ts：精确窗口、排序/上限、done归档、换cwd、不读正文、owner与只读；运行见红。
- [x] 实现domain/projects-activity.ts（参数/证据schema与summarizeProjectsActivity）及memory/projects-activity.ts（readProjectsActivity）。当前复用projectActivities；历史按轮cwd+白名单元数据；条目只line。
- [x] 原命令测试全绿。

### Task 2: 接线、提示、eval与守卫

- [x] 增MCP、路由权限、prompt断言及5个fixture eval用例；运行见红。
- [x] 新memory/projects-activity-routes.ts与注册/main分类、协议路由登记；topicSearchSection加使用/回答指引。扩展现有eval格式以确定性执行fixture，保持正常eval报告/diff。
- [x] 扩展scripts/topic-activity-metadata.guard.test.ts；运行针对性测试全绿。
- [x] 新鲜只读agent全分支审查，仅报正确性。处理问题并补红/绿。
- [ ] 同一命令load/游戏门后bun run verify；写完整报告；git diff检查后提交，尾Co-Authored-By，不push。

执行由根agent串行写文件；子agent仅只读调查/审查，遵守同worktree单写者。用户已明确执行与收尾，不再另设审批门。
