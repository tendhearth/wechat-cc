# 终端会话挂进一件事

结论：先做「共享记录本 + 详情露出」，暂不把终端列入自动接力。主人开的会话继续由主人掌控；挂入是增加一条参与关系，不迁走终端历史、不新开一个 agent。本文基于 `origin/dev` / HEAD `ec7de671` 核实，只是设计，尚未实现。

## 现状与推荐

- **登记处已有身份，也已有自己的事。** `src/ports/cli-session.ts`、`src/adapters/store/cli-session-store.ts`：持久化 `session_id/source/cwd/machine/transcript_path/origin_agent/last_event_at/last_prompt_at/created_at`；source 为 claude/codex/cursor，目录来自 hook 报送的 cwd，不能据此推断模型或精确版本。对外另有前六位 code、project、stale、pending 和 matter_id。`src/features/terminal/wire.ts`、`src/adapters/store/terminal-turns.ts` 已把会话绑到 `kind='terminal'` 的 matter（`matter_bindings.surface='cli'`）；状态从该事的轮与权限卡推导：done→ended、待批→waiting、有运行轮→running，否则 idle；30 分钟没事件的 running/waiting 读时折成 idle。推荐保留这条来源绑定，另加“参与目标事”的关系；直接改绑会破坏现有登记处查询。
- **记录本目前只认工作台执行者。** `src/features/workbench/service/execute.ts` 用 `workbench/<taskId>` 铸会话令牌；`src/features/workbench/wire.ts` 的 `mintSessionToken` 限 trusted + 三条记录本路由，再经 `mcpEnv` 与 `matterLedger` 交给执行者。`src/features/workbench/ledger-routes.ts` 限 session origin 和 key 形状；`src/adapters/store/matter-ledger.ts` 的 `bound` 从 workbench_tasks 查 matter，拒绝指定另一件事。`src/features/workbench/service/ledger.ts` 写备注还要求该事有未取消、未收尾、可信的活跃工作台 run。结束/取消由 `src/features/workbench/service/lifecycle.ts` 撤令牌。推荐新增明确的终端参与授权分支，不能伪造工作台 key 或借用其运行状态。
- **被登记不等于拿到 matter 工具。** 仓库的 hook（`src/cli/hook.ts`、`src/cli/terminal-hooks.ts`）负责事件/权限及开场信息，不给已运行终端注入 matter MCP；项目话题记忆也不等于记录本。工作台 Claude 的 MCP 可在进程内接入（`src/features/workbench/wire.ts`），通用 stdio 入口为 `src/daemon/bootstrap/mcp-specs.ts`、`src/mcp-servers/matter/main.ts`：必须有回环 API 和专属 session token，不回退全局文件令牌。现有登记链路没有为终端配置它；不能假定用户全局 MCP 配置存在或能热加载。推荐首版提供窄权限的记录本 CLI 桥给存量会话使用；以后给新启动会话加同范围 MCP，复用 `src/mcp-servers/matter/tools.ts` 的语义。不能把“挂上”承诺成已运行 CLI 立即出现三个 MCP 工具。

## 主人怎么挂、挂后看到什么

主人对 CC 说“把我终端里这个 Claude 挂到首页配色这件事上”；CC 先找会话和目标事，重名/多个终端时问一次，展示会话码、目录和事名后执行。桌面在事详情提供“挂入终端会话”，列表选同样的身份信息。只允许主人操作；首版仅本机、未 ended 的会话，完整 session_id 定位，短码歧义拒绝，不沿用“取最近一条”来授权。

推荐一个终端同时只挂一件事、同一件事首版只接一个终端参与者；目标须未归档且没有活跃工作台写入者/正在自动接力，避免提前引入并行。先挂入再由主人在终端交代工作，不因挂入自动送执行指令。不同目录明确展示差异，挂入不切目录、不搬文件；工作区冲突未解除时拒绝。

挂上后生成独立 participation/run 身份，启用目标记录本，详情显示“Claude · 终端 · 会话码”、目录、活动状态和其备注；即使只有一个参与者也显示。原终端事保留历史，目标事只显示参与信息与显式备注，不复制整段 transcript。桌面现有 `apps/desktop/src/modules/workbench-ledger.js` 少于两个 agent 隐藏，需调整；详情接线在 `apps/desktop/src/modules/conversation-work-detail.js`。

存量会话由主人在终端粘贴一次接入说明：调用新增记录本 CLI 桥，读当前事/分页记录、写短备注。桥使用本次挂入专属凭据，凭据放私有临时文件（0600），说明只给路径，不在送话、transcript、日志或 argv 放明文令牌；CLI 从该文件取回环地址及令牌。工具调用成功后才显示“记录本已接通”；未调用显示“已挂入，待接通”。不会使用 shell 的会话如实标不可接通，不能悄悄另起执行者冒充它。MCP 接入若需重开 CLI，必须明确提示，作为后续增强。

## 为什么先不自动接力

`src/features/terminal/terminal-say.ts` 的票代表送话/等回话；`src/features/terminal/reply-handler.ts`、`src/features/terminal/live-window.ts` 可走窗口送信或 resume，远端拒绝、非窗口的运行/待批轮拒绝，票会过期、重启会丢。送达、Stop、idle 都不能证明这一棒完成。

`src/domain/relay-decision.ts` 除末尾“状态:做完 / 没做完 / 要问主人”外，还查真实完成状态、不确定退出、悬挂提问/批准、计划当前棒、主人排队输入和下一执行者可用性；没有状态行还有正文判断。终端尚未提供与计划关联且可靠的一轮完成边界。推荐首版挂入不写进 matter_plans、不推进下一棒；摘下/结束只记参与结束，不宣告工作完成。后续再做终端执行适配器：绑定计划棒与投递轮、去重送话、明确完成回执、断线/重启恢复、主人插话和写入者退出确认，齐备后才以 terminal_say 为传输候选。只加一句状态要求远远不够。

## 权限与寿命

推荐令牌绑定 `{参与ID, 完整终端ID, 目标matter, 挂入代次}`，服务端查有效关系后才能读写；只放行记录本读写，首版不开放 `matter_context`（它会查话题摘要），更不开放主人对话、其他事、派活或权限批准。作者和 run 由服务端定，沿用每条 1000 字、每棒 50 条、每事显式备注 200 条及分页预算。记录本作为不可信资料，沿用现有封装。

摘下、SessionEnd、目标归档、登记处清退、换绑立即撤销；daemon 重启后旧令牌失效，参与历史保留，需主人重新接通。Stop 只是一轮结束，不撤销；stale 不当作完成，建议暂停访问并提示重新确认，补偿漏报 SessionEnd。摘下不杀主人终端，历史备注不删。令牌不进数据库、全局 MCP 配置或仓库。

这是 daemon API 的能力隔离，不是同一 OS 用户进程的沙盒；终端仍有主人的文件权限，不能声称它因此读不到磁盘上的其他私人数据。推荐明确承诺“这枚令牌只能访问这一件事”。

## 拆步与验收

1. **关系与鉴权（一个后端 PR）**：在 `src/adapters/store/matter-ledger.ts`、`src/features/workbench/service/ledger.ts`、`src/features/workbench/ledger-routes.ts`、`src/features/terminal/routes.ts` / `wire.ts` 增加参与身份、主人挂摘、只读写本事及撤销；`src/ports/matters.ts` 扩投影。当前迁移末号 `src/lib/db/migrations/v115.ts`，下一号 **v116**（实施前再查，非预占）：新增参与关系，含目标/来源、run、代次、挂摘时间，唯一活跃关系；不重写 cli binding。迁移接线及测试按 `docs/maintainer/migrations.md`。记录本 enabled 条件也须识别终端参与，不能仍要求两个 agent。
2. **接通与展示（一个贯通 PR）**：扩 `src/cli/terminal-hooks.ts` 邻近的 CLI 接线实现窄桥，复用记录本服务；修改上述桌面详情/记录本组件。新增路由登记在 `packages/protocol/src/routes.ts`，生成物按维护手册更新。验收覆盖授权人、短码歧义、重复挂入、跨事伪造、作者伪造、额度、单参与者显示、摘下/结束/重启后拒绝、不触发自动接力。
3. **隔离真流程验收（一次独立验收）**：专用临时 stateDir、测试库、回环端口和 CLI 配置目录，隔离 daemon 关闭微信/陪伴定时动作，不复制生产凭据。在专用 mini 用真实终端 CLI + 本地假模型/测试驱动验证 hook 报到→挂入→终端读写→详情可见→摘下后原凭据拒绝；Claude/Codex 分别验证，主人入口再按总纲用 Claude/网关模型的离线协议回放各走一遍。真实外网模型联调另由整合者在受保护主机串行执行；不拿本次写稿任务启动任何 daemon 或 live API。

**请主人拍板**：是否同意首版仅记录本与详情、采用“粘贴一次接入说明”的存量会话方案，以及首版禁止与工作台同时执行。以上均为本文推荐，未把自动接力能力提前算作完成。
