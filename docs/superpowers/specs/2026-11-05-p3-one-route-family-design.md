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
- P3c-4 交办选项与会话:`entry/options`、`entry/models`、`attachment/*` 三条、`sessions`、`session`。
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
