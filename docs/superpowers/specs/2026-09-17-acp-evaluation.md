# ACP 能不能当工作台执行者的接缝 —— 评估备忘

日期:2026-09-17。状态:调研,未定案。问题:是否用 Agent Client Protocol(ACP)取代工作台今天各自维护的 per-provider runtime。

**一句话**:不换 Claude / Codex;把 ACP 当**新执行者的接线方式**,先拿 cursor 开刀,因为 `cursor-agent acp` 能把它从「免审」升成真有权限卡的一等执行者,且零额外安装。agy 等 Google 把 ACP 收进 CLI 再说。详见 §6。

## 1. 我们今天有什么(已在仓库核对)

- **Claude**:`src/core/claude-workbench-runtime.ts`(286 行)—— claude-agent-sdk `query()` 循环、`includePartialMessages` 逐字流、`canUseTool` 权限回调、后台任务/Monitor 归并。`claude_code_version === '2.1.267'` 才认 registration(:147);win32 直接抛 `claude_workbench_process_groups_unsupported`(:36)。`package.json` 钉 `@anthropic-ai/claude-agent-sdk 0.2.116`。
- **Codex**:`src/core/workbench/codex-app-server.ts`(785 行)—— `codex app-server` stdio JSON-RPC:`item/started`、`item/agentMessage/delta`、`item/fileChange/patchUpdated`、`item/{commandExecution,fileChange,permissions}/requestApproval`、`item/tool/requestUserInput`、`turn/interrupt`、`thread/{start,resume,read}`、`thread/backgroundTerminals/{list,clean}`;win32 同样拒绝(:128)。钉 `@openai/codex 0.144.4`。
- **agy / cursor**:`agy-agent-provider.ts`(549)+ `agy-stream.ts`(162)+ `cursor-cli-provider.ts`(306)+ `cursor-cli-stream.ts`(134)+ `agy-mcp-config.ts`(244)+ `cursor-mcp-config.ts`(153)= **约 1548 行**。print 模式,无逐工具回调 ⇒ 才有 2026-09-17 刚落地的「免审」(`UNATTENDED_CAPABILITIES`,`permissions:'unattended'`)。
- **公共面**:`AgentEvent`(text/itemId/textMode、tool_call/activity、init、result、error)、`requestPermission`(**布尔**)、`requestUserInput`、`mcpEnv`、`appendInstructions`、`resumeSessionId`、`cancel/close`、`WorkbenchExecutorCapabilities`;额度走旁路 `subscription-usage.ts`(codex `account/rateLimits/read`、claude OAuth `/api/oauth/usage`)。
- **前提复核**:`docs/rfc/03-multi-agent-architecture.md` §1.1–1.2 曾明确否决「ACP 通用层」,理由是"最大公约数只剩发 prompt → 收 text,削掉 MCP / canUseTool / sandbox 深度"。**这个理由在 2026-09 的 ACP 上已不成立**(见 §4 对照表);但"不做 N-agent 路由器"的产品判断与本评估无关,仍然有效。
- `2026-09-17-workbench-live-stream-design.md` 已把 ACP 列为实时事件流的**第三步**,本备忘正是那一步的前置。

## 2. 协议现状

- **治理**:Zed + JetBrains **共同治理**(不是 Zed 独家),lead maintainer 各一名(Ben Brandt / Sergey Ignatov),core maintainer 双周例会,RFD 流程,Apache-2.0,无 CLA,目标是转交独立基金会。
- **传输**:stdio JSON-RPC 2.0,换行分隔,agent 作为子进程。Streamable HTTP 还是草案,WebSocket 未定。
- **版本**:`initialize` 里 `protocolVersion` 是单个整数(MAJOR)。**v1 稳定**(适配器都发 `protocolVersion: 1`);**v2 仍是 alpha**:`schema/v2/CHANGELOG.md` 从 `2.0.0-alpha.0` 排到 **alpha.4(2026-09-17,今天)**,官方明确要求实现方同时保留 v1、把 v2 藏在版本协商/特性开关后。SDK:Rust crate `agent-client-protocol` 2.1.0(2026-09-04),npm **`@agentclientprotocol/sdk` 1.4.0(2026-08-20)**(旧的 `@zed-industries/agent-client-protocol` 冻在 0.4.5 / 2025-10-02,已废)。
- **稳定节奏(近 4 个月)**:session resume(04-22)、session close(04-23)、message id / session usage / session delete(06-05)、model_config 类目(06-24)、Rust+TS SDK 1.0(06-25)、request cancellation(06-29)、boolean config(07-06)、elicitation(07-22)、tool call name(**09-17,今天**)。
- **稳定性机制**:RFD 有生命周期 Draft → Active → Preview → **Completed**(官方原话:completed 是唯一能代表"单向门"的状态);未稳定的东西藏在具名 feature flag(`unstable_mcp_over_acp`、`unstable_session_fork` …)和能力位后面;`_` 前缀字段留给扩展。schema crate 声明 Keep-a-Changelog + SemVer。
- **关键事实:v1 的 wire format 至今没破过。** Rust SDK 2.0.0(2026-07-23)的发布说明原话:"Version 2.0 keeps the stable ACP v1 wire schema unchanged while making coordinated breaking changes to the Rust SDK APIs and low-level transport boundary." —— **版本号跳动是 SDK API 的事,不是协议的事**。schema 发布频次还在降(2026-07 ×4、08 ×1、09 ×1),近期条目几乎全是"把某个东西稳定下来"。我们若自己写薄客户端(不吃 SDK),受的就是 wire 那一层的约束,而那一层是稳的。
- **重名警告**:IBM Research / BeeAI 另有一个叫 "Agent Communication Protocol (ACP)" 的**完全不同**的东西(REST/HTTP,agent↔agent),2025-08 已并入 Google A2A、仓库归档。2025 年的资料多半说的是那个。另:ACP 站在 agent **前面**(会话/提示/权限/diff),MCP 站在 agent **后面**(工具)—— 二者互补不互斥。
- **核心方法**:`initialize`、`authenticate`(v2 → `auth/login`)、`session/new`、`session/load`(带历史重放)、`session/resume`(不重放)、`session/prompt`、`session/cancel`、`session/close`、`session/set_config_option`、`session/list`、`session/delete`。
- **流式通知**:`session/update` 的变体 —— `agent_message_chunk`(带可选 `messageId`,同 id 即同一条消息,**追加语义**)、`agent_thought_chunk`、`user_message_chunk`、`tool_call`、`tool_call_update`、`plan`、`usage_update`、`config_option_update`、`available_commands_update`。
- **工具调用**:`toolCallId`、`title`、`name`(今天刚稳定)、`kind`(read/edit/delete/move/search/execute/think/fetch/other)、`status`(pending/in_progress/completed/failed)、`locations`、`rawInput`/`rawOutput`;内容三种 —— 普通 content、**diff(`path` + `oldText` + `newText`)**、terminal(`terminalId` 活输出)。
- **权限**:`session/request_permission`,参数含完整 `toolCall` 与 `options[]`,option `kind` = `allow_once` / `allow_always` / `reject_once` / `reject_always`;turn 被取消时 outcome 为 `cancelled`。
- **提问**:`elicitation/create`(form / url 两模式,form 带受限 JSON Schema,回 accept/decline/cancel),2026-07-22 稳定。
- **客户端能力(agent 反向调用我们)**:`fs/read_text_file`、`fs/write_text_file`、`terminal/{create,output,wait_for_exit,kill,release}`、`elicitation`、`auth.terminal`。**未声明 = 不支持**,agent MUST NOT 调用 ⇒ 我们可以全部不实现。
- **MCP**:在 `session/new` / `session/load` 的 `mcpServers[]` 里传,stdio 形态带 `command`/`args`/`env[{name,value}]`,另有 http / sse(已弃用)。
- **模型/推理档**:`session/set_config_option` + `config_option_update`,保留类目 `mode` / `model` / `model_config` / `thought_level`(旧的 session modes 已被它取代)。
- **注册表**:`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`,一个 JSON 列出所有 agent 的启动方式(npx 包名 / 各平台二进制 + cmd + args),PR 收录 + CI 校验。

## 3. 适配器成熟度(2026-09-17 实测)

| agent | 怎么起 | 版本 / 日期 | 维护方 | 备注 |
|---|---|---|---|---|
| Claude | `npx @agentclientprotocol/claude-agent-acp` | 0.79.0 / 2026-09-17 | 作者栏 Anthropic + Zed + JetBrains | 2539★,repo Apache-2.0,依赖 `@anthropic-ai/claude-agent-sdk` **钉死 0.3.274** + `@agentclientprotocol/sdk 1.4.0`,node ≥22。旧名 `@zed-industries/claude-code-acp` 已死在 0.16.2 |
| Codex | `npx @agentclientprotocol/codex-acp` | 1.12.0 / 2026-09-15 | 作者栏 OpenAI + JetBrains + Zed,Apache-2.0(版权 JetBrains s.r.o.) | `src/CodexAppServerClient.ts` ⇒ **正是包一层 `codex app-server`**,依赖 `@openai/codex ^0.154.0`,`CODEX_PATH` 可覆盖。**openai/codex 自己没有 `codex acp`** |
| Cursor | `cursor-agent acp`(**CLI 原生子命令,零额外安装**) | 2026.09.15 | Cursor 官方,有文档 | 六平台二进制,**含 windows x64/arm64**;能力只报 `loadSession` + `session/list`(**无 resume/fork**) |
| Antigravity(agy) | `agy_acp_server.par`(**与 `agy` CLI 无关的独立 316MB 二进制**) | 1.1.1 / 2026-09-02 | Google,**proprietary,查不到任何官方文档** | dl.google.com 分发;能力报 loadSession + list + resume。注册表是唯一公开出处 |
| Gemini CLI | `npx @google/gemini-cli --acp` | 0.60.0 / 2026-09-15 | Google 官方,有文档 | `--experimental-acp` 已降级为弃用别名;**只报 `loadSession`,四家里最弱**。⚠️ Google 2026-05-19 宣布 Gemini CLI 向 Antigravity CLI 过渡(AI Pro/Ultra 请求 06-18 停),**这是条在退场的路** |
| GitHub Copilot CLI | `copilot --acp` | 1.0.85 | **GitHub 官方,原生,public preview(2026-01-28 changelog)** | 目前唯一有厂商正式公告的原生 ACP |

其余在注册表里的:GitHub Copilot CLI、Junie(JetBrains)、goose、Qwen Code、Kimi CLI、OpenCode、Cline、Devin、Amp、Factory Droid、Mistral Vibe、GLM、Grok Build、Auggie 等,共 41 个。注册表另有**每日 protocol matrix**(`.protocol-matrix/latest.json`)真连每个 agent 探能力 —— 2026-09-17 那轮 34 个里 33 个 `initialize` 成功;`session/list` 20 家支持、`session/set_model` 17、`session/resume` 10、`session/fork` 8、`session/stop` **只有 1 家**。Crush / Aider 不在册。

**claude-agent-acp 的实证**(读 repo,非宣称):`src/permissions/`(options / modes / normalization / presentation / effects / response)把 SDK `canUseTool` 完整映射到 `session/request_permission`,**带 `toolCall.name` + `rawInput` + title**,并把选择映回 SDK `PermissionResult`;`src/tests/session-load.test.ts` ⇒ 有 session/load;`src/async-tasks.ts`、README 的 "interactive and background terminals" ⇒ 后台任务在;`src/session-model.ts` / `session-effort.ts` ⇒ 模型与推理档走 config option;`src/elicitation.ts` ⇒ AskUserQuestion 有落点;`docs/diff-statistics-extension.md`、CHANGELOG "report file changes from Claude checkpoints" ⇒ 文件变更有结构化来源。**发布节奏 ~每周 2 次**(0.75.0 09-05 → 0.79.0 09-17)。
**codex-acp 的实证**:`src/RateLimitsMap.ts`、`src/app-server/v2/GetAccountRateLimitsResponse.ts` ⇒ 订阅额度它自己也读得到;`loadSession`/`list`/`fork`/`resume` 四件齐,后台终端在 1.10.0 落地。

**已知缺口(来自两个 repo 的 open issue,不是推测)**:
- **claude-agent-acp #883(2026-07-16 起开着)—— `session/new.mcpServers` 里传的 stdio MCP server 根本没到模型手里**,而且 ACP 没有"server 已连上"的确认,客户端连察觉都察觉不到。**这一条正对着我们的 `mcpEnv`(按任务注入 `WECHAT_SESSION_TOKEN`),是全表最危险的一条。**
- claude-agent-acp #1038 后台任务生命周期(保住 Monitor + 后台 Bash)、#1110 `session/fork` 自 0.71.0 起不返回活会话、#1137 空的 bash 权限请求、#1041 Windows/WSL 下 `session/list` 大小写敏感对不上 `/mnt/<盘>`;协议侧 #1979 权限提示可能静默丢掉 `rawInput` 里的工具上下文。
- codex-acp #519 权限档没映成 ACP mode、#516 大会话在 Zed 里只重放部分历史、#489 会话再加一个 MCP server 时 `CODEX_CONFIG` 的 env 覆盖被丢。
- **两个适配器的 CI 全是 ubuntu-only**(`.github/workflows/*` 没有任何 Windows / macOS job)。Windows 代码路径有(`.exe`、`shell:true`、win 打包),但没人跑过。
- Cursor 官方文档明说:**dashboard 配的 team-level MCP server 在 ACP 模式下不支持**,ACP 模式的 MCP 来自 `.cursor/mcp.json`。

**厂商立场**:GitHub/Microsoft、Google、Cursor、xAI、Mistral、Moonshot、Block、Augment、Cognition 原生支持。**Anthropic 与 OpenAI 都没有公开表态** —— 但两家都出现在注册表 `authors` 里(claude-acp: Anthropic+Zed+JetBrains;codex-acp: OpenAI+JetBrains+Zed)。`anthropics/claude-code#6686`(552 赞)被**机器人以 stale 关成 not_planned,全程无 Anthropic 员工发言**,不能当成"官方拒绝";`openai/codex#30052` 至今开着。

**客户端生态**(官方名录已 100+ 条):JetBrains AI Assistant 是**第一方内建**(不是插件,`~/.jetbrains/acp.json`,不需要 AI 订阅,2025.3 起 beta)、Qt Creator 官方插件(20.0.1,带 ACP 流量检查器)、Visual Studio / ReSharper 2026.2、marimo、Emacs(agent-shell 1.86k★,更新最勤)、Neovim(CodeCompanion 6.8k★ 且**内建 15 个 ACP adapter**、avante 18.2k★、agentic、hermes)、5 个社区 VS Code 扩展(**微软自己没有**)、Obsidian、Sublime、acpx(3.2k★,近乎日更)、移动端若干。**不是"只有 Zed"**。顺带:官方名录的 Messaging 类目里已经有一个 `formulahendry/wechat-acp`。**明确不存在的**:Helix、Xcode、Continue.dev;JupyterLab / DuckDB 那两个已停更或归档。

## 4. 能力对照表(我们今天靠的 × ACP 给不给)

| 我们今天的能力 | ACP | 承载的方法 / 通知 |
|---|---|---|
| 逐工具权限卡 | ✅ **超集**(我们只有布尔 allow/deny;ACP 有 4 档) | `session/request_permission`,option kind `allow_once`/`allow_always`/`reject_once`/`reject_always` |
| 逐字文本流 + 稳定 itemId | ✅ | `session/update` → `agent_message_chunk` + `messageId`(同 id 追加)→ 直接对应 `textMode:'append'` |
| 工具活动 + 状态迁移 | ✅ | `tool_call` / `tool_call_update`:`toolCallId`、`title`、`name`、`kind`、`status` |
| 逐工具文件 diff | ✅ v1 / ⚠️ v2 换形状 | v1 `ToolCallContent{type:'diff',path,oldText,newText}`;**v2 改成 `changes[]` 文件操作 + git patch** |
| 向用户提问 | ✅ | `elicitation/create`(form 模式,受限 JSON Schema)→ `requestUserInput` |
| 按 sessionId 恢复 | ✅ 协议有 / 🟡 实现参差 | `session/resume`(不重放)/ `session/load`(重放全历史,我们丢弃重放即可)。**cursor 与 gemini 只报 `loadSession`**,agy 报 resume |
| 取消 + 确认收工 | ✅ | `session/cancel` → `stopReason:'cancelled'`;`session/close` 释放资源;`$/cancel_request` 管单个请求 |
| 按任务注入 MCP 凭据 | ⚠️ **协议有,实现有洞** | `session/new.mcpServers[].env[{name,value}]` 是 `mcpEnv` 的一对一落点,但 claude-agent-acp **#883 开着:传进去的 stdio server 到不了模型且无法察觉**;cursor 的 ACP 模式 MCP 来自 `.cursor/mcp.json`。必须逐 agent 实测 |
| Claude 后台/常驻 runtime | 🟡 | 适配器有 `async-tasks.ts` + 后台终端,但**我们那套 `retained/foreground/backgroundCount` 快照没有对应字段**,只能从 tool_call 状态推,或用 `_meta` |
| 模型 / 推理档选择 | ✅ | `session/set_config_option`,类目 `model` / `thought_level` / `model_config` |
| 订阅额度(5h / 周窗口 %) | 🟡 | ACP `usage_update` 只有 token 数 / 上下文窗口 / 可选累计成本,**没有订阅窗口百分比**;现有 `subscription-usage.ts` 旁路照旧可用(它本来就不经 provider) |
| 附件(图片 / PDF) | ✅ | `session/prompt` content blocks,`promptCapabilities.image` 协商 |
| 追加系统提示 | 🟡 | 无标准字段;塞进首条 prompt(codex 今天就是这么做的)或 `_meta` |
| 成果 / git diff 快照 | n/a | `artifacts.ts` / `git-review.ts` 是我们自己的,与执行者无关,**一行不改** |
| `fs/*`、`terminal/*` 客户端能力 | 可不实现 | 初始化时不声明 ⇒ agent MUST NOT 调用;适配器自己落盘 |

## 5. 风险

1. **v2 是悬着的刀,而且还在动**。v2 对客户端是**破坏性**的:`session/load` 删除、`session/set_mode` 删除、`session/prompt` 改成立即返回 `{}` + 靠 `state_update` 收 stopReason、每个 chunk 必须带 `messageId`、diff 换成 `changes[]`+git patch、权限请求结构重排、**`fs/*` 与 `terminal/*` 客户端方法整体移除**。schema 还在 alpha(alpha.4 就是今天发的),无稳定时间表。今天写 v1 客户端,将来要么同时养两套,要么重写一次解析层。
   **但要把这条摆正**:v1 的 wire schema 至今一次没破过(见 §2),破的是 SDK API 与 v2 alpha。我们写薄客户端就只吃 wire 那层,这条风险比版本号看起来小。
2. **适配器 pre-1.0 + 高频发布**。claude-agent-acp 0.79.0,**每周两发、每次 main 推送还发一个 `@preview`**,`minor` 版里就带 ⚠ BREAKING CHANGES(0.77.0 删掉 `claudeCode.options.agent`)。我们得钉版本 + 一条"升版要跑的真机清单",和今天钉 `claude_code_version === '2.1.267'` 是同一类债,不是新债。
3. **多一层进程**。claude-agent-acp 是 in-process 用 SDK,再由 SDK spawn 它自带的 `claude` 二进制(`pathToClaudeCodeExecutable`,可用 `CLAUDE_CODE_EXECUTABLE` 覆盖;`npm i --omit=optional` 会直接装坏)。所以 daemon → node 适配器 → claude 二进制,比今天多一层;冷启动、内存、**以及进程树清理**都多一层,而进程树清理正是 Claude/Codex 工作台至今 win32 拒绝服务的原因。ACP 不免除它,只是把两种形状收敛成一种。
4. **SDK 专属能力的损耗**。`includePartialMessages` 有对应(agent_message_chunk),`extraArgs:{'replay-user-messages'}`、Monitor/后台快照、`spawnClaudeCodeProcess` 自管进程组这三样**没有协议对应物**;`claude-workbench-process.ts` 的进程组所有权在 ACP 下要么交给适配器,要么我们管适配器的进程组。
5. **Codex 独有面**。`thread/backgroundTerminals/{list,clean}` 的收尾、`account/rateLimits/read`、`thread/read` 校验 —— ACP 没有对应方法;codex-acp 自己读了 rateLimits 但**是否透出**未核实。这些要么退回旁路进程(额度已经是旁路),要么接受丢失。
6. **许可与供应链**。协议与两个 npm 适配器都是 Apache-2.0、无 CLA,可接受(注册表把 claude-acp 标成 `proprietary`,与 repo 的 Apache-2.0 冲突,未查清 —— 大概率指的是捆绑的 claude 二进制)。但 **antigravity 的 ACP 服务端是 dl.google.com 上 316MB 的 proprietary 独立二进制,和用户装的 `agy` CLI 不是一回事,而且 Google 官方文档里查不到它**。我们不下载别人的二进制(codex-version-coupling 定案:用用户 CLI),所以 agy 走 ACP 需要用户额外装一个没有文档的东西 —— 这与"装了就该能用,零配置"的要求相冲突。cursor 相反:`cursor-agent acp` 就在用户已装的 CLI 里。
7. **Windows 不会自动变好,而且 stdio 有一类新坑**。注册表里 19 个二进制分发的 agent **全部**有 windows-x86_64 构建,是加分项;但两个 npm 适配器的 CI 全是 ubuntu-only,Windows 路径没人跑过。Zed 侧的真 issue 值得照抄防御:**#58568 —— 用户的 PowerShell profile 只要往 stdout 写一个字,JSON-RPC 流就脏了、外部 ACP agent 直接起不来**(stdio 是唯一传输,这是结构性的);#58873 claude-code-acp 留下永不回收的 node/MCP 孤儿进程;#54855 `codex-acp.exe` 不退、锁住项目目录句柄;路径大小写一类(claude-agent-acp #1041、codex-acp #431、gemini-cli #29000)。JetBrains 文档另明说:**ACP agent 不支持 WSL**。工作台在 win32 的拒绝服务源自我们自己的进程树清理未验证,ACP 不解决它,只是把两种形状收敛成一种。

## 6. 建议

**只为新执行者采用,且先做 cursor;Claude / Codex 不动;agy 有条件推迟。**

理由:
1. **对 cursor 是净升级,不是平级替换**。cursor 今天在工作台里是「免审」—— 不是我们不弹卡片,是它的 print 模式**没有卡片可弹**。走 `cursor-agent acp` 之后它有 `session/request_permission`(官方文档明载 allow-once / allow-always / reject-once),可以从 `permissions:'unattended'` 升到 `'task'`,和 Claude/Codex 同一档,09-17 刚上线的一次性确认门对它就能退场。而且**零额外安装** —— ACP 在用户已装的 `cursor-agent` 里。
2. **代码是净减**。现在 agy+cursor 那条线约 1548 行自研流解析 + 两份 MCP 配置;换成一个 ACP 客户端后,新增执行者 = 一行启动描述 + 能力声明。顺带能拿到的还有 GitHub Copilot CLI(`copilot --acp`,厂商原生 + 正式公告)、goose、Qwen Code、Kimi CLI 等。**gemini 别当卖点** —— Google 已宣布 Gemini CLI 向 Antigravity 过渡,那是条在退场的路。
3. **风险被限制在"本来就不太行"的一侧**。这几家没有我们依赖的深度能力(无附件、无执行设置、无模型目录、无后台快照),v2 破坏性变更真来了,重写的是新代码,不是已经真机验过的 Claude/Codex 那两条。
4. RFC 03 否决 ACP 的理由("最大公约数只剩 prompt→text")在今天的 ACP 上不成立:逐工具权限、diff、MCP env、模型档、elicitation、usage 都在协议里。但**那条 RFC 的产品判断(不做 N-agent 路由器)不变** —— 这里只是把已注册的 CLI 换一条更好的接线,不是开放任意 agent。

**agy 推迟的理由**:它的 ACP 面不在 `agy` CLI 里,是 dl.google.com 上一个 316MB、proprietary、**Google 官方文档只字未提**的独立二进制。让用户额外装它,违背"装了就该能用"。触发条件:Google 把 ACP 收进 `agy` CLI(一个子命令/开关),或 Antigravity IDE 的安装包里本来就带 `agy_acp_server` 且路径可发现。

**Claude / Codex 的重看触发条件**(任一命中即重评):① ACP v2 稳定且两个适配器跟上;② claude-agent-acp **#883(session MCP server 到不了模型)关闭**;③ 我们要支持 Windows 工作台,且适配器有了 Windows CI;④ Claude 或 Codex 官方自己改成 ACP-first(codex-acp 已经是 JetBrains 在维护的 `codex app-server` 包装、作者栏挂着 OpenAI —— 若 OpenAI 收编,直连 app-server 的价值就下降);⑤ 我们要接第 4、第 5 家有深度能力的执行者。

**规模估算**:
- 新增 ~4 个文件,约 600–800 行:`src/core/acp/client.ts`(JSON-RPC over stdio + initialize/session 生命周期)、`src/core/acp/events.ts`(session/update → `AgentEvent` 的翻译,含 messageId→itemId、tool_call→`AgentActivity`、diff→活动 detail)、`src/core/acp-agent-provider.ts`(实现 `AgentProvider`/`AgentSession`,把 `requestPermission`/`requestUserInput`/`mcpEnv`/`resumeSessionId` 接上去)、`src/core/acp/agents.ts`(agy/cursor/gemini 的启动描述 + 发现)。
- 删除:cursor 转完即删 `cursor-cli-provider.ts` + `cursor-cli-stream.ts` + `cursor-mcp-config.ts`(~593 行);agy 若跟上再删 ~955 行。`UNATTENDED_CAPABILITIES` 与 `unattendedAck` 那条门要等最后一家转完才退场。
- **不动**:`AgentEvent` 契约、`service.ts` 执行循环、租约/收工、`artifacts.ts`、`git-review.ts`、桌面渲染、微信 y/n、`claude-workbench-runtime.ts`、`codex-app-server.ts`、`subscription-usage.ts`。

**第一个 spike 要证明的事**(一个任务,`cursor-agent acp`,真机):
1. `initialize` 只声明 `elicitation`、**不声明 `fs/*` 与 `terminal/*`**,cursor 仍能改文件(即适配器自己落盘,我们不用做客户端文件系统)。
2. 一次改文件的工具调用,**权限卡在桌面弹出来、微信 y/n 能拍板**,拒绝后这一步真的没执行。
3. `agent_message_chunk` 的 `messageId` 稳定,喂给现有 `DeltaCoalescer` + 桌面增量补丁**不闪不跳**。
4. **最关键的一条**:`session/new.mcpServers` 里带 `WECHAT_SESSION_TOKEN` 的 wechat MCP 子进程**真的起来、模型真的能调用它、调用真的打到内部 API**。这是 agy/cursor 今天做不到的 per-task 凭据,也正是 claude-agent-acp #883 翻车的地方,还撞上 cursor 文档"ACP 模式只认 `.cursor/mcp.json`"的说法。**不许用"server 列出来了"当通过标准,必须看到一次成功的工具调用。**
5. `session/cancel` + `session/close` 之后**没有孤儿进程**(`pgrep -P` 核对),以及 `session/load`(cursor 不报 resume)能接上同一个会话、我们能安全丢弃重放的历史。

若 5 条里有 2 条以上不成立,就停在"cursor 维持免审",本备忘作废重估。

## 7. 未能核实

- claude-agent-acp 是否把 `usage_update` 真的发出来(只在 CHANGELOG 里见到关键词,未读实现)。
- codex-acp 读到的 rateLimits 是否经 ACP 透出给客户端(有 `RateLimitsMap.ts`,未确认出口)。
- cursor / antigravity 的 ACP 服务端**是否支持 `session/new.mcpServers` 的 env 注入**(厂商二进制,无源码;这正是 spike 第 4 条要打的点)。
- 两个 npm 适配器在 Windows 上的真机状态(有 win 代码路径,但无 Windows CI,也没人跑过)。
- Cursor ACP 与 Antigravity ACP 的**首发日期**(厂商都没有 changelog;只有注册表提交时间与二进制 `Last-Modified`)。
- Antigravity IDE 的安装包里**是否已经带了 `agy_acp_server`**(若带,推迟的理由就消失)。
- claude-acp 的许可冲突(repo Apache-2.0 vs 注册表 `proprietary`)。
- ACP v2 的稳定时间表(官方明说"未定")。

## 8. 来源

- ACP 文档索引 https://agentclientprotocol.com/llms.txt(2026-09-17 取)
- 概览 / 初始化 / 会话建立 / prompt turn / 工具调用 / 文件系统 / 终端 / elicitation / 取消 / 传输 / 配置项 / schema:`https://agentclientprotocol.com/protocol/v1/{overview,initialization,session-setup,prompt-turn,tool-calls,file-system,terminals,elicitation,cancellation,transports,session-config-options,schema}.md`
- v2 概览与迁移 https://agentclientprotocol.com/protocol/v2/{overview,migration}.md;v2 草案公告 https://agentclientprotocol.com/announcements/acp-v2-draft.md(2026-07-20)
- 稳定公告:session-resume(2026-04-22)、session-close(2026-04-23)、message-id / session-usage / session-delete(2026-06-05)、model-config-category(2026-06-24)、sdk-1-0-releases(2026-06-25)、request-cancellation(2026-06-29)、boolean-config-option(2026-07-06)、elicitation(2026-07-22)、tool-call-name(2026-09-17);汇总 https://agentclientprotocol.com/updates.md
- 治理 https://agentclientprotocol.com/community/governance.md(Zed + JetBrains,Apache-2.0)
- 客户端名录 https://agentclientprotocol.com/get-started/clients.md;agent 名录 https://agentclientprotocol.com/get-started/registry.md;注册表 RFD https://agentclientprotocol.com/rfds/acp-agent-registry.md
- 注册表数据 https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json(2026-09-17 取:cursor 2026.09.15 `cursor-agent acp`;antigravity-acp 1.1.1 `agy_acp_server`;claude-acp 0.79.0;codex-acp 1.12.0;gemini 0.60.0 `--acp`)
- TypeScript SDK https://agentclientprotocol.com/libraries/typescript.md(`@agentclientprotocol/sdk` 1.4.0 / 2026-08-20);Rust crate `agent-client-protocol` 2.1.0 / 2026-09-04;维护者名单 https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/MAINTAINERS.md
- v2 alpha 进度:`schema/v2/CHANGELOG.md`(2.0.0-alpha.0 … alpha.4,alpha.4 2026-09-17)
- 注册表仓库 https://github.com/agentclientprotocol/registry(`agent.schema.json`、`build_registry.py` 每小时同步、`verify_agents.py` 真连校验、`.protocol-matrix/latest.json` 每日能力探测,2026-09-17T10:01Z 那轮)
- Cursor ACP 文档 https://cursor.com/docs/cli/acp;Gemini ACP 文档 https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md(`--acp`,`--experimental-acp` 为弃用别名)
- open issue:claude-agent-acp #883 / #1038 / #1041 / #1110 / #1137,agent-client-protocol #1979,codex-acp #489 / #516 / #519,zed #58568(PowerShell profile 污染 stdio)/ #58873 / #54855(2026-09-17 查)
- v1 wire 未破的依据:https://github.com/agentclientprotocol/rust-sdk/releases/tag/v2.0.0(2026-07-23);RFD 流程 https://agentclientprotocol.com/rfds/about
- 厂商:Copilot CLI ACP public preview https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/;Gemini CLI → Antigravity CLI 过渡 https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/(2026-05-19);`anthropics/claude-code#6686`(bot 关的 not_planned)、`openai/codex#30052`(仍开)
- 客户端:https://www.jetbrains.com/help/ai-assistant/acp.html(含"ACP agent 不支持 WSL");https://doc.qt.io/qtcreator/creator-how-to-use-acp-client.html;CodeCompanion.nvim / xenodium agent-shell / openclaw acpx
- 重名:IBM/BeeAI 的 ACP 并入 A2A https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/(2025-08-29)
- https://github.com/agentclientprotocol/claude-agent-acp —— README、`package.json`(sdk 0.3.274 / acp-sdk 1.4.0 / node≥22)、`CHANGELOG.md`、`docs/permission-extension.md`、`src/` 目录(2026-09-17 经 `gh api` 取;release v0.79.0 2026-09-17,v0.75.0 2026-09-05)
- https://github.com/agentclientprotocol/codex-acp —— `LICENSE`(JetBrains,Apache-2.0)、`package.json`(`@openai/codex ^0.154.0`)、`src/CodexAppServerClient.ts`、`src/RateLimitsMap.ts`(2026-09-17 取;release v1.12.0 2026-09-15)
- 本仓库:`src/core/agent-provider.ts`、`src/core/claude-workbench-runtime.ts`、`src/core/workbench/{codex-app-server,service,executor-capabilities,permissions,git-review,artifacts}.ts`、`src/core/{agy-agent-provider,cursor-cli-provider}.ts`、`src/core/subscription-usage.ts`、`src/daemon/bootstrap/wire-workbench.ts`、`docs/rfc/03-multi-agent-architecture.md`、`docs/superpowers/specs/2026-09-17-{unattended-executors,workbench-live-stream}-design.md`
