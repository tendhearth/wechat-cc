# M6:读这一侧收口(设计稿)

2026-11-05 · 承接 [一个伙伴一副骨架](2026-10-31-one-companion-one-skeleton-design.md) §4 M6(做完 = `MatterEvent` / `TaskEvent` / `CliActivityItem` 三种形状不在 `src`;`detail()` 只读步;状态只从 matter 推)。

## 现在的样子(origin/dev 8941af93)
- **`TaskEvent`**(`src/adapters/store/workbench/timeline-events.ts`):内部类型,**已经从步来**(M2 起 `publicEvent(item)` 把 `matter_items` 翻回旧形状)。用它的:工作台 store / service、`features/workbench` 的 `continuation.ts`、`handoff.ts`、`wechat-results.ts`、`adapters/executors/codex/codex-execution-error.ts`。线上同形的是 `desktop-api.ts` 的 `WorkbenchTaskEvent`(桌面工作台详情 `/v1/workbench/task`,`apps/desktop/src/modules/workbench-timeline.js` 画)。
- **`MatterEvent`**:两份。`src/app/matters/service.ts` 里一份手写 interface(`detail()`、`chat.recent`、`searchOwnerChat`);`packages/protocol/src/api.ts` 里一份 zod(`MatterDetail.events`,App 每个返回都过 `PHONE_API_SCHEMAS`)。来源:任务 = `workbench.detail().events`(也就是步);对话 = `messages` 表经 `owner-chat-reading.ts`(§8.4:正文唯一来源,M3 没动出口);终端 / act 的详情 `events` 是空的。桌面 `converse.js` 读 `/v1/matter/owner-chat` 的 events;搜索命中走 `desktop-api.ts` 的 `MatterEvent.extend`。
- **`CliActivityItem`**:`src/features/terminal/cli-activity.ts` 定义,协议包里同形一份(`/m/api/cli/activity`、`CliSessionRow.now`,App `useTerminal.ts` 读)。终端的步**存的就是它**(`terminal-steps.ts` 把它原样当 payload)。还有两处直接解析记录:
  - `phone-actions.ts` 的退路:`steps.view()` 给 null(会话还没有那件事)⇒ `activityOfTranscript` → `parseActivity`。`wire.ts` 的列表「此刻那一步」同样有这条退路。
  - 微信「看 码」的 `renderTurnSteps`(`reply-handler.ts` 调)每次整段 `parseActivity`,**从来不读步**。
- **`matters.status`**:写 —— `matters-store.ts` 的 `create` / `setStatus`,调 `setStatus` 的是 `service.ts` 的 `syncTask` 与工作台 `service/lifecycle.ts`、`execute.ts`、`native.ts`(同一个「任务 → 旧状态」式子抄了两遍)。读 —— `toMatter` 原样给出(`state` / `archivedAt` 根本不上线);列表按它筛:`routes-matters.ts`、`settings-panel.ts` 的 `?status=`(默认 open,replied,done = 不要归档的)、`mobile-home-focus.ts`、`pipeline-deps.ts` 的今日总览;`phone-topic-sources.ts` 的 `matter/<id>` 帧 `phase` 对非任务就是它。`state` 只有 `MatterLog` 自己和 `execution-settings.ts` 读。
- **客户端读 `status`**:App —— `view/status.ts` 的 `statusOfMatter`(没任务的事:对话 / 终端 / act 全靠它)、`view/home.ts` 与 `view/cc-acts.ts` 的 `m.status !== 'archived'`、`backend/demo.ts`;协议里 `Matter.status` 是**必填枚举**,少了或多一个值,老 App 整页解析失败。手机网页 `apps/mobile/src/workbench.js` 读 `matter.status` 并带 `?status=open,replied,done`。桌面不读 `matter.status`(按任务 / 终端自己的状态)。
- **金样**(`src/daemon/__golden__/matter-read-paths.golden.test.ts`,19 份):三件任务(做完 / 卡权限 / 卡提问)× `/v1/workbench/task`、`/v1/matter`、`topic matter/<id>`、`/m/api/matter`,外加 `?since=8`;主人对话 × `/v1/matter`、topic、`/m/api/matter`、`/m/api/chat`(两页);终端 × `/m/api/cli/activity`。`matter.status` 在每份详情里逐字节钉着。**没钉的**:终端 / act 那件事的详情、`/m/api/matters` 列表行、`CliSessionRow.now`;而且终端那份接的 `makeCliPhoneActions` 没给 `steps` —— 钉的是**退路的解析**,不是生产走的步。
- **兼容的约定**:没有别名表,也没有客户端版本统计。握手 `ClientHello` 只有 `client: 'web'`(`packages/protocol/src/messages.ts`),App 不报版本;唯一的先例是中继 v1 按日期退休(2026-10-25,回 `upgrade_required`)。主人手里的 App 是 build 2(`apps/app/app.json`)。

## 定案
**`src` 里只剩「步」一种读形状;线上的旧形状冻结,由一个投影文件从步(和 `messages`)现算,留到最低在用的客户端跟上。`status` 列删,线上的 `status` 字段从 `state` + `archivedAt` 推。**
- 线上留着、改成现算的(到「退休条件」为止):`Matter.status`(枚举不变)、`MatterDetail.events`(`MatterEvent` 形状)、`WorkbenchTaskEvent`、`CliActivityItem` 与 `CliSessionRow.now`、topic 帧的 `phase`(本来就是字符串)。
- 线上新增(纯加字段,老 App 的 zod 丢掉不认识的键):`Matter.state`、`Matter.archivedAt`。新 App 读这两个,不再读 `status`。
- 兼容表一处:新文件 `packages/protocol/src/wire-compat.ts`,每行 = 旧字段、从哪推、退休条件;守卫只许行数变少。退休条件按版本不按日期:握手加可选 `build`(App 报 Expo 构建号;老 daemon 丢掉不认识的键),daemon 记每台设备最近一次的构建号;**近 30 天连过的设备都 ≥ 那一版**才删那一行。桌面随版本走,条件写「桌面 ≥ 带新读法的那一版」。

### M6a 金样补齐(只加测试)
- 终端那份改接生产的 `steps`(真 `makeTerminalSteps` + 终端那件事);**字节不变**就证明步和退路解析一样,不一样就在这个 PR 里讲清楚。
- 新钉:终端那件事的 `/v1/matter` 与 `/m/api/matter`、一件 act(信)的 `/m/api/matter?id=`、`/m/api/matters`(默认与 `?kind=act`)、`/m/api/cli/sessions` 的 `now`。
- 做完怎么算:新旧金样都绿;生产代码零改动。

### M6b 状态从 matter 推(daemon;列照旧写)
- 一个函数 `legacyStatus(state, archivedAt, 最近一轮)`:归档 ⇒ archived;done / failed / cancelled ⇒ done;任务开着且最近一轮已收 ⇒ replied;其余 open。
  - 实际落地(`src/domain/matters/legacy-status.ts`):非任务一律 open(终端会话结束 state = done,列也还是 open —— 真库 12 行);任务的 done / 中断看 `workbench_tasks.status`(写列的式子看的就是它)。
  - **replied 这一位照旧读列**(`storedReplied`,Codex 评审 P2):执行者先交结果、后台还在干时,轮已收、state 回 open,但 `settleQuiet` 要等运行时真闲下来(没后台、没待拍板)才写 replied。这份「准备好了」除了列哪儿都没落库。所以 replied = 列记着 replied **且**任务在跑、state = open、最近一轮已收;其余照现算(列过期的 replied 不算)。`toMatter`、列表筛选(`?status=` 照收,翻成 `archived_at` / `state` 条件)、topic 的 `phase` 都改用它;工作台那两份「任务 → 旧状态」式子合成一份。
- `Matter` 加 `state` / `archivedAt`;握手加 `build` 并记下来;`wire-compat.ts` 建表。
- 拿真库副本对一遍(同 M4d 第 1 步):推出来的和列逐行一样才合;不一样的行在 PR 里逐条说明并补上。
- 金样:所有详情只多两个字段,重录并逐行说明;`status` 一字不变。

### M6c `TaskEvent` / `MatterEvent` 退出 src(daemon)
- 工作台那四个消费方改吃 `MatterItem`(要字段的地方用步的 payload);`timeline-events.ts` 只剩写口和「步 → `WorkbenchTaskEvent`」的投影。
- `service.ts` 的手写 `MatterEvent` 删;`detail()` 的 events:任务 = 步的投影;对话照旧按 `messages`(正文来源,§8.4),类型用协议包的 `MatterEventT`;终端 / act 照旧空。
- 做完怎么算:`grep -w 'TaskEvent\|MatterEvent' src` 为零(协议包里的线上形状不算);金样一字不变。

### M6d 终端不再直接解析记录(daemon)
- 会话第一次被看、还没有那件事 ⇒ 当场建那件事、导入一次(骨架 §4 M4「首见导入一次」),之后只读步;`phone-actions.ts` / `wire.ts` 的退路删。
- 「看 码」的 `renderTurnSteps` 改读最近一轮的步。
- `CliActivityItem` 改名为 `ports/terminal-steps.ts` 里步的 payload 类型;`parseActivity`、`activityOfTranscript` 和缓存删,`feedActivity` 留着(增量读要它)。
- 做完怎么算:三种形状都不在 src(骨架 M6 的门);终端金样一字不变。

### M6e 停写、删列(soak 之后)
- **前提:「答完了、闲着」先落成 matter 上的事实,`legacyStatus` 改读它,再删列。** 提议:`settleQuiet` 在写 replied 的那一刻,往这件事最近那一轮(已收的那一轮)写一步 `system`,key = `ready:<turnId>`、payload `{ready:true}`(幂等,同一轮只一行)。`legacyStatus` 的 `storedReplied` 换成「最近一轮有这一步」;新一轮开始自然就不算了(最近一轮换了),不用撤。出口要把这一步从 `MatterEvent` / `WorkbenchTaskEvent` 的投影里滤掉(用户看不见),金样一字不变为门。换读法那一步先在真库副本上对一遍 replied(列 vs 步)再删列。
- `setStatus` 改名只管归档 / 重开(写 `archived_at` 与 `state`);迁移删 `matters.status`(重建表,`withoutForeignKeys`,见 `docs/maintainer/migrations.md`);从此回不到之前的版本。
- 手机网页改读 `state` / `archivedAt`(随 `self deploy`,和 daemon 同步到手)。
- 做完怎么算:`status` 不在 `matters` 表与 `ports/matters.ts` 里;线上 `Matter.status` 只剩 `wire-compat.ts` 那一行在推。

### M6f App 改读新字段(随下一个 build)
- `statusOfMatter`、`home.ts`、`cc-acts.ts`、`demo.ts` 改读 `state` / `archivedAt`;老 daemon 不带 ⇒ 退回 `status`。
- 这一版之后才轮得到兼容表删行;删行是另一个 PR,按退休条件来。

## 不做 / 推后
- **对话详情里带上工具那几步**:不在 M6。步早就有(M3),但一放进 `events`,老 App 当场就会画出来(`view/conversation.ts` 认 `tool_call`)—— 主人看得见,要另外点头。
- **`messages` 换成步**:不做。正文唯一来源照 §8.4。
- **`/m/api` 路径别名**:P3 的事;M6 只建字段那一张表,P3 往里加路径。

## 风险
- **replied 推不准**:旧列的 replied 来自任务的 phase;最近一轮已收是近似。M6b 的真库对账是门,对不上不合。
- **首见导入**:钩子的回包有时限,导入只发生在「有人来看」那条路上,不在钩子里;读尾巴 256KB 照旧。
- **删列不可逆**:M6e 只在 M6b–M6d 部署 soak 绿之后。
- 主人看得见的:无(M6a–M6f 都以金样逐字节不变或只多字段为门)。

## 顺序
M6a → M6b → M6c、M6d(可并行,碰的文件不重叠)→ soak → M6e;M6f 随下一个 build,和 M6e 不互等。M6a–M6e 只动 daemon(`self deploy` 生效)。
