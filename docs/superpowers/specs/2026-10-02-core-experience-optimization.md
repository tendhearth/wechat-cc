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
- [ ] 桌面聊天等待阶段与最终答复到达不打断上翻；选区、焦点、原文展开与横向代码滚动保留；主动回到最新恢复跟随。
- [ ] 桌面工作台流更新保护正在交互的正文；权限刷新不丢焦点；成果返回解除浏览成果状态，并保留文件选择和阅读位置。
- [ ] 原生手机运行中补充可送到正确轮次，显示实际回执；断线重试保持同一提交身份，明确区分未确认和送达。
- [ ] 原生会话在电脑停下后可同页重新检查；回前台/重连复查，旧的运行观察不冒充当前状态。
- [ ] 手机两种入口都能发现、阅读与接着做已有会话；大量会话可搜索，长会话可直接看最近进展，服务器读取有预算与帧大小边界。
- [ ] 组合版本通过 Bun、Node、类型与依赖边界检查；原生构建、宽窄浏览器真实交互覆盖上述行为。
- [ ] 交付到可运行版本并核对实际运行状态；按维护者回路验证部署、必要真机闭环与 CI，不以源码或演示通过替代用户可用。

## 已确认的实现边界

CC 无法无条件接管原程序正在执行的那一轮：忙碌状态仍拒绝接手，保留原程序已停止的确认声明。此轮改善发现、读取与恢复动作，不放宽执行所有权。

运行中补一句依赖当前执行者能力，不能承诺所有 provider 都能即时打断或插话。daemon 已有正确的提交规则，客户端提供真实参数与回执；不把重复发送作为默认恢复方法。

原生历史读取和搜索沿用现有凭据、来源隔离、文本上限及中继帧预算。超出预算明确提示，不在手机无限翻页，也不把有限窗口描述成完整历史。
