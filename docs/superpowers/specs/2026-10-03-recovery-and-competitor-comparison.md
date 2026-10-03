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
- 与同期网络守护合并后，原生的 `network_unprotected` 与 `execution_model_unsupported` 码优先于错误正文；不会因诊断中出现额度词而改成额度失败，也不追加第二段同义报错。

## 验收清单

- [x] 原生日志实例/进程重启、写失败/中途崩溃、迟到回调、撤销/换配对、容量/分片、调用次数与新草稿保护；自动化故障验证与普通 Release 实测的边界分开记录。
- [x] 单回执真实持久库、>50 条、真实详情 413、v1/v2 手机链路、未认证/撤销、跨任务/主人/关联、held 重启；Bun / Node / relay / 类型 / 边界通过开发者验证。
- [x] 桌面与 PWA 实际控件：确认取消、双击、候选变化、未知结果手动同身份重试、handed/none、忙、迟回切页；无自动 POST。
- [x] Codex adapter 的 error / turn-completed / RPC 路径，稳定任务码、单条诊断、无正文误判；模型按钮只 GET，保留草稿，真实目录选择只作用本任务。
- [x] 整合后完整 Bun / Node / app / relay / typecheck / depcheck，普通 native Release 和浏览器生产模块验证；各阶段源码与验收边界独立记录。

交付门：构建、原子部署及健康门、实际 disposable 任务与手机自检、dev 推送和准确 CI 收据分别核对。中断、外部执行者不可用以及不能安全清理的临时记录单列，不能冒充全绿。

验证中保留失败和未覆盖边界；普通 Release 构建或启动成功不等于已验证所有 native 手势与跨进程恢复。没有主人手机安装、App Store 发版或公开发布。

开发期交叉审查发现并交付修复：临时读取凭证失败误清日志；旧设备撤销与新配对保存竞争；等待 consume 落盘时同正文新稿或 held 稿被清；迟到的 GET / POST 把较新的 held 回执覆盖。修复已由实例故障测试、真实 Compose 发送门测试和独立审查验证。草稿以提交时的进程身份与编辑代次核对，live 作用域为空时拒绝 POST，迟到回执只能更新原来捕获且仍有效的快照。

## 普通原生包的实际证明

普通非 E2E iOS 模拟器 Release 已通过系统 Keychain 签名与启动、手动粘贴 HTTPS 配对链接、一次手动发送、结束 app 进程后重启、从已保存提交恢复到输入框。实测以输入框当时的实际值为准：165 个 ASCII 字节，前后空格保留；重启后本地完整原文 SHA256 与提交前快照相同，requestId、服务端 runId 和 held 状态一致。按既有发送规则 trim 后的已提交正文是 162 字节，不能把它与 165 字节完整原文混为一谈。不能把这次实测说成 OS 长 Unicode / 分片文本、真实 POST 次数监控、Keychain 延时或物理 iPhone 已验证；这些故障与容量条件另有源码测试。首次缺少 entitlements 的启动失败保留，最终成功使用标准模拟器签名构建，不改产品 Keychain 行为。

## 同期整合与运行边界

同期 provider 结构化错误合并时保留原生模型拒绝的具体恢复入口：精确模型拒绝可细化通用 invalid_request，其他明确认证 / 网络 / 额度分类仍优先。下游只在完全无码时从正文判断额度；模型拒绝与守护拒绝仍只保留一条原始诊断。相关合并交界已通过 Bun / Node 各 177 条测试。

本机运行服务在验收中两次被同期安装替换。此前有效的健康、Claude 续接与手机恢复证明保留；被替换中断的 Codex 验收单独记录，不能算本轮通过。其临时任务缺少原进程组退出证明，保留 writer_not_closed 保护，不清掉记录、不复用原路径，也不冒充清理成功。早期 3099f935 基线的 Cursor 创建请求在入库前返回 unavailable_provider；最终 bcde48fb 基线可以创建 Cursor 任务，但实际执行返回“Upgrade your plan to continue”。两次结果按各自运行版本记录，不能把它们当作真实额度接手已验收。

没有修改全局 Codex 模型偏好。原生 CLI 会给自己的临时项目登记信任元数据，因此整个配置文件字节可能变化；模型设置与其他非验收项目配置是否变化另行按语义核对，不以整文件 SHA 不变冒充证明。最终完整检查、实际运行结果与准确 dev SHA 的 CI 收据在交付验收记录中分别列出。

最终生产源码基线 `bcde48fb`：完整 Bun 10,972 条、Node 9,471 条通过，完整类型与模块边界检查通过。原生 app 源码在本轮持久化收尾后未再变化，Bun / Node 各 745 条证明继续适用。新增桌面错误文案再次通过 1000 / 390 真实 DOM 验证；PWA 与安全 Markdown 源码未变，保留既有宽窄验收。普通桌面签名包已本机原子安装，保留原设置与打开的 GUI；没有公开 updater 发版。

同一 bcde48fb 运行版本与启动时间下，实际 Codex 普通续接 10/10、图片续接 7/7 通过；只对自己的临时任务选择目录中存在的模型，语义核对全局模型设置和其他项目设置均未变化。手机 v2 单回执 GET 也通过：162 字节已提交正文与原提交记录一致，UUID、runId、held 一致；零原消息 POST、零新增任务，自己的临时设备已撤销并验证撤销后拒绝连接。

手机完整自检 14/15，失败项为归档 409：终态和从手机列表消失仍不足以证明执行进程已关闭。收尾修正要求服务端明确 `canArchive === true` 才归档并删除 scratch，Bun / Node 各 42 条及完整类型检查通过。这次手机验收留下的自有临时任务同样保留 writer_not_closed 保护；收尾时其 scratch 已不存在，删除原因没有足够证据，不能据此证明原进程已退出或安全清理成功。不清掉未知进程的保护，不把协议回执通过说成完整自检全绿。修正只影响 CLI 自检清理，不改变上述生产 UI、手机 app 或模型执行源码。
