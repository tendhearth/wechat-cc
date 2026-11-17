# Grok ACP 内置执行者交接（2026-11-16）

状态：**已按整合者实测改为 CC 专属 HOME + 独立登录门；离线接线完成，真实模型仍待整合者验收。** 先前「隔离未证实，一律拒绝」已由本次裁决替代。未调用真实 Grok、未部署或触碰运行中的 daemon。

工作区 `/Users/nategu_mac_company/Documents/tendhearth/wt-grok`，分支 `grok-acp-executor`，起点/merge-base `087dbf9f87b87242fe7f28ac51368c597efd8c5d`。本批整合、真模型与部署归整合者；按主人要求，不 git add/commit/push，全部为本工作区未提交改动。

## 启动和账号边界（本次裁决）

整合者在网络保护主机实测 grok 1.0.77：`HOME=<0700 临时目录>`，目录内仅 `.grok/auth.json`，`grok inspect` 显示 Plugins / MCP Servers / Hooks 全 None，不再加载主人 `~/.claude` 的 Claude.md/skills 或 `~/.claude.json` 的 context7；相同专属 HOME 的 `grok -p` 可登录作答。该证据由整合者提供，本分支没有重跑真实 Grok。

CC 固定使用 `<STATE_DIR>/executors/grok/home`（0700），`.grok/config.toml` 为 0600。主人必须在其中**独立登录一次**：

```bash
HOME='<STATE_DIR>/executors/grok/home' grok login
```

错误、doctor 与工作台入口给出实际状态目录的命令。`STATE_DIR` 是占位符；后续一键接入卡可打开同一命令，本轮不实现卡片。**不读、不复制主人 `~/.grok/auth.json`**：token 刷新可能使两份登录互相失效。登录检测只 stat 专属 `.grok/auth.json` 是否是普通文件，不解析内容、不探测 token 有效性；过期由官方 CLI 如实报错。符号链接不能充当专属家或登录文件。

ACP 对话、工作台、版本首探与退避重探都使用同一 HOME 工厂；缺少明确状态目录的 Grok 启动在 spawn 前拒绝，strict/dangerously 都不能绕过。会话启动另检查专属登录；版本探测不要求已登录，以便发现 CLI。工作台入口每次读取登录状态，登录/移除后无需重启。doctor 只找二进制、stat 专属登录，不启动 Grok；models 未实现 modelCatalog，因此不会起 `grok models`。自定义 ACP 若直接以 `grok`/`grok.exe` 为命令也受专属 HOME 门约束，不能退回主人 HOME。

环境先走现有 `workbenchSubprocessEnv` 清洗，移除 daemon 凭据；再替换 HOME 和必要 XDG/TMP 路径。移除可绕回其他家或认证源的 `GROK_*`、`CLAUDE_CONFIG_DIR`、`XAI_API_KEY`，不新增密钥透传；PATH、代理等沿原有执行者规则。专属 config 原子替换，避免并发会话读到被截空的关闭开关。

**项目信任与现有 Claude/Codex 执行者对等**：当前项目里的 `.grok` / `.claude` 配置、指令、skills、MCP、插件、hooks 按该项目的信任处理。专属 HOME 隔离的是主人账号和用户级兼容配置，不声称禁掉项目或系统 managed 策略，也不是文件/网络沙盒；Grok 的 confines 仍全为 none，访客仍拒绝。

## 插件市场与上传

仅静态读取安装自带 `~/.grok/docs/user-guide/`，未运行 Grok：

- `09-plugins.md:351–353`：`plugin_auto_update = false` 关闭会话启动的市场扫描和逐插件自动更新；不使用仅隐藏 UI 的 `disable_plugins` 冒充隔离。
- `26-config-reference.md:274`：`features.cursor_marketplace = false` 关闭可选 Cursor 市场目录。
- `05-configuration.md:569–604`、`26-config-reference.md:169`：关闭 `features.telemetry`、`diagnostics.error_reporting`、`telemetry.mixpanel_enabled`、`trace_upload` 和独立 `otel_enabled`。

这些写入专属 config.toml；不宣称改变账号云端训练/保留设置。整合者先前 `-p` 观测仅连 `cli-chat-proxy.grok.com`、`grok.com`、`github.com`；GitHub 疑似插件市场，尚未在这些关闭开关下重验，不能声称 GitHub 请求已消失。网络端点和保护口径见 [network-guard](../../reference/network-guard.md#grok-cli--acp2026-11-16)。

## 能力与一次代答

- 内置 `grok` / Grok，独立 `grokModel/grokBin`；复用通用 ACP，启动 `grok agent --no-leader stdio`，不接用户已有 leader；按 initialize 的 cached_token 认证。默认 CC 不变。
- 整合者的 initialize 事实：协议 1，loadSession、图片/embeddedContext、session list/resume/close；模型状态在 `_meta.modelState`，本轮沿用解析，不拿协议声明冒充真模型验收。
- **Grok 仅声明 http/sse MCP；CC 当前只有 stdio MCP，本轮不建桥、不 listen。** 对话与工作台均传空 MCP，明确声明无 wechat、记忆、记录本或委派工具；`adminMcpTools:false`、`mcpTools:none`、`supportsDelegation:false`。提示词不再教它调用不存在的工具，工作台 `reportMatterTools(false)`，不能声称备注已写入。
- **开放纯文字 oneoff**：`ONEOFF_PROFILE` 只允许 reply；最终文字经 `AgentEvent.text → reply-delivery` 交付，不依赖 MCP。仅对 Grok 显式放开无 MCP 一次代答，agy 仍拒；独立空工作目录、strict、临时会话、无私人历史/记忆注入沿用原路径，下一句回 CC。原生工具可能有无需上报的只读操作，不能宣称 ONEOFF_PROFILE 是 Grok 原生工具沙盒。
- 不提供 cheapEval / strongEval / modelCatalog，自动后台评估、故障转移与 pinned cheap 均不消耗 Grok 模型额度。恢复、附件、执行设置与模型目录本轮仍不开放。
- 工作台初始与晚注册均重新构造 Grok provider，并传同一个 stateDir。Windows ACP 仍受现有进程树清理限制，不登记。

## 离线红/绿与检查

本轮先加专属 HOME 测试，缺实现红；实现后通过。另做撤掉 HOME 接线的变异验证，证明缺家拒绝和 spawn 环境断言能抓住回退主人 HOME（最终结果见下方记录）。全部 ACP 流量来自内存假进程，pid undefined，不请求模型。

新增覆盖：专属目录/配置权限、关闭开关、环境来源指针清洗、只 stat 登录文件、拒绝符号链接、配置原子替换；对话/工作台缺家拒绝、专属家缺登录拒绝、spawn env.HOME；版本首探/重探/env 传递；登录后 doctor/工作台动态放行；无 MCP 提示词、oneoff 最终文字/命令权限拒绝、单句 Grok 后回 CC。无 modelCatalog 的断言确保没有额外 models 进程。

既有测试未删除；原「永久隔离拒绝」断言随本次裁决换为缺专属 HOME/独立登录拒绝，新增登录成功、无 MCP 与 guest 拒绝断言。策略与执行矩阵快照仅更新 Grok 行，其他执行者保持原值。本次用已实测的来源隔离替代临时全拒绝门；未开放 CC MCP 或访客执行。

本轮最终验证（2026-11-16）：

- 牵连批 **29 文件、722 项通过**：ACP 全目录、Grok HOME/身份、能力/策略/执行矩阵、首探/重探、无工具提示词、oneoff 路由/交付、工作台接线/入口、doctor、配置表、registry。
- 设置页仅离线「模型与后端」组 **8 项通过、63 项未执行**，未启动 HTTP server。
- `scripts` 离线守卫 46 文件首轮 356/357 通过；唯一红为新增手写原子配置违反 json-write 规范。改用现有 `writeFileAtomic` 后该守卫 **2/2 通过**；其余 45 文件未变。另含 4 个 src 守卫与 HOME/ACP/重探的补跑 **8 文件、34 项通过**。最后 Grok ACP + workbench-errors 守卫 **2 文件、84 项通过**。
- HOME 接线变异：临时把 Grok env 改回普通 baseEnv，两条缺家拒绝/专属 env 断言 **2 红**；恢复后 HOME + ACP **13 项绿**。没有真实进程或模型请求。
- `bun run typecheck` 根、mobile、relay、app 全过；`bun run depcheck` 0 errors，16 条仓库既有 CLI→daemon warnings；`git diff --check` 通过。
- 只读评审发现配置并发截写风险，已用仓库原子写工具修复，并加旧 inode 读者保持完整文件的测试；第二道未参与实现的独立正确性复核未发现违背本次裁决的确定问题。

前一轮（本次之前）的离线验证为 31 文件 867 项、相关安全守卫 111 项、设置模型组 8 项、App 资产 4 项；根与三客户端 typecheck、depcheck 通过。这些是前一轮记录，不等于本轮重新完整执行。

## 留给整合者

1. 在专属 HOME 运行一次登录，不复制登录文件。网络保护下重验关闭市场/上传开关后的实际域名、登录刷新与过期、错误/额度提示、守护拒绝无模型请求。
2. 真模型由整合者串行跑：对话/oneoff 最终文字、工作台编造文件、权限拒绝、取消和进程树清理；Claude 当 CC 与网关当 CC 双跑。无 CC MCP 时不能把 wechat ping/记录本写入等工具步骤记为成功。
3. HTTP/SSE MCP 桥另轮做，核每会话 token/tier、撤销、工具范围与记录本授权，接好前继续如实无工具。
4. mini 跑离线 UI/原生验收；Rust/tauri/重型构建交 mini/CI。主机须有完整整包回滚备份，再由整合者部署；本分支不启动/重启 daemon、不部署。
5. `bun run verify` 涉及算树/git 索引与真实形状 listen 沙盒，本沙盒不跑；`test:e2e` / `test:sandbox`、三平台 CI、node 运行时、UI 回放仍待补。
6. 不运行会启动真实供应商 CLI 的 `scripts/cli-help.guard.test.ts`；不运行需要 git add/commit/index 的 task-cache-paths/test-shrink-lib/migration-frozen/verify-stamp；不运行实际 verify/长期进程树的 verify-timeouts/verify-process-tree。settings-panel 仅跑离线「模型与后端」组，不运行其 HTTP server 组。
