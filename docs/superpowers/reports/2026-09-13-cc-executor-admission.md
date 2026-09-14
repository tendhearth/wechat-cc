# 工作执行者能力准入与原生可行性

2026-09-13，`codex/cc-workbench-v1`。本记录描述本地开发版本，不代表已推送、部署或完成用户真实账号验收。

## 完成的行为

工作台从代码注册时的明确能力契约选择执行者，不再仅看 Claude/Codex 名字，也不把普通聊天的 provider 注册视为完整工作能力。专用 Claude SDK / Codex app-server 接入显式声明；原有 Cursor/agy/API 聊天接入未自动升级。

创建、补充、继续、重开、原生恢复、交接与实际派发共用检查。附件和执行设置不支持时，在绑定附件、接受输入和写入交接记录前拒绝；恢复能力缺失沿用明确重开确认。排队期间能力变化会在真正派发前再次检查。用户仍能停止已有运行、查看记录和成果。

HTTP 创建、模型查询和交接支持有界执行者编号，再交给服务决定是否准入。原生历史导入仍只支持已实现的两个 reader。桌面错误保留可操作的原因，没有新增能力表单。普通交接动作不再写死两个品牌。

微信可以使用 `任务 新建 <项目编号> 用 @<执行者编号> <要求>` 明确选择。旧 `用 Claude` / `用 Codex` 保持兼容；`用 Python 处理数据` 保持为普通要求。未知或无效的 @ 选择不能退回默认执行者，帮助示例取自真实返回的可用选择。

这为新增执行者提供了可验证的入口，**本轮并未新增可生产使用的第三个执行者**。能力声明由适配器代码承担责任，不是模型自述、用户开关或操作系统沙箱证明。

## 验证与独立复核

- 最终相关回归：**60 文件、839 项通过**。覆盖核心工作台、注册表、桌面模块、内部 API、通知/文件启动接线。
- 全仓 typecheck 通过；diff 检查通过。
- TDD 记录：纯契约七个缺失检查、服务六项旧准入行为失败；随后增加交接和入口边界回归。日志分别在 `/tmp/cc-executor-capabilities-red.log`、`/tmp/cc-executor-handoff-red.log`、`/tmp/cc-executor-wechat-red.log`。
- 独立复核识别并修复四项 P2：交接品牌限制、继承旧附件在交接落库后才拒绝、HTTP 创建/模型查询品牌限制、能力错误被映射为不明 500。
- 复核再次使用真实服务/SQLite/路由处理器及拥有的合成执行者重现：新编号创建返回 202；能力不足返回明确 422；附件拒绝前后事件和交接记录不变，恢复能力后同一预览仍可接受。最终范围内无剩余 P1/P2。

最终日志：`/tmp/cc-executor-admission-regression.log`、`/tmp/cc-executor-admission-typecheck.log`。Vitest 仍提示已有 vendor `marked.bundle.mjs.map` 缺失，未引起断言失败，本轮未改 vendor。本轮没有运行或宣称全仓 vitest；此前 settings-panel HTTP 超时基线仍按既有记录保留。

## 已安装 CLI 的只读调查

没有执行模型任务，没有读取认证值或用户配置内容。只查看命令帮助、版本和已安装程序的公开代码；以下是该版本的实现证据，不能推导未来版本接口稳定。

### Cursor

版本目录：`~/.local/share/cursor-agent/versions/2026.09.02-c22c1a3/`。

- `index.js` 中 `cursor-config/dist/paths.js` 支持 `CURSOR_CONFIG_DIR`、`CURSOR_DATA_DIR`；但 `mcp/loader.js` 独立读取 home/project `.cursor/mcp.json`。
- `190.index.js` 的 hooks loader 读取 home/project Cursor hooks、Claude settings 和企业 hooks；`4347.index.js` 使用 terminal executor 执行 hooks，并合并团队/插件 hooks。
- 隐藏 `--disable-project-configs` 只排除 `.cursor/cli.json`。没有找到完整的 hooks/plugins/MCP 排除机制。
- headless 在内部处理权限决定和 `interaction_query`；没有找到 CC 可回答的权限输入桥。问题会被本地跳过，不能把该事件包装成可交互提问。
- ask 模式的只读策略依赖 sandbox 可用且启用；不能由 ask/plan 推导完整副作用隔离。

因此已有 Cursor 聊天适配器不满足工作台准入。其当前 `close()` 也没有等待执行资源确认退出。下一项可行性实验应使用外部隔离边界和拥有的快照项目，先确认配置排除，再考虑有限审查接入。

### agy

`agy --version` 返回 **1.2.2**。检查 `~/.local/bin/agy` 的 Go 函数元数据和针对性静态代码：

- 存在隐藏 `--gemini_dir` 与 `--app_data_dir`，由 `SetGeminiDir` / `SetAppDataRelDir` 应用，是拥有的配置根探测起点；尚未证明排除所有项目插件、hooks、MCP。
- `printmode.(*session).handleStreamMessage` 处理 user 回合，但明确拒绝 `control_request` 和 `control_response`。stdin stream-json 并不等于权限答复通道。
- `printmode.cleanupBackgroundTasks` 区分 daemon 任务并允许其退出后留存，不能把 CLI 进程退出视为全部任务资源终止。
- 静态定位：handleStreamMessage 为 `__text + 0x2598250`；控制消息拒绝字符串文件偏移 `0x2f9b168`；cleanupBackgroundTasks 为 `__text + 0x25923f0`，daemon 留存消息为 `0x2f75884`。

agy 需要自己的权限与后台生命周期方案。隐藏参数和帮助文本不作为正式支持承诺，原适配器保持未准入。用户允许后续使用 Cursor/agy 模型验证，本轮没有为得出乐观结论而运行不受本任务管理的配置。

## 整体目标仍在进行

CC 的价值仍是跨执行者任务记录、集中处理权限、固定版本交接、成果检查和微信连续性。此切片提高接入可信度，不证明覆盖了绝大部分 CLI/App 能力。真实多执行者日常验收、更多原生/API 接入、自动独立工作区和跨电脑接管仍需继续。
