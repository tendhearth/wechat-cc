# 全项目架构审查(2026-10-20)

> 主人 10-20:「审查下整个项目和代码,看看是否有不清晰的地方,架构是否好,**不要考虑迁移成本**,我希望架构清晰」。
> 基于 dev `c70ff59c`(非测试代码约 12.7 万行:daemon 5.6 万 / core 4.1 万 / cli 1.7 万 / lib 1 万)。六路只读审查(daemon 组装、工作台、执行者与对话、三端与协议、陪伴 / 记忆 / 社交、底层与工具),关键结论我抽查过(文中标 ✔)。

## 一句话结论

骨架是对的:分层意图清楚、工作台按域拆开、入站有 intent 路由、协议包有 zod schema、错误码已结构化。但**同一种病出现在六个地方**:一件事的「声明」被拆成 N 份清单散在各处,靠守卫测试把它们拉齐。每加一个功能都要改 12–20 个文件,而且清单之间已经实际漂移(下面有实例)。架构不清晰的根源不是某个大文件,而是**缺「一处声明、到处生成」的注册表**。

## 六个横切问题(按对以后开发的影响排)

### 1. 没有单一声明:路由、命令、执行者、错误码都是多份清单

| 东西 | 现在散在几处 | 已经漂移的实例 |
|---|---|---|
| 手机路由 | `PHONE_ROUTES`、`LINK_EXCLUDED` / `LINK_WRITE_OK`、`PHONE_API_SCHEMAS`、settings-panel 里 30 个 `url.pathname ===` ✔、`mobile-*.ts` 处理器、App `live.ts` / `errors.ts` / i18n、网页 js、三份守卫测试 | — |
| 桌面路由 | `ROUTE_MIN_TIER`、token-registry `routeAllow`、`lib.rs` match、`workbench-proxy.ts`、Rust 测试表(五处) | — |
| 错误码 → 状态 / 文案 | wechat-control `failure()`(~35 条中文)、`mobileMatterError`、`routes-workbench` 的状态表、桌面 `LINE_ERRORS`、App `errors.ts` | `REWIND_409` 桌面与手机各一份,内容已不同 ✔(桌面有 `rewind_undo_*`,手机有 `rewind_not_latest`) |
| 微信命令 | ≥7 套:intent 路由、`chainReplyHandlers`(jobs / 日历 / 做过的事 / 经验 / 导入记忆,全挂在 intent `cli-reply` 名下)、`command-router`(派 / 串门 / 配对…,跑在管道**之后**,绕过 intent 与 trace)、`admin-commands`(40 条正则)、`mode-commands`(19)、`wechat-control`(~25 条正则)、`core/*-command.ts` | 「是不是主人」在 main.ts 里抄了 18 次 ✔ |
| 执行者 | 聊天侧 `ProviderCapabilities` 与工作台侧 `WorkbenchExecutorCapabilities` 两套词汇;Claude / Codex / Cursor 各 3 个适配器;`bootstrap/providers.ts` 每家一段 if 梯子 | 同一家可以一边 `guestSafe:false` 一边 `permissions:'task'`,没人交叉核对 |

**目标**:每类东西一张**类型化的表**,其余全由它生成。
- `Route = {method, path, surfaces:['desktop'|'phone'], tier, link:'none'|'read'|'write', req, res, errors}`,放在 `packages/protocol`;daemon 的 allowlist / tier 表、Tauri 的 allowlist(build.rs 生成)、App 与桌面的类型化客户端、守卫测试都从它出。
- `Command = {id, intent, probe, handle, ownerOnly, guestSafe, priority}` 一个 `CommandRegistry`;intent 路由由它生成,`isOwner` / `say` 经 `CommandCtx` 注入一次。
- `ExecutorDescriptor` 每家一份:显示名、`chat?` / `workbench?` 能力、错误分类、能执行哪些策略维度;一个 `executors/<家>/{chat,workbench,errors,policy}.ts` 目录。
- `ERRORS = {code: {http, kind, zh, hint?}}` 一张表 + `WorkbenchError(code)`;测试保证每个抛出的码都在表里。

### 2. 安全模型没有落在一处 —— 这是**会出事**的那一条

- `TIER_PROFILES` 本该是唯一来源,但每家执行者各自翻译:Cursor 与 Gemini 的翻译函数**直接忽略档案**(参数名就叫 `_tp`)✔;Codex 聊天线程不设联网,沿用主人的 codex 配置;ACP 只看 permissionMode;openai 把 relay 当 deny;agy 钉死 trusted。
- 结果:一个「不给网」「不给写」的档案只在部分执行者上生效,其余**静默放过**。#460 给 Codex 补了不联网搜索,是同一类洞的一个点。
- `tierNameFromProfile` 从档案「形状」反推档位名(JOB_PROFILE 恰好拒了 fs_write 才算 guest)—— 脆。
- 手机链接令牌对**读**是 fail-open:`LINK_ROUTES = PHONE_ROUTES − LINK_EXCLUDED`,新加的 GET 默认链接能读;#457 的守卫只逼 POST 归类(我自己留的口)。「信」「回退」都是事后补的。

**目标**:`Policy = compile(TierProfile, permissionMode)` 得到规范化的 `{fs, shell, network, mcpTools, askOn}`,执行者只见 Policy,每家声明自己**能执行哪几个维度**;做不到的维度 ⇒ 拒绝这个档(`guestSafe` 由此推导,不再手写)。一张「执行者 × 档位 × 模式」一致性测试。链接令牌改成**白名单**:路由声明里显式写 `link`,缺省只给设备。

### 3. 组装没有根:main.ts 是一个 1100 行的函数

- `bootDaemon`(`main.ts:153-1276`)+ 20 个签名各异的 `bootstrap/wire-*.ts` + `pipeline-deps.ts` 的 `buildPipelineDeps`(一个函数 1100+ 行)。
- 后绑定是症状:`internalApi.set*()` 25 次、`Ref` / `workbenchRef` / `reviewRef` 三种写法、注释里写着「避 TDZ」;关闭流程一半走 `LifecycleSet`、一半手写。
- **目标**:每个功能是一个 `DaemonModule {name, needs, provides, init(c), routes?, commands?, ticks?}`;`main.ts` 拓扑排序后 init,约 60 行。路由从容器懒取服务,不再有 setter 与 ref。

### 4. 「CC 什么时候主动开口」没有一个策略模块

- 五条主动发声的路(陪伴 tick、定时、提醒、信、早报 / 周报)各管各的闸:免打扰、频率、网络守护、微信降级各在不同处判;`tick-bodies.ts`(1303 行)实际成了策略模块,又夹着提示词文案、执行者选择、打猎 / 串门。
- `proactive-channel.ts` 是唯一干净的抽象(只管走哪条通道)。
- **目标**:`SpeechPolicy.request({kind, chatId, urgency, source}) → {allow, channel} | {deny, reason}`,统一管熄火开关、免打扰、按类 / 按天上限、网络守护、降级路由、一本外发账;主人亲手要的(提醒 / 定时)用 `urgency:'requested'` 明确绕过免打扰。各 tick 只产出「候选」,不再自带闸。`tick-bodies` 按生产者拆文件,文案进 `prompts.ts`。

### 5. 持久化与记忆没有规矩

- SQLite(83 次迁移、~70 张表,全在 1988 行的 `db.ts` 里)与 ~50 个手写的 JSON / JSONL / MD 状态文件并存;拆分没有规则(提醒在库里、日程在文件里;访客请求是 JSON、笔友信在库里)。没有统一的原子写 + 校验助手(已经出过 `account.json` BOM 的真机 bug)。
- 记忆至少 8 种表示(知识库表、memory.md、profile.md、knowledge.md、corrections.md、memory-log.jsonl、portrait.json…);观察与里程碑**库里一份、jsonl 一份**;哪份是源、哪份是派生没标。
- 迁移里为了迁就从 `user_version=9/26` 起的老测试夹具,加了一串「表存在才…」的守护 —— 生产逻辑在迁就测试。
- **目标**:运行时会变的状态一律进 SQLite;文件只留主人可手改的配置(persona / agenda)与凭据,经一个 `writeJsonAtomic(path, zodSchema)`。记忆的源只有知识库,`memory.md` 等是夜里生成的视图(放 `views/`,文件头标「生成物」)。迁移一版一个文件 + 生成的清单,测试夹具从真迁移起步。

### 6. 分层是纸面上的;大文件与平铺目录让边界无从执行

- `.dependency-cruiser` 说 core「无 I/O」,实际 52 个 core 文件直接 import `node:fs` / `child_process` ✔;daemon↔cli 双向缠绕(规则写着「以后再收紧」)。
- `src/daemon` 顶层约 120 个非测试文件平铺(phone-* / mobile-* 27 个、cli-* 、atelier-* …),depcheck 管不了功能边界。
- 171 行 ratchet 把 service.ts 逼成了单行塞 30 个可选依赖、一行 16 个方法 —— **量的是症状,换来的是更难读**。
- `conversation-coordinator.ts` 1624 行一个闭包装着四种对话模式 + 准入 + 失败策略 + 通知文案,还把 `'agy'` 硬编码进通用逻辑。
- 手机网页是 ~15 个共享全局变量的 js 文件拼接,受中继 420KB 帧预算限制到要删注释。
- `docs/architecture.md` 过时(还写「CC 不会自动建独立工作区」),入口文档有 INDEX / roadmap / 全景导图 / maintainer 四个。
- **目标目录**:
```
src/
  domain/     纯类型、状态机、解析、策略(禁 node:*)
  ports/      Store / Clock / Fs / Process / Net 接口
  adapters/   sqlite、fs、spawn、git、各执行者(唯一能碰 node:* 的地方)
  app/        用例:工作台、入站链、陪伴、社交
  surfaces/   daemon(http / ws)、cli(薄)、mcp —— 只经 app/ 访问,彼此不 import
  modules/    DaemonModule:workbench / phone / wechat / companion / memory / cli-sessions …
  plugins/    social(A2A / 笔友 / 串门)、atelier、customer-review、hunt、chatroom、pet:各自的路由 / 命令 / 表,可整块关掉
db/migrations/NNNN_name.ts + runner.ts + repair.ts
```

## 先做什么(按「风险 × 收益」排,每一步都能单独合)

**第一批:先堵会出事的(不等大重构)**
1. 执行者 × 档位一致性测试 + Cursor / Gemini / ACP 真正执行档案(做不到的维度就拒);Codex 聊天线程按档案显式设联网。—— 我
2. 链接令牌改白名单(读也要显式归类)。—— 我(#457 的续)
3. 错误码一张表(`errors.ts`),先消掉两份 `REWIND_409` 的漂移;桌面 / 手机 / 微信的文案与状态从表生成。—— 2a(工作台与审阅面板是它的)

**第二批:换骨架**
4. 路由注册表(`packages/protocol` 一张表生成 daemon allowlist、Tauri allowlist、App 客户端)。
5. `CommandRegistry`:把七套微信命令收成一套,intent 由注册表生成;`isOwner` / `say` 注入一次。
6. `DaemonModule` + 容器:main.ts 缩到几十行,去掉 setter 与 ref。
7. `Policy` 编译器 + `ExecutorDescriptor`:聊天 / 工作台共用一套执行者描述。

**第三批:收拾存储与边界**
8. `SpeechPolicy`;`tick-bodies` 按生产者拆。
9. 运行时状态进库 + `writeJsonAtomic`;记忆只留一个源,其余标生成物;观察 / 里程碑去掉 jsonl 双份。
10. `db.ts` 拆成一版一个文件;老夹具改从真迁移起步,删掉迁就测试的守护。
11. 目录按上面的目标重排;social / atelier 等进 `plugins/`;depcruise 规则改成机械的(domain 禁 node:*、surfaces 互不 import),用它替掉 171 行 ratchet。
12. `docs/architecture.md` 重写成一页当前的分层图;INDEX 作唯一入口。

## 要主人拍板的三件

1. **手机网页还留不留?** App 已经覆盖了大部分;网页受 420KB 帧预算和全局 js 限制,每个功能还要写第三遍。选项:(a) 只留配对页和最基本的看,功能都进 App;(b) 改成 esbuild 打包的模块 + 分块传输,继续三端并行。
2. **social / A2A、atelier、customer-review、hunt、chatroom 这些用得很少的功能**:收进 `plugins/` 可整块关(推荐),还是直接删一部分?
3. **重构期间的节奏**:第二、三批会大面积改文件、和新功能撞车。建议先冻结新功能一段,两路按上面的归属分头做,每批合完部署一次。

## 好的地方(保留)

入站 intent 路由与「缺探针就开机失败」;工作台按域拆 + 持久化 store;`proactive-channel` 只管通道;`lib/provider-error-code` 已把各家错误归成码;`packages/protocol` 的 zod schema 与「能 z.string() 就不 enum」的前向兼容规矩;mcp-servers 不碰 daemon 的边界守得住;bun / node 双跑与真机自检(self deploy / selftest)这套交付纪律。
