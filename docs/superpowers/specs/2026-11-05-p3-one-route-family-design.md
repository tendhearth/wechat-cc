# P3:路由一族(设计稿)

2026-11-05 · 承接 [一个伙伴一副骨架](2026-10-31-one-companion-one-skeleton-design.md) §3.3 与 §4 P3(做完 = 新代码里没有 `/m/api` 字面量;别名表只许少)。兼容表与按构建号退休沿用 [M6 读这一侧收口](2026-11-05-m6-read-side-design.md) 的定案(`packages/protocol/src/wire-compat.ts`、`ClientHello.build`)。

## 现在的样子(origin/dev c02bd0ec)

### 路由表数一数(`packages/protocol/src/routes.ts`,302 行)

| 族 | 条数 | 谁接 | 收哪些令牌 | 处理器在哪 |
|---|---|---|---|---|
| `/v1/*` | 236(admin 135 / trusted 83 / guest 18;带 `operator` 106,其中走打包版宿主 `tauri` 83) | 内部 API,`src/daemon/internal-api/index.ts`,只听 127.0.0.1 | `file`(trusted)、`session`(按会话档位)、`operator`(admin + routeAllow)、federation / selftest 两种窄的 session | 各功能的 `routes.ts` / `internal-api/routes-*.ts`,签名 `(query, body, caller, ctx) → { status, body }` |
| `/m/api/*` | 61 | 设置面板,`src/features/phone/settings-panel.ts`,听 0.0.0.0;中继 v2 隧道(`tunnel-v2-stream.ts`)把请求原样交给同一个 `handleRequest` | `device`(routeAllow = `PHONE_ROUTES`)、`link`(10 分钟,routeAllow = `LINK_ROUTES`) | `settings-panel.ts`(28 处)、`mobile-*.ts`、信 / 定时各自的 `mobile.ts`,签名 `(url, req, ctx) → Response` |
| `/m`、`/set`、`/set/api/*` | 1 + 1 + 3 | 同上 | 同上 | 页面与配对(`settings-panel-html.ts`、`/set/api/state·apply·pair`) |

令牌底座已经是一个(`src/daemon/internal-api/token-registry.ts`,`TokenOrigin = file | session | operator | device | link`;鉴权现状见 [internal-api-auth](../../reference/internal-api-auth.md))。分开的是**路径族、监听、处理器签名、schema、信封、错误码列**:

- 两份 schema:`/v1` 的在 `packages/protocol/src/desktop-api.ts`(`RESPONSE_SCHEMAS`),`/m/api` 的在 `api.ts`(`PHONE_API_SCHEMAS`,61 键)。物件的形状(`Matter`、`MatterDetail` …)已共用,外面那层各写一份。
- 两种信封:`/v1` 多数是裸体(`GET /v1/matters` → `{ matters }`,错 `{ error }`);`/m/api` 一律 `{ ok: true, … }` / `{ ok: false, error }`。
- 两列错误码:`workbench-errors.ts` 的 `desktop` / `phone`。两边都有的 103 个码里 10 个不一样,几乎都是「老 App 不认新码 ⇒ 收成 `unavailable`」(`workbench_not_wired`、`module_off`、`module_degraded`、`input_storage_unavailable`),另有 `script_approval_required → script_needs_computer`、`unattended_ack_required` 428 / 422、`attachment_scope` 404 / 409、`unavailable_provider` 422 / 503。
- 两套客户端表:`desktop-calls.ts` 144 条(桌面经生成的 `daemon-calls.js`,源码里零手写 `/v1`)、`phone-calls.ts` 63 条(App 经中继,`apps/app/src` 里零手写 `/m/api`,守卫 `scripts/client-paths.guard.test.ts`)。手机网页 `apps/mobile/src` 还手写 5 条(`art/presence`、`home`、`matters`、`matter`、`matter/stop`)。
- `src` 里带引号的 `/m/api` 共 75 处、12 个文件(多数是处理器表的键,其余是注释),外加生成物 `mobile-page.generated.json`。

别的族不在这次里:微信那一侧是 ilink 入站和命令表,不是 HTTP;对话里的 MCP 工具用 session 令牌调 `/v1/wechat/*` 等,已经是一族。A2A / 笔友 / 串门的本机控制是 `/v1/a2a/*`、`/v1/social/*`、`/v1/penpal/*`、`/v1/pair/*`(trusted,只有 `/v1`)。中继自己的端点(`/v2/daemon`、`/v2/phone`、`/pset`、`/healthz`、well-known,`apps/relay/src/index.ts`)只搬加密帧、不看路径。乙 v2 的 brain ws(`src/daemon/yi-ws-server.ts`)是另一套协议。

### 同一份数据,今天走哪几条

鉴权缩写:**op** = operator(桌面宿主 / `wechat-cc` CLI),**d** = 设备令牌,**l** = 链接令牌(r 读 / w 写),**s** = 会话令牌。调用方:桌 = 桌面,App,网 = 手机网页 `/m`,CLI。

| 数据 | `/v1` 路径(鉴权 → 调用方) | `/m/api` 路径(鉴权 → 调用方) | 关系 |
|---|---|---|---|
| 一件事列表 | `GET /v1/matters`(op → 桌) | `GET /m/api/matters`(d、l-r → App、网) | 重复:同一个 `matters.list`;手机另筛「别人的聊天不给」、默认不含归档、不点名不给 terminal / act、取 50、补 `withTaskState`、记 `seenOnPhone`;桌面另有 `surface` / `since` / `limit` 和 `networkSuspended` |
| 一件事详情 | `GET /v1/matter`(op → 桌) | `GET /m/api/matter`(d、l-r → App、网) | 重复:同一个 `matters.detail`;手机另去掉旧旁白、超帧回 413、链接令牌去掉 `replyExtras`、别人的聊天回 404 |
| 对一件事说一句 | `POST /v1/matter/say`(op → 桌) | `POST /m/api/matter/say`(d → App) | 重复;手机多 `requestId` / `runId` / 附件,出生地记 `phone` |
| 主人那条对话 | `GET /v1/matter/owner-chat`、`…/search`、`…/file`(op → 桌) | `GET /m/api/chat`(分页)、`/chat/search`、`/chat/file`(d → App) | search / file 重复;整页一个是 `ownerChat()` 一个是 `history` 分页 + 手机对话任务状态,同一份数据两种读法 |
| 跟 CC 说 | `POST /v1/companion/converse`(op,同步等回话 → 桌) | `POST /m/api/chat/say`(d,收下即回 → App) | 语义不同(隧道约 15 秒没流量就断,手机不能同步等) |
| 语音 | `POST /v1/companion/transcribe`、`/v1/companion/speak`、`GET /v1/stt/status`(op / trusted) | `POST·GET /m/api/chat/transcribe`、`GET /m/api/chat/voice`(d → App) | 转写重复(同一个 `voice.transcribe`,正文键 `audio_b64` / `audioBase64`);语音按消息 id 合成是手机独有 |
| 这条对话的模型 | `GET·POST /v1/model`(admin,全局 / 按家) | `GET·POST /m/api/chat/model`(d → App,按主人对话钉) | 相近,不是一回事 |
| 交办入口 | `/v1/workbench/entry-options`、`models`、`create-entry`、`entry-receipt`、`attachment`(GET / POST)、`discard-attachment`(op → 桌) | `/m/api/entry/options`、`entry/models`、`matter/create`、`matter/create-receipt`、`attachment/upload·chunk·discard`(d → App) | 重复 7 对 |
| 一件事上的动作 | `/v1/workbench/cancel`、`permission`、`answer`、`artifact`、`handoff`、`worktree`、`review`、`review-mark·return·comment·comments-send`、`rewind-preview`、`rewind`(op → 桌,键是 taskId) | `/m/api/matter/stop`(d、l-w)、`permission`、`answer`、`artifact`、`handoff`、`worktree`、`changes`、`review-*` 四条、`rewind` GET / POST(d → App,键是 matter id,经 `MattersService` 多一道 runId 过期判断) | 重复 13 对(matter id 与任务 id 相同) |
| 电脑上的会话 | `GET /v1/workbench/sessions`、`session`;`POST /v1/workbench/prepare-resume`、`import`(op → 桌) | `GET /m/api/sessions`、`session`;`GET·POST /m/api/session/continue`(d → App) | 列表 / 读重复(同一个 `listNativeHistory`,参数 `providerId` / `provider`);接着做相近 |
| 终端会话 | `GET /v1/cli/sessions`(op → 桌、CLI) | `GET /m/api/cli/sessions`(d → App) | 重复;手机行另带此刻那一步、`last_say`、`displayName`、`live_window` |
| 终端看着它跑 | — | `GET /m/api/cli/activity`(d → App) | 手机独有 |
| 终端拍板 | `POST /v1/permissions/resolve`(op → 桌宠)| `POST /m/api/cli/permission`(d → App) | 同一件事;**撞名**:`/v1/cli/permission` 是钩子登记 / 等答案(trusted,CLI 子进程) |
| 对终端说一句 | `POST·GET /v1/cli/say`(admin,只认主人会话的 s → CC 的 `terminal_say`) | `POST /m/api/cli/say`(d → App) | **撞名不同义**:一个按「码」、回票再等;一个按 `session_id`、收下即回 |
| 今天 | `GET /v1/overseer/today`(op → CLI) | `GET /m/api/today`(d → App) | 重复 |
| 连接 | `GET /v1/connections`(op → 桌) | `GET /m/api/connections`(d → App) | 重复;手机脱敏(`redactConnections`)、错一律 503 |
| 记忆 | `POST /v1/memory/view`、`edit`;`GET /v1/memory/retractions`、`POST …/retractions/restore`(op → 桌、CLI) | `GET /m/api/memory`、`POST memory/correct`;`GET memory/retractions`、`POST memory/restore`(d → App) | 收回两条重复(同一个 `nightly.retractions` / `restore`,404 码不一样);看 / 改相近(`curatedView` + 逐条判 vs 整份 view / edit) |
| 信 | `GET /v1/letters`(状态)、`write`、`settings`(op → CLI) | `GET /m/api/letters`(寄出去的)、`letters/page`(d → App) | 相近 |
| 定时 | — | `GET /m/api/jobs`、`POST jobs/action`(d → App) | 手机独有 |
| 做过的事 | — | `GET /m/api/activity`(d → App) | 手机独有 |
| 首屏 / 看到哪了 | (桌面「此刻」自己拼)`POST /v1/journal/seen`(trusted,写 now) | `GET /m/api/home`(d、l-r → App、网)、`POST /m/api/seen`(d,带 `until`) | seen 重复(同一个 `journal-seen` 文件);home 手机独有 |
| 待办 | `POST /v1/knowledge/facts/set_fact_status`(op,主人工作区 → 桌) | `POST /m/api/todo`(d → App) | 重复(同一个 `setFactStatus`) |
| 表情 | `GET /v1/stickers`(列表) | `GET /m/api/sticker/<文件>`(前缀,d → App;`?b64=1`) | 相近 |
| 手机自己的 | `/v1/phone/link`、`/v1/phone/devices`(op → 桌) | `GET /m/api/state`、`art/presence`(l-r)、`matter/insight`、`matter/input-receipt`、`POST push/register`、`push/test`(d → App、selftest) | 手机独有 |

**合计:61 条 `/m/api` 里 35 条和某条 `/v1` 是同一个底层函数、两个处理器;10 条同一份数据但读法或动作不一样;2 条和 `/v1` 撞名不同义(`cli/permission`、`cli/say`);14 条手机独有。**

## 定案

**一份数据一条 `/v1` 路径、一个处理器;桌面 / App / 网页的差别只在令牌范围。两个监听留着,只管谁能进门。`/m/api/*` 全部变成兼容表里的别名,按客户端构建号一行一行退。**

- **路径族**:`/v1/<数据>/<动作>`。有 `/v1` 双胞胎的,以 `/v1` 那条为准(桌面不动);手机独有的起新的 `/v1` 路径(下面 P3d 列了名字);一件事上的动作以 matter 为键,收在 `/v1/matter/*`(P3e)。`/m`(页面本身)、`/set` 与 `/set/api/*`(配对与设置页)不是数据路由,不并。
- **一个处理器、一个分发**:面板与内部 API 共用同一张处理器表和同一个分发函数(档位 → routeAllow → 模块门 → 请求 schema → 处理器 → 响应契约)。监听仍是两个:127.0.0.1 只收 file / session / operator,面板(局域网 + 隧道)只收 device / link —— 内部 API 不上局域网,面板不认桌面凭据,和今天一样。
- **令牌范围从路由表推**:不加新的 origin。`routes.ts` 里把 `phone: { link }` 写到 `/v1` 那一行上:有 `phone` 块 ⇒ 设备令牌能走,`link: read | write` ⇒ 链接令牌能走(仍等于链接页面源码扫出来的调用,`scripts/link-routes-from-source.guard.test.ts` 照旧)。「送话给执行者的只给设备」那条规矩(`phone-routes.ts` 注释)原样跟着行走。
- **按范围不按路径的差别**,收成处理器里看 `caller` 的几样,一处一个函数:
  - 能看哪些:device / link 只见主人能在手机上打开的(今天的 `phoneMayOpenMatter`);operator 见全部。
  - 链接令牌读得少一点:去掉 `replyExtras`(今天的 `withoutReplyExtras`)。
  - 帧预算:从面板进来的请求(局域网直连和隧道都是,今天就这样)带 `caller.frameBudget`,要裁的处理器(`fitted`、`framedTooLarge`)按它裁;从 127.0.0.1 进来的不裁。
  - 出生地:照 `phone-client.ts` 从令牌和传输推(operator = desktop,device 带 App 标记 = app,其余 = web),不从路径推。
  - 只给设备的动作(推送登记、`device_only` 那几处):处理器里照旧看 `caller.origin`。
- **新路径的信封和错误码**:有 `/v1` 双胞胎的,回包就是 `/v1` 今天的回包;手机独有搬过去的,回包就是 `/m/api` 今天的回包。错误码用 `workbench-errors.ts` 的 `desktop` 列(精确的码)。`phone` 列、`{ ok }` 包装、手机默认筛选、参数改名(`provider` → `providerId`、`audioBase64` → `audio_b64` …)只活在别名的转换里,随别名一起退。
- **schema 一份**:新 App 改读 `/v1` 路径以后,它的返回形状从 `RESPONSE_SCHEMAS` 拿;`PHONE_API_SCHEMAS` 只剩别名那几行,跟着变少。
- **别名表一处**:`wire-compat.ts` 加一张 `WIRE_ROUTE_ALIASES`,每行 = 旧键、新键、转换名(纯改名的写 `null`)、谁读、什么时候删、链接令牌能不能走(照今天冻结)。daemon 那边只有一个文件 `src/features/phone/legacy-routes.ts` 认这张表:面板收到旧路径 ⇒ 按表翻成新键 → 走同一个分发 → 转换回包。设备 / 链接令牌的 routeAllow 自动带上别名键。**第一个 PR 就把 61 行全部登记上**(还没并的标「还是自己的处理器」),所以表从第一天起只许变少;另一把棘轮管「还是自己处理器的行」只许变少。
- **退休按构建号**(同 M6):App 握手报 `build`,daemon 记在设备上(`device-store.ts` 的 `noteBuild`,已有);**近 30 天连过的设备都 ≥ 改读新路径的那一版**,才删那一行。没报过构建号的(build 2 及以前)算老的。网页由 daemon 自己发,`self deploy` 当场换,只有网页读的行随换的那个 PR 一起删。桌面不读别名(桌面早就是 `/v1`),P3e 里桌面那些 `/v1/workbench/*` 双胞胎的退休条件写「桌面 ≥ 改读 `/v1/matter/*` 的那一版」。
- **新 App 怎么知道 daemon 有新路径**:`ServerHello` 加可选的 `routes: 'v1'`(老 App 的 `shape.ts` 丢掉不认识的键,不会坏)。新 App 见到它才走 `/v1`,没见到(daemon 还没升级)就走旧路径。所以 App 早发晚发都行,不必等 daemon。

### 守卫

- `scripts/no-m-api-literal.guard.test.ts`(新):`src`、`apps/mobile/src`、`packages/protocol/src` 里(测试与生成物除外,注释按行跳过)带引号的 `/m/api` 字面量,只许出现在 `legacy-routes.ts` 和 `wire-compat.ts`;过渡期是棘轮,基线 75 处、只许往下调,P3d 做完时降到上面两个文件之外为 0。
- `scripts/wire-compat.guard.test.ts` 扩一节:`WIRE_ROUTE_ALIASES` 行数 ≤ 上限且等于上限(同字段那张表的写法);每行的新键在 `ROUTES` 里、旧键不在 `ROUTES` 里;转换名在 `legacy-routes.ts` 里有实现。
- `routes.ts` 做完以后没有 `/m/api` 的行;`scripts/routes-snapshot.guard.test.ts` 的快照对「设备 / 链接令牌能走的集合」按「新键 ∪ 别名键」比,集合不许变大。

## 分步(每步一个 PR;daemon 先行)

### P3a 金样补齐 + 别名表登记(只加测试和数据)
- 把今天每条要动的 `/m/api` 回包钉住:M0 的 `src/daemon/__golden__/matter-read-paths.golden.test.ts` 已有 matter / chat / cli activity 那几份;补上 35 条重复里剩下的每一条(成功一份 + 一个错误码一份),以及链接令牌读的那几条(`home`、`matters`、`matter`、`art/presence`)链接令牌下的那一份。
- `WIRE_ROUTE_ALIASES` 建表,61 行全登记,新键先按本稿写好;两把棘轮、`no-m-api-literal` 的基线 75 一起进。
- 做完怎么算:金样在 dev 上绿;生产代码零改动。

### P3b 一个分发、两个监听(daemon)
- 把内部 API 的分发抽成一个函数,面板对 `/v1/*` 的请求也交给它(只认 device / link);`/m/api/*` 先照旧走面板自己那张表。
- `routes.ts` 的 `phone` 块允许出现在 `/v1` 行上;`PHONE_ROUTES` / `LINK_ROUTES` 照推。`caller` 带上 `frameBudget`、出生地。
- `ServerHello` 加 `routes: 'v1'`(先不发,P3c 第一组并完才打开)。
- 做完怎么算:金样一字不变;新加的测试证明面板上 operator / file / session 令牌一律 401、内部 API 上 device / link 一律 401;没有 `phone` 块的 `/v1` 路由设备令牌走不了(403 `route_not_allowed`)。

### P3c 并 20 条不以 matter 为键的重复(daemon,分四个 PR)
每个 PR:`/v1` 那条加 `phone` 块(link 照手机那条今天的值),处理器按上面「按范围」那几样补齐,`/m/api` 那条改成别名 + 转换,手机处理器删掉。
- P3c-1 一件事与主人对话:`matters`、`matter`、`matter/say`、`chat/search`、`chat/file`、`chat/transcribe`(POST)。
- P3c-2 终端与总览:`cli/sessions`、`today`、`connections`。
- P3c-3 记忆、待办、看到哪了:`memory/retractions`、`memory/restore`、`todo`、`seen`(`/v1/journal/seen` 收可选的 `until`,不带照旧写 now)。
- P3c-4 交办选项与会话:`entry/options`、`entry/models`、`attachment/*` 三条、`sessions`、`session`(分块上传与进度两条核过不是同一个动作,改到 P3d,见「进度 · P3c-4」)。
- 做完怎么算(每个 PR):别名回包的金样一字不变;新路径的回包等于 `/v1` 今天的回包;`no-m-api-literal` 基线往下调;「还是自己处理器」那把棘轮往下调。
- 第一组合完、部署 soak 绿以后,`ServerHello` 打开 `routes: 'v1'`。

### P3d 手机独有的、相近的、撞名的搬到 `/v1`(daemon)
- 纯改名(别名转换写 `null`):`/m/api/state` → `/v1/phone/state`、`art/presence` → `/v1/phone/art/presence`、`push/register·test` → `/v1/phone/push/register·test`、`matter/insight` → `/v1/matter/insight`、`matter/input-receipt` → `/v1/matter/input-receipt`、`home` → `/v1/home`、`cli/activity` → `/v1/cli/activity`、`activity` → `/v1/activity`、`jobs`、`jobs/action` → `/v1/jobs`、`/v1/jobs/action`、`letters` → `/v1/letters/sent`(`/v1/letters` 已经是状态)、`letters/page` → `/v1/letters/page`、`chat` → `/v1/matter/owner-chat/page`、`chat/say` → `/v1/matter/owner-chat/say`、`chat/voice` → `/v1/matter/owner-chat/voice`、`chat/transcribe`(GET)→ `GET /v1/stt/status`(形状一样就并;不一样起 `GET /v1/companion/transcribe`)、`chat/model` → `/v1/matter/owner-chat/model`、`memory` → `/v1/memory/curated`、`memory/correct` → `/v1/memory/correct`、`sticker/` → `/v1/stickers/file/`、`session/continue` → `/v1/workbench/session/continue`。
- 撞名的两条起不撞的名字:`/m/api/cli/permission` → `/v1/cli/decide`(和 `POST /v1/permissions/resolve` 同一个拍板口时并进它,P3d 里核实)、`/m/api/cli/say` → `/v1/cli/session-say`(和 CC 的 `terminal_say` 那条 `/v1/cli/say` 分开:身份、键、回法都不同)。
- 处理器从 `settings-panel.ts` 搬回各自的功能目录(信、定时已经是),面板只剩页面、配对和分发。`src/cli/selftest-phone.ts` 改调新路径。
- 做完怎么算:`routes.ts` 里没有 `/m/api` 行;`src` 里 `/m/api` 字面量只在 `legacy-routes.ts`;别名金样一字不变;`settings-panel.ts` 不再有 `/m/api` 处理器。

### P3e 一件事上的动作收进 `/v1/matter/*`(daemon;桌面随下一版)
- 13 对动作 + 交办 2 条(`matter/create`、`matter/create-receipt`),共 15 条,新键是 `/v1/matter/<动词>`(`stop`、`permission`、`answer`、`artifact`、`handoff`、`worktree`、`changes`、`review-mark` …、`rewind` GET / POST、`create`、`create-receipt`),处理器是 `MattersService` 那一层(带 runId 过期判断,终端 / act 那几件以后也用得上);桌面独有的参数(`restartToken`、`expectedRunId`、交办入口那一列错误码 `desktopEntry`)作为同一个处理器在 operator 范围下的参数。
- `/m/api/matter/*` 的别名改指新键;桌面的 `/v1/workbench/*` 那 15 条双胞胎(`cancel`、`permission`、`answer`、`artifact`、`handoff`、`worktree`、`review`、`review-mark·return·comment·comments-send`、`rewind-preview`、`rewind`、`create-entry`、`entry-receipt`)也进别名表(读的人 = desktop),桌面在下一版改调新键(`desktop-calls.ts` 一行一改、`gen:routes`;新键要 `tauri: true`,编进 `.app` 的白名单,所以**要发版**,PR 里写明并记进下一版的发版说明)。
- 做完怎么算:工作台金样(`/v1/workbench/task` 那几份)和手机金样一字不变;一件事上的每个动作只有一个处理器。

### P3f App 改读新路径(随下一个 App build)
- `phone-calls.ts` 的键换成新键(握手见到 `routes: 'v1'` 才用,否则用旧键);返回形状改从 `RESPONSE_SCHEMAS` 拿;`apps/app/src/net/errors.ts` 认精确的码(`script_approval_required` 自己翻成「回电脑上确认」,不再靠 daemon 改码);握手报 `build`(M6f 也要它,哪个先做哪个带上)。
- build 3 赶得上就随 build 3,赶不上就下一版;daemon 那几步不等它。
- 做完怎么算:App 测试里新旧两套键都过;Maestro 照 App 部署前的规矩跑。

### P3g 网页 `/m` 改读新路径(`self deploy`)
- `apps/mobile/src` 那 5 处换新键,链接令牌范围随之从别名行挪到新行(守卫会指出来);只有网页读的别名行在同一个 PR 删。
- 做完怎么算:`apps/mobile/src` 里没有 `/m/api`;`link-routes-from-source` 守卫绿。

### P3h 删别名(一行一个 PR,按退休条件)
- 拿 `device-store` 里近 30 天的构建号对一遍,到了的行删掉,两把棘轮的上限跟着调。`phone` 那一列错误码随最后一个用它的别名删。

## 进度

### P3a(金样 + 别名表 + 两把棘轮;生产代码零改动)
- **金样**:`src/daemon/__golden__/m-api-routes.golden.test.ts`,80 份在 `m-api-routes/`。接缝是面板的 `handleRequest`(设备令牌 / 链接令牌各配一枚),deps 在面板注入口给照剧本回话的假实现 —— 钉的是面板这一层加的东西:`{ ok }` 信封、`phone` 那一列错误码、手机默认筛选、链接令牌少读的、响应头(`content-type` / `cache-control`)。35 条重复每条成功一份 + 一个错误码一份(`matters`、`matter`、`cli/sessions` 的真数据成功回包 M0 已经钉了,这里只补错误码);错误码尽量挑两列不一样的(`module_off` → `unavailable`、`script_approval_required` → `script_needs_computer`、`attachment_scope` 409、`unavailable_provider` 503、`unattended_ack_required` 422、`not_found` → `matter_not_found`)。链接令牌:`home`、`matters`、`matter`、`art/presence`、`matter/stop` 各一份(设备那份并排),外加 `matter/say` 的 403。`art/presence` 两张 PNG 256,790 字节,只钉长度 + sha256。`UPDATE_M_API_GOLDEN=1` 重录。
- **别名表**:`WIRE_ROUTE_ALIASES` 61 行全登记、全部 `handler: 'own'`;`link` 照今天 `routes.ts` 冻结。`scripts/wire-compat.guard.test.ts` 加一节:行数 ≤ 61 且等于、own 行 ≤ 61 且等于;路由表里每条 `/m/api` 都在表里;P3c 的新键今天就在 `ROUTES`、P3d / P3e 的新键今天还不在;P3d 行 `transform` 为 null;已并的行旧键不在 `ROUTES`、转换名在 `legacy-routes.ts` 里有实现(现在 0 行,P3c 起生效)。
- **字面量棘轮**:`scripts/no-m-api-literal.guard.test.ts`,按文件记行数(整行注释按行跳过,不用块注释正则)。

### P3a 核过的几件(和本稿上文不一样的地方,后面几步照这里)
- **基线不是 75**:75 是 `src` 里带引号 `/m/api` 的**出现次数,连注释**(74 行)。照「守卫」那条的口径(整行注释跳过、测试与生成物除外、三个目录)实际是:`src` 60 行 / 8 个文件、`apps/mobile/src` 5 / 3、`packages/protocol/src` 182 / 3(`routes.ts` 61、`api.ts` 61、`phone-calls.ts` 60),共 247。守卫按文件记这 14 个数。
- **「P3d 做完降到两个文件之外为 0」只对 `src` 成立**:`phone-calls.ts` 是 App 的客户端表(P3f 才换新键,旧键还要留给没收到 `routes: 'v1'` 的情形)、`api.ts` 的 `PHONE_API_SCHEMAS` 跟着别名退(P3h)、网页那 5 处 P3g。P3d 的完成条件按「`src` 里只剩 `legacy-routes.ts`」算。
- **`GET /m/api/chat/transcribe` 不并进 `GET /v1/stt/status`**:形状不一样 —— `/v1` 那条回裸的 `{ configured, provider, base_url, model, saved_at }`(trusted、voice 模块),手机那条只回 `{ ok, configured }`(地址和模型不给手机)。别名表里新键写 `GET /v1/companion/transcribe`。
- **`POST /m/api/cli/permission` 不并进 `POST /v1/permissions/resolve`**:底下是同一个 `wxPerm.resolvePermission`(+ 记一次接触,`features/terminal/module.ts` 与 `internal-api/module.ts` 两处接线),但手机那条多三道收窄:只认终端中继开的码(`relay.owns`)、能按 `session_id` 找码且码要对得上、错误码 `not_found` / `cli_not_actionable` / `cli_permission_stale`(404 / 409);桌面那条认任何码(自改流水线、别的待批都能批),回 200 `{ ok: boolean }` / 400 `bad_request`。并进去等于让设备令牌能批自改流水线的待批。照本稿起 `/v1/cli/decide`。
- **P3e 和「表从第一天只许变少」冲突**:P3e 要把桌面 15 条 `/v1/workbench/*` 双胞胎也登记进别名表(读的人 = desktop),行数会涨。P3e 时二选一:那个 PR 一次性把上限上调 15 并写明;或者桌面那 15 条另起一张表 / 一把棘轮。P3a 没登记它们(按本稿只登记 61 条 `/m/api`)。
- **响应头今天就不齐**:`mobile-workbench` / `mobile-reads` / `mobile-chat` 的处理器和 `mobileMatterDetailResponse` 带 `cache-control: no-store`;`settings-panel.ts` 自己的 `json()`(列表、详情的错误、seen、todo、记忆、home、art/presence、审阅的成功回包、403 `route_not_allowed`)不带 —— 同一条 `review-comment` 成功不带、失败(走 `mobileMatterError`)带。金样把头一起钉了,并的时候按路由保持,要统一另开一步。
- 61 条的分法核对过:35 条有 `/v1` 双胞胎(P3c 20 + P3e 15,新键都在今天的 `ROUTES` 里——P3e 的双胞胎是 `/v1/workbench/*`,新键 `/v1/matter/*` 还不存在),26 条 P3d(相近 10、撞名 2、手机独有 14)。读的人:App 读 60 条(除 `art/presence`),网页读 5 条,`selftest phone` 读 `push/register·test`。

### P3c-1(六条并成 `/v1` 一个处理器;老路径是别名)
- **并了哪六条**:`matters`、`matter`、`matter/say`、`chat/search`、`chat/file`、`POST chat/transcribe` → `GET /v1/matters`、`GET /v1/matter`、`POST /v1/matter/say`、`GET /v1/matter/owner-chat/search`、`GET /v1/matter/owner-chat/file`、`POST /v1/companion/transcribe`。这六行 `/v1` 带上 `phone` 块(link 照别名行冻结:列表 / 详情 `read`,其余 `none`);`routes.ts` 里删掉六条 `/m/api` 行;手机处理器删掉(`settings-panel.ts` 三条、`mobile-chat.ts` 三条,`GET chat/transcribe` 留着 —— 它是 P3d)。
- **别名**:`wire-compat.ts` 加 `MERGED_ALIAS_KEYS`(这六个键 ⇒ `handler: 'alias'`;`routes.ts` 的 `PanelRouteKey` 把它们并进来,App 的 `phone-calls.ts` 与 `PHONE_API_SCHEMAS` 照旧按旧键写)。`src/features/phone/legacy-routes.ts` 是 daemon 里唯一认它的地方:先按手机的规矩验参数、补手机默认(`status` 默认不含归档、`limit=50`、不点名 kind ⇒ `exclude=terminal,act`、`taskState=1`),翻到新键走同一个分发,再套 `{ ok }`、换 phone 那一列错误码、按路由保持响应头。`phone-routes.ts` 让设备 / 链接令牌的 routeAllow 自动带上别名键(理由抄新键那一行的)。
- **按 caller 收**(`routes-matters.ts`,规矩在 `src/domain/matters/phone-scope.ts`,手机处理器原样搬来):device / link 只见 `phoneMayOpenMatter` 的(列表筛、按 id 打开回 404 `matter_not_found`);link 的详情去掉 `replyExtras` / `messageId`;带 `frameBudget` 的详情从最早的旁白起裁,装不下 413 `detail_too_large`;手机令牌读列表 / 详情记 `seenOnPhone`;说一句按 `surface: 'phone'`。operator 走这几条一字不变。`MattersService` 多两个方法 `phoneMayOpen`、`seenOnPhone`。`/v1/matters` 多两个可选参数 `exclude`、`taskState`(谁都能用),点名 `kind=act` 时行带 `act`;`POST /v1/matter/say` 收可选的 `requestId / runId / draftId / attachmentIds`。
- **错误码怎么回到手机那一列**:`/v1` 回的是桌面那一列,有的码桌面列改了名(`attachment_scope` → 404 `not_found`),别名认不回来。处理器可以在回包上带 `cause`(原始码,只收码形状的字符串),内部 API 在面板分发的 `opts.cause` 时把它放进回包头 `x-cc-cause`;只有面板进程里的别名这样调,网上来的请求设不了 —— `/v1` 的正文与契约不变。`matter/say` 与 `companion/transcribe`(网络守护拦下 ⇒ `network_unprotected`)用它。
- **棘轮**:`MAX_OWN_HANDLER_ROWS` 61 → 55(行数仍 61);`no-m-api-literal` 基线 `routes.ts` 61 → 55、`settings-panel.ts` 22 → 19、`mobile-chat.ts` 7 → 5(合计 247 → 236)。`routes-snapshot` 与 `link-routes-from-source` 两个守卫按「新键 ∪ 别名键」比:别名键照旧和快照 / 页面扫描比,新键另由一条核对「在不在、link、理由都同别名键」。
- **金样**:`m-api-routes` 80 份、`matter-read-paths` 全部逐字节不变(文件没动)。两份金样的面板接上一个真的 `createInternalApi`(只用 `panelDispatch`);P3a 那份的服务是剧本,形状只有几个字段,所以那里用新加的测试开关 `responseContracts: false`。
- **和并之前不一样的几处(都不在金样里,PR 里逐条写了)**:① `chat/file` 走 `/v1` 的读法,回复里的表情附件(sticker)手机也能按块读了(桌面本来就能;以前手机回 404);② 主人对话还没建(配了主人、那条 chat matter 还没有)时,`chat/search` 照搜(以前 404 `no_owner_chat`),`chat/file` 回 404 `not_found`(以前 `no_owner_chat`);③ 语音模块此刻不是 ok ⇒ `POST chat/transcribe` 回 503 `voice_not_wired`(以前不看模块,照转);④ `matters` 处理器抛了 ⇒ 500 `unavailable`(以前不回包,手机一直等);⑤ 「没接上」与「参数不对」先判哪个,个别路由换了先后(只在没接线的测试里看得到)。
- **还没做**:`ServerHello.routes: 'v1'` 照本稿等这一组部署 soak 绿再开。

### P3c-2(终端与总览三条并成 `/v1` 一个处理器;老路径是别名)
- **并了哪三条**:`cli/sessions`、`today`、`connections` → `GET /v1/cli/sessions`、`GET /v1/overseer/today`、`GET /v1/connections`。三行 `/v1` 带上 `phone: { link: 'none' }`(照别名行冻结,只给设备);`routes.ts` 删掉三条 `/m/api` 行;`mobile-reads.ts` 的三个处理器删掉,面板 deps 的 `connections` / `cliSessions` / `overseerToday` 与 wiring 里那几处随之去掉(连接经 `internalApi.provide({ connections })` 那一份,终端两条是终端模块自己挂的路由)。
- **按 caller 收**:`/v1/cli/sessions` 手机令牌回手机那一份 —— 拼行的规矩搬到 `src/features/terminal/phone-sessions.ts`(`phoneCliSessionRows`,原样:一个一个挑字段、**不给 `cwd` / `origin_agent`**、最多 50 条、等批准的带中继开的码、在跑的前 8 条带此刻那一步、`live_window` / `last_say` / `displayName` / `matter_id`),查询参数(`ended` / `detail` / `limit`)对手机令牌不起作用;`TerminalRoutesDeps` 多一个可选的 `phoneSessions`,没接 ⇒ 手机令牌 503 `cli_sessions_not_wired`(绝不退回桌面那一份)。`/v1/connections` 手机令牌回 `redactConnections`(去掉 detail)。`/v1/overseer/today` 不分 caller(并之前手机那条就是原样给同一个函数)。`/v1/cli/sessions` 的响应契约改成「桌面那一份 | 手机那一份」两种之一。
- **别名**(`legacy-routes.ts` 的 `phoneCliSessions` / `phoneToday` / `phoneConnections`,一个 `readAlias`):方法不对 405、`{ ok }` 信封、带 `no-store`;`/v1` 回同一个「没接上」码或模块门的 `module_*` ⇒ 手机原来那个「没接上」码,别的错一律 503 `unavailable`(裁定 7)。
- **棘轮**:`MAX_OWN_HANDLER_ROWS` 55 → 52(行数仍 61);`no-m-api-literal` 基线 `routes.ts` 55 → 52、`mobile-reads.ts` 8 → 5(合计 236 → 230)。
- **金样**:`m-api-routes`、`matter-read-paths` 逐字节不变(金样文件没动;两份测试的接线改成把剧本 / 真登记处挂在内部 API 上)。
- **和并之前不一样的几处**:① 终端模块此刻不是 ok(关了 / 坏了 / 开机还没挂上)⇒ `cli/sessions`、`today` 回 503 `cli_sessions_not_wired` / `today_not_wired`(以前面板不看模块门);② 连接那一份是 `internalApi.provide({ connections })` 交给内部 API 的(`wiring/module.ts` 里紧跟着建面板那一步、同步),在它之前到的请求回 503 `connections_not_wired` —— 面板的监听 / 隧道在那之后才起,实际碰不到;③ 设备令牌经新键碰上模块坏了,回包里带模块门的 `detail`(daemon 的错误串;别名不转给手机);④ 等批准那一项的 `pending` 改成逐个挑 `tool / summary / since`(今天字段一样,回包不变;以后登记处多字段手机不跟着多)。

### P3c-3(记忆、待办、看到哪了四条并成 `/v1` 一个处理器;老路径是别名)
- **并了哪四条**:`memory/retractions`、`memory/restore`、`todo`、`seen` → `GET /v1/memory/retractions`、`POST /v1/memory/retractions/restore`、`POST /v1/knowledge/facts/set_fact_status`、`POST /v1/journal/seen`。四行 `/v1` 带上 `phone: { link: 'none' }`(照别名行冻结,只给设备);`routes.ts` 删掉四条 `/m/api` 行;`settings-panel.ts` 的四个处理器删掉,面板 deps 的 `memoryRetractions` / `restoreMemory`、`todos.facts.setFactStatus`、`seen.write` 与 wiring 里那几处随之去掉(面板只留首屏要的 `todos.facts.findFacts`、`seen.read`)。待办「不对」一路收回的那一层只剩 `bootstrap/module.ts` 交给内部 API 的那一份(以前面板自己另包了一份)。
- **按 caller 收**:`set_fact_status` 对手机令牌只认 `resolved / active / rejected`(别的 ⇒ 400 `invalid_args`,不改),时间戳由 daemon 定、不认正文里的 `now`(operator / MCP 照旧认任何状态、认 `now`)。`/v1/journal/seen` 收可选的 `until`:带了 ⇒ 夹到 now、只往后推(没推动回现在的水位)、不是时间 ⇒ 400 `invalid_until`;不带照旧推到现在 —— 谁带都一样(不分 caller)。收回 / 恢复两条不分 caller(并之前手机那条就是同一个 `memoryNightly.retractions / restore`,不按 chat 收)。`JournalRoutesDeps` 多两个可选的 `seen`(水位存哪,缺省是那个文件)、`now`(测试钉时钟)。
- **别名**(`legacy-routes.ts` 的 `phoneMemoryRetractions` / `phoneMemoryRestore` / `phoneTodo` / `phoneSeen`):手机的参数规矩先验(恢复的正文恰好一个 `key`、待办 `id` 是数字且状态是那三个、seen 一定带能解析的 `until`),`{ ok }` 信封,不带 cache-control;`/v1` 回「没接上」(`memory_nightly_not_wired` / `knowledge_not_wired` / 模块门 `module_*`)⇒ 手机原来的 `memory_not_wired` / `todos_not_wired` / `seen_not_wired`,恢复 404 ⇒ `not_found`,别的 ⇒ 500 `unavailable`。待办照旧不看结果、一律回 `{ ok: true }`。
- **棘轮**:`MAX_OWN_HANDLER_ROWS` 52 → 48(行数仍 61);`no-m-api-literal` 基线 `routes.ts` 52 → 48、`settings-panel.ts` 19 → 15(合计 230 → 222)。
- **金样**:`m-api-routes`、`matter-read-paths` 逐字节不变(金样文件没动;测试的接线改成把剧本挂在内部 API 上:记忆 / 日志路由 + `knowledge`)。
- **和并之前不一样的几处**:① 记忆 / 日志模块此刻不是 ok ⇒ 四条回各自的「没接上」503(以前面板不看模块门);② 改待办状态抛了 ⇒ 500 `unavailable`(以前处理器不接,手机经隧道一直等);③ 手机的三条写(恢复、待办、seen)现在经内部 API 的分发,跑的时候持一枚 `api:POST …` 忙碌登记(桌宠在场推导本来就滤掉 `api:*`);④ 设备令牌经新键:恢复的正文多出来的键被 schema 丢掉(别名照旧 400)、待办回的是真结果 `{ ok: boolean }`(别名照旧一律 `ok: true`)、seen 不带 `until` 就推到现在(效果同带一个未来的时间,夹到 now);⑤ `/v1/journal/seen` 对本机 file / session 调用方也认 `until`,只能推到「现在的水位 ~ now」之间,不比以前的「推到现在」多;⑥「没接上」与「参数不对」先判哪个,个别路由换了先后(只在没接线的测试里看得到)。

### P3c-4(交办选项与会话五条并成 `/v1` 一个处理器;老路径是别名;分块上传两条改到 P3d)
- **并了哪五条**:`entry/options`、`entry/models`、`attachment/discard`、`sessions`、`session` → `GET /v1/workbench/entry-options`、`GET /v1/workbench/models`、`POST /v1/workbench/discard-attachment`、`GET /v1/workbench/sessions`、`GET /v1/workbench/session`。五行 `/v1` 带上 `phone: { link: 'none' }`(照别名行冻结,只给设备);`routes.ts` 删掉五条 `/m/api` 行;`mobile-workbench.ts` 的选项 / 模型 / 扔掉三个处理器与 `mobile-reads.ts` 的两个会话处理器删掉,面板 deps 的 `entry.entryOptions / entryModels`、`uploads.discard`、`sessions` 与 wiring 里那几处随之去掉。
- **没并的两条(改到 P3d)**:`POST attachment/chunk`、`GET attachment/upload` 和 `/v1/workbench/attachment` 不是同一个动作 —— 手机是可续传的分块协议(`id + draftId + offset`,另查进度),桌面那条是一次传完 base64(POST)/ 按 `taskId` 读回材料内容(GET)。硬并就是「一条路径按调用方做两件事」(上文「否决的」)。别名表里这两行改成 `P3d`、新键 `POST /v1/workbench/attachment/chunk`、`GET /v1/workbench/attachment/upload`、转换 `null`(纯改名)。所以 P3c 实际并的是 18 条,不是 20 条。
- **按 caller 收**(`features/workbench/routes.ts`,原生会话那一份在 `features/workbench/phone-sessions.ts`,手机处理器原样搬来):
  - `entry-options`:同一份选项,手机令牌按手机表面问(`surface: 'phone'`,并之前面板交给服务的就是这一份)。
  - `models`:手机令牌只认 `providerId`(手机那条的写法 `/^[a-z][a-z0-9._-]{0,63}$/`)+ 可选的项目目录 id `projectId`,**不认 `path`**、多一个参数就 400 —— 走 `entryModels`(路径在电脑上解析,没给项目 ⇒ 受管根目录);operator 照旧按绝对路径走 `modelCatalog`。
  - `discard-attachment`:手机令牌只扔自己分块上传的那一份(`discardAttachmentUpload`,手机表面,正文原样交给上传登记处验 —— 恰好 `id + draftId`,不对 ⇒ `invalid_upload_chunk`,同并之前);operator 照旧走 `discardAttachment`(还能扔一次性上传的材料)。
  - `sessions` / `session`:手机令牌回手机那一份 —— 行里项目只给目录名、**不给 `cwd` / 原生 id**,标题至多 200 字,带 `displayName` / `names`;一页 30 / 20,**不认 `limit` / `cwd`**(多一个参数就 400);每条正文至多 4000 字、按 `caller.frameBudget` 减半再拼;单飞 + 短缓存(`cacheSessions`,从 `wire-settings-panel.ts` 搬到工作台模块 init,`phoneSessionsOf`)、10 / 8 秒预算;回包带 `ok: true`(同 P3c-2 的 `/v1/cli/sessions`),别名原样转手,一帧的字节数不变。`WorkbenchRoutesDeps` 多一个可选的 `phoneSessions`;没接 ⇒ 手机令牌 503 `sessions_not_wired`(绝不退回桌面那一份)。两条的响应契约改成「桌面那一份 | 手机那一份」两种之一。
  - 手机令牌的错误回包是桌面那一列,原始码经 `cause`(`x-cc-cause`)带给别名。
- **别名**(`legacy-routes.ts` 的 `phoneEntryOptions` / `phoneEntryModels` / `phoneAttachmentDiscard` / `phoneSessions` / `phoneSession`):方法不对 405、手机的参数规矩先验(同并之前)、`{ ok }` 信封、带 `no-store`;有 `cause` ⇒ 按 phone 那一列换(`mobileMatterError`);没有 `cause` 的 503(模块门 `workbench_not_wired` / `module_*`)⇒ 手机原来「没接上」的码(`entry_not_wired`;扔掉那条 `uploads_not_wired` 本来就落成 `unavailable`);会话两条照并之前的 `sessionError`:不支持 404 `unsupported`、游标 / 键 / 参数不对 400 `invalid`、没接上 503 `sessions_not_wired`、别的 503 `unavailable`。
- **棘轮**:`MAX_OWN_HANDLER_ROWS` 48 → 43(行数仍 61);`no-m-api-literal` 基线 `routes.ts` 48 → 43、`mobile-workbench.ts` 16 → 13、`mobile-reads.ts` 5 → 3(合计 222 → 212)。`mock-internal` 删掉 `pipeline-deps-native-history.test.ts` 那一行(文件删了,它测的接线搬进工作台模块)。`workbench-errors` 的 INTERNAL_ONLY 多 `busy`、`budget_exceeded`(只在手机会话那条分支里接住)。
- **金样**:`m-api-routes`、`matter-read-paths` 逐字节不变(金样文件没动;测试的接线改成把剧本挂在内部 API 上:`workbenchRoutes` + `phoneSessions`)。
- **和并之前不一样的几处**:① 工作台模块此刻不是 ok ⇒ 五条回各自的「没接上」(以前面板直接拿 `opts.workbench`,不看模块门);② 手机的扔掉一份材料现在经内部 API 的分发,跑的时候持一枚 `api:POST …` 忙碌登记,正文上限是 `/v1/workbench/*` 的 128 KiB;③ 设备令牌经新键:参数更严(会话两条多一个键就 400、模型不认 `path`),错误码是桌面那一列(`native_history_unsupported` 422、`invalid_request` 400);④ 原生会话的缓存从面板的接线挪到工作台模块(仍是一个实例、同样的 TTL / 在途上限,只有手机令牌走它;桌面照旧不经缓存);⑤「没接上」与「参数不对」先判哪个,个别路由换了先后(只在没接线的测试里看得到)。
- **扩大了谁的够得着**:没有。设备令牌经新键够得着的函数和并之前 `/m/api` 那条一样(选项 / `entryModels` / `discardAttachmentUpload` / 缓存过的原生会话读法);链接令牌五条新键、五条别名键都 403(`panel-v1-workbench.test.ts`,每条规矩做过变异核对)。

### 打开 `ServerHello.routes: 'v1'`(给整合者:soak 绿以后一行的 PR)
- **改哪儿**:`src/features/phone/tunnel-client.ts` 里 v2 握手回应那一行 `sendToStream(stream, { hs: b64uEncode(kp.pub), v: 2 })` 加上 `routes: 'v1'`(就这一处发 `ServerHello`;形状 `packages/protocol/src/messages.ts` 的 `ServerHello` 早就认 `routes: s.optional(s.literal('v1'))`,`shape.test.ts` 钉着)。同 PR 把 `messages.ts` 那段注释里「daemon 现在还不发」改掉,`tunnel-client.test.ts` 握手那条加一句 `expect(hello.routes).toBe('v1')`。不动 `packages/protocol` 的类型就不用 `build:mobile`(改了注释也跑一遍,生成物应该不变)。
- **谁读它**:今天**没有人读**。`packages/protocol/src/client.ts` 的 `onHello` 只 `ServerHello.safeParse` 然后用 `hs` / `v`,不看 `routes`;App(`apps/app`,经 `makeProtocolClient`)、网页 `/m`(`apps/mobile`,同一个客户端打包进 `protocol-generated.js`)、`wechat-cc selftest phone`(`src/cli/selftest-phone.ts`)都一样。老 App 的 `shape` 丢掉不认识的键(`shape.ts` 的 `object` 只留声明过的键),所以对装着的 App 是无害的一行;真正开始读它是 P3f(新 App build 见到它才改调 `/v1` 键)。局域网直连没有握手,只有中继那条有这个信号。中继(`apps/relay`)只转帧不看内容,不用动。
- **它说的是什么**:`'v1'` 只能表示「P3c 那 18 条的 `/v1` 新键手机令牌能走了」。P3d / P3e 的新路径今天还不存在 —— P3f 的 App 见到 `'v1'` 只能换 `MERGED_ALIAS_KEYS` 里那几条的键,别的照旧走 `/m/api`;P3d / P3e 合完以后要么换一个新值(`messages.ts` 那里 `literal('v1')` 变成并集),要么让 App 按 `ROUTES` 里有没有 `phone` 块判断。P3f 之前要定。
- **真机上验什么**(整合者照 deploy.md 部署以后):① `wechat-cc selftest phone` 绿(中继 v2 闭环;它不读 `routes`,验的是握手多一个键没把谁弄坏);② 真 iPhone 上装着的 App(build 2 / 3)照常连上、此刻页 / 一起做 / 对话 / 交办选项与会话列表都打开(老 shape 丢掉 `routes`);③ 手机网页 `/m` 出门模式(经中继)照常连上;④ daemon 日志里没有 `bad_hello` / `downgrade_refused`;⑤ 照常 `wechat-cc self soak`。

## 不做 / 推后
- **不改语义**:同步的 `/v1/companion/converse` 和收下即回的 `owner-chat/say` 各留一条(两个动作,不是一份数据两条路);「看 / 改记忆」两种读法照旧各一条。语义要合是另外的事。
- **不并 `/m` 页面路径、`/set`、`/set/api/*`**:那是页面和配对,链接里带着,不是数据路由。
- **不动订阅**:topic(`home`、`approvals`、`agents`、`matter/`)是 P1 / P2 的事;终端钩子那两个挂起请求(`/v1/cli/permission`、`/v1/cli/say`)照骨架 §3.3 留着。
- **不动 A2A、微信侧、中继**:它们本来就一族,或者不看路径。
- **不让内部 API 上局域网,也不让面板认桌面凭据**([设备令牌底座设计稿](2026-09-27-device-token-registry-design.md) §9 的「面板仍监听 0.0.0.0、内部 API 只在本机」照旧)。

## 否决的
- **另起一个 `/api/*` 新族,两边都搬过去**:桌面 236 条全改名、`tauri` 白名单全换、要发版,换来的只是名字好看。
- **合成一个监听**(内部 API 也听局域网,或者面板代理桌面凭据):把 admin 凭据摆到网口上,换来的是少一个端口。
- **一条路径按调用方回不同形状**(看 `caller` 选信封、选错误码列):还是两份契约,只是藏进了处理器;新客户端读不出一份 schema。信封与手机错误码只在别名里。
- **按日期退别名**:App Store 上的 App 不能强制升级(`routes.ts` 头注释);中继 v1 按日期退是先例,但那次的代价是老 App 直接 `upgrade_required`。按构建号退,和 M6 一致。
- **别名放在中继里翻**:中继是端到端加密的,看不到路径;放了就要解密。
- **App 先发、daemon 不广播**:新 App 连老 daemon 会 403。用 `ServerHello.routes` 一个可选键就能两边各自先走。

## 风险
- **合处理器时漏了手机那几样**(可见范围、链接令牌少读、帧预算、默认筛选):每条合并以别名金样逐字节不变为门,链接令牌那几份单独钉。
- **链接令牌范围跑偏**:新行的 `link` 照别名行冻结的值抄;快照守卫按「新键 ∪ 别名键」比集合不许变大。
- **被 service worker 缓存的旧 `/m` 页**:设备令牌走别名照样能用;链接令牌 10 分钟就过期,影响只在 P3g 那一次部署后的十分钟里。
- **桌面白名单编在 `.app` 里**:P3e 新键要等下一版桌面;在那之前桌面走 `/v1/workbench/*` 的别名,不会断。
- **构建号从没报过的老 App 一直不升级**:它在 30 天窗口里就一直挡着删行。这是有意的,和 M6 同一个口径。

## 要主人点头的
无。每一步都以金样逐字节不变为门;主人在桌面、App、网页上看到的都不变。P3e 的桌面改动要随下一版桌面发版,只是发版说明里一句,不是看得见的变化。

## 顺序
P3a → P3b → P3c-1 → (soak 绿后打开 `ServerHello.routes`)→ P3c-2、P3c-3、P3c-4(碰的文件不重叠,可并行)→ P3d → P3e → P3g;P3f 随下一个 App build,只依赖 P3b 的 `routes: 'v1'` 和它要用的那几组已经合进去;P3h 按退休条件一行一行来。P3a–P3e、P3g 只动 daemon 与网页(`self deploy` 生效),P3e 的桌面那一半随下一版桌面。
