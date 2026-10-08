# Tendhearth CC 现行 roadmap

> 2026-10-08 状态核对 · **这份只说「往哪走 / 卡在哪」。**
> 「定了什么 / 为什么这样定」在 [全景导图](全景导图.md);「某件事的文档在哪」在 [文档索引](INDEX.md);
> `docs/rfc/02-post-v1.1-roadmap.md` 是 2026-04 的历史版本(v1.2 时代),已被本文取代。

项目组合与 4 月以来的演变见[项目总览](project-overview.md)。

命名已统一为 **Tendhearth CC**，角色称呼为 **CC**；技术兼容边界见[产品命名规范](reference/product-naming.md)。手机端的实现、真机验收和商店发布是不同交付状态，以 [apps/app](../apps/app/README.md) 及各批验证记录为准。

## 现状:最新公开版本 1.7.5

| 事实 | 怎么看(别写死数字,每次改这页先跑) |
|---|---|
| 最近一次**公开**发版 | `gh release list --limit 1`(2026-10-05:`desktop-v1.7.5`;[发版说明](releases/desktop-v1.7.5.md);1.7.1 起 macOS 包都是 Developer ID 签名 + 公证) |
| 自动更新源 | `curl -s https://dl.tendhearth.com/wechat-cc/latest.json \| grep version`(2026-10-05:1.7.5,与 GitHub 一致) |
| `dev` 领先 master | `git rev-list --count origin/master..origin/dev`(簿记合并之后是真实差值) |

1.7.0 是发版链 09-03 改造后第一次真跑,一路踩到五个「加进去后没在真 tag 上跑过」的坑,全部修在 dev 并有守卫/手册条目:dev→master 簿记合并(#121)、e2e 作业装浏览器(#122)、sd.cpp 子模块(#119)、公证变量空串(#123)、R2 令牌失效还报绿(#125)。**发版从此全自动**:合 PR、打 tag、两道 `release-signing` 审批(助手用主人 gh 凭据经 API)、Publish、核对更新源,主人不用点;细则 [maintainer/release.md](maintainer/release.md)。

版本号已统一(2026-09-22):此前四处各说各话(发版认 `tauri.conf.json` 的 1.6.6、`--version` 报根 `package.json` 的 0.6.4、`apps/desktop/package.json` 写 0.5.18、ACP 的 clientInfo 还硬编码 `'0.6.4'`),此后四处 + `Cargo.toml` 随发版保持同号(当前 **1.7.5**),由 `scripts/version-consistency.guard.test.ts` 钉住;`--version` 同时带构建的 git 短 sha(`1.7.0 (a1b2c3d)`),否则 `self deploy` 的健康门打出来的数字两次发版之间永远一样、看不出新构建起没起来。发版说明:`docs/releases/desktop-v1.7.0.md`。

**⇒ 发版节奏的教训:三周不发、发版链改了不真跑,代价是一天修五个坑。** 之后每合一批就发一版 patch。

## 命名统一的交付与验收

产品命名口径为 **Tendhearth CC**，对话称 **CC**；后续界面与商店素材继续按[产品命名规范](reference/product-naming.md)核对。技术兼容标识按该规范保留。

- **1.7.4 已发**：桌面程序坞、菜单、关于、窗口、通知和权限说明统一显示名，LaunchAgent 增加 `AssociatedBundleIdentifiers`。这批只动显示层。
- **1.7.5 已发**：macOS 安装包、主进程和 sidecar 改名为 `Tendhearth CC.app` / `Tendhearth CC` / `tendhearth-cc-cli`；老安装原地更新后首次启动改名，修复 LaunchAgent、终端 hook 与稳定 CLI 入口。R2 对象名、bundle ID、状态目录、LaunchAgent label 与 `wechat-cc` 命令保留；Windows / Linux 安装标识保留。实现、回滚与升级边界见[改名迁移手册](maintainer/app-rename-migration.md)，发布内容见[1.7.5 发版说明](releases/desktop-v1.7.5.md)。

公开发版不代表升级清单每项已在主人机器核销：1.7.4 → 1.7.5 的系统授权、固定入口、终端 hook 与下一次更新仍按[真机清单](maintainer/app-rename-migration.md#首次真实更新-174--175-的真机验证清单主人的-mac)逐项核对。

## 当前主线与验收顺序(2026-10-05 核对)

**已记录的 iPhone 闭环(10-01 / 10-02)**:中继 v2 staging(`relay-staging.tendhearth.com`)上线并配好 APNs,本机 daemon 已切过去;真 iPhone 全自动验收 `bun run e2e:device`(XCUITest,见 [apps/app](../apps/app/README.md))配对 / 重复码 / 聊天 / 真推送批准 / 撤销 / 收尾通过。该记录证明当时的 daemon、staging 中继与验收构建；后续原生改动和普通发布包另验。下一步:要出 TestFlight 时上中继生产(主人在 `relay-production` 环境批准一次)+ 开 `RELAY_WATCH`;商店与安卓按主人 10-01 的话往后放。


1. **收口当前手机主线。** 协议、中继、Expo 骨架、真连接、原生通知、手机聊天与设计统一已按各批次进入 dev；#165 配对体验与 #166 手机续接原生会话也已合入 dev，#167 补充了发送拒绝的诚实提示。实现状态与验收边界见下一节和 [apps/app](../apps/app/README.md)。未合入的工作不作为 dev 的已交付能力。
2. **完成用户能实际走通的验收。** 真机配对 → 与 CC 聊天 / 交办 → 查看进展 → 点真实通知 → 在上下文中批准 → 电脑实际执行；覆盖断网、撤销与重复提交。模拟器、进程内端到端和解密向量分别证明各自范围，不代替这条闭环。
3. **再按原有发布流程交付。** TestFlight 先完成生产中继、APNs 配置与 `RELAY_WATCH`，再构建提交；商店与安卓后置。既有桌面真机欠账继续保留，Widget / Live Activities 与跨宿主 agent 协调另排。

前一轮已收口：#117、1.7.0 / 1.7.1 发版、Codex 第一批 #129、大文件拆分、设备令牌归入 token-registry。旧的「等第一批 / 拆分后再做」顺序不再是当前主线。

## 定位(2026-10-07 主人定)

CC 要取代的是 **Paseo / Orca 这一层**(agent 之上的编排 + 多端),不取代 Codex / Claude Code 这些 agent 本身。据此的优先级:
① 并行独立工作区 —— **已做**,三端齐(#253–#256、#261、#263–#267,见下);② 能接的 agent 更多 —— **已做**通用 ACP 槽位(#257–#259);
③ 多端真正到手(TestFlight / 安卓 / Windows 工作台)—— 卡主人凭据与 win-test 真机;④ 语音先靠系统听写。终端 / 编辑器 / PR 管理继续不做。

**10-08 当前验收批次**：[PR 262](https://github.com/tendhearth/wechat-cc/pull/262) 补齐新 Git 任务默认独立副本、确认整段会话关闭后的逐文件原始字节撤回和完整补丁导出。模块与跨模块独立评审通过；实际 HTTP、磁盘 SQLite 重开、并行和交接、补丁应用已验证。全套检查、准确提交的 Windows CI、本机安装及真实执行者仍在收尾，以[交接记录](handoffs/2026-10-05-cc-isolation-and-next-tasks.md)为准。新 UUID 副本归档仍保留副本及关闭会话的恢复记录，不自动清理、不直接合回、不沿用 `.worktreeinclude`；旧登记工作区的归档清理继续保留（干净才删除目录，分支保留；脏树或占用时保留并记时间线）。这批不当作公开版本交付；Qwen 等 API 模型的命令、项目修改、网页工具和 MCP，以及浏览器操作，继续排在后续批次。

## dev 上等 1.7.6 的(2026-10-06 核对,均已合 dev 并 `self deploy` 到主人机器)

桌面界面与 iPhone app 的改动要随 **1.7.6 发版 / 装新包**才到用户手里(`self deploy` 只换 sidecar);daemon 侧已在主人机器上跑。发版待主人点头。

- **桌面**:此刻 / 一起做层级(#225、#227);此刻里拖图 / 贴图 / 拖文档进对话(#229、#234);WKWebView 静默失败四处修复 —— 弹窗、外链、下载、拖放(#230);搜对话(#235);一起做任务回复了 / 停下了弹系统通知(#245);「改动」面板逐文件撤销(#246);「没确认退出」按进程组判退出 + 旧记录「我确认它已经结束」(#228、#242)。
- **iPhone app**(装新包才有):发图(#232)、停一轮(#233)、搜对话(#235)、看成果(#236)、补一句带图(#237)、交办选模型(#238)、「CC 记得你」与逐条纠错(#239、#240)、打开 CC 回复里的文件(#241)、换「跟 CC 说」的后端 / 模型(#244)。
- **10-07 追加**:「CC 现在怎么样」能力总览(#252);独立工作区 —— 同一项目并行做几件事,交办勾选 / 侧栏归源项目 / 提交到分支 / 删除工作区,手机与微信入口,真机跑通(#253–#256);交办选项也列桌面新加的项目(#255);自定义 ACP 执行者 `wechat-cc cli acp add`(#257–#259);桌面任务回复 / 停下通知(#245)、逐文件撤销(#246)、收起成果后跟随新回复(#249);微信「任务 <码> 改动」(#248);文本回退留痕 ERROR_FALLBACK(#250,10-09 前后看日志决定删不删回退)。
- **10-08 追加(独立工作区补全)**:手机「提交到分支 / 删除工作区」(#261);「合回项目」只快进,别的情况交给主人,v75 记已合回(#263;Windows 上读系统 git 配置,否则 autocrlf 让项目全被当成有改动);`.worktreeinclude` 把被忽略的 `.env` 之类带进新工作区(#264);「另做一份」—— 同样的要求交给另一位执行者在另一个独立工作区里并行,做完挑好的合回(桌面 #265、手机 #266);微信「任务 <码> 提交 / 合回 / 删除工作区」,以前这三句会被当成补充发给执行者(#267);旧登记工作区归档时按干净状态收拾目录,分支保留(#269)。这些旧工作区入口已上线；新 UUID 副本的默认位置、关闭后撤回及完整导出仍以 PR 262 验收批次为准。
- **daemon / 打包**:打包版 JS 向量化真能用 —— onnxruntime 走 externalBin 并排装,`wechat-cc selftest embed` 核对(#243);`self deploy` 顺带装这两个库。

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
- **每晚整理长期记忆(B 看得见)** 已上线（`docs/superpowers/specs/2026-09-25-memory-nightly-design.md`）—— A 已做:手机网页与 iPhone 上逐条标记错了 / 过时了 / 不用记(#239、#240)；C:第二天偶尔说一句我注意到…;09-26 界面改版:手机「CC 眼中的你」、微信信件排版、一条一件事;10-01 治「同日失忆」:CC 白天写进 profile.md 的新行由后台抄进「今天的草稿」(`today-draft.md`,600 字封顶)随 memory.md 进每次对话、每晚整理读入后清掉;桌面「重新整理」(重算 `_overview.md` 项目地图)改名「更新项目地图」,不再和微信「整理记忆」撞名

## 手机主线：已实现与仍待验收

各批次计划保留设计和实施依据；这里合并重复进展，只列当前状态。原生工程在 [apps/app](../apps/app/README.md)，浏览器/PWA 在 [apps/mobile](../apps/mobile/README.md)。

- **协议与中继**：手机协议 v2 / `packages/protocol` 已完成；官方中继 v2 与推送发送已实现，staging 已上线、配好 APNs，本机 daemon 已设 `relay_v2_url`。生产上线步骤见[中继手册](maintainer/relay.md#8-上线前后必读--go-live-notes)。
- **原生 app 后端、骨架、真连接与通知**：批准说明、进展概括、改动路由、Expo 演示后端、LiveBackend、设备管理、iOS 通知服务扩展与安卓消息服务已进入 dev。单测、进程内端到端、模拟器与 Swift / Kotlin 向量各覆盖自己的范围；iPhone 真实配对与 APNs 批准闭环已有上节记录，安卓尚未验。实施依据见 [app 后端](superpowers/plans/2026-09-30-tendhearth-app-backend.md)、[骨架](superpowers/plans/2026-09-30-tendhearth-app-skeleton.md)、[真连接](superpowers/plans/2026-09-30-tendhearth-app-live.md)、[通知](superpowers/plans/2026-09-30-tendhearth-app-push.md)。
- **手机聊天与两端设计**：#162 聊天、#163 设计统一、#165 配对体验、#166 会话续接、#167 发送拒绝提示已合入 dev。主动作是跟 CC 说，交办为显式选项；连接卡未知不显示绿，原生会话可读和续接。10-01 的两端设计决定与对稿记录见[设计 spec](superpowers/specs/2026-10-01-tendhearth-design-unify-design.md)；桌面字体后续已随 1.7.5 更新。聊天、连接卡、wxvault、旧历史、键盘和会话续接的完整真机清单见 [app README](../apps/app/README.md#跟-cc-说话计划2026-10-01的状态与真机验收)。
- **已收掉的旧欠账**：微信聊天那件事的说一句已按 `requestId` 去重(`matter_say_receipts`，同 id 同文重发取原回执，异文返回 `input_conflict`)；#165 配对码只配一台；#158 相机权限有 en / zh-Hans 两份。10-01 还收掉聊天九项延后缺口：正文冲突检查、被挤出回执用例、shutdown 取消订阅、时钟回拨夹值、非 admin 配置日志、会话结果表上限、`limit:0` 传递、发送成功保留新稿、Maestro 注释；细节保留在本文修订记录。
- **现有取舍**：原生 app 只走中继，LAN-first 推迟；普通未提交草稿与离线列表缓存只在内存，持久恢复只覆盖已保存的补充提交，见 [app README](../apps/app/README.md)。
- **聊天次要缺口仍保留**：同时间戳分页；连接快照的引用、最多旧 10 秒的 `generatedAt` 与占位 `budgetMs`；原生会话 not-found 映射 503；演示后端不返回 not-found / 不分页；早期丢失消息的排列、已载入旧页后新增超过 30 条的缝隙、60 秒内同样短句的落地判断。它们与后面的真机验收、生产发布分开记录。

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

- **恢复、额度与模型失败补齐**（2026-10-03，dev）—— 原生保存不可变提交与只读单回执，退出后先查询、未知结果不自动重发；桌面 / PWA 补额度接手的确认与同身份重试；具体 Codex 模型拒绝能进入当前任务模型设置。源码、生产浏览器与普通原生包恢复分别验收，本机签名安装已完成；同期更新中断、Cursor 套餐限制及手机自检的进程关闭未确认单列，未记作公开发版或真手机已更新。对照、证明及边界见 [恢复与模型失败验收](superpowers/specs/2026-10-03-recovery-and-competitor-comparison.md)。

- **三端会话阅读与核心体验优化**（2026-10-02，dev）—— 共用安全 Markdown 与精确原文；中文常规字体用浅底色辨识重点；聊天等待和工作台刷新保留阅读交互。两种手机入口补齐已有会话、搜索、最近窗口和同页重新检查；原生运行中补充固定轮次与提交身份，显示真实回执。完整检查、普通 iOS 模拟器示例、本机安装与执行/中继闭环已通过；额外修复保留会话自检的安全收尾。Cursor 套餐和用户原生 Codex 无效默认模型的失败证据保留；Codex 临时选择可用模型的自检通过。未记作公开发版或主人真手机已更新。策略、证据与边界见 [核心体验优化](superpowers/specs/2026-10-02-core-experience-optimization.md)。

- **内置插件回归修复**(2026-09-30,`fix-bundled-plugins`)—— 09-11 起 LaunchAgent 改拉 `.app`,打包版 daemon 一个插件都没加载(wxvault / 客户回顾 / wxsearch 全丢)且一声不吭。修法:状态目录里登记插件来源(`wechat-cc plugin source`,源码模式 `self deploy` 自动登记)、启动日志 + `/v1/health.plugins` + 部署插件门(`--allow-missing-plugins` 逃生口)。安装包仍按设计不带插件。**信任取舍**:登记的来源按内置算、默认开(放进去就跑)。**真机账**:部署后看 `[BOOT] plugin:` 与微信里一次 wxvault 调用。见 [maintainer/deploy.md「内置插件」](maintainer/deploy.md)。

## 欠的真机账(发版前该销掉)

以下只列尚待补齐的验收或已完成的对照记录。**单测和 selftest 通过不代替对应的用户旅程**；10-01 / 10-02 的 iPhone 自动化范围已单列，后续原生版本不能沿用旧记录宣称全验完。

- ~~桌面同一个文件夹连开两件事,看等待行说的话对不对(一个文件夹一个活会话)。~~ 2026-09-28 真机核对通过:第二件 `waitingFor={reason:same_path, holderWriting:true}`、第一件独占在写(workbench service 拆分 PR 9 合入后,脚本见 PR 10 计划)。
- **手机真机(2026-10-02)**:`bun run e2e:device` 全自动覆盖配对(经深链,不经相机)、重复码、聊天、真 APNs 推送批准、撤销、收尾。仍需人手:系统相机扫码、锁屏通知文字、杀掉 app 后点通知、设置里关 / 开通知权限、iOS 备份恢复、安卓(下面 7a 清单的 3 / 5 / 7)。
- `self change --no-deploy` 走一条完整链路,确认每条运行一个 worktree 全程成立。
- 桌宠 Phase B 的权限卡闭环(微信 y/n 只认被问的那个 chat)。
- 介绍 2 跳的完整链路(需要第三台真机)。
- 回复的附件与过程(2026-10-04):Tauri 包里「在访达中显示」、手机新 development build 上放语音(静音键开着也要出声)、经中继的长语音 413 提示。
- 社交层两台真机重新配对后的 wish / postcard 信道。
- `@码 resume` 与「脑手转发」全链(CLI hook)。
- 配对体验真机(计划 7a Task 12 Step 3),其中 iOS 备份恢复与安卓指纹是主人的:
  1. staging Worker 与 AASA 已部署核对(10-01，200 `application/json`)；生产 Worker 按[中继手册](maintainer/relay.md)另验，`ANDROID_CERT_SHA256` 等安卓时再设。
  2. 本机 `relay_v2_url` 已设为 staging(10-01)；未开通的安装应显示「手机连接服务还没开通」。
  3. iPhone 系统相机扫码(通用链接)⇒ 直进确认卡(主机名对、有核对码)⇒「连接」⇒ 回此刻、CC 变 Light、桌面弹层变「已连上」。
  4. (e2e:device 已自动化)同一个码再扫 ⇒「这个码已经用过或过期了…」。
  5. 安卓 App Link(设了指纹后);没设时打开网页壳属预期。
  6. 重新配对:旧位消失(旧电脑离线则旧位留着,需在桌面设备列表手动移除)。
  7. iOS 加密备份恢复到另一台 ⇒ 配对仍在、启动核验通过;电脑上撤掉后再恢复 ⇒ 回欢迎页「这台手机和电脑的配对已经失效了。」。
  8. pset 中继壳 401 → /m 404(主人事项 8)。

## 已定未做(按价值排)

- **持续执行发版节奏** —— 09-27 后已恢复公开 patch 发版，当前到 1.7.5；每批整合、验收后按[发版手册](maintainer/release.md)交付。09 月积压三周的教训保留在上文，不能再当作当前停发状态。
- 安卓凭据恢复走 Google Block Store(配对体验 7a 之后)。
- ~~iCloud 钥匙串同步(`kSecAttrSynchronizable`)~~ ⟨2026-10-01 主人定:不同步。换机重扫一次码,守住「一个码只配一台」⟩
- ~~**e2e 只在 master 相关的分支跑**~~ 口径过时:09-18 起 dev 推送动了 `apps/desktop/**` 就跑 desktop-e2e(`changes` 作业);只剩重型 `e2e` 作业按 base_ref 限 master,这是有意的成本取舍。
- ~~**自改的工作树回收缺一个显式入口** —— 现在只回收 `done`/`declined` 的运行,可 resume 的和被 kill 的永不回收(磁盘单调增长)。缺的是「这条我不接了」这个动作。~~ **2026-10-01 完成**:`wechat-cc self change --abandon <id>` 把一条记成 `abandoned`(第三种不可恢复的终局,`--resume` 拒绝)并当场删它的工作树,正在跑的那条拒绝(锁里新记了 runId);`--list` 每条标出在跑 / 被杀 / 可 --resume / 已收场 / 已作废和盘上的树路径。微信「自改」没加作废口(理由见 [maintainer/self-change.md](maintainer/self-change.md) 已知限制)。
- ~~**设备 token 进 token-registry、http 默认 loopback**(梳理第 6 步)~~ **2026-09-29 完成(#149)**:链接 / 设备令牌进内部 API 同一个注册表(origin `link` / `device` + routeAllow `PHONE_ROUTES`),按台撤销,只允局域网的操作收成 `LAN_ONLY_OPS`,`serve()` 缺省 127.0.0.1。**没做的范围 B**:`/m/api/*` 并进内部 API dispatcher。现状见 [reference/internal-api-auth.md](reference/internal-api-auth.md)。
- ~~**拆三个大文件**(梳理第 7 步)—— `core/workbench/service.ts`(1622 行闭包,按 20 份 `service-*.test.ts` 的边界抽)、`bootstrap/index.ts`(剩余 8 个关注点进 `wire-*.ts`)、`cli.ts`(按命令族下沉;`scripts/cli-ratchet.guard.test.ts` 先钉住不再增长)。~~ **2026-09-28 三件全部完成**:`cli.ts` 4332→157(#128)、`bootstrap/index.ts` 1321→460(#131)、`core/workbench/service.ts` 1965→179 行 / 内函数 68→3(PR #132–#141 + PR 10,十个域进 `service/<domain>.ts`,棘轮守卫 `scripts/workbench-service-ratchet.guard.test.ts` 只降不升;19 份旧测试一行没改)。
- **错误通道结构化**(arch backlog #4)—— 2026-10-01 主人定开工,两条红线不变(Claude 只在双哨兵上报「登录过期」;agy 歧义句按瞬时)。第 1 步「采真实形状」2026-10-02 完成([reference/provider-error-shapes.md](reference/provider-error-shapes.md),56 条样本钉成 fixture);**第 2 步「边界产码」2026-10-02 做完**:第一片 Claude 会话(#190),余下部分(主人当天批准)codex / openai 兼容(含工作台 API 与 gemini)/ cursor(ACP + print)/ agy / Claude 一次性评估与工作台运行时都在边界产 `lib/provider-error-code.ts` 的码,下游(health 通知、cheapEval 冷却、桌面「测试连接」、微信回话、工作台任务失败)只读码;codex 与 openai 兼容有了边界超时,断网不再沉默。剩下的:真机跑一段确认码覆盖够了,再删文本回退(`AUTH_FAIL_SDK_ERROR` 宽集、`looksLikeAuthFailure`);Cursor ACP 上 `-32603` 的假 key / 死代理有意不区分;要不要压 Claude 的默认重试(假 key 约 90s 才出错)另议。见该文档 §7。
- ~~**纯 JS 的锚定文件访问**(评审 #3)—— 去 ffi 之后没有 `openat`,逐级 lstat 是多个时刻的观察;两条路(写清威胁模型 + 目录替换回归测试,或 macOS/Linux 恢复原生 openat),安全边界取舍等 owner。~~ **2026-10-01 owner 选 (a)**:保留纯 JS,威胁模型写进 [reference/workbench-file-guard.md](reference/workbench-file-guard.md)(防失误与项目内路径把戏,不防并发换目录的恶意本机进程),`anchored-fs.threat-model.test.ts` 钉住;顺手修了附件落盘从深层路径开文件、`mkdirAnchored` 逐级只 lstat 叶子两个洞。
- **动态 provider 注册** —— 等 openai-compatible 这条路被外部集成者真用起来、暴露出覆盖不了的需求再做。
- **Widget / Live Activities** —— 仍属于后续体验。早期「PWA 验证 + Apple $99 才开原生」路线已被 Expo 路线取代；原生通知已实现且 iPhone staging APNs 有真实投递记录；普通发布包与安卓另验，不能与 Widget 一起记为未开发。
- **STT(语音入站)** —— 已通(2026-09-27 口径):网关形态,`stt-config.json` 指定 whisper 网关(`src/daemon/stt/*`),接在入站链 `mw-transcribe-voice`;未配置即关。出站语音也已通(VoxCPM2)。缺的是本地 STT 与首次配置引导。
- ~~**Developer ID 证书**~~ **2026-09-28 到手**(Nate Gu & Co LLC,Team 9Y6JAPDP7A):CI 签名 + 公证已通,1.7.1 是第一版签名包;本机 `self deploy` 也用它重签(#143/#144/#146)。**证书 2027-02-01 到期**,到期前在 Apple Developer 后台续一张、更新 `release-signing` 的 `APPLE_CERTIFICATE`(Team ID 不变,TCC 授权不掉)。
- **Windows 拿不到 Codex 工作台**(2026-09-27 口径,三份文档同此)—— 文件层已通(`anchored-fs.ts` 纯 JS,有 win32 分支)、进程树清理 `jobspawn` 已落地(codex-config / model-catalog 两条路);但 Codex 执行者本身在 win32 仍显式拒绝(`codex-app-server.ts`「尚未验证任务进程树清理」),原生历史 win32 不支持(`codex-history-rpc.ts`),Claude 保留会话的 win32 真机验收也欠。要做的是:拿掉那道拒绝前先在 Windows 真机验一遍进程树清理。

## 有意推迟 / 已否决

- ~~微信小程序(手机台阶 C)~~ ⟨2026-08-26 拍板不做:审核类目敏感 + 个人主体限制,且 PWA + 微信内置浏览器已覆盖⟩
- **陌生人匿名交换(社交第三层)** —— 产品上有意推迟;二层(匿名笔友)已完整,真机往来的瓶颈是冷启动不是协议。
- **Letta 之类外部记忆内核** —— 评估过,结论是记忆已被商品化,保留 `.md` 自建那套。
- **升 bun 1.4** —— 独立一件事,它动到 `bun:sqlite` 的迁移行为,别当顺手活。

## 修订记录

以下是各批当时的证据与取舍，当前默认值和下一步以上文及权威手册为准。

- 2026-10-05:同步 GitHub / updater 1.7.5、macOS 改名已发布状态；合并重复手机进展，移出已修欠账，分开既有 iPhone 自动化、待补真机项与 TestFlight 生产条件。
- 2026-10-05:1.7.5 发版(版本号 + `docs/releases/desktop-v1.7.5.md`):macOS 改名 Tendhearth CC.app + 进程名、桌面字体、产物预览。
- 2026-10-04:1.7.4 发版(版本号 + `docs/releases/desktop-v1.7.4.md`):桌面显示名 Tendhearth CC、重启通知按证据、后台不再触发「访问其他 App 数据」、桌面麦克风权限。
- 2026-10-04:桌面显示名改为 Tendhearth CC(1.7.4,只动显示层,见「命名统一的交付与验收」);`.app` 改名、dmg 卷名、进程名记为 1.7.5 迁移。

- 2026-10-04:1.7.3 发版(版本号 + `docs/releases/desktop-v1.7.3.md`):回复交付五家全 daemon、网络守护 v2 + 暂停、报错结构化、CLI 自动升级、send-route 收紧、app 显示附件与过程。
- 2026-10-04:桌面与手机显示整个回复对象(附件 + 过程)。五家都走 daemon 交付之后,app 那一轮的接收器早就收到了语音 / 表情 / 文件与旁白,但两个 app 都只画文字。现在:daemon 新 `src/daemon/app-reply.ts` 把附件投成 app 形状(语音 `{text}`;表情 `{label, file?}` —— 本地表情解析一次、记下表情库文件名,联网表情只写情绪,daemon 不替 app 去外网取图;文件 `{name, path}`),随回复那一行落库(迁移 v72 `messages.extras`,可空 JSON;放在回复行上而不是另起几行,线索抽取 / 交接 / 夜间记忆这些读者不会把旁白读成 CC 说的话;只有附件没有文字的一轮也写这一行)。`POST /v1/companion/converse` 回包里 `attachments` / `narration` 总在(没有就空数组),本地表情多带一张 data URI(桌面 CSP 只许 data: 图);手机 `GET /m/api/chat` 的消息多两个**可选**字段(老 daemon 不带;认不得的附件逐条丢,不让整页失败),文件只给名字、路径不出 daemon;新路由 `GET /m/api/chat/voice?id=&i=` 只合成库里那一行真有的那段语音(不是任意文字的 TTS 口子),一帧装不下 ⇒ 413 `too_large`;表情图走已有的 `/m/api/sticker/<file>?b64=1`,文件不开新的取文件路由。桌面:Rust `agent_converse` 回整个对象,文件路径换成进程内一次性 ref(`reveal_reply_file` 只认它,只在访达里显示、不打开 —— 打开附件可能直接运行程序);过程是灰色、默认收起的「过程 · N 段」,悬停说明没发到微信;语音点了经 `agent_speak` 念。手机:过程同样默认收起、展开先说一句「没有发到微信」;语音点了才向电脑要声音(新依赖 `expo-audio` + `expo-file-system`,**要重新 `expo run:ios` 出 development build**);表情从电脑表情库取图,取不到退回写情绪的小条;文件只显示名字 +「在电脑上」。演示后端 / shim / `mock.js` 的演示回复都带了过程与附件;新 Maestro 流程 `.maestro/chat-extras.yaml`(本次没在模拟器上跑)。欠:真机 —— Tauri 包里点「在访达中显示」、手机 development build 上真放一段语音(含静音键)、中继上一段长语音的 413 提示。见 `maintainer/reply-delivery.md`「桌面 / 手机怎么显示」。
- 2026-10-04:回复交付第 5 步之后的补齐(spec 修订记录 2026-10-04)。① /both、/chat 的 daemon 参与者 TurnRecord 记交付列(交付之后才写,三处共用一个写法);/chat 改走交付端口(以前 daemon 发言人也把旁白一起拼着发):`#RANK` 先剥、一人一条不分条、出错不发残文。② admin 的 `message` 工具逐家核对(openai / Cursor / Codex / Claude / gemini 的 owner 会话都有,trusted 与 agy 没有;新补 openai、gemini 的集成测试)。③ 发送范围门按 #199 的计划收紧:会话跨 chat 只能走 `message`(记 `chat_scope_admin_cross`),reply 族 / share / set-mode 对所有档含 admin 只许本 chat,admin 的 403 提示改用 `message`;收紧前主人机器 #199 部署后 `chat_scope_admin_cross` 0 行。④ gemini(deprecated)按 §5.7 二选一 ⇒ 迁到 daemon(主人 09-27 定过「保留」;与 openai 同形状,改能力表两行;主人从没配过 key,闸门用剧本 genai + 生产全链)⇒ 没有 provider 默认走 legacy,legacy 只剩回滚用途。规则见 `reference/internal-api-auth.md`,排查见 `maintainer/reply-delivery.md`。
- 2026-10-04:外部 CLI provider 的开机探测不再一次定生死。真机事故:self deploy 后那次开机 `agy: binary not found … or --version probe failed`,终端里 `agy --version` 0.13s,两分钟后普通重启就好了;主人的 cheapEval 钉在 agy,期间后台判断静默落到别家。同一次开机 cursor-agent 的探测也撞了 3s 硬顶掉线(被 `CURSOR_API_KEY not set` 盖住)。根因:知识库回填 + js 嵌入预热(`knowledge_embed_runtime=js`,编译包里 dlopen 本来就失败)在 registerProviders 之前用 `setTimeout(0)` 排上,同步活把事件循环卡了 ~12s,墙钟计时的探测一醒来就判超时(失败的三次开机里 agy 那行都紧跟 `[KNOWLEDGE] embed runtime 'js' unavailable`)。为什么只在 self deploy 之后(03:14、03:34 两次,普通 kickstart 从没出过):seal 重签了 .app,daemon(app 主二进制 `--daemon`)换了代码身份,重签后第一次启动 Gatekeeper / syspolicyd 要重新评估,它起的子进程 exec 也要排队等评估(`log show` syspolicyd:03:14 那次 20 秒里 206 次 `GK evaluateScanResult`,普通重启 22 秒里 5 次;公证查询 `Error checking with notarization daemon: 3` 同步飙高)⇒ 子进程起得慢:claude/codex 的同步版本探测 4.75s(普通重启 0.06s),cursor-agent 撞 3s 硬顶,agy 再叠上知识库那段卡顿就过了 5s 窗口。环境 / PATH 两种重启一样(都是 launchctl kickstart 同一个 LaunchAgent),健康门 / 插件门只轮询 HTTP,不起子进程。修:新 `bootstrap/provider-probe.ts` —— 超时按循环醒着的时间累计 + 宽限,失败带原因;失败后 2s/4s/8s/16s/32s/60s 再每 10 分钟重探(一次一个、计时器 unref、关停时清掉),通过即注册、补一次能力矩阵检查;codex / cursor-agent 的探测从 spawnSync 3s 改成同一个异步探测。`provider-registry.getCheapEval()` 在钉死的 provider 未注册时返回按调用现取的派发器,晚注册后缓存住的函数(coordinator / social 闸门 …)自动回到它;social 闸门超时也改为每次现取预算。可见:`/v1/health.provider_probes`(原因给 trusted 以上)、`wechat-cc status`、`guard status`(含 `--json`)。与 #210 CLI 自动升级接上:升级后自检遇到「这家没注册」时先问重探名单 —— 正在重探的立刻重探一次,通过就照常自检,没好就 `deferred`(以前是 `skipped`,会把没验过的新版本永久接受)。没做:知识库开机活本身不让路(另议,探测已不受它影响);codex 晚注册时 delegate 的 `codexPathOverride` 仍是开机快照;claude 注册不依赖探测,不在重探范围。
- 2026-10-04:外部 agent CLI 自动升级(主人拍板:**全自动、默认开**,人会忘;不兼容要自动发现)。`src/core/cli-upgrade/`(引擎,副作用全注入)+ `src/daemon/cli-upgrade/`(接线、自检)+ `wechat-cc cli status|upgrade|rollback` + `/v1/health` 的 `cli_upgrade` 块 + `agent-config.json` 的 `cli_auto_upgrade`(`enabled` 缺省 true、`check_hour` 缺省 4、`per_cli` 逐个关)。发现:每天一次(查最新走官方发布元数据:npm dist-tags、Cursor 官方安装脚本;agy 没有只读来源 ⇒ 直接跑它的升级器)+ 报错触发(只看错误通道:codex 真机采到的「requires a newer version of Codex」/「not supported when using Codex with a ChatGPT account」、工作台码 `execution_model_unsupported`、cursor 整块「Check your settings to continue」;claude / agy 的句式是猜的,只多触发一次检查)+ CLI 自己在后台换了版本 ⇒ 补自检。升级:只在空闲时(无在途回合、这家无活会话、busy 登记处除自己外没人)、只用官方升级器(`claude update` / `codex update` / `cursor-agent update` / `agy update`)、同一时刻一件、期间持 busy token。升级后自检 = `selftest chat --resume` 同款 + 协议烟测(我们的解析器产出的事件种类里 text / result / tool_call 都在)+ 工作台执行者再跑 `selftest workbench --resume`;网络守护不安全或供应商侧失败(额度 / 限流 / 认证 / 网络 / 5xx)⇒「未验证」稍后重试,**不退回**。不过 ⇒ 自动退回(Claude 改 `versions/` 链接,本机没有再用官方 `claude install <v>`;Codex 改 standalone 的 `current`;cursor 两个链接一起改;agy 退不回 ⇒ 给手动步骤)、重跑自检、记坏版本(更新的出来前不再升)、微信 + 桌面通知一次;成功一句「Codex 已自动升级到 0.160.0，自检通过」。查最新 / 升级器失败指数退避(1h→24h)。测试全用临时目录里的假 CLI,不碰真装的。手册 `maintainer/cli-auto-upgrade.md`。

- 2026-10-03:回复交付第 5 步(Claude)—— daemon 路径接好,**Claude 翻 `daemon`,迁移序列五家全部是 daemon**(只剩 deprecated 的 gemini 在 legacy)。provider:事件按内容块顺序发(以前先 tool_call 后文字,开场会和结论粘成一段)、子 agent(`parent_tool_use_id`)的文字不进回复、只有 `is_error` 没有 SDK 标注的结果补 `provider_error` 码;SDK `result.result` 改为只核对(只在成功轮带出,对不上记 `[REPLY_FINAL_CHECK]`;spec 原写「以它为准」,出错轮它就是错误原文)。扇出里 `canUseTool` 也拒 `message`;`sessions/searcher.ts` 改认入站信封 `<wechat chat_id=`;`reply-tool-bridge.e2e` 改成「最后的话 → 恰好一条」+ 回滚开关下的两条旧契约。闸门:剧本臂(新 `src/core/claude-scripted.ts` 注入 `queryImpl`;recorded / bundled / drift 插件 MCP 名 / tool_error 四种条件)legacy 双发 6、旁白外泄 4、reply 失败 3/3 吞话、私聊 `NO_REPLY` 原样外发,daemon 全 0、九个场景除 g 相对条件外全过;真模型小批(沙盒 HOME,登录只读只经环境变量给 access token,每轮查 bx,25 回合,上限 40)daemon 适用场景全过,`result.result` 与分段 22/22 一致,非回复工具 10.0 vs 13.0(legacy 每轮先 ToolSearch 找 reply),录到的七轮进 `src/core/fixtures/claude-sdk-2026-10-03.jsonl` 回放。spec §5.7 补了观察期(≥14 天、每家 ≥20 个完成应答轮、六项每日指标)与第 6 步删除清单;本步不删 legacy。欠:真机 `selftest chat --provider claude`、`e2e:device`、主人试聊。数据见 `reference/reply-once-experiment.md`「第 5 步」。
- 2026-10-03:回复交付第 4 步(Codex)—— daemon 路径接好,**Codex 翻 `daemon`**(编码型,只交付最后一条非空 agent_message;旁白不进微信、120 秒一句进度)。provider 要改(spec §4.2 原写不用):不是消息 / 思考 / 非致命 error 的 item 都产 tool_call(以前 shell / 改文件 / 搜索不产,旁白和结论会粘成一段;SDK 不认识的新 item 类型也算),text 事件加 `ownSegment`(每条 agent_message 自成一段),`turn.completed` 之后 exec 非零退出不再补 error。工具表随 `wechatStdioMcpSpec('codex')` 的开关走(集成测试:spawn 的 config → 起子进程 → 无 reply 族、admin 有 `message`)。闸门两部分:剧本臂(新 `src/core/codex-scripted.ts` 注入 `codexFactory`,生产 provider / 协调器 / 交付运行时;形状照 SDK / CLI 比 SDK 新换了 item 类型 / strict 拒 MCP 三种条件)legacy 旁白外泄 7、strict 3/3 一个字都没收到、私聊 `NO_REPLY` 原样外发,daemon 全 0、适用场景全过;真模型小批(沙盒 CODEX_HOME 只复制登录、read-only、每轮查 bx,35 次调用,上限 40)daemon 适用场景全过、非回复工具 11.0 vs 14.0,并真机复现 legacy 的 strict 吞话(录到的流进 `src/core/fixtures/codex-exec-2026-10-03.jsonl` 回放)。欠:strict 下 codex 拒所有 MCP ⇒ daemon 附件调不成(要给 wechat MCP 配 approve,属重评 bypass,未做);真机 `selftest chat --provider codex`;主人默认 `gpt-6.1-sol` 在 CLI 0.153.4 下被服务端 400(版本耦合,另记)。数据见 `reference/reply-once-experiment.md`「第 4 步」。
- 2026-10-03:Cursor 的带内报错不再当回复发出(#206 发现)。cursor-agent acp 一轮出错时不回 JSON-RPC 错误,而是在 `processPrompt` 的 catch 里把报错写成**一整块** `agent_message_chunk`(`\n\n` 开头)、照常 `end_turn` —— 协议字段(stopReason / `_meta` / update 种类 / 退出码)里没有任何错误信号。ACP 边界(`cursor-errors.cursorAcpInbandError` + `acp/events` 翻译器)只认这一种结构:本轮**最后一个可见 update** 是一整块、整句等于 cursor-agent 的固定句(`Please sign in to continue` ⇒ `auth_failed`、`Upgrade your plan` / `Add a payment method` ⇒ `quota`、`Check your settings` ⇒ `provider_error`、`Error: [unauthenticated] Backend rejected …` ⇒ `auth_rejected`)或 `Error: ${String(e)}` 模板(按 connect code 分 `rate_limited` / `network` / `server_error` / `invalid_request`,其余含 Agent Looping Detected ⇒ `provider_error`);认得出的块先扣住,后面还有文字 / 工具调用就原样放行。对话侧与工作台两条路都以带码 error 收尾,daemon 交付只发通知;正文里提到 looping 照常交付。测试全用脚本化 ACP 流 + 原样回放真机 c4both,没有真 Cursor 调用。细节与残留(legacy 下报错之前的文字仍 FALLBACK)见 `reference/provider-error-shapes.md` §8。
- 2026-10-03:回复交付第 3 步(Cursor)—— daemon 路径接好,**Cursor 翻 `daemon`**(编码型,只交付最后一段;旁白不进微信、120 秒一句进度)。Cursor 的 wechat MCP 逐会话注入,`wechatStdioMcpSpec('cursor')` 按开关带 `WECHAT_REPLY_DELIVERY=daemon`(集成测试用会话 env 起子进程核对:无 reply 族、有附件工具、admin 有 `message`)。闸门不连模型(Cursor 真 API 没法沙盒、主人额度用完,一次真调用都没做):新 `src/core/acp/scripted-agent.ts` 照 2026-09-17 真机报文演假 `cursor-agent acp`,生产的 ACP 客户端 / 协调器 / 交付运行时跑同一个模型行为的两套词汇,三种外部条件(身份照真机 / CLI 不带身份 / strict)。legacy:身份照真机时没坏;不带身份 ⇒ 双发 5、旁白外泄 3;strict ⇒ reply 被拒仍算「回过」、3/3 轮一个字都没收到;私聊 `NO_REPLY` 原样外发。daemon:全 0,适用场景全过(b 不适用;g 只差相对基线)。闸门本身是测试(`cursor-fixture.test.ts`);双发结构性消失由 `conversation-coordinator.cursor-delivery.test.ts` 证明(含回放真机 c1)。欠:真模型补 a / d / h(结论是否写在最后一段)、真机 `selftest chat --provider cursor`;Cursor 把「Agent Looping Detected」写进助理消息会被当回复发出(两条路都有,另做)。数据见 `reference/reply-once-experiment.md`「第 3 步」。
- 2026-10-03:回复交付第 2 步(agy)—— daemon 路径接好,**闸门两臂打平,agy 先 `shadow`**。接好的:agy 的静态全局 MCP 配置按开关换工具表(daemon 模式条目带 `WECHAT_REPLY_DELIVERY=daemon`,开机改写;集成测试用写出的 env 起子进程核对);共享令牌 `agy-static` 的附件绑到 agy 正在跑的那一轮(`ReplyDeliveryRuntime.turnChatFor`),daemon 模式下 #199 的跨 chat 豁免取消(只许本轮聊天;无轮 / 并发 ⇒ 拒,`ambiguous_turn`);双发旁白在 daemon 下结构性消失(协调器测试用没登记的命名空间证明)。harness 加 agy 臂:工作区自定义 agent(`inheritCustomizations` + `inheritMcp` 都关)+ 插件起生产 wechat MCP + 假 internal API,每轮前查 bx;真 agy 56 轮闸门 a–i 两臂都过(g 只差相对基线那条),daemon 非回复工具 10.3 vs 15.0,双发两臂都是 0 ⇒ 不是「明显更好」,按约定不翻。翻只改 `AGY_CAPABILITIES.replyDelivery` 一行。数据见 `reference/reply-once-experiment.md`「第 2 步」。
- 2026-10-03:网络守护最后一条待定转为主人已定 ——「已经在跑的任务」**暂停,不停**。bx 来源从不停、不暂停;probe 来源连续两次不安全 ⇒ SIGSTOP 需要保护的工作台执行者的整棵进程树(`lib/process-tree-freeze.ts`:根组 + 后代另起的组),读到安全 ⇒ SIGCONT;冻住期间回合看门狗、codex 连接 / 首个事件 / RPC 超时(`lib/pausable-timers.ts`)、权限批准期限、空闲收工一律停表;暂停 30 分钟(guard.json `max_suspend_minutes`)还没恢复 ⇒ 冻住的树直接杀(从不先放开)、任务按收工停下并告诉主人「网络一直没恢复，任务已停止，可以接着做」。逐执行者沙盒(真 CLI 连 127.0.0.1 假服务,冻住时掐断流):Claude Code、Codex 放开后自己重试接上 ⇒ 暂停;Cursor ACP、agy 没法在沙盒验、openai 兼容是进程内循环 ⇒ 退回原来的停法;Windows 没有 SIGSTOP ⇒ 照旧停。对话会话不暂停(协调器的回合计时 / 送达 / 会话锁不是单轮安全的),仍关需要保护的那几个,但时刻改成和工作台一致(probe 两次)、bx 来源不再关。看得见:桌面 / 手机 / 微信「已暂停(网络未受保护)」,`/v1/health.guard.suspended(_tasks)`,`guard status` 列出。见 `reference/network-guard.md`「暂停在跑的任务」。
- 2026-10-03:回复交付第 1 步审稿第二轮 —— 运行时回滚开关 `agent-config.json` 的 `reply_delivery: { <provider>: legacy|shadow|daemon }`(覆盖能力表,重启生效,`maintainer/reply-delivery.md`);聊天型提示词加结构性约束;推送 compose 提示改成「已决定要推送」、NO_REPLY 只兜底。复测 a / f / g(15 轮):a 5/5、g 4/5 好于第 3 轮,f 2/5 比第 3 轮(3/5)差 ⇒ 按约定没切,openai 仍 `shadow`,等维护者定。
- 2026-10-03:回复交付第 1 步审稿后修订 —— 「最后的话」按执行者类型分两种策略(`replyText`):聊天型模型(openai,以后 agy)本轮所有文字段按顺序都交付、每段按 ④ 分条、不发进度;编码型执行者(Claude Code / Codex / Cursor)仍取最后一段 + 120 秒进度。提示词 / 推送提示按策略出版本;过关线 c / d / g 按审稿修订;推送「推不推」先于生成有测试钉住;harness 状态目录隔离有测试证明(新进程里导入 harness 后 lib/config 的 STATE_DIR 就是临时目录);测试夹具里不再出现真实的破坏性命令字符串。第 3 轮闸门(52 轮)a / b / d / f / g 没过,openai 保持 `shadow`;卡点见 `reference/reply-once-experiment.md`「审稿后」一节。
- 2026-10-03:回复交付第 1 步(openai 兼容)—— daemon 路径全部接好,**闸门没过,openai 先 `shadow`**。接好的:协调器 daemon 分支(只有 completed 的轮交付最后的话;出错 / 超时 / 认证只发通知、不发残文;没有 FALLBACK_REPLY;「应答轮交付为空」连击取代 fallback 连击;120 秒进度一次;/both 的 daemon 参与者只交付最后的话、前缀由 daemon 加)、伙伴推送(最后的话就是推送,`NO_REPLY` ⇒ 撤回登记)、app 轮(接收器拿整个 TurnReply,附件与旁白随 converse 返回,不再漏到微信)、wechat MCP 在 `WECHAT_REPLY_DELIVERY=daemon` 时不注册 reply 族,改注册 `voice` / `sticker` / `attach_file`(不带 chat_id,`POST /v1/turn/attach`)与 admin 的 `message`(`POST /v1/wechat/message`,to=本轮聊天报错)、final_text 版提示词(含推送提示)。闸门(真 Qwen3.8,145 轮):b 从基线 8.4 条 / 轮、3/5 跑满预算降到 9/10 恰好一条,a / e / f / h / i 全过,非回复工具更少;c(3/5)、d(1/5→3/5)、g(静默 3–4/5,基线 0/5)没过线。d 的线与已定 ④(去掉 100 字门槛)冲突,待定。数据与分析见 `reference/reply-once-experiment.md`「2026-10-03」。
- 2026-10-03:回复交付第 0 步(地基,生产行为不变;spec `superpowers/specs/2026-10-03-reply-delivery-design.md` §5.1)。新 `core/turn-reply.ts`(以 tool_call 为界取「最后一段非空文字」与旁白、`NO_REPLY` 解析与场合判定,`collectTurn` 顺手填 `finalText` / `narration`)、`daemon/reply-bubbles.ts`(空行分条、≤4 条、碎段并入上一条、代码块整块、>300 字按句切、去掉 100 字门槛、>4000 的代码块按行切补围栏)、`daemon/reply-delivery.ts`(静默 / app 接收器拿整个 TurnReply / 旁听 / 前缀 / 节奏 / 第一条失败就停 / 附件在文字之后、只有语音就只发语音、语音失败改发文字 / message 去重 / 120 秒进度 / 交付报告);`sendNotice` 与 agent 的话分家(NOTICE_* 日志,不进打猎旁听);`turn_records` 加 delivery / bubbles / attachments / narration_segments(v71);每家 provider 一个 `replyDelivery: legacy | shadow | daemon` 开关(全部 legacy),shadow 照旧走 reply 工具、另记 `[REPLY_SHADOW]` 比对;openai provider 加回实验专用的 `makeBuiltins`;harness 扩到 a–i 九个场景 + 过关线(`--gate`),并修了它的隔离漏洞(状态目录在 import 期就被定下,原来模块体里才设临时目录)。
- 2026-10-03:网络守护判 Codex 端点改按 codex 自己的配置(堵直连漏洞)。codex 0.153 **不认** `OPENAI_BASE_URL` / `OPENAI_API_KEY`(二进制里只剩网络代理凭据那一处),端点只看 `CODEX_HOME/config.toml` 的 `model_provider` → `model_providers.<id>.base_url` / `openai_base_url` 与 `-c` 覆盖;守护原来按 `OPENAI_BASE_URL` 判 ⇒ 变量指国内网关、config 是默认时判成「不用保护」而 codex 实际直连 api.openai.com。新 `lib/codex-target.ts` 按 codex 同一套层(系统 → 用户 → 项目 → `-c` → managed)解析,拿不准(读不出 / 坏 TOML / 未定义 provider / 无 base_url / 重定义内置 id / 老式顶层 `profile` / 项目层改了端点键)一律按需要保护;工作台 app-server 会话起来后直接用 codex 自己 `config/read` 报的有效配置。用在对话会话、cheapEval / delegate、工作台、终端会话 resume、`/v1/health`、`wechat-cc guard status`;Codex 额度查询固定按 OpenAI 官方。测试的 `CODEX_HOME` 指空临时目录(`vitest.setup.ts`)。见 `reference/network-guard.md`。
- 2026-10-03:安全修复 —— 发送类路由按会话 chat 限范围(`src/daemon/internal-api/send-scope.ts`)。确认过的 bug:reply / reply_voice / send_file / edit_message / broadcast / 表情包 / share_page(chat_id)/ set-mode 都从请求体拿 chat_id、从不和调用方自己的 chat 比,任何会话(含 guest)都能以 CC 身份给任意 chat 发消息,也能塞进别的 chat 开着的 App 回复截流口。现规则:guest / trusted 会话只能发给自己的 chat;broadcast 只许 admin 会话;非 admin 的 session 读不出 chat ⇒ 拒;admin(主人)会话跨 chat **暂时放行**并记 `chat_scope_admin_cross`(主人会让 CC「帮我告诉某个访客」,没有代码调用点可查),等回复交付重构做出 admin 专用 `message` 工具再把 reply 收紧到本 chat(spec §5);违者 403 `chat_scope`(不回显目标、记日志 `chat_scope_denied`)。门在 dispatcher、handler 之前。file / operator 令牌照旧;`agy-static` 共用令牌照旧(已知缺口)。回复投递的大改另行设计。规则见 `docs/reference/internal-api-auth.md`「发送类路由的 chat 范围」。
- 2026-10-03:回复交付设计稿(`docs/superpowers/specs/2026-10-03-reply-delivery-design.md`)。根因:所有执行者被要求经 `reply` 工具说话,自研循环「不调工具才结束」+ 发完话的文字被丢 ⇒ 模型没有被认可的结束动作(沙盒基线历史有连发时 12 条 / 轮);agy / Cursor 双发旁白、FALLBACK_REPLY、两条出口行为不一致、reply 可发任意 chat_id、app 轮语音表情漏到微信,都是同一个根。方向(主人 10-02 同意,对标 Letta v1 / OpenClaw):一轮最后一段非空文字 = 回复;daemon 统一分条、节奏、频道上限、三端送达;`NO_REPLY` 只在推送与 /chat、/both 生效;语音 / 表情 / 文件是本轮附件;`message` 只给 admin 往别处发;按 openai → agy → Cursor → Codex → Claude 一家一家迁,每步过 reply-once harness(扩到各家)+ `e2e:device`。PR #196 已关,它的 harness 与 110 回合数据搬进 dev(`scripts/experiments/reply-once/`;provider 没有 `makeBuiltins` 注入口时拒跑)。8 条待定项 2026-10-03 由维护者按推荐定(主人授权),见 spec §6;reply 路由不核对 chat_id 的越权另一个 PR 单独修。
- 2026-10-02:错误通道结构化(#4)第 2 步余下部分(主人批准)。每家 provider 边界产固定的码:codex 解析自家固定尾巴(HTTP status 先于「连不上」措辞 ⇒ websocket 401 是 `auth_rejected`;`Missing bearer` ⇒ `auth_failed`;usage limit ⇒ `quota`),工作台 app-server 读结构化的 `codexErrorInfo`;openai 兼容读 AI SDK 的 status / `RetryError.errors[]`(524 ⇒ `server_error`,不再是 `Last error: <none>`;一次性评估不再重抛成 `auth_failed:` 丢 status),gemini 同一份(400 + API_KEY_INVALID ⇒ `auth_rejected`);cursor ACP 读 JSON-RPC code(`-32000` ⇒ `auth_failed`,`-32603` 无可用 data ⇒ `provider_error` 不猜),print 认自家三句;agy 歧义句在边界固定 `network`(红线 B),Go 网络措辞 ⇒ `network`;Claude 一次性评估与工作台运行时读 SDK 标注。边界超时:codex(连不上 60s / 无进展 180s;沙箱实测 codex 0.153 拒连时无限期发 `Reconnecting... waiting for network`,以前连看门狗都不触发)、openai 兼容(到响应头 110s / 流停 120s),均可用环境变量改。下游只读码:cheapEval 冷却、桌面「测试连接」(agy 歧义句不再报 AUTH FAILED)、coordinator(按码说原因;spawn 失败读码)、工作台(`provider_network` / `provider_auth_rejected` 等稳定错误码 + 微信通知说原因)。守护拒绝 `network_unprotected` 不进 provider 码。详见 [reference/provider-error-shapes.md](reference/provider-error-shapes.md) §7。
- 2026-10-02:网络守护 v2 两条待定转为主人已定。① Kimi:「Kimi 都不需要判断」—— `moonshot.cn` / `moonshot.ai` / `kimi.com` / `kimi.ai` 一律不保护(之前 `.ai` 缺省判成海外需要保护),分类器新增 `kimi` 类,`protect_custom_gateways` 不影响。② Cursor:「Cursor 除了 auto，其他都要网络」—— 只有 Auto(没选、`auto`、cursor-agent 的 `default[]`)不保护;composer-\* 等 Cursor 自家模型和不认识的模型名一律保护(之前自家模型不保护)。分类 kind 换成 `cursor_auto` / `cursor_model` / `cursor_setup`。`reference/network-guard.md` 的待定只剩「停在跑任务的时机」。
- 2026-10-02:网络守护 v2 评审 #193 四处修复 + 决定分档。① 守护判的是执行者**真正**连的目标:provider / 会话自报(注册那一刻的 openai base URL、spawn 时 Claude 子进程拿到的 `ANTHROPIC_BASE_URL`、cursor-agent 自报的当前模型、Cursor 一次性评估的构造模型),不再按此刻的配置猜;报不出 ⇒ 按需要保护。② 探测结果有有效期(5 分钟),不依赖 ipify 成功;过期 = 不知道 ⇒ 等新结果,等不到按不安全。③ 后台任务里被拒 = 这一拍跳过,不打勾 / 不登记 / 不前移时间戳。④ `/chat` 被筛到只剩一位按单人排队。`reference/network-guard.md` 的「主人的决定」改成两档:主人已定(含「装了 bx 但关着 / 读不出 ⇒ 暂停、不回退 Google,`signal_source: probe` 可显式改用探测」)/ 待定(停在跑任务的时机 —— 临时沿用 #191、Kimi `.ai`/`.cn`、不认识的 Cursor 模型、Cursor 其它模型)。第二轮评审(#194)再修三处:守护装进会话自己的发送方法(selftest 等拿到会话就发的入口不再绕过);同一个底层会话同一时刻只有一个回合(网络来回切换时单模型 / 群聊交接不再撞车);被拒后的撤回只撤本次登记(保留期间主人来信清零、新的记忆通知等)。
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
