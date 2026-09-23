# CC 后台执行会话

延续 `2026-09-13-cc-unified-task-entry.md`。目标是保留主回复后的子助手结果、原生自动补充回复和用户继续输入，仍使用完整对话与折叠操作记录。

## 已验证的协议限制

Claude CLI 2.1.267 / SDK 0.2.116 会先产生主 result，之后产生 child task notification 和新的自动主回复。两个子任务先后完成时，第二个通知可在第一个自动回复期间排队：后台计数归零后的下一个 result 仍不是最后一个回复。默认没有 session_state_changed；内部开关下 idle 也可能发生在子任务仍执行时。没有经过验证的公共 drain 屏障，不能靠静默时间、计数或 result.origin.kind 推断整体结束。

Codex 0.153.4 的 parent turn/completed 不结束 child turn；parent interrupt 不停止 child。V1/V2 子 thread 的消息均会继续到达原 app-server。child turn ID 表示一次执行，child thread ID 可复用。原生命令可能另开 PTY 进程组；仅关闭 app-server 或观察父进程组退出不能证明命令已停止。释放目录需要确认自己持有的执行资源已回收，无法确认则保留隔离。

原生探针只使用独立临时目录、自己创建的测试工具和回环模拟模型端点，不访问用户模型账号、真实 MCP 或微信。

## 本次架构

普通聊天的 AgentSession.dispatch 保持现有单轮协议。工作台可选择独立的 runtime lifetime stream，主 result 在这里仅表示一次主回复完成。所有消息由一个原生读取器分发。

同一个 runtime 对应一个 CC task/run epoch、目录身份、模型配置和权限桥。发现原生后台执行，或向原生提交额外的人类输入后，retained 永久为真，直到用户明确停止；后续输入仍属于该 epoch。不能把迟到消息套到新的 run，不能自动归因或偷偷新开原生会话。

只有首次输入、且未发现后台执行的常规任务可保持原来的自动收尾路径。启用此路径的适配器须针对实际原生版本证明后台注册先于父 result；未知或已观察到的后台操作不得算成无后台。后台执行包括已支持的子助手和原生命令任务；不支持的类型必须如实保留或记录限制。

## 共享接口

AgentWorkbenchRuntime 提供 events（唯一消费的 AsyncIterable<AgentEvent>）、start(text, attachments?)（只允许一次）、submit(requestId, text, attachments?)（同 epoch 输入，成功仅表示已获原生接收确认）、snapshot()。

snapshot 为 `{retained:boolean, foreground:'running'|'idle'|'unknown', backgroundCount:number, input:'steer'|'send'|'queue'}`。它是观察值，不是全局空闲证明。retained 不得反向恢复为 false；后台计数可以随已观察到的执行完成而降低，由执行 occurrence 的映射计算。重复事件不能多计或复活完成记录。

AgentSession.workbenchRuntime 为可选能力，SpawnContext.workbenchLifecycle 控制启用。AgentActivity.output 仅保留子助手有意公开的回复，限制 40,000 字符；不把子回复放进主 text，不记录隐藏推理、完整工具参数或任意工具输出。

## 服务、输入与结束

- 持续消费 runtime.events。父 result 更新原生父会话身份与回复事实，不关闭权限、不发布最终成果、不释放目录。
- 原先已受保护的收尾仍在 iterator 结束、明确停止或真正失败时执行。close 失败继续隔离目录；必须确认 owned writer 退出。
- 先保存 task/run/request 绑定的持久回执，再发送。runtime.submit 只在原生确认后成功；本地写入队列不能冒充已交付。未确认的输入显示 held，不自动重发；停止不可被迟到拒绝反向改回 pending。
- Codex 主 turn 正在运行时使用带预期 turn ID 的 steer，主 turn 已结束时使用同 thread 的 turn/start。同 epoch 序列化启动，拒绝并发切换模型。
- Claude 已在隔离原生探针验证显式 SDKUserMessage.uuid 与公共 replay-user-messages 回显的匹配；该确认可能要等当前自动回复结束后才到达。未经确认的能力保留 queue，不伪装 steer；不使用内部 command_lifecycle 作为公共交付协议。多个输入可能被原生合并进自动 turn，CC 不编造一条输入对应一轮结果。
- retained 且没有观察到执行时允许保持连接，静默不自动判定成功。观察到执行中的 watchdog 仍只判定失败，权限等待按既有方式暂停。
- 停止收回凭证并阻止新请求，结束自己的所有后台资源，保存稳定成果。状态沿用已停止；不得把中断自动通知队列伪装成全部完成。
- 重启不自动重发，未知子状态记为中断；本轮不声称跨进程崩溃后的存活 writer 自动接管已完成。

## 界面和微信

保留两栏与同一输入框。有实际执行时显示执行状态，retained 且当前没有观察到执行时显示“会话保留中”，没有常驻 spinner；一句说明后续回复仍会到这里。停止按钮明确结束整个后台会话。子助手公开回复放在该助手的可展开记录里，主回复按实际到达顺序穿插，已完成操作可折叠。

retained 且 input=queue 时只能承诺已保存在 CC，不能承诺自动进入下一轮。已交原生但尚未获确认的输入，即使用户停止，也保留“未确认交付”；不得改写为确定没有发送。

工作台列表、桌面详情和微信状态必须从同一 snapshot 派生。微信“最近回复”只取主 text。同目录的下一项任务、模型修改与检查交接仍等待关闭；不会为了方便释放潜在 writer 的目录。

## 借鉴与范围

Paseo 的后台常驻 query 与 foreground/autonomous 分离是此次参考；原生读取器属于会话而非最后一次 UI 请求。参考固定版本 d1b705a0cd91617a5707fae25d80cb0be3057950 的 `packages/server/src/server/agent/providers/claude/agent.ts`。Orca 的项目隔离沿用在目录所有权与成果检查上。此次不引入永久流程图、终端墙或插件平台。

首个可宣称的能力是“CC 保留后台会话及晚到回复，支持经验证的继续输入和明确停止”。不宣称通用原生 quiescence、自动跨 run 因果追踪、所有 CLI/App 功能或跨电脑迁移已完成。
