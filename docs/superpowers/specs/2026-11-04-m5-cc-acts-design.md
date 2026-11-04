# M5:CC 自己做的事成为「一件事」(设计稿)

2026-11-04 · 承接 [一个伙伴一副骨架](2026-10-31-one-companion-one-skeleton-design.md) §4 M5,以及 U 线「CC 最近在忙」那一组(主人 10-31 定:不混排,「一件事」列表只放你的事)。

## 现在的样子(origin/dev da0ef120)
- 六个发起方各记各的,没有一个建 matter;库里从没写过 `kind = 'act'`(只在枚举里)。
  - **信**:`features/letters`,15 分钟一拍 + 当面「给我写封信」。状态在 `companion/letters.json`(dueAt / pending / lastSentAt)和每封信的 `letter.json`(sent_at / sent_via)。
  - **早报**:jobs runner 的 `job.brief`,经 `runJobTurn` 开一轮 provider。状态在 `scheduled-jobs-state.json`(lastRunDay / lastRunAt / lastStatus / failStreak)。同一条路也跑主人自己定的定时任务 —— 那些不是 CC 自己做的事。
  - **记忆整理**:`features/memory/nightly-*`,15 分钟一拍,一天一次;主人也能当面叫。状态在 `companion/memory-nightly.json`、`memory-log.jsonl`。
  - **打猎**:伙伴推送那一拍里便宜模型挑中 ⇒ `huntAction.run`,在主人那条对话里开一轮。状态在 `care_ledger.json` 的 `lastHuntAtIso`、`plan-log.json`、journal 的战利品。
  - **画室**:introspect 那一拍(默认关),画好存本地,不自己发。状态在 `atelier/atelier-state.json`。
  - **贴纸**:introspect 那一拍,画好存进贴纸库再说一声。状态在 `sticker-artist.json` 的 `last_at`。
- 「CC 做过的事」另有一份(B9):`activity-log.jsonl` + 信的存档 + `memory-log.jsonl` 在 `daemon/cc-activity-source.ts` 拼起来。
- **要先挡住的一处**:`GET /m/api/matters` 不点名种类时什么都给,App 主页只滤掉聊天 —— 一旦开始写 act,CC 自己做的事会直接混进主人的列表;MatterLog 不改旧的 `status` 列,它们还会一直挂在「在做」里。

## 定案
**每个发起方一件长期的 `kind = 'act'`、`initiator = 'cc'` 的事;每做一次 = 这件事的一轮;过程(写了什么、画了什么、送到哪)是这一轮的步。**
- 不是每做一次一件:信一周几封、早报天天有,一次一件会把「CC 最近在忙」刷满同一种东西;一个发起方一件,最近那一轮就是它的近况。
- 六件事按发起方认:**id 由发起方名字定**(`sha1('cc-act:<who>')` 取前 8 位,who = letters / brief / memory / hunt / atelier / stickers)。第一次做时建,标题用中文名:信 / 早报 / 记忆整理 / 打猎 / 画室 / 贴纸。
  - 不用 `matter_bindings`:它的 surface 有 CHECK(wechat / desktop / phone / cli),加一种要重建表;协议包里 `MatterBinding.surface` 也是封闭枚举,老 App 解析详情会失败。
- 只经 MatterLog 写;写不上不挡原来的事(一律 try,只少一轮)。

### M5a 先挡、再接口(只动 daemon)
- `GET /m/api/matters` 不点名 `kind=act` 就不给 act(和 #798 挡终端同一个做法)。主页、网页看不出变化;桌面不读这份列表。`GET /v1/matters` 不动(桌面不用,CLI / 工具要看全的)。
- 端口 `ports/cc-acts.ts` + 实现 `adapters/store/cc-acts.ts`:
  - `begin(who, { startedAt, policy? })` ⇒ 一轮的把手:`step(kind, status, payload, key?)`、`finish(status, { endedAt, errorCode? })`。
  - 进程重启:开着的 act 轮记中断(同终端、对话)。
- 不加迁移,不动协议。

### M5b 六个发起方接上(和原来的状态文件并行写)
- 每个发起方在「真动手」的那一刻开一轮,在原来写状态文件的地方收:
  - 信:开始写 ⇒ 开轮;草稿 = 一步 artifact(只放字数和第一行,不放全文);每页送出 = 一步 delivery;送完 ⇒ completed。等微信窗口 / 被挡下(可能挂好几天)⇒ 这一轮先收成 failed(errorCode = blocked),下次续发再开一轮,免得一轮挂几天。
  - 早报:只认 `job.brief`;`runJobTurn` 前后开收;发出的那段 = 一步 agent_message(截 600 字)。主人自己的定时任务不进 act。
  - 记忆整理:真跑了(有新材料)才开轮;改了几条 = 一步 system(只放条数和种类);通知送出 = 一步 delivery,可能在几小时后,挂在当时已经收了的那一轮上(轮收了步照样能写)。主人当面叫的也算这件事的一轮,`policy.trigger = 'owner'`。
  - 打猎:选中并真开了口才开轮;战利品 = 一步 artifact。打猎那次开口本身照旧是主人那条对话的一轮(M3),这里只记「去打了猎、带回了什么」,不重复记对话。
  - 画室:真动笔才开轮(没有冲动不记);画好 = 一步 artifact(作品 id)。
  - 贴纸:画了才开轮;存进库 = 一步 artifact,说一声 = 一步 delivery。
- 不做的:陪伴问候、日程提醒(那是开口,不是做事;在 speech_log 里已经有账)。

### M5c App「CC 最近在忙」(动 App,随下一个包)
- 主页最末一组,默认折叠:点名 `kind=act` 拉六件事,按最近一轮的时间排,一行 = 发起方 + 最近一轮那一句(「写了一封信 · 昨天」)。点进去是 `/matter/<id>`,按 kind 画轮的时间线。
- 老 daemon 不给 act ⇒ 这一组不出现。

### M5d 删能从轮推出来的标记(soak 之后)
- 能删的:信的 `lastSentAt` / 每封信的 `sent_at`、早报的 `lastRunAt` / `lastStatus`、记忆整理的 `lastRunIso`、画室的 `successfulAt`、贴纸的 `last_at`、打猎的 `lastHuntAtIso`。
- 不能删的:信的 `dueAt`(随机定的下一次)、早报的 `failStreak`(没跑的日子也要算)、`noReplyCount`、`plan-log` 的再问退避。
- 「CC 做过的事」(cc-activity-source)改读这六件事的轮,`activity-log.jsonl` 里 proactive 那一类跟着删。

## 不做 / 推后
- **一次一件 act**:否决,理由见上。
- **把伙伴问候也写成 act**:不做。开口归 S 线(speech_log),做事归 M 线。
- **act 的步放全文(信的正文、早报全文)**:不放。正文已经在各自的存档里,步只引 id / 放摘要,免得一封信在库里存两份。

## 风险
- **打猎在主人对话的一轮里**:act 那一轮和对话那一轮同时开着,两件不同的事,互不影响;别把对话轮的步写进 act。
- **列表 50 条上限**:M5a 先挡住,就不会挤掉任务。
- **旧 `status` 列**:act 的 status 一直是 open;M6 之前 App 不读 act 的 status,只读 state。

## 顺序
M5a → M5b(一个发起方一个 PR,先信和记忆整理:真机上最常发生)→ soak → M5c(随 build)→ M5d。M5a / M5b 只动 daemon,`self deploy` 生效;界面上看不出变化。
