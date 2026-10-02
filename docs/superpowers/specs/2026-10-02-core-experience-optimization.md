# Tendhearth CC 核心体验优化

2026-10-02。主人授权：完善和优化，保持设计原则，按竞品使用者的核心体验提出策略并实施，中途不打扰。

整合者：本会话 root。集成工作区 `/tmp/tendhearth-history-render-1c53th79`，分支 `dev`，起点 `b5484fd1`（包含此前三端阅读格式改动）。实现者使用各自独立 clone 的 `dev`，提交后由整合者串行合入。主 checkout 仍在 `master`，保持只读；生产运行环境和共享推送由整合者串行处理。

## 约束

沿用已拍板的设计：暖纸、衬线体、常规/中等字重、深绿只给动作、状态色只给真实状态点、CC 是唯一插画、最多一层卡片、两枚手机底部标签。入口与反馈用功能需要的文字，不增加仪表盘、重复状态或无效按钮。原记录、用户输入、权限和会话所有权规则保持可靠；历史文字不能变成有效批准请求。

本轮把竞品的操作习惯用于检查用户旅程。竞品事实来自官方文档和固定提交源码，下面的取舍是产品判断，不把代码审查当成安装体验。

## 竞品依据与策略

| 使用习惯 | 已核对的一手依据 | CC 的实施策略 |
| --- | --- | --- |
| 很快找到刚才那条会话 | [Paseo 导入入口](https://github.com/getpaseo/paseo/blob/3b5bbb139bdd27aa029120d3fc1b82e4bcb388d6/packages/app/src/screens/new-workspace/import-session-button.tsx#L7-L30)、[最近活动排序与预览](https://github.com/getpaseo/paseo/blob/3b5bbb139bdd27aa029120d3fc1b82e4bcb388d6/packages/app/src/components/import-session-sheet-view-model.ts#L68-L84)、[Orca 会话历史](https://www.onorca.dev/docs/agents/session-history) | “一起做”提供已有会话的文字入口；查看记录与启动工作分开；支持认出会话的来源、项目、时间与搜索。 |
| 打开先知道最近做到哪里 | [Paseo 最近窗口](https://github.com/getpaseo/paseo/blob/3b5bbb139bdd27aa029120d3fc1b82e4bcb388d6/packages/app/src/agent-stream/history-window.ts#L3-L38)、[Orca 尾部读取](https://github.com/stablyai/orca/blob/de8bffe24045b396212f4f63de8960ec8380ea07/src/renderer/src/components/native-chat/native-chat-pagination.ts#L1-L9) | 长会话提供有预算的最近记录视图，同时保留从头查阅；明确截断和窗口边界。 |
| 等回复时也能读、复制和核对旧内容 | [Paseo 跟随判断](https://github.com/getpaseo/paseo/blob/3b5bbb139bdd27aa029120d3fc1b82e4bcb388d6/packages/app/src/agent-stream/strategy-web.tsx#L772-L800)、[Orca 手机阅读意图](https://github.com/stablyai/orca/blob/de8bffe24045b396212f4f63de8960ec8380ea07/mobile/src/session/use-mobile-native-chat-tail-follow.ts#L77-L132) | 保留正文 DOM、选区、焦点、展开与代码横向位置；上翻即停止跟随，新答复提供轻量回到最新入口。等待文案只说明可观察事实。 |
| 执行到一半，在手机补一句 | [Orca 能力门](https://github.com/stablyai/orca/blob/de8bffe24045b396212f4f63de8960ec8380ea07/mobile/src/session/use-mobile-structured-send-with-outcome.ts#L111-L121)、[回执](https://github.com/stablyai/orca/blob/de8bffe24045b396212f4f63de8960ec8380ea07/mobile/src/session/use-mobile-structured-native-chat-send-bridge.ts#L73-L95)、[操作对账](https://github.com/stablyai/orca/blob/de8bffe24045b396212f4f63de8960ec8380ea07/mobile/src/session/mobile-structured-send-operation-journal.ts#L228-L233) | 原生端补充绑定真实 runId，按执行者能力走现有 steer/send/queue；固定原文、runId 与 requestId，按回执确认，失联时保留未确认状态。 |
| 权限判断突出，成果安静可回查 | [Orca 原生聊天](https://www.onorca.dev/docs/agents/native-chat)、[通知策略](https://www.onorca.dev/docs/notifications) | 保留权限卡键盘操作位置；结果查看后回到原阅读位置，能够恢复跟随。普通进展只更新视图，不新增对外通知。 |

固定核对版本：Paseo `3b5bbb139bdd27aa029120d3fc1b82e4bcb388d6`；Orca `de8bffe24045b396212f4f63de8960ec8380ea07`，均于 2026-10-02 核对。

## 实际缺口与验收

这不是按已有改动反推的完成清单；以下从完整旅程的实际实现与隔离浏览器审计得出，未验证项保持待办。

- [x] 用户和助手 Markdown 正常阅读，用户可核对原文，发送与存储不被改写；三端初步检查已通过。重点字配色按“强调色只给动作”修正后重新验收。
- [x] 桌面聊天等待阶段与最终答复到达不打断上翻；选区、焦点、原文展开与横向代码滚动保留；主动回到最新恢复跟随。
- [x] 桌面工作台流更新保护正在交互的正文；权限刷新不丢焦点；成果返回解除浏览成果状态，并保留文件选择和阅读位置。
- [x] 原生手机运行中补充可送到正确轮次，显示实际回执；断线重试保持同一提交身份，明确区分未确认和送达。
- [x] 原生会话在电脑停下后可同页重新检查；回前台/重连复查，旧的运行观察不冒充当前状态。
- [x] 手机两种入口都能发现、阅读与接着做已有会话；大量会话可搜索，长会话可直接看最近进展，服务器读取有预算与帧大小边界。
- [x] 组合版本通过 Bun、Node、类型与依赖边界检查；原生构建、宽窄浏览器真实交互覆盖上述行为。
- [ ] 交付到可运行版本并核对实际运行状态；按维护者回路验证部署、必要真机闭环与 CI，不以源码或演示通过替代用户可用。

## 已确认的实现边界

CC 无法无条件接管原程序正在执行的那一轮：忙碌状态仍拒绝接手，保留原程序已停止的确认声明。此轮改善发现、读取与恢复动作，不放宽执行所有权。

运行中补一句依赖当前执行者能力，不能承诺所有 provider 都能即时打断或插话。daemon 已有正确的提交规则，客户端提供真实参数与回执；不把重复发送作为默认恢复方法。

原生历史读取和搜索沿用现有凭据、来源隔离、文本上限及中继帧预算。超出预算明确提示，不在手机无限翻页，也不把有限窗口描述成完整历史。

## 分项证据（组合交付仍以最后两项为准）

桌面聊天使用生产模块与合成 API，Chromium 1000 / 390 两档验证三个等待阶段及最终答复：正文、原文展开、选区、链接焦点、代码横向位置（120px）保留；新回复出现轻入口，主动回到最新恢复跟随。Markdown 同档确认“用户原文”解析成重点文字、字号16px、文字颜色与正文一致，原文含 CRLF 精确保留。中文只带 Regular，不能把 CSS 的500当成已加载中文中等字体；三端用 ground 浅底色补足重点辨识，避免与用户气泡的 rail 底色重合。

工作台不仅保护流补丁，也复用全量绘制中的消息节点。权限变化、状态变化、跨操作摘要的选区、反向选区、删除消息和旧缓冲版本均有回归；真实浏览器验证权限焦点转移和成果返回。浏览器几何断言在字体加载完成后执行。

原生补充通过真实 LiveBackend / store / Compose / Matter 和 daemon 路由验证，而非只测演示后端。首次正文、原文、runId、requestId 固定；重连只核对，不自动重发；取回原文不覆盖新的草稿。快照与现有草稿一样只保存在当前配对的客户端进程中，关闭进程后不会自动重试；不能宣称已实现持久操作日志。

最近记录优先尾部定位，否则100条一页、最多80页、整趟8秒；超时后不继续服务层翻页。底层 SDK 已开始的单次读取无法取消，这个边界不改变旧读取器。手机只收20条、每条4000字，并继续受512KiB帧上限约束；从头分页与最近窗口缓存分开。

两种手机入口都支持来源筛选、提交搜索、最近窗口和从头分页；旧服务器没有确认窗口时不冒充最近记录。续聊先检查，再确认原程序已停止，最终 POST 仍只有会话 key。回前台和重连只重新检查接手条件，保留已读内容；手动刷新才替换记录。原生真实 LiveBackend/store 页面测试覆盖第一次读取中断、上下文变更、后端返回错 key、刷新失败保留旧正文等边界。PWA 工作台按事件身份复用正文，正在选择、聚焦、展开或横向读取的变化延后到释放后的正常轮询，新回复照常出现。

最终组合检查（代码 `61536972`）：根套件 Bun 800文件10684项通过、12项跳过；Node 680文件9209项通过、16项跳过；完整类型检查通过，依赖边界0错误（21条既有警告）；relay 8文件67项通过。原生专属套件 Bun/Node 各68文件704项通过。生产模块 Chromium 1000/390 验证聊天、工作台、PWA 会话旅程与阅读保护；普通 iOS Simulator Release 包包含最终原生修改，已在专属 iOS27/iPhone17 模拟器成功安装、启动。原生包未安装到主人真手机，未做新一轮真手机配对或商店发布。

本机完整 Developer ID 安装包已原子更新到 `/Applications/wechat-cc.app`，服务从旧兄弟 checkout 转到该安装位置，保留既有权限开关、启动行为和环境；不写兄弟 checkout。首次交付脚本合并诊断与 JSON，解析误判触发回退，旧版本恢复健康后修正并重装。最终 `self deploy` 含 sign/seal，实际 daemon `a297deab`、health200、6/6插件就绪、文件访问正常。旧 GUI 进程保留其草稿，仍是旧前端；重新打开窗口加载新前端。

实际模型闭环：Claude 的权限/执行/写文件/运行中补充/图片/续接与聊天 ping/续接均通过；Codex 用仅当前自检任务的 `gpt-5.6-sol` 选择通过权限、文件、图片和续接。两项既有外部限制原样保留失败证据：Cursor 返回“Upgrade your plan to continue”；用户原生 Codex pin `gpt-6.1-sol` 不在当前账号目录，未修改全局偏好。手机中继真实配对、v2、订阅、撤销与撤销后拒绝通过；Claude 保留会话导致原有 phone 自检等待终态超时，其错误收尾需要修复后复验，不能把这份报告记为整体通过。
