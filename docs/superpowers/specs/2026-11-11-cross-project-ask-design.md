# 跨项目问 CC（2026-11-11）

让主人在微信、桌面、App一句话查跨项目进展，按项目一两句：做了什么、此刻状态、是否需要你，等你在前，附会话码或话题名。没有记录就说没有；三端界面不改。此次产品负责人的详细任务授权覆盖下述最小实现。

## 方案

选新增只读 `projects_activity({ since?, until?, projects? })`。扩展today_digest仍受滚动24h与正文边界限制；拼topic_search/terminal_sessions既不能取历史窗，也会读不需要的正文。独立reader复用#890当前安全活动与项目身份解析，不改现有计数口径。

## 数据与边界

- 时间参数为带时区ISO，范围 `[since,until)`，until默认现在；无since可查已记录历史（用于“上次”）。日/周由对话按主人时区转成明确边界，周一开始；当前活动明确标记为generatedAt快照，不冒充历史状态。
- 历史从owner的task/terminal轮次及安全步骤元数据读取（包括归档）；终端按该轮policy.cwd归属，不用当前cwd替过去补归属。复用真实common-dir与唯一话题证据；无可靠公开话题归属不猜。公开done话题历史允许使用有效work归属证据；跨仓库迁移且仅有matter级work证据时继续弃用该证据，不能假定条目属于哪轮。远端、子agent、临时目录、private排除，done公开话题可查历史。输出说明此覆盖范围，不能将缺记录说成没工作。
- 当前计数复用projectActivities：只未决审批/提问等你；真执行才在跑；终端答完不算等你/未读。会话只返回码/类型/执行者/固定步骤/时间/状态，不取原始标题或消息。
- topic_entries仅decision/progress/conclusion的已有line，live/done，按updated_ts筛窗，明确是条目更新时间而非工作发生时间；不读body/命令参数/diff/输出/问题或审批正文。带matter_id的work索引行继承事项的owner、本机和非临时来源限制；读取后的同步阶段再核对话题与事项权限。
- 最多12项目，各3历史、3条目、3当前入口，整体12000字符；截断明确标记，可用projects缩小。projects按话题id/title/alias精确匹配，缺数据明确返回空，不虚构项目。只admin且主人当前聊天（含已绑定shared turn）；拒访客/其他chat，读完复核owner。不adopt、不seen、不写库、不调用模型。

## 验证

先用现有recall离线跑五问、先查报告落scratchpad；随后先红后绿。五个eval样本自带虚构证据与明确窗口，通过现有CLI报告/规则→真eval路由→生产聚合函数，不起模型；另用内存真store→工具route验证SQL、历史cwd、隐私、只读与权限。隐私守卫扩展新工具。提示要求先取工具、等你优先、每项目一两句、仅引用已给入口、不猜卡住原因。

主Mac同一命令先判断load<8且无CivilizationVII再bun run verify；不跑UI、不上mini、不触碰daemon/live库。verify绿后一次提交（含Co-Authored-By），不push。真实模型的自然语言遵循留给整合者后续授权评估，本次不伪称已验。
