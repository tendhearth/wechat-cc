# CC 单任务完整入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 正式「一起做」采用两栏连续对话，Claude / Codex 的真实权限请求在本任务内处理，保留原生续接、停止和成果查看。

**Architecture:** 保留现有任务服务和严格权限策略。新增可选 SpawnContext.requestPermission，由任务当前运行实例持有请求；Claude 复用工具分类，Codex 工作台使用 app-server 协议，普通聊天仍用原适配器。

**Tech Stack:** Bun / TypeScript / SQLite / 原生 DOM 与 CSS / Vitest / Tauri。

**Spec:** docs/superpowers/specs/2026-09-12-cc-task-entry-scope.md 的第一段。本计划不将多项目并发、外部历史导入或交接样板算作已完成。

## Global Constraints

- “普通消息无需再让 CC 调一次模型改写。”
- “只完成界面不算 CLI 替代目标达成。”
- 复用当前隔离工作树，不改主仓库、冻结角色资产、普通聊天与微信权限队列，不推送合并。
- 不提高权限绕过审批，不让任务使用个人记忆或消息 MCP。
- 停止仅在执行者确认退出后完成，断连和未知状态不得伪装成功。

### Task 1: 连续工作对话与两栏界面

**Files:** apps/desktop/src/modules/workbench.js、workbench.test.ts、styles/workbench.css、cc-life.css；可拆 workbench-view.js / workbench-view.test.ts。

**Interfaces:** 现有 API 保持，Detail 增加可选 `permissions: Array<{id:string,taskId:string,tool:string,description:string,createdAt:number}>`。权限按钮 POST `/v1/workbench/permission` `{id,requestId,decision:'allow'|'deny'}`。

- [x] 先写并运行失败测试：所有 user/text 在主对话按序可读；工具详情默认收起；项目按完整目录分组；权限文本转义、按钮携带具体 requestId；过时详情/成果响应不会影响新选任务。
- [x] 实现主对话、紧凑状态、收起的成果区。执行中可保留补充草稿，明确本轮结束才发送，不伪装即时传达。新任务沿用上次执行者选择，未安装时清楚说明。
- [x] 轮询维持输入焦点、选区、按任务存储的草稿、展开状态和阅读位置。提交成功清除已发送文字，但保留发送途中新写内容；失败保留原稿。
- [x] 权限卡仅来自返回的 pending requests；批准/拒绝与成果确认分离。断连时禁止对陈旧权限卡操作。
- [x] 运行模块测试，保留并更新旧断言，浏览器验证 1440 / 900 / 414 宽度。

### Task 2: 任务权限生命周期与 Claude 适配

**Files:** src/core/agent-provider.ts、claude-agent-provider.ts、workbench/service.ts、workbench/permissions.ts、各自测试、internal-api/routes-workbench.ts、route-tiers.ts、workbench-proxy.ts、对应测试、src-tauri/src/lib.rs。

**Interfaces:** `SpawnContext.requestPermission?: (request:{tool:string,description:string},signal?:AbortSignal)=>Promise<boolean>`；可选最终 SpawnContext 参数传至 Claude sdkOptionsForProject。服务 `resolvePermission(id,requestId,decision)`；detail.permissions 输出上述只读结构。

- [x] 写失败测试：ownerless 请求、批准/拒绝、重复/跨任务/过期回复、取消/退出/abort/恢复后的旧请求失效；失败不得放行。
- [x] 独立 runtime map 用 UUID 标识请求，绑定具体 Active 实例，取消/finally/shutdown 清理 resolver/timer/listener；默认审批 5 分钟内过期拒绝，短于默认回合 10 分钟 watchdog。允许测试注入短 timeout。
- [x] 请求/处理结果保存 system 事件，待决请求不恢复；新一轮不得复用旧 callback。停止或断开时清空卡片并拒绝执行。
- [x] Claude task-only CanUseTool 使用 classifyToolUse / effectivePolicy trusted+solo+strict；allow/deny 不变，relay 走 requestPermission，MCP 仍全部拒绝。正常聊天不变。
- [x] 增加 admin-only 路由、校验合法 task/request/decision、过时请求 409；扩充桌面 dev/native 精确 allowlist。
- [x] 运行服务/路由/权限/Claude 定向测试。主代理负责最终 wire-workbench 连接，避免并行编辑冲突。

### Task 3: Codex 工作台原生审批会话

**Files:** 新 src/core/workbench/codex-app-server.ts / .test.ts，共用 Codex 配置 helper 及测试；主代理接 wire-workbench.ts 和 dev-cc-workbench.ts。

**Interfaces:** 实现 AgentProvider.spawn(project,context):Promise<AgentSession>，requestPermission 使用 Task 2 契约，init/text/tool_call/result/error 使用现有 AgentEvent。

- [x] 用可控子进程写失败测试覆盖 initialize、thread start/resume、turn completed/error、审批 request id 回复、拒绝、取消、意外进程退出、协议解析失败。
- [x] JSONL app-server 会话完成初始化后启动/恢复 thread；turn input 保留用户原文；只在已确认 completed 发 result，willRetry 错误不提前判终局。
- [x] commandExecution/fileChange 审批调用任务 callback；无 callback 或失败一律拒绝；不支持的服务器请求返回明确错误或安全拒绝，不能悬挂。
- [x] 显式 on-request / workspace-write / user reviewer；禁用 inherited bypass、apps、plugins、hooks 和所有发现的 MCP。项目级 MCP 只读取名称，失败则不启动；不泄露凭据、不写用户配置。
- [x] cancel 发 turn/interrupt，close 关闭并确认自己拥有的进程退出；pending RPC 和 approval 不遗留，守卫旧 turn 事件。
- [x] 本地协议测试通过后，分别真实启动、连续两轮、停止和审批；协议模拟证据与真实模型证据分开记录。

### Task 4: 集成与证据

**Files:** src/daemon/bootstrap/wire-workbench.ts、scripts/dev-cc-workbench.ts、上述 plan、独立验证记录。

- [x] 集成 Claude task callback 和 Codex app-server，只注册这两个实际可用执行者；dev 使用隔离状态，不连微信，不修改用户项目内容。
- [x] 一次全仓 typecheck、定向测试、独立代码审查；按审查修正后重跑相关测试。
- [x] 浏览器通过真实 API 验证新建/历史/完整对话/草稿/成果/权限。真实模型在专用临时文件夹验收，记录未触发或无法验证的能力。
- [x] 提交明确文件，打开正式开发页面供用户查看；不将第一段成功描述为整个三段目标完成。

## 完成记录

- 用户追加确认：工作时全局生活导航收进 CC 按钮，临时展开；离开工作页恢复完整导航。补齐返回任务/新任务草稿、同页点击不重建的回归。
- 实际证据与边界见 `../reports/2026-09-12-cc-task-loop-validation.md`。18 文件 249 项测试、全仓类型检查通过。
- 此计划仅完成产品范围的第一段。多任务并行与跨执行者交接仍待后续实现。
