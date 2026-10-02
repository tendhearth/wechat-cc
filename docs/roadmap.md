# Tendhearth CC 现行 roadmap

> v1 · 2026-09-22 · **这份只说「往哪走 / 卡在哪」。**
> 「定了什么 / 为什么这样定」在 [全景导图](全景导图.md);「某件事的文档在哪」在 [文档索引](INDEX.md);
> `docs/rfc/02-post-v1.1-roadmap.md` 是 2026-04 的历史版本(v1.2 时代),已被本文取代。

项目组合与 4 月以来的演变见[项目总览](project-overview.md)。

命名已统一为 **Tendhearth CC**，角色称呼为 **CC**；技术兼容边界见[产品命名规范](reference/product-naming.md)。手机端的实现、真机验收和商店发布是不同交付状态，以 [apps/app](../apps/app/README.md) 及各批验证记录为准。

## 现状:最新公开版本 1.7.2

| 事实 | 怎么看(别写死数字,每次改这页先跑) |
|---|---|
| 最近一次**公开**发版 | `gh release list --limit 1`(2026-10-02:`desktop-v1.7.2`,master `7c07de44`;1.7.1 起 macOS 包都是 Developer ID 签名 + 公证) |
| 自动更新源 | `curl -s https://dl.tendhearth.com/wechat-cc/latest.json \| grep version`(2026-10-02:1.7.2,与 GitHub 一致) |
| `dev` 领先 master | `git rev-list --count origin/master..origin/dev`(簿记合并之后是真实差值) |

1.7.0 是发版链 09-03 改造后第一次真跑,一路踩到五个「加进去后没在真 tag 上跑过」的坑,全部修在 dev 并有守卫/手册条目:dev→master 簿记合并(#121)、e2e 作业装浏览器(#122)、sd.cpp 子模块(#119)、公证变量空串(#123)、R2 令牌失效还报绿(#125)。**发版从此全自动**:合 PR、打 tag、两道 `release-signing` 审批(助手用主人 gh 凭据经 API)、Publish、核对更新源,主人不用点;细则 [maintainer/release.md](maintainer/release.md)。

版本号已统一(2026-09-22):此前四处各说各话(发版认 `tauri.conf.json` 的 1.6.6、`--version` 报根 `package.json` 的 0.6.4、`apps/desktop/package.json` 写 0.5.18、ACP 的 clientInfo 还硬编码 `'0.6.4'`),现在四处 + `Cargo.toml` 都是 **1.7.0**,由 `scripts/version-consistency.guard.test.ts` 钉住;`--version` 同时带构建的 git 短 sha(`1.7.0 (a1b2c3d)`),否则 `self deploy` 的健康门打出来的数字两次发版之间永远一样、看不出新构建起没起来。发版说明:`docs/releases/desktop-v1.7.0.md`。

**⇒ 发版节奏的教训:三周不发、发版链改了不真跑,代价是一天修五个坑。** 之后每合一批就发一版 patch。

## 命名统一的后续交付

本批统一 README、维护入口、手机说明与全景导图。后续桌面与手机批次应按[产品命名规范](reference/product-naming.md)检查应用显示名、窗口标题、关于页、权限说明和商店素材，统一为 **Tendhearth CC**；对话仍称 **CC**。这项文案验收纳入各端原有交付，不新增底层标识迁移，不阻塞正在进行的手机功能开发。

## 当前主线与验收顺序(2026-10-02 更新)

**10-02 进展**:中继 v2 staging(`relay-staging.tendhearth.com`)上线并配好 APNs,本机 daemon 已切过去;真 iPhone 全自动验收 `bun run e2e:device`(XCUITest,见 [apps/app](../apps/app/README.md))配对 / 重复码 / 聊天 / 真推送批准 / 撤销 / 收尾全绿,第 2 条的主体已由它覆盖。下一步:要出 TestFlight 时上中继生产(主人在 `relay-production` 环境批准一次)+ 开 `RELAY_WATCH`;商店与安卓按主人 10-01 的话往后放。


1. **收口当前手机主线。** 协议、中继、Expo 骨架、真连接、原生通知、手机聊天与设计统一已按各批次进入 dev；#165 配对体验与 #166 手机续接原生会话也已合入 dev，#167 补充了发送拒绝的诚实提示。实现状态与验收边界见下一节和 [apps/app](../apps/app/README.md)。未合入的工作不作为 dev 的已交付能力。
2. **完成用户能实际走通的验收。** 真机配对 → 与 CC 聊天 / 交办 → 查看进展 → 点真实通知 → 在上下文中批准 → 电脑实际执行；覆盖断网、撤销与重复提交。模拟器、进程内端到端和解密向量分别证明各自范围，不代替这条闭环。
3. **再按原有发布流程交付。** 凭据、中继上线、双平台真机和商店提交各自有完成条件；既有桌面真机欠账继续保留。Widget / Live Activities 与跨宿主 agent 协调另按设计和验收排期。

前一轮已收口：#117、1.7.0 / 1.7.1 发版、Codex 第一批 #129、大文件拆分、设备令牌归入 token-registry。旧的「等第一批 / 拆分后再做」顺序不再是当前主线。

## 1.7.0 里交付的(2026-09-27 已发)

按主题,括号里是权威文档。

- **工作台**(`docs/cc-workbench.md`)—— 把 CLI 执行者派到文件夹里干活。这三周加了:实时事件流(逐字)、逐文件 diff 审阅与打回、免审执行者、租约模型两次重写,最后收在**一个文件夹一个活会话**(占用从派发到会话关闭 + 两档空闲自动收工)。
- **ACP 客户端** —— Cursor 走 `cursor-agent acp` 进工作台(命令有卡、编辑免审的中间档),对话侧也从 print 模式切到常驻 ACP 会话。Claude / Codex 不换。
- **自维护三件套 + 自改流水线** —— `self deploy`(换 inode / 健康门 / 回滚)、`selftest workbench|chat`、`self change`(专用工作树 + 五道闸门 + 微信拍板)、`ci triage`。维护者手册在 `docs/maintainer/`。
- **「一件事」matter 原语** —— 微信 / 桌面 / 手机三面共用一张表,intent 路由一站消费。
- **终端会话 ↔ 微信** —— `wechat-cc hook`:终端里的 claude / codex 会话完成推送到微信、微信里 y/n 拍板、「看 码」「@码」回话。
- **社交层** —— 五层架构重构(信封 / journal / 关系 / 驱动 / 觅食台)、串门、心愿与明信片、介绍 2 跳、笔友信箱。
- **桌宠 CC** —— Phase A/B(manifest 驱动的精灵运行时 + 真实事件桥 + 权限卡)、美术 v1(Blender 角色 / 13 行为表情 / 7 道具)。
- **模型与后端统一管理** —— 提示词报模型、按对话钉模型、`provider_switch`、面板「模型与后端」。
- **陪伴与任务衔接、手机版** —— 此刻可把要求带入项目草稿，点 CC 查看正在照看的事；手机首屏保留 feed，任务详情支持权限处理、问题回答、同任务补充和成果查看。浏览器与加密通道检查通过，真人手机和 Tauri 验收待补，见[验证记录](superpowers/reports/2026-09-22-cc-companion-task-entry.md)。
- **每晚整理长期记忆(B 看得见)** 已上线（`docs/superpowers/specs/2026-09-25-memory-nightly-design.md`）—— 下一步 A:手机上逐条标不对 / 过时 / 删掉；C:第二天偶尔说一句我注意到…;09-26 界面改版:手机「CC 眼中的你」、微信信件排版、一条一件事;10-01 治「同日失忆」:CC 白天写进 profile.md 的新行由后台抄进「今天的草稿」(`today-draft.md`,600 字封顶)随 memory.md 进每次对话、每晚整理读入后清掉;桌面「重新整理」(重算 `_overview.md` 项目地图)改名「更新项目地图」,不再和微信「整理记忆」撞名

## 手机主线的逐批进展(1.7.0 发布之后)

以下保留各批次的实现与欠账。文中的分支名和「当批下一份计划」是历史交接，不表示所有条目仍在等待开发；当前路线以前面的主线、最近合并及各端 README 为准。

- **手机 app 子项目 1(协议包 + 实时通道)已完成**(2026-09-29,`packages/protocol/README.md`;设计 `docs/superpowers/specs/2026-09-29-phone-protocol-v2-design.md`)—— 子项目 2(中继升级成对外服务 + 推送发送,`apps/relay`,`docs/maintainer/relay.md`):代码完成,等上线(凭据 / 付费计划 / 域名);其后子项目 3 已按下列批次进入 dev，不能再把 Expo app 记为尚未开工。
- **手机 app 子项目 3(TendHearth app v1)后端补全:代码完成,单测/自检绿,真机待验**(2026-09-30,`app-v1` 分支;设计 `docs/superpowers/specs/2026-09-30-tendhearth-app-v1-design.md`,计划 `docs/superpowers/plans/2026-09-30-tendhearth-app-backend.md`)—— 批准说明 / 进展概括(`/m/api/matter/insight`,便宜模型 + 原文回退)、改动路由(`/m/api/matter/changes`)、推送定位与时间窗、子项目 1 三个遗留;接线在 `src/daemon/wiring/pipeline-deps.ts`。**当批下一份计划（已继续交付，见后续条目） = app 骨架与演示模式**(设计稿 `docs/design/tendhearth-app-v1/`)。
- **手机 app 子项目 3:app 骨架 + 演示模式完成**(2026-09-30,`app-skeleton` 分支;`apps/app/README.md`,计划 `docs/superpowers/plans/2026-09-30-tendhearth-app-skeleton.md`)—— Expo 原生工程 `apps/app`:此刻 / 一起做 / 进展 / 批准(模型说明时原始命令直接可见)/ 问答 / 交办 / 配对说明 / 设置,界面只认 `Backend` 接口,数据来自演示后端;iOS 模拟器(iPhone 17 Pro,iOS 26.5,development build)上 Maestro 三个演示流程(approve / compose / demo-walkthrough)通过。Android 与真机未跑。**当批下一份计划（已继续交付，见后续条目） = 真连接与配对**。
- **手机 app 子项目 3:真连接与配对完成**(2026-09-30,`app-live` 分支;计划 `docs/superpowers/plans/2026-09-30-tendhearth-app-live.md`,`apps/app/README.md`「真连接的规矩」)—— LiveBackend + 扫码配对 + 设备管理(含新增 daemon 操作 `unpair_self`);进程内端到端(`src/daemon/phone-app-live-e2e.test.ts`)+ 单测覆盖,Maestro 演示流程与无效链接流程通过;**真机配对待主人验收**。**当批下一份计划（已继续交付，见后续条目） = 原生通知**。已知取舍与欠账:(1)局域网直连(LAN-first)推迟——daemon 局域网口没有 v2 订阅;(2)离线缓存只在内存,冷启动离线 ⇒ 空列表 + 「暂时连不上」;(3)当批配对链接可重复使用的限制已由 #165 单次码取代;~~(4)相机权限文案目前只有英文,等计划 4 补 en + zh-Hans 语言文件~~(#158 已补 `locales/en.json` + `zh-Hans.json`,`plugins/app-config.test.ts` 钉住;`expo config --type introspect` 核对过);(5)提交的去重:交办与说一句按草稿给稳定的 `requestId`(同一份草稿、同样正文重发用同一个,正文改了才换)——交办 daemon 按它去重、超时后查回执;说一句对**工作台任务** daemon 按它去重(工作台输入回执,端到端测试钉住),对**微信聊天那件事** daemon 不看 `requestId`,「不确定」后重发仍可能说两遍(欠账);批准 / 回答本来就带被批准那一条的 id,重发只会得到「已处理」;进后台 / 撤销时还在飞的提交报「不确定」(撤销则报撤销),不再说「没送到」;(6)中继上线需 `agent-config.json` 的 `relay_v2_url`,未设时走老中继(`t…` id);(7)正式图标由 Codex 出稿后替换 `apps/app/assets/images/*`。**主人真机验收清单**:真 iPhone 扫桌面「手机上用」的码配对 → 此刻 / 进展 / 批准 / 交办各走一遍 → 电脑上撤销这台手机 ⇒ 显示「这台手机已不再配对」→ 关掉电脑 ⇒ 显示上次同步时间 → 设置里解除配对;配对过程中 iOS 左滑返回已锁定,也请试一下。安卓等有设备再补。
- **手机 app 子项目 3:真连接与配对完成**(2026-09-30,`app-live` 分支;计划 `docs/superpowers/plans/2026-09-30-tendhearth-app-live.md`,`apps/app/README.md`「真连接的规矩」)—— LiveBackend + 扫码配对 + 设备管理(含新增 daemon 操作 `unpair_self`);进程内端到端(`src/daemon/phone-app-live-e2e.test.ts`)+ 单测覆盖,Maestro 演示流程与无效链接流程通过;**真机配对待主人验收**。**当批下一份计划（已继续交付，见后续条目） = 原生通知**。已知取舍与欠账:(1)局域网直连(LAN-first)推迟——daemon 局域网口没有 v2 订阅;(2)离线缓存只在内存,冷启动离线 ⇒ 空列表 + 「暂时连不上」;(3)当批配对链接可重复使用的限制已由 #165 单次码取代;(4)相机权限文案目前只有英文,等计划 4 补 en + zh-Hans 语言文件;(5)提交的去重:交办与说一句按草稿给稳定的 `requestId`(同一份草稿、同样正文重发用同一个,正文改了才换)——交办 daemon 按它去重、超时后查回执;说一句对**工作台任务** daemon 按它去重(工作台输入回执,端到端测试钉住),对**微信聊天那件事**也按它去重了(2026-10-01,`say-dedupe`:回执表 `matter_say_receipts`(v70),同 id 同文重发拿回原来的回复、在跑就跟上同一轮,同 id 异文 ⇒ `input_conflict`,失败不留回执;端到端测试钉住);批准 / 回答本来就带被批准那一条的 id,重发只会得到「已处理」;进后台 / 撤销时还在飞的提交报「不确定」(撤销则报撤销),不再说「没送到」;(6)中继上线需 `agent-config.json` 的 `relay_v2_url`,未设时走老中继(`t…` id);(7)正式图标由 Codex 出稿后替换 `apps/app/assets/images/*`。**主人真机验收清单**:真 iPhone 扫桌面「手机上用」的码配对 → 此刻 / 进展 / 批准 / 交办各走一遍 → 电脑上撤销这台手机 ⇒ 显示「这台手机已不再配对」→ 关掉电脑 ⇒ 显示上次同步时间 → 设置里解除配对;配对过程中 iOS 左滑返回已锁定,也请试一下。安卓等有设备再补。
- **手机 app 子项目 3:原生通知完成**(2026-09-30,`app-push` 分支;计划 `docs/superpowers/plans/2026-09-30-tendhearth-app-push.md`,`apps/app/README.md`「推送(原生通知)」)—— 推送登记、iOS 通知服务扩展、安卓消息服务、点通知路由;Swift / Kotlin 跑协议包向量(CI `app · native push vectors`);iOS 27 启动崩溃已用 `with-ios-scene` 修掉;模拟器 simctl 验证见 apps/app/README(`simctl push` 不经过扩展,扩展在循环里是真机项)。**真投递待主人**:APNs 密钥 / Firebase / 中继上线(`relay_v2_url`)/ EAS 构建 / 安卓设备(本机没有 Android SDK,安卓未验)/ 两平台真机验收,清单见 README。计划 3 遗留仍开(微信聊天那件事的说一句不去重;配对码 10 分钟可复用已由 #165 修掉)。**当批下一份计划（已继续交付，见后续条目） = 补齐页面**。
- **手机 app:跟 CC 说话 + 真历史 + CC 的连接 + 原生会话完成**(2026-10-01,`app-chat` 分支,状态:#162 已合 dev、单测 / Maestro 绿,待主人真机;计划 `docs/superpowers/plans/2026-10-01-tendhearth-app-chat.md`,spec `docs/superpowers/specs/2026-10-01-tendhearth-app-chat-design.md`)—— 手机的主动作改为**跟 CC 说**:`/m/api/chat*` 走 companion 路径,收下即回、回复靠主题唤醒,一次一句、10 分钟超时,「可能没送到」气泡可重试 / 忽略(同 requestId,daemon 去重);主人对话置顶、访客聊天永不上手机;交办改为显式选项。连接卡语义:未知永不绿、知识库陈旧按最近同步、微信记录日期按 wxvault 解密时间;电脑上的 Claude Code / Codex 会话只读。**手机聊天 #162 与设计统一 #163 均已合入 dev**；配对体验 #165 与手机续接会话 #166 也已合入；真机验收仍保留。**主人真机验收**:从手机跟 CC 说一句(回复用到 wxvault)→ 往上翻旧对话 → 未确认气泡重试 → 连接卡各值 → 会话列表 → 输入框在真机聚焦。**延后的次要项**:说一句失败重试不比较正文;重试与别的 pending 并存、被挤出的早期重试项缺测试;matterActivity 的 dispose / 取消订阅未接 shutdown;主人聊天很久不动会掉出 200 窗口(app 经 `/m/api/chat` 钉住,无影响);`since` 时钟回拨未夹;`default_chat_id` 非 admin 时静默禁用手机聊天(应记一次日志);分页同时间戳漏项(实测 0 例);连接快照按引用返回、`generatedAt` 最多旧 10 秒、`budgetMs` 占位;会话 done-map 无软上限、会话 not-found 映射 503;演示 `chat()` 不返回 not_found / 不分页、live `chat()` 丢 `limit:0`;输入中发送成功会清掉新键入的文字、早先丢失的一句渲染在新问答之后、已加载旧页时新消息 >30 条会有缝、60 秒内同样的短句被误判已落地、`chat.yaml` 里 "2 秒" 过期注释。
- **设计统一(plan 6)**:两端同一套 token、衬线、无深色、CC 明暗来自真实信号 —— 截图与对稿记录在 `~/Documents/tendhearth/cc-screens-2026-10-01-design/`(README 列了跟稿差异);待主人定的六条 2026-10-01 已全部拍板并实施(spec §9:inkSoft `#70665d`、浮窗桌宠够得着 = Light、鱼缸画布退休 +「浮到桌面」改普通按钮、桌面「N 件事等你」写问题原文(attention 带 `first`)、字体子集化、离线红 / 连接中灰);桌面出图用例 `WECHAT_CC_DESIGN_SHOTS=<目录> bun x playwright test design-shots`(apps/desktop);spec `docs/superpowers/specs/2026-10-01-tendhearth-design-unify-design.md`。
- **手机 app:跟 CC 说话 + 真历史 + CC 的连接 + 原生会话完成**(2026-10-01,`app-chat` 分支,状态:#162 已合 dev、单测 / Maestro 绿,待主人真机;计划 `docs/superpowers/plans/2026-10-01-tendhearth-app-chat.md`,spec `docs/superpowers/specs/2026-10-01-tendhearth-app-chat-design.md`)—— 手机的主动作改为**跟 CC 说**:`/m/api/chat*` 走 companion 路径,收下即回、回复靠主题唤醒,一次一句、10 分钟超时,「可能没送到」气泡可重试 / 忽略(同 requestId,daemon 去重);主人对话置顶、访客聊天永不上手机;交办改为显式选项。连接卡语义:未知永不绿、知识库陈旧按最近同步、微信记录日期按 wxvault 解密时间;电脑上的 Claude Code / Codex 会话只读。**手机聊天 #162 与设计统一 #163 均已合入 dev**；配对体验 #165 与手机续接会话 #166 也已合入；真机验收仍保留。**主人真机验收**:从手机跟 CC 说一句(回复用到 wxvault)→ 往上翻旧对话 → 未确认气泡重试 → 连接卡各值 → 会话列表 → 输入框在真机聚焦。**延后的次要项**:~~说一句失败重试不比较正文~~;~~重试与别的 pending 并存、被挤出的早期重试项缺测试~~;~~matterActivity 的 dispose / 取消订阅未接 shutdown~~;主人聊天很久不动会掉出 200 窗口(app 经 `/m/api/chat` 钉住,无影响);~~`since` 时钟回拨未夹~~;~~`default_chat_id` 非 admin 时静默禁用手机聊天(应记一次日志)~~;分页同时间戳漏项(实测 0 例);连接快照按引用返回、`generatedAt` 最多旧 10 秒、`budgetMs` 占位;~~会话 done-map 无软上限~~、会话 not-found 映射 503;演示 `chat()` 不返回 not_found / 不分页、~~live `chat()` 丢 `limit:0`~~;~~输入中发送成功会清掉新键入的文字~~、早先丢失的一句渲染在新问答之后、已加载旧页时新消息 >30 条会有缝、60 秒内同样的短句被误判已落地、~~`chat.yaml` 里 "2 秒" 过期注释~~。**2026-10-01 清掉划线的九项**(`app-chat-minors`):同一 requestId 换正文 ⇒ 409 `input_conflict`;`wireMatterActivity` 的 stop 登记进 shutdown;节流的 `since` 夹到 ≥0;原生会话结果表软上限 64;`limit:0` 原样带给 daemon(判 400);发送成功只去掉发出去的那段前缀;`chat.yaml` 注释改成 5 秒;`default_chat_id` 那条日志与 daemon 端挤出用例其实 #162 已做 / 已有,本次只补了 app 回执的挤出用例。
- **设计统一(plan 6)**:两端同一套 token、衬线、无深色、CC 明暗来自真实信号 —— 截图与对稿记录在 `~/Documents/tendhearth/cc-screens-2026-10-01-design/`(README 列了跟稿差异与待主人定的六条);桌面出图用例 `WECHAT_CC_DESIGN_SHOTS=<目录> bun x playwright test design-shots`(apps/desktop);spec `docs/superpowers/specs/2026-10-01-tendhearth-design-unify-design.md`。
- **配对体验(plan 7a)**(2026-10-01,`pairing-ux` 分支):一个码只配一台(配上即作废、设备令牌不能再铸)、桌面「手机扫码改设置」改名「连接手机」并按需打开远程隧道(中继没开通就直说)、引导页最后一步直接给码、出码时桌面与手机确认卡显示同一个核对码(由 daemon id 派生、配对前就有,标识哪台电脑;6 位 `XXX-XXX`,人眼核对不是认证)、确认卡在会换掉现有配对时明说、中继发 AASA / assetlinks、app 声明关联域名 / App Links 且链接只到确认卡(iOS 模拟器开发 scheme 已验锚点保留)、恢复回来的配对先核对、重新配对退旧位(旧电脑离线时旧位留到主人在桌面设备列表移除,占 20 台名额)。`GET /v1/settings/link` 已由 trusted 升 admin。spec `docs/superpowers/specs/2026-10-01-tendhearth-pairing-ux-design.md`。7b 见下一条。
- **手机接着做电脑上的会话(plan 7b)**(2026-10-01,`continue-sessions` 分支):手机「电脑上的会话」读页一个「接着做」→ 确认卡(在哪台电脑、用 Claude Code / Codex、哪个文件夹、会用额度;接原会话还是带记录新开从不让人选,两者在核心里互斥;卡即「原程序已关闭」声明,因为普通终端里的 Claude Code CC 看不见)→ 成为「一起做」的一件事、进去输入框已聚焦,第一句在 daemon 里一次完成 prepare + continue(决定令牌不出 daemon,按 requestId 幂等)。接过的 ⇒「打开这件事」(幂等 POST,桌面早先导入、没有 matter 行的顺手补上);看得见在跑 ⇒ 灰字,绝不劫持。新路由 `GET|POST /m/api/session/continue`;桌面不改。spec `docs/superpowers/specs/2026-10-01-tendhearth-continue-sessions-design.md`。主人事项:
  - 真机各验一条 Claude Code / Codex(Maestro 演示流 `apps/app/.maestro/continue-session.yaml` 只覆盖演示模式)。
  - ~~要不要让「CC 能探测到它在不在跑(hook)」成为出现「接着做」的前提~~ —— 已裁决(2026-10-01,spec §7-1):不做前提,保留确认卡声明。
  - ~~额度耗尽时是否提示换另一个执行者接手~~ —— 已裁决并实施(2026-10-01,spec §7-3,`phone-quota-handoff` 分支):手机驱动的事(含接过来的会话)额度用完 ⇒ 进展页「交给 X 继续」确认卡,复用微信「交给 X 继续？」的信号(`quotaExhausted` + `fallbackExecutor`)与动作(同一文件夹新开一件),`POST /m/api/matter/handoff` 按 requestId 幂等、一件事只交一次。真机待验:让一个执行者真用完额度后从手机交一次(apps/app README 真机验收第 8 条)。
  - 已知取舍(R4):桌面早先导入、从未派发过的事,点「打开这件事」直接进任务页、不经确认卡;任务页上显示的是灰字「先让原来那个停下」之类的提示。
  - ~~已知限制:会话的 cwd 是符号链接时显示「电脑上找不到这个会话的文件夹了」~~ 已修(2026-10-01,`import-realpath` 分支):共用导入规则(`nativeProjectPath`,桌面导入与手机接着做同一处)先 realpath,任务 / matter 用真目录,来源记下原样 cwd;之后目录身份、「在用」、路径冲突、私有目录等守卫一律只看真目录(链接不带来任何额外权限);导入后链接被改指 ⇒ 第一句 invalid_path。**取舍(待主人看)**:记下的 cwd ≠ 真目录时一律只「带记录新开」、不恢复原会话 —— 原生恢复要求在原会话那个文件夹(plan 2026-09-12),Claude 的会话文件按路径写法存、换写法本来就找不到;Codex 按真目录恢复未在真机验证,保守不开。
  - 已知缺口:主人自己装了 hook 的终端 Claude Code 会话不会被判成「正在跑」(spec §7 第 2 条)。
  - 已知缺口:已经跑过的事(managed)再接着说走 `continueTask`,不重查它对应的 Codex 原生会话是不是又在终端里跑了(桌面早就如此,手机「打开这件事」也会走到;spec §7 第 4 条)。
  - 已知限制:接过来的事第一句碰到「文件夹被 CC 占着」与「会话本身在跑」都说「这个会话正在电脑上跑」(第一句的冲突判定是一个布尔值,分不开;spec D7)。

## 其他近期运行修复

- **三端会话阅读与核心体验优化**（2026-10-02，dev）—— 共用安全 Markdown 与精确原文；中文常规字体用浅底色辨识重点；聊天等待和工作台刷新保留阅读交互。两种手机入口补齐已有会话、搜索、最近窗口和同页重新检查；原生运行中补充固定轮次与提交身份，显示真实回执。完整检查、普通 iOS 模拟器示例、本机安装与执行/中继闭环已通过；额外修复保留会话自检的安全收尾。Cursor 套餐和用户原生 Codex 无效默认模型的失败证据保留；Codex 临时选择可用模型的自检通过。未记作公开发版或主人真手机已更新。策略、证据与边界见 [核心体验优化](superpowers/specs/2026-10-02-core-experience-optimization.md)。

- **内置插件回归修复**(2026-09-30,`fix-bundled-plugins`)—— 09-11 起 LaunchAgent 改拉 `.app`,打包版 daemon 一个插件都没加载(wxvault / 客户回顾 / wxsearch 全丢)且一声不吭。修法:状态目录里登记插件来源(`wechat-cc plugin source`,源码模式 `self deploy` 自动登记)、启动日志 + `/v1/health.plugins` + 部署插件门(`--allow-missing-plugins` 逃生口)。安装包仍按设计不带插件。**信任取舍**:登记的来源按内置算、默认开(放进去就跑)。**真机账**:部署后看 `[BOOT] plugin:` 与微信里一次 wxvault 调用。见 [maintainer/deploy.md「内置插件」](maintainer/deploy.md)。

## 欠的真机账(发版前该销掉)

这三周的东西**单测和 selftest 绿 ≠ 用户能用**,以下都没在真机上走过:

- ~~桌面同一个文件夹连开两件事,看等待行说的话对不对(一个文件夹一个活会话)。~~ 2026-09-28 真机核对通过:第二件 `waitingFor={reason:same_path, holderWriting:true}`、第一件独占在写(workbench service 拆分 PR 9 合入后,脚本见 PR 10 计划)。
- **手机真机(2026-10-02)**:`bun run e2e:device` 全自动覆盖配对(经深链,不经相机)、重复码、聊天、真 APNs 推送批准、撤销、收尾。仍需人手:系统相机扫码、锁屏通知文字、杀掉 app 后点通知、设置里关 / 开通知权限、iOS 备份恢复、安卓(下面 7a 清单的 3 / 5 / 7)。
- `self change --no-deploy` 走一条完整链路,确认每条运行一个 worktree 全程成立。
- 桌宠 Phase B 的权限卡闭环(微信 y/n 只认被问的那个 chat)。
- 介绍 2 跳的完整链路(需要第三台真机)。
- 社交层两台真机重新配对后的 wish / postcard 信道。
- `@码 resume` 与「脑手转发」全链(CLI hook)。
- 配对体验真机(计划 7a Task 12 Step 3),其中 iOS 备份恢复与安卓指纹是主人的:
  1. ~~部署中继 Worker~~ staging 已部署(10-01),AASA 200 `application/json` 已核;`ANDROID_CERT_SHA256` 等安卓时再设。原文:部署中继 Worker(`docs/maintainer/relay.md` §9),设 `ANDROID_CERT_SHA256`;`curl -sI https://relay-staging.tendhearth.com/.well-known/apple-app-site-association` ⇒ 200 `application/json`。
  2. ~~本机 `relay_v2_url`~~ 已设为 staging(10-01)。原文:本机 `relay_v2_url` 必须已设,桌面「连接手机」才出二维码;没设时应显示「手机连接服务还没开通」。
  3. iPhone 系统相机扫码(通用链接)⇒ 直进确认卡(主机名对、有核对码)⇒「连接」⇒ 回此刻、CC 变 Light、桌面弹层变「已连上」。
  4. (e2e:device 已自动化)同一个码再扫 ⇒「这个码已经用过或过期了…」。
  5. 安卓 App Link(设了指纹后);没设时打开网页壳属预期。
  6. 重新配对:旧位消失(旧电脑离线则旧位留着,需在桌面设备列表手动移除)。
  7. iOS 加密备份恢复到另一台 ⇒ 配对仍在、启动核验通过;电脑上撤掉后再恢复 ⇒ 回欢迎页「这台手机和电脑的配对已经失效了。」。
  8. pset 中继壳 401 → /m 404(主人事项 8)。

## 已定未做(按价值排)

- **发版节奏本身要有纪律** —— 三周不发版是这轮最大的结构性问题,不是某个功能的问题。
- 安卓凭据恢复走 Google Block Store(配对体验 7a 之后)。
- ~~iCloud 钥匙串同步(`kSecAttrSynchronizable`)~~ ⟨2026-10-01 主人定:不同步。换机重扫一次码,守住「一个码只配一台」⟩
- ~~**e2e 只在 master 相关的分支跑**~~ 口径过时:09-18 起 dev 推送动了 `apps/desktop/**` 就跑 desktop-e2e(`changes` 作业);只剩重型 `e2e` 作业按 base_ref 限 master,这是有意的成本取舍。
- ~~**自改的工作树回收缺一个显式入口** —— 现在只回收 `done`/`declined` 的运行,可 resume 的和被 kill 的永不回收(磁盘单调增长)。缺的是「这条我不接了」这个动作。~~ **2026-10-01 完成**:`wechat-cc self change --abandon <id>` 把一条记成 `abandoned`(第三种不可恢复的终局,`--resume` 拒绝)并当场删它的工作树,正在跑的那条拒绝(锁里新记了 runId);`--list` 每条标出在跑 / 被杀 / 可 --resume / 已收场 / 已作废和盘上的树路径。微信「自改」没加作废口(理由见 [maintainer/self-change.md](maintainer/self-change.md) 已知限制)。
- ~~**设备 token 进 token-registry、http 默认 loopback**(梳理第 6 步)~~ **2026-09-29 完成(#149)**:链接 / 设备令牌进内部 API 同一个注册表(origin `link` / `device` + routeAllow `PHONE_ROUTES`),按台撤销,只允局域网的操作收成 `LAN_ONLY_OPS`,`serve()` 缺省 127.0.0.1。**没做的范围 B**:`/m/api/*` 并进内部 API dispatcher。现状见 [reference/internal-api-auth.md](reference/internal-api-auth.md)。
- ~~**拆三个大文件**(梳理第 7 步)—— `core/workbench/service.ts`(1622 行闭包,按 20 份 `service-*.test.ts` 的边界抽)、`bootstrap/index.ts`(剩余 8 个关注点进 `wire-*.ts`)、`cli.ts`(按命令族下沉;`scripts/cli-ratchet.guard.test.ts` 先钉住不再增长)。~~ **2026-09-28 三件全部完成**:`cli.ts` 4332→157(#128)、`bootstrap/index.ts` 1321→460(#131)、`core/workbench/service.ts` 1965→179 行 / 内函数 68→3(PR #132–#141 + PR 10,十个域进 `service/<domain>.ts`,棘轮守卫 `scripts/workbench-service-ratchet.guard.test.ts` 只降不升;19 份旧测试一行没改)。
- **错误通道结构化**(arch backlog #4)—— 两条判定红线已定(claude 只在双哨兵上报登录过期;agy 歧义句按瞬时)。第 1 步「先采真实形状」2026-10-02 完成:[reference/provider-error-shapes.md](reference/provider-error-shapes.md)(56 条样本钉成 fixture);第 2 步「边界产码」提议见该文档 §5。**第 2 步第一片(只 Claude 会话)2026-10-02 做完**:owner 拍板 `authentication_failed` 非哨兵 ⇒ 认证失败但不说登录过期;Claude 的 API 错误不再当回复外发(码闭集 `lib/provider-error-code.ts`)。下一片:cheapEval / 工作台的 Claude 路径,然后 openai 兼容 → cursor → codex → agy。
- **错误通道结构化**(arch backlog #4)—— 2026-10-01 主人定:开工,两条红线不变(Claude 只认两个哨兵才报登录过期;agy 模糊报错按瞬时)。第 1 步「真机采集各 provider 的真实失败形状」进行中(10-02),第 2 步再改成 provider 边界产结构化 code。
- ~~**纯 JS 的锚定文件访问**(评审 #3)—— 去 ffi 之后没有 `openat`,逐级 lstat 是多个时刻的观察;两条路(写清威胁模型 + 目录替换回归测试,或 macOS/Linux 恢复原生 openat),安全边界取舍等 owner。~~ **2026-10-01 owner 选 (a)**:保留纯 JS,威胁模型写进 [reference/workbench-file-guard.md](reference/workbench-file-guard.md)(防失误与项目内路径把戏,不防并发换目录的恶意本机进程),`anchored-fs.threat-model.test.ts` 钉住;顺手修了附件落盘从深层路径开文件、`mkdirAnchored` 逐级只 lstat 叶子两个洞。
- **动态 provider 注册** —— 等 openai-compatible 这条路被外部集成者真用起来、暴露出覆盖不了的需求再做。
- **Widget / Live Activities** —— 仍属于后续体验。早期「PWA 验证 + Apple $99 才开原生」路线已被 Expo 路线取代；原生通知实现已有单独批次，待真实投递验收，不能与 Widget 一起记为未开发。
- **STT(语音入站)** —— 已通(2026-09-27 口径):网关形态,`stt-config.json` 指定 whisper 网关(`src/daemon/stt/*`),接在入站链 `mw-transcribe-voice`;未配置即关。出站语音也已通(VoxCPM2)。缺的是本地 STT 与首次配置引导。
- ~~**Developer ID 证书**~~ **2026-09-28 到手**(Nate Gu & Co LLC,Team 9Y6JAPDP7A):CI 签名 + 公证已通,1.7.1 是第一版签名包;本机 `self deploy` 也用它重签(#143/#144/#146)。**证书 2027-02-01 到期**,到期前在 Apple Developer 后台续一张、更新 `release-signing` 的 `APPLE_CERTIFICATE`(Team ID 不变,TCC 授权不掉)。
- **Windows 拿不到 Codex 工作台**(2026-09-27 口径,三份文档同此)—— 文件层已通(`anchored-fs.ts` 纯 JS,有 win32 分支)、进程树清理 `jobspawn` 已落地(codex-config / model-catalog 两条路);但 Codex 执行者本身在 win32 仍显式拒绝(`codex-app-server.ts`「尚未验证任务进程树清理」),原生历史 win32 不支持(`codex-history-rpc.ts`),Claude 保留会话的 win32 真机验收也欠。要做的是:拿掉那道拒绝前先在 Windows 真机验一遍进程树清理。

## 有意推迟 / 已否决

- ~~微信小程序(手机台阶 C)~~ ⟨2026-08-26 拍板不做:审核类目敏感 + 个人主体限制,且 PWA + 微信内置浏览器已覆盖⟩
- **陌生人匿名交换(社交第三层)** —— 产品上有意推迟;二层(匿名笔友)已完整,真机往来的瓶颈是冷启动不是协议。
- **Letta 之类外部记忆内核** —— 评估过,结论是记忆已被商品化,保留 `.md` 自建那套。
- **升 bun 1.4** —— 独立一件事,它动到 `bun:sqlite` 的迁移行为,别当顺手活。

## 修订记录

- 2026-10-02:网络守护 v2「按调用判」(主人收窄 #191:守护只回答「按约定的网络信号,CC 能不能开始一次需要保护的调用」)。每次调用按真正连到的端点 + 模型分类(`lib/call-classifier.ts`):Anthropic / OpenAI / Google / OpenRouter 与 Cursor+Claude/GPT/o/Gemini 默认保护;国内平台、自建、Cursor auto/composer、自定义网关(含 `ANTHROPIC_BASE_URL` 指到别处)默认不保护;Kimi 国际版按 host 判成保护;不认识的 Cursor 模型默认保护;guard.json 新增 `signal_source` / `protect` / `trust` / `protect_custom_gateways`(老三项兼容)。信号:装了 bx 只认 bx(不回落 Google,除非 `signal_source: "probe"`);没装用 daemon 自己的探测,修掉初始 `reachable: true` 的 fail-open(无结果先有界等待再按失败算)。只拒需要保护的那一次:协调器多人模式只拿掉被挡的参与者,cheapEval 逐候选跳过,不需要保护的照常;入站 `mw-guard` 删除(y/n、取消、换模型、/set 照常);probe 来源停在跑执行者、翻不安全时关会话都只针对需要保护的。`/v1/health.guard` 加 `providers` / `protected_in_use` / `paused`,桌面一行三态,`guard status` 列分类。见 `reference/network-guard.md`。

- 2026-10-02:网络守护改为 bx 优先并覆盖所有模型入口(主人拍板:直连供应商可能封号)。装了 bx 以 `bx status --json` 的 `protection_state=protected` 且 `tunnel_healthy` 为准,读不出即不安全;没装保持 ipify+探测。拦截点:协调器每轮、provider registry(spawn/cheapEval/strongEval/modelCatalog)、SessionManager、delegate、工作台起步/补充/额度查询、终端会话 resume、语音;已在跑的工作台执行者:bx 来源不停(fail-closed),probe 来源连续两次不安全才停;后台 tick 与每晚记忆安静跳过。`/v1/health.guard` + 桌面此刻页一行。见 `reference/network-guard.md`。
- 2026-10-02:错误通道结构化(#4)第 2 步第一片(只 Claude 会话)。owner 拍板:Claude 的 API 错误不许当回复发出去;SDK 标了 `authentication_failed` 而双哨兵没中 ⇒ 仍算认证失败,但文案说「认证没通过(API 返回 401/403),请检查账号或密钥」,「登录过期」只留给两句哨兵(红线 A 细化);红线 B 不动。实现:Claude provider 读 SDK 助理消息的 `error` 标注与结果的 `api_error_status`,产 `auth_rejected` / `network` / `server_error` / `rate_limited` / `quota` / `invalid_request` / `provider_error`(哨兵仍是 `auth_failed`),回合不再 `completed`、fallback 不再外发原文(修掉 07-28 那句 403);码沿 `TurnRecord.errorCode` 进 health,health/classify 有码只看码。其余 provider 与 Claude 的一次性评估 / 工作台路径没动。详见 [reference/provider-error-shapes.md](reference/provider-error-shapes.md) §4.1、§6。
- 2026-10-02:错误通道结构化(#4)第 1 步 —— 采集真机日志 + 沙箱诱发(临时 HOME、假 key、拒连 / 黑洞地址,主人凭据零接触;agy 无法隔离只采集),56 条真实失败样本进 `src/daemon/diagnostics/__fixtures__/provider-errors/`,测试钉住今天全部判定处的答案(不改判定)。最大的发现:claude 会话路径的 API 错误(401 / 拒连 / 超时)是正文 text 事件,会被 fallback 原样发给主人(真机 2026-07-28 发生过),而 SDK 本来给了 `error: authentication_failed` 等结构;cursor 的 `acp_auth_required` 没有下游认;codex 与 openai 兼容在断网时没有超时、只有沉默。详见 [reference/provider-error-shapes.md](reference/provider-error-shapes.md)。
- 2026-10-02:现状改 1.7.2;主线补 staging 中继 + `e2e:device` 全绿;手机真机账按自动化覆盖重排;iCloud 同步(不同步)、e2e 口径、错误通道第 1 步入账。
- 2026-10-02:1.7.2 发版(版本号 + `docs/releases/desktop-v1.7.2.md`);发版前在真 iPhone 上 `bun run e2e:device` 全绿(daemon 029582ee、staging 中继)。
- 2026-10-01:手机 app 真机全自动验收 `bun run e2e:device`(XCUITest + devicectl,对着在跑的 daemon 与 staging 中继 v2):配对 / 同码重用被拒 / 跟 CC 说 / 真 APNs 横幅点开批准 / 撤销 / 收尾放回原配对,在 iPhone SE(iOS 27.0.1)上全过;顺手修了三处:推送 token 监听自激成每 0.6 秒一次登记的重试风暴、已配对的手机从系统链接进配对页点返回落到欢迎页、同一部手机两个设备位都登记推送 ⇒ 重复且解不开的通知(daemon 侧,待部署)。
- 2026-10-01:中继 v2「按 IP 限连接尝试」改在 Worker 内做(Workers Rate Limiting 绑定 `IP_LIMIT`,60 次 / 10 秒,只管 `/v2/`):Free 计划的唯一一条 WAF 限速规则已给 dl.tendhearth.com;relay.md 补「首次部署前先开 Analytics Engine(否则 10089)」。
- 2026-10-01:设计统一 §9 六条主人拍板入账(inkSoft、浮窗桌宠明暗、鱼缸画布退休、等你的事写原文、字体子集化、离线点红)。
- 2026-10-01:plan 7b 主人事项两条落定 —— hook 不做「接着做」的前提(spec §7-1);额度用完从手机交给另一位继续已实施(spec §7-3)。
- 2026-10-01(晚):评审 #3「纯 JS 的锚定文件访问」划掉 —— owner 选保留纯 JS + 写清威胁模型(`reference/workbench-file-guard.md`)+ 回归测试;范围内修了两个洞(附件落盘复核不到中间几级、`mkdirAnchored` 穿过被换掉的上一级),加固了锚点 `..` 与 win32 的 ADS / 尾点别名。
- 2026-10-01:每晚整理记忆两项 owner 拍板落地 —— 「今天的草稿」治同日失忆(spec 2026-09-25 §1),桌面按钮改名「更新项目地图」。
- 2026-10-01:「跟 CC 说话」延后次要项清掉九项(含两项其实已做只补划线 / 用例),相机权限双语文案确认 #158 已交付。
- 2026-10-01:手机对微信聊天那件事「说一句」按 `requestId` 去重(v70 `matter_say_receipts`),子项目 3 欠账 (5) 收掉。
- 2026-10-01:7b 已知限制「cwd 是符号链接 ⇒ 找不到文件夹」修掉(共用导入规则先 realpath,经链接的只带记录新开)。
- 2026-10-01:加入项目组合与方向演变入口；把手机主线从 1.7.0 发布清单中分出，更新已过期的等待顺序与 Widget / 通知边界。
- 2026-10-01:「自改的工作树回收缺一个显式入口」完成(`self change --abandon <id>` + `--list` 标出可回收的树)。

- 2026-09-30:内置插件回归(09-11 → 09-30)修复入账,含「登记的来源按内置默认开」的信任口径。
- 2026-09-29:1.7.1 已发(第一版 Developer ID 签名 + 公证包);第 6 步设备令牌进 token-registry 完成(#149),梳理七步全部落地;Developer ID 条目改成「到手,2027-02-01 到期」。

- 2026-09-27(晚):1.7.0 已发,现状表与下一步改写;发版链五个坑与「全自动发版」入账;⑥⑦ 四份设计稿入下一步。
- 2026-09-28:第 7 步「拆三个大文件」三件全部完成(cli #128、bootstrap #131、workbench service PR #132–#141 + 收尾);真机账「一个文件夹连开两件事」核对通过;hookTimeout 抬到 40s(#133);Codex 第一批 #129 合入。第 6 步(设备令牌进 token-registry)仍是「已定未做」。
- 2026-09-27:现状表改成「命令 + 当日值」;#117 已合、tag 已推;STT 口径定为已做(网关形态);第 6/7 步(设备 token、拆大文件)入「已定未做」;发版链接改指 maintainer/release.md。
- 2026-09-22 v1:首份现行 roadmap。此前五个月的方向只活在 PR 描述和对话记忆里,文档侧唯一叫 roadmap 的是 4 月的 RFC 02。
