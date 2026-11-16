# 这句该谁答 + 直通露标 + 补 Grok

状态：设计草稿，未授权实施。基线 `origin/dev = 27d0109ed`；本次只新增本文，不运行服务或真实模型。
依据：[一个管家总纲](2026-11-12-one-butler-direction.md)规矩 1–3、7 与顺序第 5 步；[话题方向](2026-11-05-one-conversation-topics-direction.md)、[T1–T3](2026-11-05-topics-t1-t3-design.md)、[T5](2026-11-06-t5-one-conversation-ui-design.md)、[多 agent 记录本](2026-11-12-one-matter-many-agents-design.md)。冲突以总纲为准。目的：主人照常对 CC 说话，需要别人答时知道是谁，送错时能退回来。

## 1. 今天怎么答：已有与缺口

| 场合 | 当前代码行为、主人看见什么 | 还缺什么 |
|---|---|---|
| 主人普通一句话 | [入站 intent](../../../src/daemon/inbound/intent.ts)按命令 → 事项指称 → chat；[mw-dispatch](../../../src/daemon/inbound/mw-dispatch.ts)交给 coordinator。桌面/App 经 [wire-converse](../../../src/daemon/wiring/wire-converse.ts)共用 route + consume | 没有统一的「CC / 单次代答 / 一件事 / 问一句」决策 |
| 谁承载 CC | [Mode](../../../src/domain/conversation.ts)有 solo、primary_tool、parallel、chatroom；[admit](../../../src/app/coordinator/plan.ts)按模式、注册、权限、守护准入。solo 由所选一家答；primary_tool 主模型开口、工具委派 | `/v1/conversation/set-mode`（[routes](../../../src/daemon/internal-api/routes.ts)）持久改模式，quiet 只省提示；自然语言换后端也可经 [provider_switch](../../../src/mcp-servers/wechat/tools-mode.ts)持久切换，均不是单次代答。旧多人模式不扩成新群聊 |
| 提到旧事 | [task-reference](../../../src/features/workbench/task-reference.ts)先引用头/声明焦点/ID/名字/有效焦点，再模型兜底；[中间件](../../../src/daemon/inbound/mw-task-reference.ts)在声明或成功匹配后设 20 分钟焦点并回显，歧义问数字，转成查询/停止/补充。微信有「项目 · 标题 · 执行者 · 状态」 | 这套是事项指称，不是通用的答话者选择器；焦点有效时，普通下一句也可能成为补充 |
| 打开话题 | 召回相关记忆；泡泡可进入原事项（[话题就是项目](2026-11-09-topics-are-projects-design.md)） | 话题不等于收件人；点泡泡不能悄悄绑定下一句 |
| 在一件事里说 | [matters.say](../../../src/app/matters/service.ts)的 task 走 input/continue，直达当前棒；chat 才回 CC。[ledger](../../../src/features/workbench/service/ledger.ts)、[relay](../../../src/features/workbench/service/relay.ts)已有计划、记录本、顺序接力与停住条件 | 多 agent 补充不是广播；不能任点一张头像就绕过接力换人，并行仍是后续范围 |
| 看回复 | 事项已有执行者圆头像；主人对话三端仍统一按 CC 呈现。回复交付知道 provider，消息/协议出口却未贯通 | 缺逐条、逐轮的实际来源；不能用当前模式或参与者头像组给历史补标 |

CC 自己答与执行者代答是**角色区别**：即使 CC 的后端是 Claude，日常 CC 回话仍是 CC；代答指另一家直接回答本句。CC 咨询工具后自己组织的回答仍属 CC。

## 2. 推荐：结构先定目标，模型只补拿不准的部分

在 daemon 共用一份判定，微信与 App/桌面/网页用同一契约；每次接收先固化 `kind、matterId?、agentId?、provider?、reason`，连同 requestId 留回执。它不重写持久 Mode。

1. **已有控制和响应先处理**：命令、停止、审批、提问回答、接力确认沿原入口及有效期，不让「谁答」抢走一个「好」或数字。
2. **明确事项输入目标优先**：详情里的补充框携带 matterId/runId；正文与附件原样给当前棒，回复原样回，CC 只旁听记账。事内点名另一位是接力意图，交回 CC 走原换棒检查，不在前端改收件人。
3. **本句明确要求某家答**：如「让 Grok 回答这个问题」，该家可用且通过权限/守护才作一次代答；只交本句及必要工作背景/硬规矩，不附主人的闲聊和情绪。「换成 X / 用 X / 切回 X」仍沿原持久后端切换，无法区分切换与代答时才澄清，不截成代答；只提到模型名字（如「Claude 的额度呢」）不算点名发话。点名者不可用时说明并问是否改由 CC，不静默换人。
4. **引用/ID/名字/有效事项焦点**：复用现有指称顺序、成功匹配后的回显与 20 分钟焦点，区分查状态与补充；明确「跟 CC 说」可退出焦点。新加的代答只管本轮，不留下隐形焦点。
5. **话题只缩小候选**：用已关联的事项与工作状态帮助找事；只打开话题、只剩一件活、语义相似都不足以把普通聊天送出去。有多个可能目标就问一句，选择绑定原句和候选有效期。
6. **模型兜底**：只看有限候选及短索引，返回受限编号/意图；不让它自由造 provider、事项或路径。只在结构匹配不明且有任务/代答语义时调用；超时、非法、不可用或仍歧义，回 CC 或澄清。模型建议新交办/拆棒，先沿现有确认再执行，不能直接派活。
7. **其余 CC 自己答**：保留默认后端、输入习惯、自然语言/斜杠切换及设置；不根据「强模型更会判断」换默认。直接开终端的习惯也保留，已挂入的会话沿记录本接续。

「说完或切走回 CC」指一次代答完成后，主输入框恢复原目标（通常是 CC）；打开事项详情期间，其补充框始终给这件事，关闭后回原对话。微信已有回显的 20 分钟事项焦点视为仍在该事里，退出/到期才回 CC；本次保留这一习惯，不新增“上一位代答了所以下一句也归它”的粘连。
误判时提供「跟 CC 说 / 不是这件 / 换成 X」：撤掉路由焦点，未送出可改目标；已经送出则标明送达，沿原入口停止后续执行，改投前确认原句。停止不能撤销既有副作用，不自动向第二家重放操作；重试先核原回执，避免一条话派两遍。
CC 旁听按已有工作结果 → 话题/总账记；执行者间仍只经该事记录本交接，不共享主人的私人对话，也不新建 agent 群。

## 3. 直通与代答露标：先补数据，再画头像

**来源由 daemon 按实际执行轮填写，模型不自报。**[ReplyDelivery.begin](../../../src/daemon/reply-delivery.ts)已有 providerId；[MatterTurn](../../../src/ports/matters.ts)已有 executor/model/runId；[MessageRecord](../../../src/lib/messages-store.ts)已有可选 provider，但 [wire-converse](../../../src/daemon/wiring/wire-converse.ts)未写它，[ilink-glue](../../../src/daemon/ilink-glue.ts)普通出站也未填。
拟新增统一的回复归属：`speaker: cc | agent | notice`、`provider`（实际 registry id，模型回复必填，通知/旧记录可空）、`model?、matterId?、agentId?、turnId`。从执行轮贯通回复接收器、converse 回包、消息存储及 [owner-conversation](../../../packages/protocol/src/owner-conversation.ts)的 window/events/work.results；事内历史按对应 MatterTurn 投影。流开始即定来源，完成、分条、附件、重连后不变。
`provider`解决后台来源，`speaker`决定露 CC 还是那家的标；接力后的新回复换标，旧回复不变。旧记录缺来源沿用旧展示/通用头像，不按当前 Mode、task.providerId 或 `matter.agents[0]`猜。网关未声明品牌用通用服务标，不按自由模型名猜厂牌。

| 界面 | 推荐显示（均待主人点头） |
|---|---|
| App 主对话、事项过程与带回结果 | [ConversationScreen](../../../apps/app/src/ui/ConversationScreen.tsx)及事项消息按归属画一个圆标；复用 [AgentAvatars](../../../apps/app/src/ui/AgentAvatars.tsx)与 [agents](../../../apps/app/src/view/agents.ts) |
| 桌面同上 | [converse](../../../apps/desktop/src/modules/converse.js)及事项过程复用 [共享头像](../../../apps/desktop/src/shared/agent-avatars.js)，每条直通/代答只露实际答话者一个标 |
| 已配对网页/PWA 同上 | [conversation](../../../apps/mobile/src/conversation.js)复用共享头像及同一来源；不因露标扩大短链接可见内容 |
| 微信文字 | 无法放同位 logo，建议例外使用短前缀 `[Grok] 正文`；复用交付层 participantLabel 的分条规则。普通 CC 不加，通知不冒充执行者；沿用任务头，不另发图片或新增身份消息 |

GUI 不在回复旁常驻厂商文字，保留读屏名称/悬停说明；CC 页头与现有事项参与者头像组保留各自用途，不拿头像组代表这条回复是谁说的。只增加来源辨识，不增第二个聊天入口。

## 4. Grok：独立身份，复用兼容通道

仓库 [provider-ids](../../../src/lib/provider-ids.ts)尚无 grok；ProviderId 虽是 string，注册仍须补事实、能力与构造，按 [加执行者手册](../../maintainer/add-an-executor.md)。当前 [providers](../../../src/daemon/bootstrap/providers.ts)的兼容槽是 `openaiBaseUrl/openaiModel` + `WECHAT_OPENAI_API_KEY`，可另配 openaiEvalModel；[createApiModel](../../../src/adapters/executors/openai/api-model.ts)用 Chat Completions 形状。

| 选项 | 取舍 |
|---|---|
| 现有 openai 槽指向 xAI 或提供 Grok 的网关 | 改配置少；会替换已有网关，身份仍是 openai，工作台也固定该槽模型。只适合用户主动替换的试用，不能算完整「补一家」 |
| **推荐：新增 grok 身份与独立槽，底层复用兼容适配器** | 原网关与 Grok 可同时在线；可直连 xAI，也可用网关；不另写调用循环或依赖 Grok 自带记忆/调度 |

建议新增 `grokBaseUrl/grokModel`、密钥声明 `WECHAT_XAI_API_KEY`，可选 grokEvalModel；这些**现在不存在**。填实际兼容端点、模型标识及该端点的 API key，沿现有密钥设置保存，不在消息/日志/报告输出。本文不指定未经仓库验证的 API 路径、现行模型名或原生搜索能力；实现时先核兼容性、工具调用、流式与错误形状。
需把 [对话适配器](../../../src/adapters/executors/openai/openai-agent-provider.ts)、[工作台适配器](../../../src/adapters/executors/openai/openai-workbench-provider.ts)及 [api-sessions](../../../src/adapters/executors/openai/api-sessions.ts)里的 openai 身份条件参数化：调用目标、续接、配置指纹、会话保留/清理都隔离到实际 provider，不能仅换 registry key。补 Grok 圆标至现有头像表，不让网关上的所有模型共用 Grok 标。
**网络守护沿实际端点判**：[call-classifier](../../../src/lib/call-classifier.ts)已列 x.ai 为官方，直连需保护；自定义网关默认不保护，可被 protect/protect_custom_gateways 覆盖，已知海外聚合仍按原分类。新身份须如实报实际 baseURL/model，经过 registry 和每轮/工作台准入门，不单凭“叫 Grok”放行或拦截（[规则](../../reference/network-guard.md)）。
**角色**：工具/权限/记录本真流程通过后可作执行者；对话、体检、记忆与轮换通过后可由主人选作 CC 后端。只会文字先只开文字，未验证的能力不宣称支持；不自动替换当前 CC，也不把手下执行者的失败静默切给另一家。

## 5. 拆步：每行一个小 PR，每行都双跑真模型

实施前确认第 6 节；以下均为未来验收计划，本稿没有运行结果。每个 PR 先离线守卫/契约，再按同一编造场景跑 **Claude 当 CC + 网关模型（如 Kimi-Code）当 CC 各一遍**，核目标、原文、来源和回执，不只看模型声称成功。
按根 [AGENTS](../../../AGENTS.md)与 [mini lab](../../maintainer/macmini-ui-lab.md)分工：mini 只做假服务/离线真接线与 UI 验收；真实模型双跑由整合者在有网络守护的主机、独立临时状态/测试项目中串行做。不上生产会话，不把密钥带到 mini，不把离线图当真模型证据。

| PR | 仅做什么 | 双跑各自的验收场景 |
|---|---|---|
| 1 来源贯通 | 回复/历史/事件/结果可选归属字段，旧端兼容；暂不改展示 | CC 一轮 + 执行者一轮；切后端后回看旧回复，来源不变 |
| 2 结构路由 | 共用目标契约，事项目标/点名/指称优先，一次代答不改 Mode | 同句从微信与设备入口走；事内原文直达当前棒；无事项焦点时，代答后的闲聊回 CC，原持久切换仍有效 |
| 3 兜底与纠正 | 限定模型判定、歧义问一句、退出/改投及回执核对 | 两件同名事、模型乱回/超时、说「不是这件」；不误开事、不重复投递 |
| 4 微信文字标识 | 直通/代答短前缀，通知分类沿交付层 | 多分条、附件、CC 咨询后自己答；前缀只给实际代答，不双发 |
| 5 App 露标 | 主对话/事项过程/结果用既有圆标 | 两棒接力回看、退出详情、重连；真实来源经离线 mini 同形回放验 UI |
| 6 桌面露标 | 同上，复用共享头像 | 同场景双跑产来源，mini 宽窄屏/读屏属性回放，旧消息不换标 |
| 7 网页露标 | 同上，设备与短链接边界不变 | 同场景双跑产来源，mini 重连/旧字段/设备权限回放 |
| 8 兼容适配器复用 | 参数化 provider 与会话隔离，不注册 Grok | 两个测试身份交替续接、轮换/清理；CC 与网关历史不串，守护目标正确 |
| 9 Grok 对话接入 | 独立配置/事实/能力/策略/注册/圆标，默认不换 CC | 两种 CC 均点名真 Grok 答一句/调工具；另以 Grok 作 CC 跑短体检/记账轮换；端点被守护拒绝时无请求 |
| 10 Grok 执行者 | 工作台构造、记录本与接力能力声明 | 两种 CC 各派 Grok 写编造文件并留备注，再交另一家回读；失败/提问停住，权限不扩大 |

每个 PR 记录提交、两次 CC 后端/模型、目标与实际回包来源、去重回执、结果及证据路径；UI 步另带 mini 回执。没有真模型、守护或隔离条件就记未验，不用 mock 冒充。按 [verify](../../maintainer/verify.md)跑牵连检查，既有测试只增不减。

## 6. 主人看得见、实施前需点头的选择

1. **答话路由**：明确「让 X 答这句」变成一次代答，结束恢复原目标；自然语言持久换后端、已回显事项焦点和当前棒补充保留。歧义问一句及「跟 CC 说 / 不是这件 / 换成 X」的文案和退回方式需确认；纠正语里的「换成 X」须确认只改原句还是持久切换。
2. **可见身份**：App/桌面/网页的直通、代答和带回原始结果只露实际一家圆标；微信用 `[名字]` 文字例外。CC 本人回复保留 CC，不露承载 CC 的后端标。
3. **Grok 入口与花费**：多一家配置、模型选择和执行者，新增密钥与独立额度；允许手动选作 CC，接入体检先展示预计用量/时间，默认 CC 不变。
4. **不作为新行为推出的现状**：话题只帮助找事；现有斜杠/模式、终端入口、审批和拆棒确认照旧。新增元数据、适配器复用属于内部工作，不拿本稿提交当作上述可见变化已获批准。
