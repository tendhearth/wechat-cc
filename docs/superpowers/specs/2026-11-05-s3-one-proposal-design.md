# S3:一件事一次提议(设计稿)

2026-11-05 · 承接 [一个伙伴一副骨架](2026-10-31-one-companion-one-skeleton-design.md) §4 S3、§5 第三行(「任务做完时人在电脑前 ⇒ 先只在桌面提示,10 分钟没看再推手机」,主人照建议)、§8 第 6 条(blocking 照旧各处推;report 按人在哪选一个通道,10 分钟没被看到升一级:桌面 → App → 微信;桌面通知和桌宠两个通道在 S3 里新加)。用 S2 做好的 `speech_pending`(v101)、`lib/delivery-backoff.ts`、待说那一拍。

主人已点头的范围就是上面那两处。超出的地方在文中标 **待主人点头**,这一轮不做,只留成选项。

## 现在的样子(origin/dev 6c7341dd,11-05)

一件工作台任务做完(或者在等主人批准),今天有**四条路**各自决定要不要告诉主人,有三条过门,一条不过:

| # | 路 | 触发 | 过门 | `speech_log` |
|---|---|---|---|---|
| 1 | App 推送:`features/phone/phone-notifier.ts:39-134` | 订事件集线器 `approvals` / `agents` 两个主题,比前后快照:新的待批 / 提问(`:62-83`);`working/queued → replied` 记「做完了」,`failed / interrupted` 记「没做成」(`:85-107`) | `deps.deliver` → `daemon/speech/push-gate.ts:77-86` `speech.ask({kind}, {channel:'app'})` | 一行(`permission_ask` 或 `matter_report`,channel = app) |
| 2 | 微信通知:`features/workbench/wire-notifications.ts:26-95` | 工作台服务入队 `workbench_wechat_notices`:待批 / 提问(`service/notices.ts:52-63`)、run 终态(`service/notices.ts:105-129`,事务里先 stage) | worker 的 `send` 里 `speech.say`(`wire-notifications.ts:50`) | 又一行(channel = wechat) |
| 3 | 回原对话的回报:`features/reports/sweeper.ts` | 有出生地(从微信交办)的一轮答完 ⇒ `matter_report_outbox`(`service/lifecycle.ts:135-139` reportOnce) | `sendReportVia` → `speech.say({kind:'matter_report'})`(`sweeper.ts:171-182`) | 又一行 |
| 4 | 桌面自己的系统通知:`apps/desktop/src/modules/workbench-attention.js:93-130` | 桌面每 3 秒拉 `GET /v1/workbench/attention`,比前后 phase:「有一件事回复了 / 停下了 / 等你决定」;窗口在前面就不弹 | **不过门**(免打扰里照弹) | 没有 |

几个细节:

- 第 1 条只在**接了中继**而且**有登记设备**时才订阅(`daemon/wiring/wire-phone.ts:187-197` 在隧道起来之后才建;`phone-notifier.ts:121-131` 没设备就退订)。没配手机的主人这一路整个不存在。
- 第 2 条只对**订了微信提醒**的任务:从微信交办时自动订(`service/execute.ts:628`),桌面派的要主人自己开(`notices.ts` setWechatWatch)。有出生地、这一轮会回报的,「这一轮已完成」那条通知压掉(`notices.ts:105-107` suppressCompleted),免得和第 3 条说两遍。
- 第 3 条自己有一道粗的「在场」闸:主人一分钟内在这条对话说过话 ⇒ 先压着,压到 10 分钟强制放(`domain/matters/report.ts:87-92` shouldDisturb、`sweeper.ts:184` HELD_OVERRIDE_MS、`:221`)。
- 所以一件从微信交办的事做完,主人在电脑前:桌面弹一次(第 4 条)、手机响一次(第 1 条)、微信里收到回报(第 3 条);`speech_log` 里两行(1、3),三处通知没有一处知道另外两处。
- 账上分不出「同一件事」:`speech_log`(v84,`daemon/speech/ledger-store.ts`)只有种类 / 类别 / 结果 / 原因 / 通道 / 时间,没有事件的键。

### 终端会话已经在判「人在哪」

`app/cli-events.ts` 是唯一按在场选通道的地方(spec 2026-09-09-cli-hook-push §5):

- 信号:本机上次键鼠输入距今秒数(`lib/machine-idle.ts:42`,macOS `ioreg` HIDIdleTime / Windows GetLastInputInfo / Linux xprintidle;探不到 ⇒ null),hook 报来的 `idle_s` 五分钟内算新鲜(`cli-events.ts:62` IDLE_FRESH_MS),再退到「这条会话 3 分钟内敲过 prompt」(`:58` PRESENT_WINDOW_MS)。
- 判法:空闲不足 120 秒(`:60` PRESENT_IDLE_S)⇒ 人在电脑前 ⇒ 只发桌面系统通知(`lib/desktop-notify.ts:22`,osascript / notify-send / PowerShell 气泡),不进微信、不推 App(`cli-events.ts:283-292`);否则微信 + App 各一份(`:246-269`)。
- 没有「没看到就升级」:人在电脑前时弹过桌面就算完。

## 定案

### 一个事件 = 一个提议 = 账上一行

- **事件的键**(`ref`):`ask:<matterId>:<requestId>`(等你批准 / 有问题问你)、`turn:<matterId>:<seq>`(这一轮做完 / 没做成;`seq` = `matter_turns` 里这件事最新那一轮)。工作台任务和它的 matter 同 id。
- **账一行**:迁移 **v103** 给 `speech_log` 加一列 `ref`(可空,带部分索引),`matter_report_outbox` 也加一列 `ref`(回报入队那一刻记下报的是哪一轮;同一件事两轮合并成一行时跟着换 —— 不能事后按 `created_at` 推,合并时它故意不动)。带 `ref` 的判定写账时:没有这一行就插;已有就**改这一行**(结果 / 原因 / 时刻换成最新的,通道追加,如 `desktop+app`)。不带 `ref` 的照旧一判一行。于是「同一事件 `speech_log` 只有一行」由写口保证,不靠各路自觉。
  - 免打扰里先推后、天亮放行的,账上仍是一行(最后是 allowed);中间那次推后只留日志。S2 的「连着推后一小时只记一次」改成按事件分开(两件不同的事同一小时里推后各有一行)。
- 第 1、2 条路的门都带上同一个 `ref`(App 推送那一份在 phone-notifier 里算,微信通知那一份由 notice 的 taskId / requestId / runId 推出同一个键)。第 3 条见下面「回原对话的回报」。

### 一条路:matter 状态变化 → 一个提议(`daemon/speech/matter-proposals.ts`)

- **探测**只留一处:phone-notifier 比快照那段搬出来成为「matter 事件探测」,**不再以有没有登记设备为条件**订阅(没配手机的主人也要有桌面那一级)。它只产出事件 `{ref, matterId, kind: permission|question|task_done|task_failed, title, body, requestId?}`,交给提议。
- **blocking**(permission / question):照今天各处都推 —— App 推送(push-gate)、订了提醒的微信通知(worker)、桌面自己的通知(第 4 条不动)。区别只在账:同一个 `ref`,一行,通道 `app+wechat`。
- **report**(task_done / task_failed):过一次门(`speech.ask`,带 `ref`)。放行 ⇒ 按「主人此刻在哪」选**第一级**通道,记下这一级和时刻;推后(免打扰)⇒ 照 S2 压进 `speech_pending`,到点再判在场、再选第一级。
  - 在电脑前 ⇒ **桌面**:daemon 侧发一条系统通知(`lib/desktop-notify.ts`,和终端会话同一个)。桌面 app 开着时它自己那条(第 4 条)已经会弹 ⇒ daemon 不再另弹,只记这一级是 desktop(避免同一件事桌面弹两下)。
  - 不在电脑前、配了手机 ⇒ **App** 推送。
  - 都不是 ⇒ **微信**(只对订了微信提醒的任务;没订的,这一级不存在,提议到此为止 —— 和今天一样不推)。
- **升级**:第一级发出后 10 分钟内没被看到(见下)⇒ 升一级:desktop → app(没配手机就跳到 wechat)→ wechat(没订提醒就停)。每升一级之前**再问一次门**(带同一个 `ref`,账还是那一行,通道追加);期间开了免打扰就压着,时段结束接着升。被看到了 ⇒ 不再升,账那一行 reason 记 `seen:<在哪看到的>`。
- 订了提醒的微信「这一轮已完成 / 需要处理」通知(第 2 条的 report 那一半):worker 照旧持久、照旧幂等,只是送之前问提议「轮到微信没有」:没轮到 ⇒ `postponed` 到升级时刻(不算尝试,S2a 已有这条路);被看到了 ⇒ `suppressed: seen`。
- 存在哪:**复用 `speech_pending` lane = `push`**,不新建表。一个 report 提议在等升级 = 一行(`ref` = 事件键,唯一索引已有 `(lane, ref)`),`body` 是提议本身(JSON:事件、当前级别、第一级发出的时刻),`next_at` = 下一次升级的时刻,`expires_at` 照 S2 的 24 小时。开机按最早 `next_at` 起计时器(push-gate 已有),**重启不丢**。push-gate 放到点的行时,看到是提议就交给提议去升级,不当普通推送推。lane 的 CHECK 不用改,所以 S3b 不用再加迁移。

### 「主人此刻在哪」(在场信号,从终端会话那份推广)

- 抽出 `lib/owner-presence.ts`:`atDesk(): Promise<boolean | null>` = 本机空闲 < 120 秒(`machine-idle.ts`,同一个阈值,`cli-events.ts` 改为从这里拿常量);探不到 ⇒ null ⇒ 当作不在电脑前(宁可推手机,不漏)。
- 桌面 app 开没开:daemon 看它最近有没有来拉 `GET /v1/workbench/attention`(3 秒一次)或挂着 `presence` 主题(S5);20 秒内来过 ⇒ 桌面 app 在。只用来决定桌面那一级由谁弹(app 自己 / daemon 的系统通知),不用来判人在不在。
- App 在不在前台:中继隧道上挂着订阅的设备(`wire-phone.ts` onlineDevices)。今天推送已经跳过在线设备(`phone-notifier.ts:26`);提议里 App 那一级照旧经 fanoutPush,在线的设备算「看着呢」。
- 第一步不用「最近在微信里说过话」这种粗信号判在场(那是第 3 条路的临时闸,注释里自己写了临时)。

### 「看到了」怎么算(每个通道)

都落在已有的 `matter_bindings(matter_id, surface, surface_key, last_seen_at)`(v60;surface 已允许 `desktop` / `phone` / `wechat`),判法 = 这件事在某个面上的 `last_seen_at` 晚于提议第一级发出的时刻。

| 通道 | 看到了 = | 今天有没有 |
|---|---|---|
| App | 手机打开这件事的详情(`GET /v1/matter?id=`,`routes-matters.ts:134` seenOnPhone 写 `phone/pwa`) | 有。注意 `:98` 列表也会写 —— 手机列表上露面也算(App 首屏「带回来的」那一组就是这件事) |
| 桌面 app 打开这件事 | 桌面读这件事的详情(`GET /v1/matter?id=` 非手机令牌、`GET /v1/workbench/task?id=`)⇒ 写 `desktop/app` | **新加**(daemon 侧,一行 bind) |
| 桌面系统通知被点 | 桌面 app 收到通知点击 ⇒ `POST /v1/matter/seen {id, surface:'desktop'}` | **新加**,在 `apps/desktop`,随下一版桌面 |
| 桌宠被点开 | 桌宠点开、陪伴窗里露出这件事 ⇒ 同上,surface `desktop`、key `pet` | **新加**,在 `apps/desktop`,随下一版桌面 |
| 微信 | 最后一级,发出去就不再升;主人在微信里 `任务 <编号>` 看了这件事也写 `wechat` | 已有 bind 路径,不另做 |

daemon 侧发的 osascript 通知点不到(系统不回调)⇒ 桌面 app 没开时,桌面那一级只能靠「打开这件事」算看到;10 分钟没开就升到手机 —— 正是主人点头的那条。

### 回原对话的回报(第 3 条路)

它不是通知,是**交办那次对话的回话**(内容是答复正文,出生地契约「回到那次对话里说一声」)。这一轮**不按在场收窄**、不进升级:照今天发,只是账上带同一个 `turn:` 键 ⇒ 并进同一行(通道追加 `wechat`)。微信回报发出去了,这件事的提议就当「已经送到手机」,不再升到 App(否则同一件事手机上收两次)。

**待主人点头 A**:把回报也当成升级梯子的微信那一级 —— 人在电脑前、10 分钟内在桌面看过了,就不在微信里回那一句。建议:先不做(微信里交办的人多半就是要在微信里收到答复)。

## 主人看得见什么

| 变化 | 何时 | 范围 |
|---|---|---|
| 任务做完 / 没做成时人在电脑前:先只在桌面提示,手机不响;10 分钟没看再推 App | S3b 部署后 | 主人已点头(§5 第三行) |
| 人不在电脑前:直接推 App(和今天一样);App 推了 10 分钟没开、这件事订了微信提醒 ⇒ 再在微信里说一声 | S3b-2 | 主人已点头(§8 第 6 条)。订了提醒的任务,「这一轮已完成」那条微信通知从「马上」变成「App 没看才发」 |
| 等你批准 / 有问题问你:照旧各处都推 | — | 不变 |
| 从微信交办的事:微信回报照旧;回报发出去以后手机 App 不再另推一次「做完了」 | S3b-2 | 主人已点头范围内(同一件事一次提议);列在这里让主人知道 |
| 没配手机的主人:人在电脑前时 daemon 也弹桌面通知(桌面 app 没开时) | S3b-2 | 已点头(桌面那一级);S3b 这一步没做 |
| 点桌面通知、点开桌宠就算看过,不再升级 | 下一版桌面 | 已点头(§8 第 6 条) |

## 不做 / 留成选项(待主人点头)

- **A** 回原对话的回报也按在场收窄(见上)。
- **B 终端会话并进来**:终端会话今天在电脑前只弹桌面、不会升级。并进同一条路以后,在电脑前弹了桌面、10 分钟没回终端就会推手机 —— 多出来的推送。建议:先不做,`cli-events.ts` 只改用共用的在场常量,行为不动。
- **C 桌面 app 开着时它自己的通知也过门**(免打扰里不弹):今天桌面通知不看免打扰。建议:随桌面那一步一起做,但它是主人天天看得见的变化,要点头。
- **D blocking 也按在场收窄**:骨架稿已定不收(§8 第 6 条),不做。
- 提醒、定时任务、自改进展等别的 report 种类:不是 matter 状态变化,这一轮不动(S4 再看)。

## 顺序

- **S3a**(daemon,行为不变;#847):v103 `speech_log.ref` / `matter_report_outbox.ref` + 写口按 `ref` 并一行;第 1、2、3 条路的门带同一个键。沙盒:一件做完的事、一次等你批准,`speech_log` 里各只有一行。
- **S3b**(daemon,看得见的变化,已点头;#848,叠在 #847 上):`lib/owner-presence.ts` 抽出来、`cli-events` 改用;`matter-proposals.ts`:做完 / 没做成时人在电脑前 ⇒ 先只在桌面(桌面 app 开着、看见了这件在做 ⇒ 它自己弹;否则 daemon 弹,通知里不放任务标题),App 那一条进 `speech_pending`(key `later:`)等 10 分钟,到点桌面 / 手机看过就不推,没看过照常问门推(账同一行 `desktop+app`);同一件事来了新的回报,等着的旧那条作废。测试缝:升级间隔、在场探针、daemon 弹的通知(从 Foundation 进,测试里默认「探不到 = 不在」、不真弹)。沙盒:没人看 ⇒ 2 秒后推一次、账一行 `desktop+app`;桌面打开过 ⇒ 不推。
  - 比上面的定案**收窄了**这几处(留给 S3b-2,都在已点头范围内,只是这一步没做):① 探测仍只在接了中继(有 App)时跑 —— 没配手机的主人这一步行为不变;② 只升到 App,App → 微信那一级(订了提醒的任务的微信通知等「轮到没有」)没做;③「桌面读过」记在 daemon 内存里,**不写 `matter_bindings`**(那张表出现在一件事的详情里,写了金样就变);只有打开详情那一次读算看过,之后的长轮询不算(窗口在后台时它照样在拉)。
  - 已知的限:桌面 app 开着、窗口在前面、主人看着这件做完 —— 桌面 app 自己不弹(它在前面),daemon 也认不出「看过了」⇒ 10 分钟后手机多响一次。宁可多推一次;S3c 由桌面在前台显示结果时明确说一声「看过了」来补。
- **S3c**(`apps/desktop`,随下一版桌面):通知点击 / 桌宠点开 ⇒ `POST /v1/matter/seen`;桌面自己那条「有一件事回复了」改由 daemon 的提议驱动(选项 C 点头后再加过门)。

## 测试

- 金样一字不变(S3a/S3b 不改 matter 的读出形状)。
- 真实形状沙盒(`real-shaped-sandbox.e2e.test.ts`,照 S2 用 `rebootForS2` 从定好的起点开机):「同一事件一行」与「10 分钟升级」(升级间隔走测试缝缩到秒级);删除 / 发送之后才写的都用 `expect.poll`。要 Codex 做完一件事的那一半在 win32 上跳过(同 S2)。
