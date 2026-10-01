# Tendhearth 手机接着做电脑上的会话(Claude Code / Codex)· spec(plan 7b)

日期:2026-10-01。状态:设计稿。基线 origin/dev 7757748d(#165 配对体验 7a)。增补 `2026-10-01-tendhearth-app-chat-design.md` 的「电脑上的会话(只读)」部分,以及工作台原生会话导入(`src/core/workbench/service/native.ts`)。plan 7 的第二份:7a = 配对(已合),**7b = 本 spec**。

依据(**有约束力**):
- 主人 2026-10-01 的要求:「手机上能接着 Claude Code / Codex 的会话」(§1)
- 控制者裁决 1–9(§2,原样采纳)
- 设计原则 `~/Documents/tendhearth/cc-screens-2026-09-30/CC-设计原则.md`(下称「原则」):只留 CC + 功能、全衬线、一个强调色(只给动作)、状态色只上点、页面不变色(无深色)、状态只说真话

## 0. 白话

手机上「设置 → 电脑上的会话」里点开一条 Claude Code 或 Codex 的会话,读到底下有一个「接着做」。点它,弹出一张小卡,老老实实说清楚:会在你的电脑上、用哪个执行者、在哪个文件夹里接着做,会用掉它的额度;是接着原来那个会话(它记得之前说过的话),还是原会话接不上、带着记录新开一轮;还有一句 —— 先让电脑上原来那个停下,CC 没法替你确认。点「已经停了，接着做」,这条会话就变成「一起做」里的一件事,手机直接进这件事、打开说一句的输入框(光标已经在里面),你写下一句要它接着做什么。之后的批准、提问,走现在就有的卡片。

已经接过的会话,按钮变成「打开这件事」,直接进那件事,不再导入第二次。这个会话此刻正在电脑上跑(CC 看得见的时候),不给按钮,只一行灰字「这个会话正在电脑上跑，停下后才能接着做」。CC 绝不去停、去抢一个正在终端里跑的会话。

## 1. 主人的要求

「手机上能接着 Claude Code / Codex 的会话」(plan 7 清单,2026-10-01)。

## 2. 裁决(采纳)与本 spec 补的决定

控制者裁决 1–9 原样采纳:范围只到 Claude Code + Codex 原生会话(1);会话读页一个「接着做」+ 确认卡 + 导入成一件事 + 进那件事、输入框聚焦(2);接过的 ⇒「打开这件事」(3);正在跑 ⇒ 灰字、绝不劫持(4);新路由在 `/m/api/*`、登记 `phone-routes.ts`、schema 在协议包、处理器在 mobile-workbench 模块直接调核心服务、令牌尽量留在服务端(5);matter/say 不认导入任务就修绑定而不是另开一条路(6);每种状态说真话、daemon 没确认前不画「在跑」(7);测试面(8);文案 zh + en、中文全角标点(9)。

下面是裁决没覆盖、本 spec 补上的决定(实施以此为准,交主人过目):

- **D1 手机只传会话 key,导入的页与消息由 daemon 挑**。桌面导入要客户端带 `pages` + 每页指纹 + `messageIds`(`POST /v1/workbench/import`);手机不该拼这些。daemon 读第一页(`limit: 100`),按桌面 `nativeImportMessages` 同一条规则挑消息(从最新往前,至多 200 条、合计 ≤ 24 000 字,单条放不下就跳过),规则搬进核心 `selectNativeImportMessages`(桌面那份不动)。读与导入之间会话变了(`native_history_changed`)⇒ 重读重导一次,再变就如实报错。
- **D2 不让人选模式**。裁决 2 说「两种都可以时才给选」;核心里这两种是互斥的:`native_resume` 要求执行者能恢复这个会话(`canResume`),`fresh_context` 只在**不能**恢复(`continuation.mode === 'restart_required'`)时才被 `prepareNativeResume` 接受 —— 两者从不同时成立。所以确认卡不出选择,只如实说是哪一种;第一句话到达时按同一条规则再判一次(与桌面 `workbench.js` 的 `native-prepare` 同一判法)。
- **D3 确认卡就是「原程序已关闭」的声明**。CC 看不见普通终端里跑着的 Claude Code:Claude 原生历史的 `observedState` 永远是 `unknown`,只有 Codex 的 `active`、CC 自己占着的会话(含 CC 派出去、带 `origin_agent` 的 CLI hook 会话)能被看见。主人自己在终端里开、装了 hook 的会话**目前也看不见**:`executionConflict`(`main.ts:722-725`)只认带 `origin_agent` 的 hook 会话(见 §7 第 2 条)。所以「正在跑 ⇒ 灰字」只能覆盖看得见的那部分;看不见的那部分靠主人自己声明 —— 与桌面「原程序已关闭，继续」同一个语义。卡上明说「先让电脑上原来那个 {provider} 停下。CC 没法替你确认它停了。」,确认按钮写「已经停了，接着做」。核心的 5 分钟决定令牌(`state.nativeDecisions`)**从不离开 daemon**:第一句话到达时,daemon 在同一次调用里 `prepareNativeResume` + `continueNativeTask`,令牌只在内存里活几毫秒。审计照旧:`start()` 记一行「用户声明原 {provider} 执行程序已关闭,选择恢复原会话 / 带已确认的记录新开一轮」。
- **D4 matter 绑定的真缺口是「导入不建 matter」**。调查:`matter/say` 对 `kind: 'task'` 没有主人校验(`matter_say_unsupported` 只在 chat 分支),但 `store.importSource` 只建工作台任务、**不建 matter 行** ⇒ 手机 `GET /m/api/matter?id=` 直接 404。修法:新的 `adoptNativeSession` 在导入后补建 matter(id = 任务 id,与 `createTask` 的登记一致:`create` + `linkTask` + 有主人则 `bind('wechat', owner)`),并登记手机露面;桌面早先导入过的(managed)走同一个补建。桌面导入路径不改(桌面不需要 matter 行,别让桌面行为在这一份里漂)。
- **D5 matter/say 的新分支只对手机生效**。`say(id, text, 'phone', input)` 碰到「导入了、还没发过第一句」(`requiresExternalClose`)的任务 ⇒ 走 `workbench.continueImported`;桌面 / 内部 API 的 `say` 照旧拿到 `409 external_close_confirmation_required`,桌面的声明按钮不被绕过。
- **D6 第一句话也按 requestId 幂等**。手机「说一句」超时会用同一个 `requestId` 重发;导入任务的第一句原本不进回执表(`continueNativeTask` 不收 `inputRequestId`)⇒ 重发会起第二轮。给 `continueNativeTask` 加一个可选尾参 `{ inputRequestId?, attachmentPolicy? }`,交给 `start()` 的 `queuedInputId` —— 与 `continueTask` 同一张回执表;重发时先查回执,命中就原样返回。内部 API 调用不变。
- **D7 「忙」分两种,各说各的**:会话本身在跑(看得见的 `active` / 远程 / `executionConflict(path, provider, nativeId)`)⇒ `busy_session`,用裁决 4 的原话;CC 正在这个文件夹里做别的事(`executionConflict(path, provider, null)`,比如微信那边的 CC 会话占着这个项目)⇒ `busy_folder`,另一句。两种都不给按钮。
- **D8 能不能接是一条单独、不缓存的 GET**。`GET /m/api/session` 有 15 秒单飞缓存(裁定 8),「正在跑」不能晚 15 秒才知道;所以新开 `GET /m/api/session/continue?key=`,读页打开时、重连后(连接 epoch 前进)、点开确认卡时各问一次。`POST` 里 daemon 再判一遍(状态在两次之间变了 ⇒ 对应错误码,卡里换成那句话)。
- **D9 「打开这件事」也走 `POST`**。它幂等:已接过 ⇒ 不再导入,只补 matter 行(桌面导入过但没有 matter 行的那种)、登记手机露面,回同一个 matterId。
- **D10 额度**:预览时执行者额度已耗尽(`quotaExhausted`)⇒ 不给按钮,一行灰字。文案用桌面现成那句(`workbench-execution.js` 的 `provider_quota_exhausted`),去掉「交给另一位执行者继续」那半句(手机这一版没有换执行者)。说一句页碰到 `provider_quota_exhausted` 也说这句。
- **D11 手机错误码细分**:`BackendCode` 加 `session_busy`(`native_session_busy`)、`folder_busy`(`native_folder_busy`)、`provider_missing`(`unavailable_provider`)、`folder_missing`(`invalid_path`)、`quota`(`provider_quota_exhausted`)。这是全局映射:交办新事项碰到同样的码也会说同样的话(更准,不是更坏)。另加三个(控制者裁决 R5):`session_changed`(`native_history_changed`,可重问预览再接)、`session_empty`(`native_history_empty`)、`session_managed`(`native_session_already_managed`,不是错:重问预览、打开那件事)。三个都不说「没送到电脑上」。
- **D12 接过来、还没发第一句的那件事,页面上说清楚第一句会怎样**:`MatterDetail` 加可选 `nativeStart: { mode, providerId }`(仅在 `requiresExternalClose` 时出现),进展页与说一句页顶上显示「你发的第一句会接着电脑上原来的 {provider} 会话。」或「…会新开一轮，带上之前的对话记录。」,再加「先让电脑上原来那个 {provider} 停下…」。发过第一句后字段消失。
- **D13 项目只给目录名**:预览里的 `project` 与会话列表一样是 `basename(cwd)`,手机永远拿不到完整路径与 nativeId。
- **D14 权限档不变**:设备令牌与链接令牌共用 `PHONE_ROUTES`(`LINK_ROUTES = PHONE_ROUTES`,admin 档),新两条随之而来;不是 `LAN_ONLY_OPS`,在外面也能用。微信 `/set` 链接 10 分钟内同样能接着做 —— 与「交办新事项」同权,没有放宽。

## 3. 现状核对(调查结论)

| 调查项 | 结论 | 位置 |
|---|---|---|
| 手机只读列表 / 单条 | 属实;单条带 `managed`(有工作台任务管着这个 nativeId) | `src/daemon/mobile-reads.ts:87-107`;`phone-routes.ts:42-43`;协议 `api.ts:340-345,374-375` |
| 读页 | 「只读」一行 + 消息 + 继续读取;**不用** `managed` | `apps/app/src/app/sessions/[key].tsx` |
| matter/say 收不收导入任务 | `kind: 'task'` 不查主人;但导入的任务**没有 matter 行** ⇒ 404;即使有,`continueTask` 对「还没发过第一句」的导入任务抛 `external_close_confirmation_required`(409) | `src/core/matters/service.ts:110-139`;`store.ts` `importSource` 不碰 matters;`execute.ts:536` |
| 导入 → 第一句的模式选择 | 桌面:`continuation.mode === 'restart_required'` ⇒ `fresh_context`,否则 `native_resume`;`prepareNativeResume` 校验互斥 | `apps/desktop/src/modules/workbench.js:1226`;`native.ts:168-190` |
| 5 分钟决定令牌 | `state.nativeDecisions`(内存 Map,上限 100,同任务新的顶掉旧的);`restartToken` 只在服务端决定里 | `native.ts:185-188` |
| 忙的判定 | `observedState === 'active'`(只 Codex 有)/ `remote` / `executionConflict(path, provider, nativeId)`;后者在 `main.ts:722` 接成「CC 会话占着项目 / 会话库里有同一 nativeId / 旧认领 / 带来源的 CLI hook 会话」 | `native.ts:33,41,177`;`main.ts:722-725` |
| 手机任务页 / 说一句 / 批准 | 进展页底部「说一句」→ `/compose?matter=`;`say(id, text, requestId)` 幂等;批准 / 提问卡已有;**没有额度文案** | `apps/app/src/app/matter/[id].tsx`、`compose.tsx`、`approval/[id].tsx` |
| 演示数据能不能表示会话 | 能:`demo-claude-1`(进行中)、`demo-claude-2`、`demo-codex-1`;Maestro 已有「设置 → 会话 → 读一条」 | `apps/app/src/backend/demo-data.ts:146-166`;`.maestro/connections.yaml` |
| 手机路由守卫 | `scripts/phone-routes.guard.test.ts` 从 `settings-panel.ts` routeRequest 与 `mobile-workbench.ts` / `mobile-chat.ts` / `mobile-reads.ts` 抓 `url.pathname === '…'` 字面量,双向比对;`phone-api-schema.test.ts` 要每条路由有 schema | — |
| 设备令牌档位 | 设备令牌 / 链接令牌都是 admin 档,`routeAllow = PHONE_ROUTES`;经隧道只拒 `LAN_ONLY_OPS` | `phone-routes.ts:52-61` |

## 4. 架构

### 4.1 核心:工作台原生域(`src/core/workbench/service/native.ts`)

新增四个函数(都在原生域里,经 `ServiceCtx` 拿依赖,门面 `service.ts` 暴露后三个):

- `inspectNativeSession(key)`(域内):按顺序判,返回 `{ preview, page }`:
  1. 解 key(坏 ⇒ `invalid_native_history_key`)。
  2. 已有任务管着这个 nativeId(导入过 / 工作台跑出来的)⇒ `managed`(带 `taskId`、目录名)。
  3. 读第一页(`limit: 100`,经 `historyDeadline`);读不了 ⇒ 抛(`native_history_unsupported` 等)。
  4. 没有 cwd / 目录不在 / 不是规范路径 ⇒ `folder_missing`。
  5. 执行者没准入(`act().provider` 抛)⇒ `provider_missing`。
  6. `remote` 或 `active` ⇒ `busy_session`;`executionConflict(path, provider, null)` ⇒ `busy_folder`;`executionConflict(path, provider, nativeId)` ⇒ `busy_session`。
  7. 额度耗尽 ⇒ `quota`。
  8. 挑不出能带过来的消息 ⇒ `empty`。
  9. 否则 `ready`,`mode` = 能恢复(`canResume`,用 `{ providerId, sessionId: nativeId, path }` 判)? `native_resume` : `fresh_context`。
- `previewNativeContinue(key) → NativeContinuePreview`:只读,不建任何东西、不起执行者。
- `adoptNativeSession(key) → { taskId, created }`:`managed` ⇒ 补 matter 行、回原任务;`ready` ⇒ 用 `selectNativeImportMessages` 挑消息、走现有 `importNativeHistory`(同一套快照 / 指纹 / 截断规则)、补 matter 行;其余状态 ⇒ 抛对应错误码(`NATIVE_CONTINUE_REFUSAL`:`native_session_busy` / `native_folder_busy` / `unavailable_provider` / `invalid_path` / `provider_quota_exhausted` / `native_history_empty`)。`native_history_changed` 重来一次。matter 补建失败不回滚导入 —— 下次 `adopt` 走 `managed` 再补(自愈)。
- `continueImported(id, text, options, attachmentPolicy?)`:先查回执(D6);再确认这是「导入了、还没发过第一句」的任务(否则 `invalid_request`);按 D2 选模式,`prepareNativeResume` 拿决定,从服务端决定里取 `restartToken`,交给 `continueNativeTask(..., { inputRequestId, attachmentPolicy })`。所有既有的守门(目录身份、执行冲突、页指纹、恢复令牌)原样生效。
- `continueNativeTask` 加可选尾参 `extra: { inputRequestId?, attachmentPolicy? }`(D6),只透传给 `selectAttachments` 与 `start`。

`native-adoption.ts` 新增纯函数 `selectNativeImportMessages`、类型 `NativeContinueState` / `NativeContinuePreview`、常量 `NATIVE_CONTINUE_REFUSAL`。

### 4.2 核心:「一件事」(`src/core/matters/service.ts`)

- `MattersServiceDeps.workbench` 加可选 `continueImported`;`detail` 的类型加 `requiresExternalClose?` / `continuation?`(工作台 detail 本来就给)。
- `say`:`surface === 'phone'` 且详情 `requiresExternalClose` ⇒ `await workbench.continueImported(id, text, { inputRequestId?, draftId?, attachmentIds? }, 'owner')`,回执照旧从详情里取(D5、D6)。没接 `continueImported` ⇒ 落回原路径(仍是 409)。
- `detail`:`requiresExternalClose` ⇒ 加 `nativeStart: { mode, providerId }`(D12)。

### 4.3 daemon 路由与协议

两条新路由,同一路径,处理器 `mobileSessionContinueRoute(actions, url, req, seen?)` 写在 `src/daemon/mobile-workbench.ts`(已在守卫扫描名单里;路径用 `url.pathname === '/m/api/session/continue'` 字面量,`!==` 不会被守卫抓到):

| 路由 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `GET /m/api/session/continue?key=` | `key` 恰好一个、1–2048 字 | `{ ok, state, provider, project, mode, matterId }`(状态见 §4.5;`matterId` 只在 `managed` 有) | 400 `invalid`;404 `unsupported`(这台电脑没有这类历史);503 `sessions_not_wired` / `unavailable` |
| `POST /m/api/session/continue` | `{ key }`(多一个键 ⇒ 400) | `{ ok, matterId, created }`,并 `seenOnPhone(matterId)` | 409 `native_session_busy` / `native_folder_busy` / `native_history_changed` / `native_history_empty`;400 `invalid_path` / `invalid`;503 `unavailable_provider` / `provider_quota_exhausted` / `unavailable`(`matters_not_wired` 等);404 `unsupported` |

- `mobileMatterError` 的 409 名单加 `native_session_busy`、`native_folder_busy`、`native_history_changed`(第一句 `matter/say` 也会抛它们;今天会落成 500)。
- 协议 `packages/protocol/src/api.ts`:`SessionContinue`、`SessionContinueResult`、两条 `PHONE_API_SCHEMAS`;`MatterDetail` 加可选 `nativeStart`;`index.ts` 导出。
- `phone-routes.ts`:`'GET /m/api/session/continue'`、`'POST /m/api/session/continue'`。
- `settings-panel.ts`:依赖 `sessionContinue?: MobileSessionContinueActions`;在 `mobileWorkbenchRoute` 之后分发。
- `wiring/pipeline-deps.ts`:`sessionContinue: { preview: k => workbench.previewNativeContinue(k), adopt: k => workbench.adoptNativeSession(k) }`。
- 不加任何 `/v1/*` 路由 ⇒ 桌面四处白名单、Rust 宿主都不动。

### 4.4 手机

- 后端接口 `Backend` 加 `continuePreview(key)`、`continueSession(key)`;`live.ts` 走两条路由(POST `retry: true`,幂等);`demo.ts`:`demo-claude-1` ⇒ `busy_session`,`demo-claude-2` ⇒ `ready` / `native_resume`,`demo-codex-1` ⇒ `ready` / `fresh_context`;接过 ⇒ `managed`;接成的事带 `nativeStart`,第一句后去掉。
- `net/errors.ts`:D11 的五个码(在 `invalid_` 前缀规则之前判)。
- 纯视图 `view/continue.ts`:`continueBlock`(读页底部那一块)、`continueSheetLines`(确认卡几行)、`continueErrorText`(卡里的失败句)、`nativeStartLines`(进展页 / 说一句页的第一句说明)、`providerName`。`view/compose.ts`:`composeOutcome` 认五个新码,`composeOutcomeText` 统一出一句话。
- 确认卡的「先让原来那个停下」与主按钮按执行者分(D3,控制者裁决):Claude Code(CC 看不见普通终端里的它)⇒ `stopFirst` + 主按钮 `confirm`「已经停了，接着做」;Codex(CC 读得到它在不在跑,在跑的预览就是 `busy_session`)⇒ `notSeenRunning` + 主按钮 `action`「接着做」。进展页 / 说一句页的第一句说明同一条规则。
- 读页 `sessions/[key].tsx`:去掉「只读」一行;底部固定一块(像进展页的说一句):
  - 还在问 ⇒ 什么都不画(不先画一个可能用不了的按钮)。
  - `ready` ⇒ 唯一的强调按钮「接着做」(`session-continue`);离线 / 连接中 ⇒ 按钮锁住(`ConnectionNotice` 说为什么)。
  - `managed` ⇒ 强调按钮「打开这件事」(`session-open`)⇒ `POST`(幂等)⇒ `router.push('/matter/<id>')`。
  - 其余 ⇒ 一行灰字(`session-continue-note`),问不到 ⇒ 灰字 +「再试一次」。
  - 确认卡(`Modal`,与说一句页「调整」同一个底部卡样式):标题 +§4.5 的几行 + 主按钮「已经停了，接着做」(`continue-confirm`)+ 次按钮「取消」;点开时重问一次预览,状态变了就换成那句灰字、收起主按钮。提交中按钮转圈;失败 ⇒ 卡里一行(`continue-error`,点 + 文字);成功 ⇒ `router.replace('/matter/<id>')` 再 `router.push('/compose?matter=<id>&focus=1')`。daemon 没回成功之前,页面上不出现任何「在跑」。
- 说一句页 `compose.tsx`:`focus=1` ⇒ 输入框 `autoFocus`;说的是一件事时读它的详情(与进展页共用 `matter:<id>` 缓存),有 `nativeStart` ⇒ 顶上两行说明(`compose-native-start`);失败句改用 `composeOutcomeText`。
- 进展页 `matter/[id].tsx`:状态标签下,有 `nativeStart` ⇒ 同样两行(`progress-native-start`)。

### 4.5 状态与文案对照

| 预览 state | 读页底部 | 确认卡 / 提交失败 |
|---|---|---|
| (问着) | 不画 | — |
| (问不到) | `continue.unknown` +「再试一次」 | — |
| `ready` | 「接着做」 | `runsOn` / `modeResume` 或 `modeFresh` / `quotaNote` / `stopFirst`;主按钮 `confirm` |
| `managed` | 「打开这件事」 | — |
| `busy_session` | `busySession`(裁决 4 原话) | `session_busy` ⇒ 同一句 |
| `busy_folder` | `busyFolder` | `folder_busy` ⇒ 同一句 |
| `provider_missing` | `providerMissing`(裁决 7 原话) | `provider_missing` ⇒ 同一句 |
| `folder_missing` | `folderMissing` | `folder_missing` ⇒ 同一句 |
| `quota` | `quota` | `quota` ⇒ 同一句 |
| `empty` | `empty` | — |
| 提交「不确定」 | — | `uncertain`(再点不会重复:POST 幂等) |
| 提交时会话刚变(`native_history_changed` ⇒ 手机 `session_changed`) | — | `changed`;重问预览,还能接就照旧给确认按钮 |
| 提交时没内容(`native_history_empty` ⇒ `session_empty`) | — | `emptyNow`;重问预览 |
| 提交时别处刚接过(`native_session_already_managed` ⇒ `session_managed`) | — | 不是错:重问预览,`managed` ⇒ 走「打开这件事」 |
| 没送到(离线 / 那一块没接上) | — | `compose.failed` |
| 其它失败(电脑答了、但没接上) | — | `failed`(中性,不说「没送到」,裁决 R5) |

## 5. 文案

中文全角标点(,。?:「」),一句话的灰字结尾不加句号(与「这台电脑上没有它的会话记录」同一风格);卡里的整句带句号。英文用弯引号与 ’、破折号 —。手机进 `apps/app/src/i18n/{en,zh-Hans}.ts`(键一致)。`{provider}` 填 `Claude Code` / `Codex`(现有 `sessions.claude` / `sessions.codex`)。

| 键 | zh | en |
|---|---|---|
| `continue.action` | 接着做 | Continue here |
| `continue.open` | 打开这件事 | Open this task |
| `continue.title` | 在手机上接着做？ | Continue from your phone? |
| `continue.runsOn` | 会在你的电脑上用 {provider} 接着做，文件夹是 {project}。 | It runs on your computer with {provider}, in the folder {project}. |
| `continue.unknownFolder` | （未知） | (unknown) |
| `continue.modeResume` | 接着原来的会话，它记得之前说过的话。 | It picks up the same session, so it remembers what was said. |
| `continue.modeFresh` | 原来的会话没法直接接上，会新开一轮，把之前的对话记录一起带上。 | The original session can’t be resumed, so it starts a new round and brings the earlier conversation along. |
| `continue.quotaNote` | 会用掉 {provider} 的额度。 | This uses your {provider} quota. |
| `continue.stopFirst` | 先让电脑上原来那个 {provider} 停下。CC 没法替你确认它停了。 | First stop the original {provider} on your computer. CC can’t check that for you. |
| `continue.notSeenRunning` | CC 没看到原来那个 {provider} 在跑；要是你在别处开着它，先让它停下。 | CC didn’t see the original {provider} running. If you have it open somewhere, stop it first. |
| `continue.confirm` | 已经停了，接着做 | It’s stopped — continue |
| `continue.busySession` | 这个会话正在电脑上跑，停下后才能接着做 | This session is running on your computer. You can continue once it stops |
| `continue.busyFolder` | CC 正在这个文件夹里做别的事，做完后才能接着做 | CC is busy with something else in this folder. You can continue once it’s done |
| `continue.providerMissing` | 电脑上没装 {provider} | {provider} isn’t installed on your computer |
| `continue.providerMissingAny` | 电脑上没装这个执行者 | This helper isn’t installed on your computer |
| `continue.folderMissing` | 电脑上找不到这个会话的文件夹了 | This session’s folder is no longer on your computer |
| `continue.quota` | 这个执行者的额度已用完。等额度恢复后再试。 | This helper is out of quota. Try again after it resets. |
| `continue.empty` | 这个会话里没有能带过来的内容 | There’s nothing in this session to bring along |
| `continue.unknown` | 现在确认不了能不能接着做 | Can’t check right now whether this can continue |
| `continue.uncertain` | 不确定电脑收到没有。再点一次不会重复。 | Not sure your computer got it. Tapping again won’t do it twice. |
| `continue.changed` | 这个会话刚有新动静，再看一眼再接。 | This session just changed — take another look, then continue. |
| `continue.emptyNow` | 这个会话里没有能接着做的内容。 | There’s nothing in this session to continue. |
| `continue.failed` | 这次没能接上，请再试一次。 | Couldn’t continue it this time. Please try again. |
| `continue.firstResume` | 你发的第一句会接着电脑上原来的 {provider} 会话。 | Your first message continues the original {provider} session on your computer. |
| `continue.firstFresh` | 你发的第一句会新开一轮，带上之前的对话记录。 | Your first message starts a new round with the earlier conversation attached. |
| (删除)`sessions.readOnly` | ~~只读；要接着做，请在电脑上打开~~ | ~~Read only. To keep going, open it on your computer.~~ |

## 6. 测试

- 核心(根 `bun run test` + `npm run test:node`):`selectNativeImportMessages`(预算、200 条、跳过超长);预览全表(ready ×2 模式、managed、busy ×3 路、folder_missing、provider_missing、quota、empty;不建任务、不起执行者);`adoptNativeSession`(建任务 + matter 行 + 主人绑定;再点回同一件;桌面导入过、没有 matter 行 ⇒ 补建;读写之间变一次 ⇒ 重来成功;一直变 ⇒ `native_history_changed`;拒绝状态 ⇒ 对应错误码、什么都不建);`continueImported`(恢复原会话 / 带记录新开;同一 requestId 重发不起第二轮;会话变忙 ⇒ `native_session_busy` 且不记一句;不是导入任务 ⇒ `invalid_request`);`continueNativeTask` 尾参不改内部 API 行为。
- 「一件事」:手机 say 走 `continueImported`(带 requestId 与 owner 策略、回执);桌面 / 无 surface 照旧 `continueTask`;`nativeStart` 两种模式与不出现。
- daemon 路由:`mobileSessionContinueRoute` 的方法 / 没接 / 坏 key / 多余键 / 错误映射表 / 露面登记;`mobileMatterError` 新 409;守卫(`phone-routes.guard`、`phone-api-schema` 双向);真实返回过 schema(预览 → 接成一件事 → 详情 `nativeStart` → 第一句 `say`)。
- 协议:`SessionContinue` 接受全部状态、拒未知状态;`MatterDetail` 不带 `nativeStart` 也过。
- 手机(`cd apps/app && bun run test && bun run typecheck && bun run export:check`):`errors` 五个新码;`live` 两条路由的路径 / 正文 / `retry`;演示后端全表 + 幂等 + 第一句清 `nativeStart`;`view/continue` 每个分支;`composeOutcome` / `composeOutcomeText`;文案两份键一致。
- 端到端:`src/daemon/phone-app-live-e2e.test.ts` 新用例 —— LiveBackend 经内存中继对真面板 + 真工作台:预览 ready → 接成一件事(再点同一件)→ `managed` → 详情 `nativeStart` → 第一句接着原会话跑完 → `nativeStart` 消失;正在跑的会话 ⇒ `busy_session`、`continueSession` 报 `session_busy`。
- Maestro(模拟器 `th-push`,演示模式)`.maestro/continue-session.yaml`:进行中的那条只有灰字、没按钮;另一条「接着做」→ 确认卡 →(输入框已聚焦)直接打字发出 → 回到这件事、话在对话里、第一句说明消失。
- 桌面:不改代码;`bun --bun vitest run apps/desktop` 照旧全绿即可。

## 7. 主人事项(不挡执行)

1. **真机验一次**(合并后):电脑上用 Claude Code 跑一个会话 → 退出 → 手机「接着做」→ 发一句 → 电脑上 `claude --resume` 看到同一个会话里多了这一轮;再验 Codex 一条。
2. **看不见的「正在跑」**:普通终端里的 Claude Code CC 看不见,只能靠确认卡上的声明(D3)。连装了 hook 的也一样:`executionConflict`(`main.ts:722-725`)只把带 `origin_agent`(CC 派出去的)hook 会话算作占用,主人自己在终端开的 hook 会话不算 —— 要不要把它也算进去(改动面:`cliEvents.sessions()` 那一条去掉 `origin_agent` 条件,会同时影响工作台其它入口的忙判定),以及要不要以后让 hook 成为「接着做」的前提(更安全、但没装 hook 的人就用不了)—— 交主人。
3. **额度耗尽时换执行者**:桌面能「交给另一位继续」,手机这一版只说额度用完(D10)。要不要做,交主人。

## 8. 不做

- 桌面改动、微信路径(`@码` resume、`claude -p --resume` 照旧)、cursor / agy 会话、ACP。
- 终端实时画面 / 流式镜像;停掉或接管一个正在跑的终端会话。
- 让人手选模式(D2:两种从不同时可选)、手动挑要带过来的消息(D1:与桌面同一自动规则)。
- 第一句带附件的界面(说一句页今天没有附件按钮;核心已透传 `draftId` / `attachmentIds` 与 owner 策略,以后加界面即可)。
- 浏览器 / PWA 版(`apps/mobile`)的同一功能。
