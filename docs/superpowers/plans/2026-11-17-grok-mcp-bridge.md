# Grok 会话 MCP HTTP 转接交接（2026-11-17）

工作区 `/Users/nategu_mac_company/Documents/tendhearth/wt-grok-mcp`，分支 `grok-mcp-bridge`，基线 `origin/dev` / `fe887741f991f85ca65852f82393374ef4a68fff`。本分支仅开发、离线验证和提交，不 push、不建 PR、不合并、不部署。整合、三平台 CI、真模型和日常部署留给整合者。

本轮补上 [上一轮交接](2026-11-16-grok-acp-executor.md) 所述 HTTP/SSE 与 stdio 的缺口。原文中的“Grok 永远无 CC 工具”描述由本轮按会话协商取代；账号隔离、网络预检、访客拒绝和原生工具权限策略仍适用。

## 设计与监听方式

每次 Grok spawn 先完成原有专属 HOME / 登录存在性检查、网络预检、ACP `initialize` 和可选认证，再读取 `agentCapabilities.mcpCapabilities.http`。只有严格等于 `true` 才创建桥；不支持、缺位、缺 spec 或启动失败时发送 `mcpServers: []`，使用真实的“未接入工具”提示词。

选择 **每会话一个 `127.0.0.1:0` HTTP listener**。该 listener 属于 daemon 内的会话对象，每个 stdio spec 对应 `/mcp/0`、`/mcp/1` 等路径与一个 MCP SDK `StreamableHTTPServerTransport`。没有新 daemon 公共路由、持久 endpoint 表或内部 API token 类型。相比复用已有本机 HTTP 服务，这样无需扩大共享路由权限，也不牵连手机代理、中继或生产 listener 的启动/关闭顺序；会话关闭就能撤掉整个监听。

- 对话使用 boot 创建的 `wechatStdioMcpSpec(internalApi, 'grok')` 与 `delegateStdioMcpSpec(..., 'claude')`；不复用 Cursor 的 participant 标识，也不加载用户/第三方插件。
- 与 Cursor 共用 `acpMcpServersFor`：PATH/HOME → spec.env → 仅 CORE 名字 `wechat` / `delegate` 的 context.mcpEnv。记录本名 `wechat-cc-matter` 不会额外获得会话 env，授权来自原有 matter spec.env。
- 工作台走相同转接，spec 由已有 `MatterMcpFactory(context)` 创建，与 Cursor 的记录本范围一致；不把对话 wechat/delegate 带进工作台。
- 只转发 JSON-RPC envelope，保留 id、method、params、result/error 与通知内容；不检查、不重写工具调用，不复制工具权限判断。
- HTTP 使用现有 MCP SDK 的有状态 Streamable HTTP transport，负责 POST 应答、202、GET SSE、协议版本与 MCP session id。stdio 使用 daemon 自己的 `spawn`，不使用会额外继承环境变量的 SDK stdio launcher。
- 通知优先走已连接的 GET SSE；没有 GET 时走正在等待的 POST SSE；没有消费者时排队，最多 100 条 / 4 MiB，超限撤桥。每条只发一个流。stdio 单条消息也限 4 MiB。

ACP v1 官方规范确认 HTTP 条目为 `{ type: 'http', name, url, headers: [{name, value}] }`，原本仅 stdio 的本地类型已扩展为联合类型。参考：[ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)、[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。

**仅 `sse: true` 时保守回退**：ACP 将旧 SSE 与 HTTP 分别声明，旧 SSE 使用不同握手，不能把 HTTP 条目发给只支持 SSE 的 agent。本轮实现指定的 Streamable HTTP，不实现已废弃的旧 SSE；测得的 Grok 同时声明 http/sse，因此正常路径受 http 门控。Streamable HTTP 内的 SSE 通知已覆盖。

## 认证、安全边界与撤销

每个桥使用 `crypto.randomBytes(32)` 生成一把 bearer，同会话的各 MCP 端点共用该 bearer。它只通过 ACP HTTP 条目的 Authorization header 传给 Grok；URL、命令参数、MCP 子进程环境、daemon 数据库与日志均不携带它。MCP session id 是传输标识，不能代替 bearer。

认证在路径查找前执行。对 Authorization 与预期值做固定长度 SHA-256 摘要的 `timingSafeEqual` 比较；缺失、错误、其他/旧会话 token 对任何路径都得到空体 401。校验 Host 为实际回环 origin；存在 Origin 时必须与该 origin 相同，没有 CORS 放行。

`close()` 在任何 await 前将 active 置为 false：撤销窗口内返回 401，清理完成后 listener 关闭。会话 close / SessionManager shutdown（含 pending spawn）、ACP 进程退出或错误、MCP 子进程退出或流失败、显式取消/停止消费、idle timeout、HTTP DELETE 都收回同一桥。先关 HTTP/SSE transport，再结束 stdin，SIGTERM 后有界升级 SIGKILL，核对进程组已经消失；不能确认会抛清理错误，不能假称退出成功。SessionManager 为准备阶段持有 AbortController；shutdown / shutdownProtected 在首次 await 前同时收回现有会话与准备中的桥，并阻止被取消的 spawn 入缓存。Grok 会话持有 MCP 进程组用于工作台关闭证据。取消含工具的会话会关闭该 ACP 会话，后续不能复用失效工具；新 spawn/resume 创建新 bearer。

stdio stderr 只排空、不保留也不转日志；转接失败只记固定文字。ACP 诊断和回包入口脱敏，助理文字另用跨分块 redactor，防止 agent 将 header 原文回显进回复；被撤掉桥的 redactor 仍保留到整个会话释放。该 bearer 仅在进程内存和发送给 Grok 的 ACP 配置中存在，CC 不将它写盘。外部 Grok 自身遵守 ACP 凭据不落日志/历史的要求，仍需整合者真机核实。

权限仍由原 stdio MCP 按会话 tier / token / notebook baton 判断；访客不能启动 Grok，因为原生工具面仍无沙盒。没有改变官方端点、代理或网络守护。一次代答保持原先纯文字、无 MCP 行为，不加载私人记忆指令。

## 能力与失败回退

`ACP_GROK_CAPABILITIES` 声明可支持按会话 MCP（`mcpTools: 'session'`）、admin tier 与委派，默认 peer 为 Claude；这表示可支持的上限。spawn 前提示词仍默认无工具。SessionManager 提供 `instructionsForMcp`，桥成功后按实际 wechat/delegate 集合重新构造 daemon 提示词；失败时构造无工具版本，避免靠字符串删改提示词。最终指令长度也用于会话上下文计量。

`AgentSession` / `SessionHandle.supportsDelegation` 是实际可用性 getter，撤桥立即变 false。primary_tool 遇到 false 会告知本会话未接入委派。工作台 `reportMatterTools` 仅在实际注入记录本端点时为 true，失败为 false。

若 agent 明确用 ACP 请求错误拒绝带 MCP 的 `session/new` / `session/load`，先撤桥，再用空 MCP 对**相同方法**重试一次并降级提示词。认证错误、进程断线和一般运行失败不走此回退，不发送额外模型请求；resume 保持原有 strict 语义。提示词/工具报告回调在桥启动后抛错，也会先关闭桥再回退，不遗留令牌或子进程。

## 验证与红/绿

测试只增加。原能力测试和执行矩阵快照只更新 Grok 的真实 MCP 可达性；访客与原生工具约束未放松。错误码守卫登记了转接内部码。

- 新增传输测试：正确/错误/缺失/旧 token；未知路径的相同 401；撤销窗口 401 与 listener 关闭；32 字节随机凭据只在 headers；URL/argv/子进程环境/日志无桥 token；Origin 拒绝；真实假 stdio initialize → tools/list → tools/call；POST/GET SSE 通知、并发 POST、无消费者排队；部分 spawn 失败清理；子进程退出撤桥。
- 新增 Grok 接线测试：能力缺位/false/sse-only 不注入；成功后真实 daemon 提示词、委派与记录本授权；启动失败和 ACP 显式拒绝的空 MCP 回退；提示词回调失败清理；新/resume token 轮换；活动/空闲取消、ACP 退出、SessionManager shutdown（包括卡在 session/new 与同时存在 live/pending 的情况）；跨分块凭据回显脱敏及原有消息/工具边界不变。
- 红/绿命令：`bun --bun vitest run src/adapters/executors/acp/acp-grok-mcp.test.ts -t 'uses the real SessionManager'`。临时将 http 成功路径改为直接 fallback，成功接线用例红（expected true to be false）；恢复后两项绿。撤掉的仅是该注入分支，测试与其余代码保留。
- pending shutdown 红/绿：`bun --bun vitest run src/adapters/executors/acp/acp-grok-mcp.test.ts -t 'revokes a bridge during pending ACP'`；临时撤掉 manager 的 preparation abort 后，桥 active=true 的断言红；恢复后绿。
- 自然退出的清理回归曾在 stdio EOF 与 exit 之间因瞬时 EPERM 报失败；改为有界发信号并以最终进程组退出确认后，原测试绿。独立只读复核另发现完整消息被 streaming redactor 拆开、shutdown 先等 pending 导致 live token 延迟撤销，均补确定性测试并修正。
- `bun run verify` 使用临时 HOME、受控 PATH 和最多两个 worker；CLI 版本探测使用离线替身，避免真实 Grok/供应商 CLI。第一轮根 typecheck、depcheck（0 errors / 16 条既有 warnings）、4,332 项相关测试与 26 项真实形状沙盒通过，另发现预期能力快照及内部错误码登记待同步，已修正。
- 最终完整 verify 与 Node 定向复验结果在本文件末尾追加。

## 已知限制与整合者验收

不运行真实 Grok、真实模型、登录命令或真实网络预检；不接触运行中的 daemon、生产数据库或主人 Grok 登录文件。端口测试可运行，没有按 listen 权限跳过用例。没有进行 UI、Playwright、模拟器、截图、Rust/tauri 或重型构建。

桥创建成功表示本地子进程和 listener 已准备、ACP 接受了配置，不等于 Grok 模型一定看见或调用了工具；ACP 没有逐 MCP 成功确认字段。Grok 客户端的具体 MCP 初始化、严格模式下是否对工具调用再提权限请求、请求超时和凭据本地持久化，都需要真模型验证。没有 SSE event replay / Last-Event-ID 恢复；断线期间有界排队不等于跨进程可靠投递。SIGKILL / 系统崩溃无法执行 daemon 的正常收尾；本轮验证的是正常 shutdown 与会话撤销。

整合者按下列顺序串行验收，使用现有网络保护和 CC 专属 HOME 的独立登录，不复制登录文件：

1. PR 说明采用每会话回环随机端口的理由、上述 sse-only 回退取舍，填写 `## 红/绿`；能力快照属于行为同步，`## 删掉/放松的测试` 说明未删用例、只更新 Grok 能力预期。等三平台 CI 后合入 dev。
2. 用 Grok 对话执行编造数据的 wechat `ping`，再做一次 delegate_claude 咨询；同时观察 ACP 工具事件与实际工具副作用，不能只凭模型声称成功。分别测 admin 与 trusted 工具范围；访客仍拒绝启动。
3. 工作台创建独立 scratch 任务，经真实 matter baton 调用记录本读取/写入；没有 baton 时拒绝。不得把对话 wechat/delegate 注入工作台。
4. 无 HTTP capability、无法启动 stdio、明确 MCP 配置拒绝时确认提示词和回复如实无工具；账号过期/网络断开仍走原提示、无额外模型重试。
5. 对话停止、工作台取消、agent 退出、daemon 正常关闭后核对端口关闭和 MCP 进程组退出；新会话/续接只使用新凭据。安全检查只报告成功/失败，不输出 bearer、环境或登录内容。
6. 核实真实 Grok 不把 ACP headers 写入配置/日志/历史，工具初始化与调用不会把 bearer 放入模型上下文。若发现凭据持久化，应停止启用并修正客户端，不靠桥端 URL 隐藏代替。
7. 后续 UI 在 mini 离线验收，真模型及最终部署由整合者在保护主机按原流程完成，留完整回滚包；本分支不执行。
