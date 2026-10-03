# 恢复、额度与模型失败：竞品对照及验收

2026-10-03；整合者 Codex；在隔离 dev checkout 开发。前一轮阅读优化已交付，本轮只补下面三个实际缺口。

## 一手对照

核对时间 2026-10-03 02:53:51 UTC；固定版本 Paseo `5293ddac3f17f35ea090b292447ec0498edafafe`，Orca `5c62cb5320c399662b569da22a1399393381979b`。以具体路径为限，不能泛化到整款产品。

| 场景 | Paseo | Orca | CC 本轮取舍 |
|---|---|---|---|
| 手机提交后重启 | [daemon 回执](https://github.com/getpaseo/paseo/blob/5293ddac3f17f35ea090b292447ec0498edafafe/packages/server/src/server/message-receipts/index.ts#L25)持久化，pending 恢复为 outcome unknown；[客户端提交状态](https://github.com/getpaseo/paseo/blob/5293ddac3f17f35ea090b292447ec0498edafafe/packages/app/src/stores/session-store.ts#L651)是内存 Map。[普通草稿另有持久化](https://github.com/getpaseo/paseo/blob/5293ddac3f17f35ea090b292447ec0498edafafe/packages/app/src/stores/draft-store/index.ts#L428) | [手机操作日志](https://github.com/stablyai/orca/blob/5c62cb5320c399662b569da22a1399393381979b/mobile/src/session/mobile-structured-send-operation-journal.ts#L11)保存身份、指纹和附件路径；[草稿与 pending 全文](https://github.com/stablyai/orca/blob/5c62cb5320c399662b569da22a1399393381979b/mobile/src/session/use-mobile-native-chat-drafts.ts#L104)仍是组件状态 | 保存完整不可变提交快照；重启先 GET 原回执，未知结果不自动重发 |
| 主机重启时队列 | 服务端 pending 不冒充未送达 | structured 模式有 [SQLite 队列](https://github.com/stablyai/orca/blob/5c62cb5320c399662b569da22a1399393381979b/src/main/native-chat/agent-session-journal/journal-queued-messages.ts#L1)，[重启恢复](https://github.com/stablyai/orca/blob/5c62cb5320c399662b569da22a1399393381979b/src/main/native-chat/agent-session-journal/journal-pending-submission-recovery.ts#L7)把已经开始提交的 pending 变 unknown；不能推广到全部 PTY 路径 | 延续 daemon 的 held / daemon_restarted，不换 runId、不补自动 POST |
| 当前会话选模型 | [控制器](https://github.com/getpaseo/paseo/blob/5293ddac3f17f35ea090b292447ec0498edafafe/packages/app/src/composer/agent-controls/index.tsx#L1617)同时写后续 provider 偏好 | [当前 session 选项](https://github.com/stablyai/orca/blob/5c62cb5320c399662b569da22a1399393381979b/mobile/src/session/use-mobile-structured-agent-options.ts#L134)有身份检查，但 accepted 之后还写后续 launch picks | 从具体模型拒绝进入当前任务设置，不改全局默认、不借换模型重发未知输入 |

竞品未安装或执行。该对照不构成对其全部错误恢复入口的否定。

## 已发现的 CC 缺口

1. 原生提交快照只有进程内 Map。app 退出后丢失原文和 requestId；详情只带最后 50 个输入，且 300 KiB 帧限制可能令整个详情返回 413。
2. 额度接手领域和 RN 已有 offer / none / handed，PWA 与桌面没有完成对应入口；PWA 把额度失败解释成连接故障。
3. 本机实际 Codex 错误是结构化 400 / invalid_request_error，说明当前 ChatGPT 账号不支持所用模型。任务和事件仍显示原始 JSON，提示“用自动”还可能沿用同一个不可用默认。

## 边界与实现

- 原生 journal 使用既有 SecureStore，不加依赖。完整配对身份哈希隔离记录，原 token 不入日志；串行写、提交指针与作用域代次保护迟到回调。先保存再 POST，保存失败保留草稿且零 POST。正文分片独立于状态索引，避免每次状态变更重写所有长文本。达到容量上限明确拒绝新提交，不悄悄淘汰未知消息。
- 新增只读单回执 `GET /m/api/matter/input-receipt?id=…&requestId=…`。Matter 与 Workbench 分别核对可信主人、任务关联和 receipt.taskId，不受详情数量/大小限制；404 表示当前尚未找到，不等于从未送达。
- 重启把 submitting 恢复为 uncertain；重连只查询。所有未确认记录均可发现，原文可恢复；新草稿不被旧回执覆盖，已交付/撤回不提供重发动作，held 不自动投递。
- 额度接手复用已有 handOff 事务与 receipt。确认说明同目录新任务、实际可用候选、有限上下文及新执行者额度；提交前刷新，候选变化重新确认。未知结果保留原 requestId / provider，手动重试先 GET，已 handed 打开实际接手任务。
- Codex 只识别已经采集的原生错误通道 JSON 形状；不扫描助手正文，不扩展认证/额度推断。任务保留稳定错误码，原生文本仍在原始数据库，阅读投影用人话并提供折叠诊断。桌面恢复动作只打开真实模型目录和本任务下一轮设置。

## 验收清单

- [ ] 原生日志实例/进程重启、写失败/中途崩溃、迟到回调、撤销/换配对、容量/分片、调用次数与新草稿保护。
- [x] 单回执真实持久库、>50 条、真实详情 413、v1/v2 手机链路、未认证/撤销、跨任务/主人/关联、held 重启；Bun / Node / relay / 类型 / 边界通过开发者验证。
- [x] 桌面与 PWA 实际控件：确认取消、双击、候选变化、未知结果手动同身份重试、handed/none、忙、迟回切页；无自动 POST。
- [x] Codex adapter 的 error / turn-completed / RPC 路径，稳定任务码、单条诊断、无正文误判；模型按钮只 GET，保留草稿，真实目录选择只作用本任务。
- [ ] 整合后完整 Bun / Node / app / relay / typecheck / depcheck，普通 native Release 和浏览器生产模块验证。
- [ ] 构建、原子部署及健康门、真实 disposable 任务与手机自检清理、dev 推送和准确 CI 收据。

验证中保留失败和未覆盖边界；普通 Release 构建或启动成功不等于已验证所有 native 手势与跨进程恢复。没有主人手机安装、App Store 发版或公开发布。

开发期交叉审查发现并交付修复：临时读取凭证失败误清日志；旧设备撤销与新配对保存竞争；等待 consume 落盘时同正文新稿或 held 稿被清。原生验收须覆盖这些故障，不能用正文相等替代草稿身份，也不能在 live 作用域为空时跳过持久化继续 POST。修复验证完成之前不部署。
