# Tendhearth CC 架构:一页现状图

> 2026-10-25,架构终态 A–F 大部分落地之后。这一页只说**现在是什么样、每类东西的唯一来源在哪**。为什么这样定看[架构复查 2026-10-21](architecture-review-2026-10-21.md)(五条理念)和各设计稿;2026-07 起陪伴路径的长版说明在 [`reference/architecture-companion-2026-07.md`](reference/architecture-companion-2026-07.md)(历史)。数字型事实(迁移条数、命令条数、执行者家数)这里一律不写,写「去哪看」。**往哪收、终态长什么样**看[架构终态与升级计划 2026-10-25](architecture-end-state-2026-10-25.md)。

## 一句话

CC 是住在主人自己电脑上的一个 daemon。微信、桌面、手机 App、浏览器都是同一个 CC 的入口;daemon 管会话、执行者、权限和记忆,数据留在本机。

## 一张图

```text
 微信(ilink)   桌面(Tauri)   手机 App(Expo)   浏览器 / PWA          另一台 CC(A2A / 笔友信箱)
     │               │               │  └── 中继(apps/relay)──┐            │
     │               └──── internal API(packages/protocol 的路由表)◄──────┘            │
     ▼                                   │                                              │
 入站流水线(src/daemon/inbound/build.ts) │                                              │
   └─ 命令表(commands/registry.ts)── 没人认领 ──► 对话协调器(app/coordinator/)
        task · admin.* · mode.* · …            │        └─ 会话管理(app/session-manager.ts)
        · control.*                            ▼
                                     执行者登记(app/provider-registry.ts)
                                       Claude · Codex · Cursor · 自定义 AI 服务 · Gemini · agy
                                       └─ 工作台(features/workbench/,「一起做」)按登记跟上
 
 CC 主动开口 ─► SpeechPolicy(src/daemon/speech/)─► 微信 / App;免打扰、断线排队、记账
 一切状态 ──► 本机:SQLite(src/lib/db.ts)+ 状态文件(src/lib/json-file.ts)+ 记忆目录(memory/<chat>/)
 一切子系统 ─► DaemonModule 容器(src/daemon/modules/container.ts):启停成对,关机顺序 = 启动倒过来
```

入口是 `src/daemon/main.ts`:地基(`foundation.ts`:锁、db、几个必须共享的单例)+ **一个**模块容器,模块表在 `src/daemon/daemon-modules.ts`(只列模块;每个模块怎么接写在它旁边的 `module.ts`:功能在 `src/features/<名>/module.ts`,平台在 `src/daemon/<块>/module.ts`)—— 表的顺序 + `needs` 就是开机顺序,关机严格倒过来(`__e2e__/shutdown-order` 快照钉住);晚到的东西只经 `lazy` / `ctx.late` 拿。bootstrap 是其中一组模块(`bootstrap/index.ts` 的 `bootstrapModules`:基础 → 知识库 → 核心 → 自重启 / 空闲清扫 / 社交 / A2A / 配对 / 乙 → 拼回 `Bootstrap`),每一块的接线仍在 `src/daemon/bootstrap/wire-*.ts`。

## 分层:谁能依赖谁

```text
apps/*  ──HTTP──►  packages/protocol(路由表、错误码,纯数据)
src/cli ──spawn / HTTP──►  src/daemon ──► src/features ──► src/app ──► src/ports / src/domain ──► src/lib
                          src/daemon / src/features ──► src/adapters(executors / store / workbench / git / a2a / mailbox / knowledge …,实现 ports;src/app 不直接依赖它)
src/mcp-servers ──HTTP──►  src/daemon(internal API)
```

- `src/lib`:最底层,零业务依赖(可以用 `node:*`);事实表、文件写法、db、运行时适配。
- `src/domain`:纯规则 —— 档位与放行(`policy` / `user-tier` / `tool-decision` / `provider-policy`)、开口(`speech/decide`、`quiet-hours`)、伙伴判定、提示词(`prompt-builder`)、能力表。**零例外**:运行时只依赖 domain 自己和 lib 里不碰 I/O 的,不碰 node 内置(depcheck `domain-is-pure` / `domain-no-node`)。
- `src/ports`:接口 —— 执行者的口(`agent-provider`)、微信的十个窄口(`wechat.ts`:send / permissions / pages / link / contacts / accounts / companion / voice / polling / workbench;模块 `needs` 口名,只拿那一片,没有谁拿整个 ilink 适配器)、陪伴的贡献点(`companion-contributions.ts`),以及 app 认 adapters 用的形状(E5):`a2a`、`mailbox`(含配对加密口 `PairingCrypto`)、`penpal-channel`、`session-store`、`conversation-store`、`cli-session`、`knowledge`、`matters`、`workbench`。只依赖 domain 与纯 lib。
- `src/app`:用例 —— 对话协调器(`coordinator/`:`planTurn` / `admit` 一轮定一次档位,`TurnRunner` 三种派法共用)、会话管理、执行者登记、「一件事」服务(`matters/service.ts`)、终端会话的事件判定与权限中继(`cli-events` / `cli-permission-relay`)、配对、关系视图、乙(`yi-hub` / `yi-hand`)、A2A 委派、知识库的一轮(`knowledge/`)。不往上依赖、不碰 node(随机 id 经 `lib/random.ts`),**只经 ports / domain 认 adapters**(depcheck `app-does-not-reach-up` 零例外,只引类型也不行):要 node 的小工具在 lib(`claim-paths`、`content-hash`),配对的加解密由 `daemon/bootstrap/wire-pairing.ts` 经 deps 注入。
- `src/adapters/executors/<家>`:各家执行者的适配器(对话侧 + 工作台侧),实现 ports;不往上依赖 app / daemon。
- `src/adapters/store`:通用的 store(对话、会话、会话状态、回合记录、终端会话、「一件事」、定时任务、信道、A2A 事件、背包、记忆目录 MemoryFS …);`store/workbench/` 是工作台的 store 与它的子表。同一条 `adapters-implement-ports` 规则。
- `src/adapters/` 其余:`workbench/`(工作台的文件层、附件、成果、原生历史、权限 / 提问登记、文件夹占用 …,执行者和工作台功能共用)、`git/`(独立工作区)、`a2a/`(A2A 传输)、`mailbox/`(信箱客户端与加密)、`knowledge/`(知识库的 store、来源、嵌入子进程)、`cli-upgrade/`(探外部 CLI 的版本与布局)、`permission-rules/`(放行规则:路径归一靠 `node:path` 的 posix / win32 解析,所以不在 domain)。
- `src/core` 已于架构终态 E3 清空删除(`core-no-node` 守卫一并删掉,换成上面这些目录各自的 depcruise 规则)。
- `src/features/<名>`:一个功能一个目录(见[加一个功能](maintainer/add-a-feature.md)):日历、提醒、信、定时、回报、画室、贴纸、打猎、背包、语音、终端会话、社交、记忆、手机、工作台、陪伴。功能自己挂路由(`internalApi.mount`)、自己是模块;别的功能经 `needs` / 窄导出用它,陪伴经贡献点接各家的候选与自省步骤。
- `src/test-support`:测试替身(照剧本说话的假执行者),生产代码不许 import。
- `src/daemon`:「怎么接起来」—— 入站、命令、internal API、模块、定时。
- 规则在 `.dependency-cruiser.cjs`(`bun run depcheck`),不是靠人记。

## 唯一来源:每类东西只在一处声明

| 东西 | 唯一来源 | 推导出来的 / 守着它的 |
|---|---|---|
| 执行者有哪几家 | `src/lib/provider-ids.ts` | 下面每张表的键都要和它相等(各自测试) |
| 执行者「是什么」:名字、斜杠词、模型字段、安装提示、密钥、怎么判在不在 | `src/lib/executor-facts.ts`(判在不在只在 `executor-detect.ts`) | 三端显示名、`/help`、doctor、guard;`executor-detect` 守卫拦手写判断 |
| 执行者「能做到什么」:四件事各靠什么收住(confines)、MCP 档位 | `src/domain/provider-capabilities.ts` | `guestSafe` 从 confines 推;访客能用谁由 `provider-policy.ts` 一处判 |
| 一次工具调用:放 / 问 / 拒 | `src/domain/authorize.ts` 的 `authorize()` | 各家逐工具回调、工作台、终端会话、定时任务闸门都只调它;主人的放行规则在终端、一起做、主人自己的对话里生效(红线照旧问,对话里放了会说一行) |
| 档位 × 模式 → 执行者实际设置 | `src/domain/policy.ts` 的 `compilePolicy` | 全表快照;每家每档每类工具实际怎样由 `src/domain/enforcement-matrix.ts` 从 `authorize` / `providerDenialFor` / `compilePolicy` 推出来,也钉快照(问不了于是放行的,主人切过去时照实说) |
| 执行者登记 | 对话侧 `bootstrap/providers.ts` 登记一次 | 工作台按 `onRegister` 跟上,不抄快照;可执行文件路径经登记项的 `bin()` 现取 |
| 路由:路径、谁能调、属于哪个模块 | `packages/protocol/src/routes.ts`(App 调手机接口经 `phone-calls.ts` 的类型化客户端,不手写路径) | 鉴权表、模块门、`gen:routes` 生成物、桌面白名单;`route-registry` 守卫 |
| 错误码 → 各表面的状态与说法 | `packages/protocol/src/workbench-errors.ts` | 桌面 / 手机 / 微信的映射都核它 |
| 微信命令 | `commands/registry.ts` 一张表,顺序就是优先级 | 各族(admin / mode / control)行两两互斥;路由快照记每句落到哪 |
| 子系统的启停 | `DaemonModule`(`modules/container.ts`),全部模块一张表 `daemon-modules.ts` | `daemon-module` 守卫数旧写法,只许少;main.ts 已清零 |
| CC 什么时候能主动开口 | SpeechPolicy(`src/daemon/speech/`) | `speech-send` 守卫按文件数发送调用 |
| 数据库迁移的顺序 | `src/lib/db/migrations/index.ts`(一版一个文件) | 文件名 = 位置;进了 `dev` 的一字不改(CI `migrations · frozen`) |
| 状态文件怎么写 | `src/lib/json-file.ts`(独立 tmp + fsync + rename;读不出来拒写) | `json-write` 守卫:新代码手写 tmp / 直写 JSON 就红 |
| 记忆目录里哪些是源、哪些是生成物 | `src/lib/memory-artifacts.ts` | 源一变生成物过期(主人删改 ⇒ 藏,只是多了 ⇒ 贴标签);合成只吃源;主人的更正清单 `corrections.md` 一路传到底 |
| 一个功能有什么(要什么、给什么、哪些路由 / 命令) | `src/features/<名>/index.ts` 的模块清单(样板:日历) | 路由表的 `module` 字段 + `internalApi.mount` 只认标给自己的;depcheck 管功能目录的边界 |

新加一样东西,先找它属于哪一行;找不到,说明要新开一张表,而不是在用的地方手写一份。「怎么加」:[功能](maintainer/add-a-feature.md)、[执行者](maintainer/add-an-executor.md)、[微信命令](maintainer/add-a-command.md)、[数据库迁移](maintainer/migrations.md)、[页面](maintainer/add-a-page.md)。

## 规矩交给机器

`scripts/*.guard.test.ts` 是守卫:每一条把一条规矩变成测试。新写守卫的习惯:先故意把被守的东西弄坏,看它红了才算数;扫源码时注释按行跳。大多数是**棘轮**(登记过的违规只许少,新文件出现就红),而不是一次改完。数违规条数,不数行数。

## 去哪看更细的

- 现在往哪走、欠什么账:[`roadmap.md`](roadmap.md)
- 某件事的文档在哪:[`INDEX.md`](INDEX.md)
- 怎么改、怎么验、怎么部署:[`maintainer/README.md`](maintainer/README.md)
- 「一起做」(工作台)的能力与边界:[`cc-workbench.md`](cc-workbench.md)
- 定了什么、为什么、否决过什么:[`全景导图.md`](全景导图.md)
