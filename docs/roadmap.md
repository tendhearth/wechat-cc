# wechat-cc 现行 roadmap

> v1 · 2026-09-22 · **这份只说「往哪走 / 卡在哪」。**
> 「定了什么 / 为什么这样定」在 [全景导图](全景导图.md);「某件事的文档在哪」在 [文档索引](INDEX.md);
> `docs/rfc/02-post-v1.1-roadmap.md` 是 2026-04 的历史版本(v1.2 时代),已被本文取代。

## 现状:1.7.1 已发(2026-09-29)

| 事实 | 怎么看(别写死数字,每次改这页先跑) |
|---|---|
| 最近一次**公开**发版 | `gh release list --limit 1`(2026-09-29:`desktop-v1.7.1`,master `0e667c87`;第一版 Developer ID 签名 + 公证的 macOS 包) |
| 自动更新源 | `curl -s https://dl.tendhearth.com/wechat-cc/latest.json \| grep version`(2026-09-29:1.7.1,与 GitHub 一致) |
| `dev` 领先 master | `git rev-list --count origin/master..origin/dev`(簿记合并之后是真实差值) |

1.7.0 是发版链 09-03 改造后第一次真跑,一路踩到五个「加进去后没在真 tag 上跑过」的坑,全部修在 dev 并有守卫/手册条目:dev→master 簿记合并(#121)、e2e 作业装浏览器(#122)、sd.cpp 子模块(#119)、公证变量空串(#123)、R2 令牌失效还报绿(#125)。**发版从此全自动**:合 PR、打 tag、两道 `release-signing` 审批(助手用主人 gh 凭据经 API)、Publish、核对更新源,主人不用点;细则 [maintainer/release.md](maintainer/release.md)。

版本号已统一(2026-09-22):此前四处各说各话(发版认 `tauri.conf.json` 的 1.6.6、`--version` 报根 `package.json` 的 0.6.4、`apps/desktop/package.json` 写 0.5.18、ACP 的 clientInfo 还硬编码 `'0.6.4'`),现在四处 + `Cargo.toml` 都是 **1.7.0**,由 `scripts/version-consistency.guard.test.ts` 钉住;`--version` 同时带构建的 git 短 sha(`1.7.0 (a1b2c3d)`),否则 `self deploy` 的健康门打出来的数字两次发版之间永远一样、看不出新构建起没起来。发版说明:`docs/releases/desktop-v1.7.0.md`。

**⇒ 发版节奏的教训:三周不发、发版链改了不真跑,代价是一天修五个坑。** 之后每合一批就发一版 patch。

## 下一步(按顺序)

1. ~~合 #117~~(09-23)· ~~发 1.7.0~~(09-27)· ~~发 1.7.1~~(09-29)。
2. **补真机验证**(下面「欠的真机账」整节)—— 大量功能只有单测和 selftest 绿,没在真机上走过一遍。
3. ~~Codex 第一批 #129~~(09-27 合)· ~~⑦ 拆三个大文件~~(09-28)· ~~⑥ 设备令牌进 token-registry~~(09-29,#149)。梳理 2026-09-26 的七步全部落地。
4. 之后才谈新功能。

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
- **手机 app 子项目 1(协议包 + 实时通道)已完成**(2026-09-29,`packages/protocol/README.md`;设计 `docs/superpowers/specs/2026-09-29-phone-protocol-v2-design.md`)—— 子项目 2(中继升级成对外服务 + 推送发送,`apps/relay`,`docs/maintainer/relay.md`):代码完成,等上线(凭据 / 付费计划 / 域名);之后子项目 3 才是 Expo app 第一版。
- **手机 app 子项目 3(TendHearth app v1)后端补全:代码完成,单测/自检绿,真机待验**(2026-09-30,`app-v1` 分支;设计 `docs/superpowers/specs/2026-09-30-tendhearth-app-v1-design.md`,计划 `docs/superpowers/plans/2026-09-30-tendhearth-app-backend.md`)—— 批准说明 / 进展概括(`/m/api/matter/insight`,便宜模型 + 原文回退)、改动路由(`/m/api/matter/changes`)、推送定位与时间窗、子项目 1 三个遗留;接线在 `src/daemon/wiring/pipeline-deps.ts`。**下一份计划 = app 骨架与演示模式**(设计稿 `docs/design/tendhearth-app-v1/`)。
- **手机 app 子项目 3:app 骨架 + 演示模式完成**(2026-09-30,`app-skeleton` 分支;`apps/app/README.md`,计划 `docs/superpowers/plans/2026-09-30-tendhearth-app-skeleton.md`)—— Expo 原生工程 `apps/app`:此刻 / 一起做 / 进展 / 批准(模型说明时原始命令直接可见)/ 问答 / 交办 / 配对说明 / 设置,界面只认 `Backend` 接口,数据来自演示后端;iOS 模拟器(iPhone 17 Pro,iOS 26.5,development build)上 Maestro 三个演示流程(approve / compose / demo-walkthrough)通过。Android 与真机未跑。**下一份计划 = 真连接与配对**。
- **手机 app 子项目 3:真连接与配对完成**(2026-09-30,`app-live` 分支;计划 `docs/superpowers/plans/2026-09-30-tendhearth-app-live.md`,`apps/app/README.md`「真连接的规矩」)—— LiveBackend + 扫码配对 + 设备管理(含新增 daemon 操作 `unpair_self`);进程内端到端(`src/daemon/phone-app-live-e2e.test.ts`)+ 单测覆盖,Maestro 演示流程与无效链接流程通过;**真机配对待主人验收**。**下一份计划 = 原生通知**。已知取舍与欠账:(1)局域网直连(LAN-first)推迟——daemon 局域网口没有 v2 订阅;(2)离线缓存只在内存,冷启动离线 ⇒ 空列表 + 「暂时连不上」;(3)配对链接令牌在 10 分钟有效期内可重复使用(安全跟进:被拍下的二维码 10 分钟内能配第二台手机);(4)相机权限文案目前只有英文,等计划 4 补 en + zh-Hans 语言文件;(5)每次调用带各自的 `requestId`(说一句 / 批准 / 回答可按回执查重);(6)中继上线需 `agent-config.json` 的 `relay_v2_url`,未设时走老中继(`t…` id);(7)正式图标由 Codex 出稿后替换 `apps/app/assets/images/*`。**主人真机验收清单**:真 iPhone 扫桌面「手机上用」的码配对 → 此刻 / 进展 / 批准 / 交办各走一遍 → 电脑上撤销这台手机 ⇒ 显示「这台手机已不再配对」→ 关掉电脑 ⇒ 显示上次同步时间 → 设置里解除配对;配对过程中 iOS 左滑返回已锁定,也请试一下。安卓等有设备再补。
- **每晚整理长期记忆(B 看得见)** 已上线（`docs/superpowers/specs/2026-09-25-memory-nightly-design.md`）—— 下一步 A:手机上逐条标不对 / 过时 / 删掉；C:第二天偶尔说一句我注意到…;09-26 界面改版:手机「CC 眼中的你」、微信信件排版、一条一件事

## 欠的真机账(发版前该销掉)

这三周的东西**单测和 selftest 绿 ≠ 用户能用**,以下都没在真机上走过:

- ~~桌面同一个文件夹连开两件事,看等待行说的话对不对(一个文件夹一个活会话)。~~ 2026-09-28 真机核对通过:第二件 `waitingFor={reason:same_path, holderWriting:true}`、第一件独占在写(workbench service 拆分 PR 9 合入后,脚本见 PR 10 计划)。
- `self change --no-deploy` 走一条完整链路,确认每条运行一个 worktree 全程成立。
- 桌宠 Phase B 的权限卡闭环(微信 y/n 只认被问的那个 chat)。
- 介绍 2 跳的完整链路(需要第三台真机)。
- 社交层两台真机重新配对后的 wish / postcard 信道。
- `@码 resume` 与「脑手转发」全链(CLI hook)。

## 已定未做(按价值排)

- **发版节奏本身要有纪律** —— 三周不发版是这轮最大的结构性问题,不是某个功能的问题。
- **e2e 只在 master 相关的分支跑**(`.github/workflows/ci.yml:152` 的分支条件)—— dev 上推送不跑 e2e,于是积压的 e2e 红会在开 PR 那一刻一次性砸下来(这次砸了 8 条)。要不要让 dev 也跑是成本取舍。
- **自改的工作树回收缺一个显式入口** —— 现在只回收 `done`/`declined` 的运行,可 resume 的和被 kill 的永不回收(磁盘单调增长)。缺的是「这条我不接了」这个动作。
- ~~**设备 token 进 token-registry、http 默认 loopback**(梳理第 6 步)~~ **2026-09-29 完成(#149)**:链接 / 设备令牌进内部 API 同一个注册表(origin `link` / `device` + routeAllow `PHONE_ROUTES`),按台撤销,只允局域网的操作收成 `LAN_ONLY_OPS`,`serve()` 缺省 127.0.0.1。**没做的范围 B**:`/m/api/*` 并进内部 API dispatcher。现状见 [reference/internal-api-auth.md](reference/internal-api-auth.md)。
- ~~**拆三个大文件**(梳理第 7 步)—— `core/workbench/service.ts`(1622 行闭包,按 20 份 `service-*.test.ts` 的边界抽)、`bootstrap/index.ts`(剩余 8 个关注点进 `wire-*.ts`)、`cli.ts`(按命令族下沉;`scripts/cli-ratchet.guard.test.ts` 先钉住不再增长)。~~ **2026-09-28 三件全部完成**:`cli.ts` 4332→157(#128)、`bootstrap/index.ts` 1321→460(#131)、`core/workbench/service.ts` 1965→179 行 / 内函数 68→3(PR #132–#141 + PR 10,十个域进 `service/<domain>.ts`,棘轮守卫 `scripts/workbench-service-ratchet.guard.test.ts` 只降不升;19 份旧测试一行没改)。
- **错误通道结构化**(arch backlog #4)—— 要 owner 参与定两条判定红线。
- **纯 JS 的锚定文件访问**(评审 #3)—— 去 ffi 之后没有 `openat`,逐级 lstat 是多个时刻的观察;两条路(写清威胁模型 + 目录替换回归测试,或 macOS/Linux 恢复原生 openat),安全边界取舍等 owner。
- **动态 provider 注册** —— 等 openai-compatible 这条路被外部集成者真用起来、暴露出覆盖不了的需求再做。
- **手机台阶 B(桌面 Widget + 原生推送)** —— 解锁条件:PWA 验证有人用 + 决定掏 Apple $99/年。
- **STT(语音入站)** —— 已通(2026-09-27 口径):网关形态,`stt-config.json` 指定 whisper 网关(`src/daemon/stt/*`),接在入站链 `mw-transcribe-voice`;未配置即关。出站语音也已通(VoxCPM2)。缺的是本地 STT 与首次配置引导。
- ~~**Developer ID 证书**~~ **2026-09-28 到手**(Nate Gu & Co LLC,Team 9Y6JAPDP7A):CI 签名 + 公证已通,1.7.1 是第一版签名包;本机 `self deploy` 也用它重签(#143/#144/#146)。**证书 2027-02-01 到期**,到期前在 Apple Developer 后台续一张、更新 `release-signing` 的 `APPLE_CERTIFICATE`(Team ID 不变,TCC 授权不掉)。
- **Windows 拿不到 Codex 工作台**(2026-09-27 口径,三份文档同此)—— 文件层已通(`anchored-fs.ts` 纯 JS,有 win32 分支)、进程树清理 `jobspawn` 已落地(codex-config / model-catalog 两条路);但 Codex 执行者本身在 win32 仍显式拒绝(`codex-app-server.ts`「尚未验证任务进程树清理」),原生历史 win32 不支持(`codex-history-rpc.ts`),Claude 保留会话的 win32 真机验收也欠。要做的是:拿掉那道拒绝前先在 Windows 真机验一遍进程树清理。

## 有意推迟 / 已否决

- ~~微信小程序(手机台阶 C)~~ ⟨2026-08-26 拍板不做:审核类目敏感 + 个人主体限制,且 PWA + 微信内置浏览器已覆盖⟩
- **陌生人匿名交换(社交第三层)** —— 产品上有意推迟;二层(匿名笔友)已完整,真机往来的瓶颈是冷启动不是协议。
- **Letta 之类外部记忆内核** —— 评估过,结论是记忆已被商品化,保留 `.md` 自建那套。
- **升 bun 1.4** —— 独立一件事,它动到 `bun:sqlite` 的迁移行为,别当顺手活。

## 修订记录

- 2026-09-29:1.7.1 已发(第一版 Developer ID 签名 + 公证包);第 6 步设备令牌进 token-registry 完成(#149),梳理七步全部落地;Developer ID 条目改成「到手,2027-02-01 到期」。

- 2026-09-27(晚):1.7.0 已发,现状表与下一步改写;发版链五个坑与「全自动发版」入账;⑥⑦ 四份设计稿入下一步。
- 2026-09-28:第 7 步「拆三个大文件」三件全部完成(cli #128、bootstrap #131、workbench service PR #132–#141 + 收尾);真机账「一个文件夹连开两件事」核对通过;hookTimeout 抬到 40s(#133);Codex 第一批 #129 合入。第 6 步(设备令牌进 token-registry)仍是「已定未做」。
- 2026-09-27:现状表改成「命令 + 当日值」;#117 已合、tag 已推;STT 口径定为已做(网关形态);第 6/7 步(设备 token、拆大文件)入「已定未做」;发版链接改指 maintainer/release.md。
- 2026-09-22 v1:首份现行 roadmap。此前五个月的方向只活在 PR 描述和对话记忆里,文档侧唯一叫 roadmap 的是 4 月的 RFC 02。
