# 拒绝一步后继续任务

主人拒绝批准卡只否决该次操作。支持交付理由的卡片通过 `canDenyWithReason: true` 声明能力，桌面工作台、桌宠、手机 App 和手机网页才显示可选理由框（最多 2000 个 UTF-16 单元）。普通对话等未接理由通道的卡片不显示输入框；服务端收到这类卡片的理由会拒绝消费，保留待批卡，避免静默丢弃。

微信带理由必须用明确的 `n 07 理由`（码为两位 01–99 或原有五位 hash，词与码之间用空格或制表符）；`不行 10 分钟后再说`、`n07 理由` 等仍是普通聊天。原来的 `n`、`n 07`、中文完整等价回复与旧 hash 无理由形式仍有效。不支持理由的卡片不提示带理由语法，附理由回复也按普通消息处理。理由属于这张卡，保留在任务时间线，并作为执行者可见的反馈；允许不携带理由，也不产生任何新增许可。

## 协议依据（2026-11-09 核对）

- **Codex app-server**：[OpenAI Docs 的批准协议](https://developers.openai.com/codex/app-server/#approvals)列出 `decline` / `cancel`，响应没有自由文本理由；`turn/steer` 可向正在执行的轮追加输入。[官方源码的决定映射](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/approval_overlay.rs)将 `Cancel` 映射到 `ReviewDecision::Abort`；[官方 schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/ExecCommandApprovalResponse.json)区分继续尝试其他办法的拒绝和等待下一条用户输入的 `abort`。因此不能假设所有拒绝都会自动继续。本仓库保留请求提供的决定：有 `decline` 就发 `decline` 并 steer 理由；只提供 `cancel` 时仍发 `cancel`，待原生 `interrupted` 后以同一个 thread、进程和任务事件流发一次 `turn/start`。steer 与结束竞争时，仅在明确未送达时续投一次；传输超时等不确定结果不自动重复提交。
- **Claude Agent SDK**：[官方 canUseTool 说明](https://code.claude.com/docs/en/agent-sdk/user-input#respond-to-tool-requests)明确说 `behavior: deny, message` 阻止工具，Claude 能读到说明并调整做法。这里直接返回包含操作和理由的拒绝消息，不设置 `interrupt`。
- **ACP v1**：[官方工具协议](https://agentclientprotocol.com/protocol/v1/tool-calls#permission-options)将 `reject_once` 定义为仅拒绝本次；`cancelled` 表示 prompt 被取消，不等于普通拒绝。`RequestPermissionOutcome` 只有选项 ID 或取消，没有标准理由字段，也没有 v1 steer。无理由时照常选 `reject_once`；有理由时先回答原请求，再取消当前 prompt，等它结束后在同一 session 发一次带理由的 `session/prompt`。用户取消、带内错误或 RPC 失败优先，不续投。

Codex 后台子执行者被拒后，先将操作和理由交给仍持有任务的父线程，再收尾子轮：父轮运行中用 steer，父轮已结束则在同一父 thread 开新轮。子线程重复终态只交付一次，主人取消优先，不因此重开任务。

## 停止边界

只有**审计成功、主人明确点击或回码的拒绝**才触发反馈。规则、红线、通道缺失、超时、取消、过期与审计失败不冒充主人拒绝，不触发自动续接。未知请求和无法完整核实的协议形状仍按既有边界停止。

连续三次主人拒绝后，CC 收起待批请求、关闭执行会话，将任务保留为可续接的 `interrupted`（事项仍 open，错误为空），等待主人下一步说明。只有主人明确允许（包括任务放行）或已确认送达的新主人输入才清零；规则自动允许、复用任务放行、执行者 result 和任何自动续接均不清零。检查失败后自动开新 run 也继承原计数。达上限后不能用已在途的输入抹掉停止决定，须由主人明确续接。自动输入只含被拒操作、理由和遵守边界换做法的说明，不重放被拒操作。主人中途发来的补充继续走原会话输入及回执。

[PR #889 的最终权限决定](https://github.com/tendhearth/wechat-cc/pull/889)继续有效：单次 accept 只授权原请求、原 run、原范围；不发 session / execpolicy 扩权，不修改权限规则、红线、身份核验或脚本快照语义。见[任务权限](task-permissions.md)。

## 离线验证

`codex-app-server.test.ts` 覆盖原生 cancel 后同 thread 续接、decline 后当前轮 steer、子执行者拒绝交付与终态/取消竞争；`acp-workbench-provider.test.ts` 和 `workbench-can-use-tool.table.test.ts` 覆盖原生反馈。`service-codex-output.test.ts` 走真实任务服务和 Codex 适配器，系统边界用离线报文替身；`workbench-task-permission.e2e.test.ts` 走真实服务、共享批准登记处和微信回复接线，检查理由、连续拒绝上限和可恢复状态。新增审查回归覆盖自动放行穿插、自动续轮保留计数、普通微信消息负例与各端卡片能力；桌面 DOM 回归覆盖理由草稿、焦点/选区保留及发送。图形与真实模型验收单独记录，不能用离线测试宣称真机已通过。
