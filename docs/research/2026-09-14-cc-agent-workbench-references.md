# CC 任务工作台：项目参考与借鉴边界

核验日期：2026-09-14（UTC；洛杉矶为 2026-09-13）。本文归并 9 月 12—13 日的研究记录，并重新打开作者维护的 GitHub 仓库、固定版本源码及 OpenAI 官方文档。默认分支说明可能继续变化；固定版本链接保留当时的研究依据。本次没有安装或运行参考项目，也没有导入其实现代码。

改动任一条借鉴、或引用本文论证某项能力之前，先复检链接是否还活着：

```bash
grep -oE '\]\(https://[^)]+\)' docs/research/2026-09-14-cc-agent-workbench-references.md \
  | sed 's/^](//; s/)$//' \
  | while read u; do echo "$(curl -s -o /dev/null -w '%{http_code}' -L -m 25 "$u")  $u"; done
```

固定版本链接不会因上游改动而失效，默认分支链接会。顺带一个坑：deepseek-harness 的默认分支是 `master` 不是 `main`，按 `main` 去抓会拿到 `404: Not Found` 的正文而不是错误码，容易被误读成"该项目已删库"。

## Paseo：后台会话与多个入口

[getpaseo/paseo](https://github.com/getpaseo/paseo) 用本机 daemon 管理 coding agents，桌面、手机、网页和 CLI 连接同一后台；执行使用用户机器上的开发环境。[^paseo-name]

CC 借鉴后台持有执行会话、界面订阅进展的分工，落实为切换页面后仍能继续查看任务，以及桌面与微信共用任务记录。研究固定在 `d1b705a0` 的 [Claude adapter](https://github.com/getpaseo/paseo/blob/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/server/src/server/agent/providers/claude/agent.ts)，包括持续 query、订阅者与 foreground/autonomous 状态。CC 没有因此获得 Paseo 的全部客户端、设备中继或插件能力，也不照搬其权限策略。

这份材料还回答了一个 CC 自己悬着的问题。那个 adapter 是**单家**执行者的适配，在固定版本上有 6386 行 —— 认真接一个执行者（持续会话、订阅者、前台/自治回合状态机）的真实价格就是这个量级。CC 的 `executor-capabilities.ts` 要求 `permissions:'task'` 与 `configuration:'task-policy'`，而 cursor / agy 是 `perToolCallback: false` 且只读自己的全局配置，两条都不满足。所以"要不要接 cursor/agy"不是排期问题：先得有人付这个价，或者放宽契约。

## Orca：项目隔离、成果检查与退出确认

[stablyai/orca](https://github.com/stablyai/orca) 将多个 coding agents 放在独立 Git worktree 中并行工作，提供终端、文件和差异查看，也有手机与远程运行入口。

CC 借鉴项目边界和成果核对，结合普通文件夹设计自己的目录占用、任务身份及成果快照。固定版本 `403b62a8` 的 [会话关闭实现](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/codex/codex-structured-session-close.ts) 在观察到退出前保留会话，并核对会话代次；这支撑了 CC“停止请求不等于执行者退出”的生命周期要求。CC 的目录排队不等同于 Orca 的 worktree 隔离，也不代表已经实现完整 IDE、SSH 工作区或任意 agent 并行编排。

## CC Switch：已有配置与会话入口

[farion1231/cc-switch](https://github.com/farion1231/cc-switch) 是多种 AI 工具的桌面配置管理助手，当前说明包含供应商配置切换、MCP/Skills 管理、会话历史、本地代理与故障转移。应依据其 [功能说明](https://github.com/farion1231/cc-switch#features)，将它与 README 中赞助商宣称的网关服务区分开。[^ccswitch-name]

CC 借鉴减少重复配置、提供清楚的继续入口，并参考 `1d5d90f4` 的 [会话列表项](https://github.com/farion1231/cc-switch/blob/1d5d90f4aba88447d422a16cdec5282ec5331fd7/src/components/sessions/SessionItem.tsx) 呈现标题、执行来源和时间。CC 没有移植其代理、供应商预设或自动故障转移；“复用已有配置”也不表示可随意接管外部正在运行的会话。

## Codex：原生协议与真实事件身份

[openai/codex](https://github.com/openai/codex) 提供终端 coding agent 的开源实现。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 将集成对象分为 thread、turn、item，并提供历史、审批和流式事件；[官方 SDK 文档](https://learn.chatgpt.com/docs/codex-sdk) 说明如何启动、继续和恢复本地任务。

CC 使用原生 SDK/app-server 接口，保留会话、回合和操作身份，让审批、取消和历史续接对应实际执行。既有后台研究还核对了 `rust-v0.153.4` 的 [turn processor](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/request_processors/turn_processor.rs)。接口集成不代表 CC 与 Codex App 功能等同；兼容性须按实际运行版本验证，不能以最新网页替代已有实测记录。

## DeepSeek Harness：已确认来源，仍属架构参考

既有研究明确给出了 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，本次已核对，无需按名称猜测。该项目以插件组合 agent harness，当前 README 标为 developer preview，提示兼容性仍会变化。

`c291e796` 的 [MCP client 设计记录](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.md) 区分配置中的服务器身份、模型看到的工具名与线上调用的原始工具名。CC 在原生能力研究中采用这种精确身份边界；这不是 DeepSeek Harness 适配器已落地的声明。通过兼容 API 选择模型，也不等于运行了该 harness。

## 回合、会话、租约：三家都分开

CC 里"这件事做完没有"曾经答不一致：Codex 任务答完自动变成 `completed`，Claude 任务答完停在 `running`。查下来根因是**同一个词 retained 两种含义**——Codex 运行时把它定义为"还有命令或子进程在跑"，没有就自行收尾；Claude 运行时把它定义为"SDK 的 query 流还活着"，于是答完也永远为真、这条 run 永不结算。三家参考项目在这一点上一致：回合、会话、资源占用是三条轴。

- **Paseo**（`agent.ts` @ `d1b705a0`）：`type TurnState = "idle" | "foreground" | "autonomous"`（第 272 行）；`turn_completed | turn_failed | turn_canceled` 是**回合级**终止事件，发出后 `syncTurnState()` 把状态退回 `idle`（第 3415–3432 行），而会话继续存在。回合有终点，会话另有寿命。
- **Codex**：协议对象就是 `thread → turn → item`，`turn/completed` 是一等公民消息；CC 的 `codex-app-server.ts` 已经在消费它。
- **Orca**（`codex-structured-session-close.ts` @ `403b62a8`）：会话关闭是一份**租约**——`ended` 事件带 `cause: 'requested-close' | 'unexpected-exit'`、`acquisitionGeneration`、`fence`；注释原话是每条退出路径都得结算，否则 *"waiting for a second callback would strand the lease"*。他们专门防的就是"资源被一个已经结束的东西永久占住"。

CC 两边其实都已握有回合终点（Codex 的 `turn/completed`；Claude SDK 的 `result` 事件，`claude-workbench-runtime.ts` 收到后置 `foreground='idle'`），缺的是拿它驱动三件事：成果登记（2026-09-15 已改为回合落定即登记）、用户可见的状态（统一为「已答复」）、目录租约（答复后释放、续接时再申请）。后两项的落地进度见 [工作台导览](../cc-workbench.md) 的修订记录。这里没有照搬 Orca 的 worktree：CC 的目录占用是普通文件夹上的租约，不是隔离副本。

## 协议层的借鉴：不守规矩的端点怎么处理

上面五段都是架构形状的借鉴。但 CC 实际出的事故是协议形状的 —— 2026-09-08 cursor 的 envelope 跟我们类推的形状完全不同、一个 tool_call 都没解析出来；2026-09-14 某网关的 DeepSeek 把思维链内联进 `content`，`<think>` 就这么当成回复发给了主人。这一节记各家在这一层怎么做，以及 CC 实际采用了谁的。

推理内容（reasoning）的处理分两派：

| 项目 | 做法 | 依据强度 |
| --- | --- | --- |
| Codex | 协议一等公民：`ReasoningItemContent`、`ReasoningContentDelta` 流事件 | 仓库代码检索 |
| DeepSeek Harness | `reasoning_content` 类型字段 | 仓库代码检索（`packages/llm/llm-deepseek/src/types.ts`） |
| Orca | `reasoning_content` 随会话结构化落库 | 仓库代码检索（`src/relay/hermes-session-run-database.ts`） |
| Paseo | 不适用 —— 它包的是 agent CLI，不碰裸 chat completions | 检索无命中 |
| CC Switch | 唯一处理**内联 `<think>` 标签**的 | 已打开固定版本源码 |

四家把 reasoning 当独立频道，只有 CC Switch 额外管内联标签，而且是降级兜底：`42ac174d` 的 [reasoning 字段抽取与标签剥离](https://github.com/farion1231/cc-switch/blob/42ac174dbc42e0cf50a50e60c5f2c3dcecca4560/src-tauri/src/proxy/providers/codex_chat_common.rs) 先穷举 `reasoning_content` > `reasoning` > `reasoning_details`，抽不到才走 `split_leading_think_block`，而且**只认开头**；[流式实现](https://github.com/farion1231/cc-switch/blob/42ac174dbc42e0cf50a50e60c5f2c3dcecca4560/src-tauri/src/proxy/providers/streaming_codex_chat.rs) 是 `Detecting / Reasoning / Text` 三态机加一个 `NeedMore`，处理标签被切在 chunk 边界上的情况，并带 MiniMax 的测试样本。

CC 修 `<think>` 泄漏时采用了这个顺序，但结论不同：`@ai-sdk/openai-compatible` 已经把 `reasoning_content` 解析成 `reasoning-delta`，我们两条流都不消费它，所以结构化那半截天然成立，只需要补内联兜底；剥下来的内容 CC 丢弃而非保留成 reasoning（我们没有 reasoning 频道）。以后若要做可折叠的思考行，数据源应当是 `reasoning-delta`，**不是**剥标签的兜底 —— 兜底只在端点不守规矩时才有内容，形状随供应商变。

这一节的存在本身是个教训：文档写在任何人拿真实端点跑过之前，所以五段借鉴全是架构形状的，而最后真正用上的那条在此之前不在文档里。以后每收一个参考项目，除了"它怎么分层"，还要记一句"它怎么处理脏数据"。

## 如何理解这些参考

以上是设计借鉴和接口参考，不能用上游功能清单证明 CC 已具备相同能力。CC 当前批次的 API 任务执行器另有[独立契约](../superpowers/specs/2026-09-14-cc-api-task-executor.md)：受限材料读取、目录列表、成果生成及 CC 管理的续接记录；不据此承诺原生 CLI 的 shell、MCP 或后台进程能力。

借鉴如何落实、哪些检查真正运行过，分别见[任务入口范围](../superpowers/specs/2026-09-12-cc-task-entry-scope.md)、[并发验证](../superpowers/reports/2026-09-12-cc-task-concurrency-validation.md)及[原生能力研究](../superpowers/reports/2026-09-13-cc-native-capabilities-and-wechat.md)。这些文件也有各自日期；历史缺口须结合后续交付记录阅读。本次资料核验不补充实机或真实模型验收结论。

[^paseo-name]: 这里明确指 **Paseo**，此前把它与 Parea 等评估平台混同的描述不适用。
[^ccswitch-name]: 概括成“破解工具”或通用智能任务路由器均不准确。
