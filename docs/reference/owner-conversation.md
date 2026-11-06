# 主人对话合同（T5d）

桌面 operator HTTP 与配对设备使用同一条 `/v1` 路由；短链接、file 和模型会话不能调用这些主人读写口。主人身份由 daemon 决定，请求不能指定 chatId。响应不缓存。

| 调用 | 参数与语义 |
| --- | --- |
| `GET /v1/protocol/capabilities` | `routes: 'v1'`、`topics: 'v1'`；手机直接读 `ProtocolClient.capabilities()` 的已验证握手字段，不自行解析 socket。 |
| `GET /v1/matter/owner-chat/window` | `anchor`、`before`、`after` 三选一，值均为原消息 ID；不带则读最新。`limit` 为每页条数（1–50）；anchor 窗口左右各取 `floor(limit/2)`，再带原消息。`q` 可用于更早历史搜索。 |
| `GET /v1/matter/owner-chat/work` | `cursor` / `nextCursor` 分页（默认 30、最多 50）；持久工作引用与 MatterLog 已完成轮的结果；引用按 `work:<matterId>`、结果按 `result:<turnId>` 去重。`messageId` 指向主人对话的原消息。 |
| `GET /v1/matter/owner-chat/events` | `since` 为上次游标。每页最多 50 个持久事件；同一 `id` 的正文更新用替换合并。首次只读当前轮；`running.turnId` 是停止凭据。各端可每秒轮询，不依赖 HTTP SSE 穿过加密中继。 |
| `POST /v1/matter/owner-chat/stop` | `{ turnId }` 必须仍是主人正在执行的那一轮；过期回 409 `input_stale`。客户端沿用两次点击确认，不自动重试。 |

响应的 `scope` 隔离主人变更后的端侧缓存；工作分页游标也绑定此作用域。窗口正文最多 4000 字，工作结果与流式事件正文最多 16000 字，裁剪时带 `truncated`（完整正文仍可从事项详情读取）；附件仍保留授权元数据。

窗口消息按 `(ts,id)` 全序排列，`earlier` / `later` 是下一页的边界消息 ID，同毫秒的多条消息不会漏掉。anchor 不属于当前主人时回 404；读取不创建对话。正文附件仍只给公开元数据，原文件由原有授权分块接口读取。

表单交办使用 `entry:<requestId>` 的消息 ID，消息与任务在同一创建事务内落库。创建重试不会产生第二条消息。一次性 delegate 创建持久 act，并记录其主人对话来源与 MatterLog 结果。终端成功发送后，将主人消息与对应 terminal matter 持久关联。工作台新正文写入明确的 turnId；旧的未绑定正文仅在 run 唯一对应一轮时读取，不猜测多轮归属。阶段结果取 MatterLog 的完成轮与正文，客户端不根据状态变化自行生成结果消息。

话题详情的事项行新增 `kind` 与 `detailRoute`。统一详情仍是 `/v1/matter?id=…`；terminal 用其 `cli` binding 的 session ID 打开终端详情，act 用活动详情，只有 task 才能调用工作台任务接口。`mergedInto` 为 surviving topic ID；旧 ID 的详情在相同主人作用域内解析，链式合并保持映射，跨主人仍 404。

终端的 `/v1/cli/activity`、`/v1/cli/decide`、`/v1/cli/session-say` 由 terminal 模块统一处理，旧手机地址只做别名转换。发送沿用原来的窗口转入/闲置会话恢复、忙碌与网络保护规则。`POST /v1/cli/session-stop` 接收 `{ session_id, run_id, confirmed: true }`：只中止 CC 自己恢复启动且 run ID 相符的进程。`run_id` 只在这种可停轮次的设备会话行中出现；外部终端窗口没有该能力。
