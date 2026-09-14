# CC 任务工作台：项目参考与借鉴边界

核验日期：2026-09-14（UTC；洛杉矶为 2026-09-13）。本文归并 9 月 12—13 日的研究记录，并重新打开作者维护的 GitHub 仓库、固定版本源码及 OpenAI 官方文档。默认分支说明可能继续变化；固定版本链接保留当时的研究依据。本次没有安装或运行参考项目，也没有导入其实现代码。

## Paseo：后台会话与多个入口

[getpaseo/paseo](https://github.com/getpaseo/paseo) 用本机 daemon 管理 coding agents，桌面、手机、网页和 CLI 连接同一后台；执行使用用户机器上的开发环境。这里明确指 **Paseo**，此前把它与 Parea 等评估平台混同的描述不适用。

CC 借鉴后台持有执行会话、界面订阅进展的分工，落实为切换页面后仍能继续查看任务，以及桌面与微信共用任务记录。研究固定在 `d1b705a0` 的 [Claude adapter](https://github.com/getpaseo/paseo/blob/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/server/src/server/agent/providers/claude/agent.ts)，包括持续 query、订阅者与 foreground/autonomous 状态。CC 没有因此获得 Paseo 的全部客户端、设备中继或插件能力，也不照搬其权限策略。

## Orca：项目隔离、成果检查与退出确认

[stablyai/orca](https://github.com/stablyai/orca) 将多个 coding agents 放在独立 Git worktree 中并行工作，提供终端、文件和差异查看，也有手机与远程运行入口。

CC 借鉴项目边界和成果核对，结合普通文件夹设计自己的目录占用、任务身份及成果快照。固定版本 `403b62a8` 的 [会话关闭实现](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/codex/codex-structured-session-close.ts) 在观察到退出前保留会话，并核对会话代次；这支撑了 CC“停止请求不等于执行者退出”的生命周期要求。CC 的目录排队不等同于 Orca 的 worktree 隔离，也不代表已经实现完整 IDE、SSH 工作区或任意 agent 并行编排。

## CC Switch：已有配置与会话入口

[farion1231/cc-switch](https://github.com/farion1231/cc-switch) 是多种 AI 工具的桌面配置管理助手，当前说明包含供应商配置切换、MCP/Skills 管理、会话历史、本地代理与故障转移。应依据其 [功能说明](https://github.com/farion1231/cc-switch#features)，将它与 README 中赞助商宣称的网关服务区分开；概括成“破解工具”或通用智能任务路由器均不准确。

CC 借鉴减少重复配置、提供清楚的继续入口，并参考 `1d5d90f4` 的 [会话列表项](https://github.com/farion1231/cc-switch/blob/1d5d90f4aba88447d422a16cdec5282ec5331fd7/src/components/sessions/SessionItem.tsx) 呈现标题、执行来源和时间。CC 没有移植其代理、供应商预设或自动故障转移；“复用已有配置”也不表示可随意接管外部正在运行的会话。

## Codex：原生协议与真实事件身份

[openai/codex](https://github.com/openai/codex) 提供终端 coding agent 的开源实现。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 将集成对象分为 thread、turn、item，并提供历史、审批和流式事件；[官方 SDK 文档](https://learn.chatgpt.com/docs/codex-sdk) 说明如何启动、继续和恢复本地任务。

CC 使用原生 SDK/app-server 接口，保留会话、回合和操作身份，让审批、取消和历史续接对应实际执行。既有后台研究还核对了 `rust-v0.153.4` 的 [turn processor](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/request_processors/turn_processor.rs)。接口集成不代表 CC 与 Codex App 功能等同；兼容性须按实际运行版本验证，不能以最新网页替代已有实测记录。

## DeepSeek Harness：已确认来源，仍属架构参考

既有研究明确给出了 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，本次已核对，无需按名称猜测。该项目以插件组合 agent harness，当前 README 标为 developer preview，提示兼容性仍会变化。

`c291e796` 的 [MCP client 设计记录](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.md) 区分配置中的服务器身份、模型看到的工具名与线上调用的原始工具名。CC 在原生能力研究中采用这种精确身份边界；这不是 DeepSeek Harness 适配器已落地的声明。通过兼容 API 选择模型，也不等于运行了该 harness。

## 如何理解这些参考

以上是设计借鉴和接口参考，不能用上游功能清单证明 CC 已具备相同能力。CC 当前批次的 API 任务执行器另有[独立契约](../superpowers/specs/2026-09-14-cc-api-task-executor.md)：受限材料读取、目录列表、成果生成及 CC 管理的续接记录；不据此承诺原生 CLI 的 shell、MCP 或后台进程能力。

借鉴如何落实、哪些检查真正运行过，分别见[任务入口范围](../superpowers/specs/2026-09-12-cc-task-entry-scope.md)、[并发验证](../superpowers/reports/2026-09-12-cc-task-concurrency-validation.md)及[原生能力研究](../superpowers/reports/2026-09-13-cc-native-capabilities-and-wechat.md)。这些文件也有各自日期；历史缺口须结合后续交付记录阅读。本次资料核验不补充实机或真实模型验收结论。
