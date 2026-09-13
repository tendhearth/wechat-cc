# CC 后台执行会话交付记录

日期：2026-09-13。工作区 wechat-cc-cc-kit，分支 codex/cc-workbench-v1，基线 8dc06d52。

状态：本轮原生、服务、界面验证和独立复核完成，保存在本地开发分支。没有推送、合并、重新安装桌面程序或重启正式 bot；整个统一入口目标仍在进行。

## 用户可见的变化

工作台用同一条完整对话接收主回复、后台子助手结果和原生自动补充回复。主回复穿插显示；子助手公开回答留在对应的可展开操作记录中，不伪装成主执行者回复。已有操作记录的折叠方式保留。

观察到后台执行，或向同一原生会话提交额外输入后，这个会话保持连接。仍有执行时显示执行状态；没有观察到执行时显示“会话保留中”，不显示永远转动的执行标志。这只是观察到的状态，不是原生所有队列已经排空的证明。

补充先保存持久回执，再交给原生。界面区分等待确认、已交付、已保存但尚未发送和未确认交付。停止时不能把正在等待确认的内容改写成确定没有发送；迟到确认只更新原始回执。当前执行者只能保存补充时，桌面和微信都不承诺会自动进入下一轮。

“结束后台会话”停止仍在执行的受管理工作，确认资源退出之后才保存最终成果、释放同目录下一项任务。关闭无法确认时保留目录隔离。停止保持“已停止”，不把它包装成全部成功完成。

## 原生协议为什么需要单独处理

Claude Code 2.1.267 / Agent SDK 0.2.116 的父 result 之后，子任务可以继续发送通知，并触发额外的自动主回复。实测两个子任务先后完成时，第二个通知排在第一个自动回复之后：后台数量归零之后的下一个 result 也不一定是最后一个。公共接口没有经过验证的通知排空屏障。

Codex 0.153.4 的父 turn/completed 不结束子 turn，父 interrupt 不递归停止所有子任务。V1/V2 的原生子回复可继续通过同一 app-server 到达；子身份必须使用 thread ID 和 turn ID，不能使用可能与父相同的 sessionId。旧父轮次上的晚到完成记录仍需要保留，但不能重新授予旧轮次权限。

因此此次采用一个原生 runtime 对应一个固定 CC task/run 的方式。目录身份、权限凭证、模型设置和输入回执保持原来归属；不把迟到消息绑定到“最新的一轮”。仅经过实际版本验证的单次输入、无后台任务可以自动收尾；未知版本保守保留。

## 已完成的证据

### Claude

生产适配器调用真实 SDK/CLI，以临时 HOME、项目、假凭证和仅回环模拟模型端点运行。没有使用用户真实模型服务、未知 MCP、真实微信或内部 session-state 开关。

七个模式全部通过：plain、pair、pair-input、bash、bash-close、close、interrupt。原生 UUID replay 匹配额外输入；两个补充可以在原生合并或延迟处理，CC 不发明一条输入对应一个新回合。等待原生回显期间，回执仍为等待确认。

关闭探针确认父进程和另起进程组的 Bash / sleep 均退出。实现先冻结并记录仍属于自己进程树的后代，再直接终止已记录的组，不恢复其信号处理器；所有阶段共用 2.5 秒截止时间。独立审查复现了 TERM 处理器另起进程的旧漏洞，修正后同一探针不再产生该后代。丢失归属、无法读取进程表或无法确认退出都不能算关闭成功。

4 个 Claude 测试文件、81 项测试通过，其中包括 57 项原有路径测试。最终原生记录位于 `cc-claude-background-sDxwdK`，索引 `/tmp/cc-claude-background-final-production.log`。脚本：[原生 Claude 探针](../../../scripts/workbench-claude-background-smoke.ts)。

### Codex

生产适配器调用真实 Codex 0.153.4，隔离临时原生配置和仅回环模拟模型端点。V1/V2 各三种模式均通过：父回复后的子权限、公开回复和同父会话续说/steer；子回复仍被挂起时停止；父回复后仍在执行的原生 PTY 命令停止。所有已记录父、桥接、命令 PID/PGID 均无存活，测试命令的延迟文件写入未发生。

启用后台 runtime 时使用该安装版的 experimentalApi，先等待已知生产者停止确认，处理停止期间晚到的子身份，再通过 `thread/backgroundTerminals/clean` 和 `list` 确认原生终端清理，最后回收 app-server 进程组。所有阶段使用同一个有界截止时间。非空 turn/interrupt 确认只有固定版本源代码证明等待 TurnAborted 时才作为停止依据；空启动确认不算停止完成。一般的 notLoaded、缺少启动身份、新到且未纳入清理的子身份、原生进程失联均不当作已清理证据，保留目录隔离。

2 个聚焦文件、144 项测试通过；独立复核另运行最终 8 个关闭/容量/竞态回归，全部通过。真实原生 MCP 批准、拒绝、取消、恢复及模拟微信的旧五模式探针也通过。普通单轮路径不启用这套实验接口。

六模式索引 `/tmp/cc-codex-background-runtime-matrix.json`，详细记录 `/tmp/cc-codex-background-runtime-report.md`。最后的新增否定守卫仅加强无法确认时的隔离，没有声称为这一守卫重跑原生六模式。[原生 Codex 探针](../../../scripts/workbench-codex-background-smoke.ts)、[生产适配器探针](../../../scripts/workbench-codex-background-runtime-smoke.ts)。

### 服务、桌面与微信

13 个聚焦测试文件、318 项测试通过。覆盖父回复后同一 run 保留、晚到子结果、自动主回复、不同目录并发、同目录排队、原生确认竞态、权限与问题、异常 EOF、关闭不确定时的隔离，以及子回复的公开字段投影和转义。日志 `/tmp/cc-background-service-ui-final.log`。

真实桌面模块 → 主机代理 → 内部 HTTP → 任务服务 → SQLite 的浏览器探针通过。仅执行器是明确标注的模拟实现。这条链路证明界面和服务行为，不能代替原生协议证据。2 项同目录任务、1 个持久补充回执，主回复后不提前关闭，结束后才保存成果并启动下一项。已查看截图，子回复中的脚本文字被转义，展开记录和主回复层次清楚。

最新证据目录 `cc-background-browser-evidence-wxCEbB`，索引 `/tmp/cc-background-browser-final.log`。脚本：[工作台浏览器探针](../../../scripts/workbench-background-browser-smoke.ts)。

## 审查修正

- 停止先把等待原生确认的回执覆盖成“未发送”：改为精确匹配原始 task/run/material 的原子更新，保留未确认状态。测试先复现四项失败后修正。
- retained + queue 仍承诺自动下一轮：桌面控件、历史回执、微信和重复命令响应统一改成仅保存的事实；旧有真正自动下一轮路径保留。
- 终止错误本身超过队列上限时再次抛错、漏掉结束流：终止错误有界，并保证异常收尾执行。
- 仅确认父进程组退出不够：真实原生命令可以另起组；独立关闭证明必须覆盖这些受管理资源。

- 独立服务复核进一步复现瞬时保存失败：跟踪在持久化之前被移除，后续停止仍会误标“未发送”。现在只在持久化成功后移除；确认成功/失败两条故障注入测试先失败后通过，同一个独立 SQLite 复现也转绿。
- Codex 停止期间仍保留清理所需的身份/终止记录，但拒绝一切新权限。cancel 已被调用不等于收到原生停止确认；等待已有停止请求，避免重复中断和漏收新子身份。
- 所有持续事件/身份/公开回复缓存设置容量边界，超过时失败并清理，不能无限增长。公开子回答持久化和界面投影均限制 40,000 字符。

## 最终验证记录

| 检查 | 结果 |
| --- | --- |
| 全仓 Vitest | 528 文件通过、1 文件失败、1 跳过；7,124 项通过、16 失败、10 跳过，80.83 秒，退出码 1 |
| 唯一失败文件 | src/daemon/settings-panel.test.ts，仍是旧 IPv4 wildcard 监听的 16 个 HTTP 超时 |
| 最后修正后的服务/桌面/微信定向检查 | 13 文件、318 项通过 |
| 冻结 Claude 检查 | 4 文件、81 项通过；生产路径原生 7 模式通过 |
| 冻结 Codex 检查 | 2 文件、144 项通过；生产路径原生 6 模式通过，最终否定守卫另有聚焦回归 |
| 全仓 typecheck | 最后代码修正后通过，退出码 0 |
| 实际浏览器/HTTP/SQLite | 两项任务、同一轮次补充、晚到结果、结束后成果和排队任务均通过 |
| 独立审查 | 两个适配器及服务/UI 回执修正无剩余已确认问题 |
| 冻结美术、正式 bot、用户真实 MCP/模型、真实微信 | 未修改或调用 |

全仓运行发生在最后两个服务故障注入回归和 Codex 否定清理守卫之前；对应改动随后分别通过上表完整定向套件，不把全仓 7,124 项说成最后新测试的数量。全仓日志 `/tmp/cc-background-full-vitest.log`，类型日志 `/tmp/cc-background-typecheck.log`。

设置页源代码和测试与基线 8dc06d52 完全相同；前一轮在没有仓库导入的 Bun/Node 独立监听探针中已复现相同问题，见[环境记录](2026-09-13-cc-task-execution-models-network.md)。本轮未跳过这些测试、延长超时或改正式监听方式，不能称全仓绿色。

三个独立复核记录：`/tmp/cc-background-codex-independent-review.md`、`/tmp/cc-background-claude-independent-review.md`、`/tmp/cc-background-service-ui-fix-review.md`。

## 限制与产品取舍

- 没有通用“所有原生通知已处理完”证明。保留会话需要用户明确结束；更改模型、释放同目录任务也等待这个边界。
- 进程树关闭覆盖捕获时仍附属的后代和已验证原生后台命令，不承诺接管此前已经脱离的守护进程，或跨进程崩溃后的存活 writer。
- POSIX 进程组实现不冒充 Windows 支持；Windows 工作台原生关闭能力仍需专门实现和验证。
- 当前仍是两个原生执行者的具体能力，不能推导为所有 API provider、插件、MCP OAuth、云端任务、跨电脑迁移均已覆盖。
- 微信查询最新回复只取父 text，工作消息仍使用任务来源，不成为普通私人记忆。

## 参考

Paseo 的会话常驻 query 与 foreground/autonomous 分离，参考固定版本 [Claude agent.ts](https://raw.githubusercontent.com/getpaseo/paseo/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/server/src/server/agent/providers/claude/agent.ts)。Orca 的项目隔离和成果检查继续体现在 CC 目录所有权与固定成果版本中。Codex 采用实际安装版协议，不用模型工具名猜测 RPC。[Claude 公共 SDK 类型参考](https://code.claude.com/docs/en/agent-sdk/typescript)。Codex 固定源代码：[停止确认](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/app-server/src/request_processors/turn_processor.rs)、[后台终端接口](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/app-server/src/request_processors/thread_processor.rs)。

这批工作的专业性验收仍是：用户能在 CC 中看见晚到结果、确认输入、处理权限、明确停止，并接着同一件事做。它不代表 CLI/App 大部分功能已经覆盖。[覆盖范围与用户选择理由](../specs/2026-09-13-cc-professional-coverage.md)。

## 本地提交

- e04eb6d5：可选后台 runtime 契约与公开子回复投影。
- 3d12a732：Claude 持续会话、原生回显回执与受管理进程关闭。
- 9f4ebfb3：Codex 子任务身份、后台终端、停止确认与容量边界。
- 3c6e9737：服务、桌面、微信与浏览器验证的同一任务集成。

这些提交保留在 codex/cc-workbench-v1，未推送或合并。配套文档另行保存。
