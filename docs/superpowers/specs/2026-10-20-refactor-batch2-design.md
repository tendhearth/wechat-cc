# 重构第二批「换骨架」—— 设计稿

> 2026-10-20 · 接 [架构审查](../../architecture-review-2026-10-20.md)。主人拍板:微信收敛到「对话聊天 + 简单做事」,整体掌控 / 多 agent 放软件;少用功能进插件;停新功能分三批。第一批(#463 链接白名单、#464 执行者 × 档位表、#465 / #466 错误码一张表)已完成。
> 这一批的原则:**一处声明,其余生成**;每一步合进去时用户看到的行为不变(除了下文「顺手修掉的 bug」和主人点头的「收敛」),靠快照测试证明。

## 0. 这一批解决什么

| 现在 | 之后 |
|---|---|
| 微信命令 77 条、9 套分发(intent 探针、`chainReplyHandlers`、`command-router`、`admin-commands` 40 条正则、`mode-commands`、`wechat-control`、访问闸…),顺序靠人记 | 一张 `CommandRegistry`,入站只有一站「命令」,冲突由测试抓 |
| 手机路由 8 份清单、桌面路由 5 处登记、settings-panel 30 个 `url.pathname ===` | 一张路由表(`packages/protocol`),daemon 的 allowlist、Tauri 白名单、客户端类型都从它生成 |
| `main.ts` 一个 1100 行函数 + 25 次 `internalApi.set*` + 三种 ref | 功能模块声明「需要 / 提供」,启动按依赖顺序装配,main 几十行 |
| 聊天 / 工作台两套执行者能力词汇、每家 3 个适配器 | 每家一份 `ExecutorDescriptor`(这一批只做描述与注册,适配器合并放第三批) |

## 1. 命令注册表(WeChat)

### 1.1 形状

```ts
interface Command {
  id: string                      // 'task.status'、'jobs.add'、'set.quiet' …
  who: 'owner' | 'admin' | 'any' | 'stranger'
  match(text: string, ctx): Match | null   // 只读;不许有副作用
  run(match, ctx: CommandCtx): Promise<Reply>
  needsModel?: true               // 只有真要调模型的才标(管家指称解析)
  surface: 'wechat' | 'software'  // 见 1.3;software ⇒ 微信回一句「到 App / 电脑上做」
  examples: string[]              // 喂冲突测试与 /help
}
interface CommandCtx { chatId; tier; isOwner; say(text); log; services: … }   // isOwner / say 注入一次
```

### 1.2 入站流水线里只有一站「命令」

- 现在的 `route → consume` 两站与 `INTENT_ORDER` 收成一站 `mw-command`:按注册表逐条 `match`,**最多一条命中**;没命中才进对话。
- **不调模型的命令排在「模型是否健康」那一站之前**,也不付 recall(向量检索)的钱。`needsModel` 的(管家指称解析)留在后面。
- `who` 不够的:回一句「这条只有主人能用」,不再静默吞掉。
- trace:每条入站记下命中了哪个 `id`(或「对话」)。

### 1.3 收敛:哪些留在微信、哪些引去软件(主人拍板「微信保持对话聊天和简单做事的感觉」)

**留在微信(简单做事)**:
- 任务:列表、看状态 / 结果、补充 / 继续、停止、批准 / 回答(y/n 码)、提醒开关、新建(含「独立」「issue N」)
- 管家:「那个怎么样」「停了吧」「等恢复」这类自然说法
- 定时、早报 / 周报偏好、日历、做过的事、日报、终端会话列表 / 看码 / @码
- `/set` 这一族(每个对话自己的偏好)、`/cc /codex …` 切执行者、`/whoami /name /help`
- 配对、访客批准 / 邀请码、自改、`/health`、`/update`、`/reset`

**引去软件(整体掌控 / 多 agent)** —— 微信上仍认得这句话,但回一句「这件事在 App / 电脑上做:……」并给出打开方式:
- 两家对比(新建 / 并排看)、请 X 审、改动详情、记成经验、项目经验的增删、工作区的提交 / 合回 / 删除 / 重开、取成果文件 / 正文分页
- `/both /chat` 多家同答 / 圆桌

> 这一节是**我按主人那句话做的划分**,PR 之前请主人过目;任何一条想留在微信,改 `surface` 一个字段就行。

**进插件(默认关)**:手(配对手 / 派手 / 有哪些手)、背包 / 猎物、串门、回信、派 / 取消心愿、认识 / 同意介绍、`/hearth`、清理 bot。

### 1.4 冲突测试(取代「顺序靠人记」)

- 每条命令的 `examples` + 一份「普通聊天」语料(真机里常见的句子:「@codex 帮我看看」「看 README」「早报那个能不能早点」「1」…)。
- 断言:每个例子**恰好**命中它自己的命令;普通聊天一条都不命中。两条命令同时命中同一句 ⇒ 测试红,写明是哪两条。
- 先用现在的 77 条跑一遍,记成基线(现有冲突照实列出),逐条修。

### 1.5 这次清点发现、顺手修掉的 bug(用户可见,单独列)

1. 单发 `/cli`、`/today`、`/visit` 永远不管用:`/词` 一律先被 mode 截走,回「不认识」。
2. 模型挂了时,配对 / 允许访客 / 邀请码 / 待批准 / 串门 / 回信也用不了(它们排在「模型健康」之后),只会回「我现在暂时没法思考」。
3. 主人写「@codex 帮我…」「@claude …」会被当成会话码,回「没见过会话码」;「看 README」同理。
4. 非主人说「背包」「看记忆」这类,被静默吞掉,没有任何回复。
5. 「早报 …」「经验 …」开头的普通聊天被当成命令吃掉。

## 2. 路由注册表(桌面 + 手机)

### 2.1 一张表

```ts
// packages/protocol/src/routes.ts
route('POST /v1/matter/say', {
  surfaces: ['desktop', 'phone'],   // 同一个处理器,两种令牌
  tier: 'admin',
  link: 'none' | 'read' | 'write',   // 只对手机有意义;缺省 'none'(只给设备)
  req: zod, res: zod,
  errors: ['workbench_busy', …],     // 引用 workbench-errors 表
})
```

- **一个命名空间**:手机的 `/m/api/*` 与桌面的 `/v1/*` 指向同一批处理器(现在两套平行路由族、同一个 MattersService)。旧路径先保留一层别名,App / 网页换完再删。
- 从表里生成:daemon 的 `ROUTE_MIN_TIER` / `routeAllow` / `PHONE_ROUTES` / `LINK_READ_OK` / `LINK_WRITE_OK`;Tauri 的 `lib.rs` 白名单与 `workbench-proxy.ts`(build 时生成一份 JSON);App 与桌面的类型化客户端(`createClient(routes)`)。
- 一层统一的 HTTP:鉴权(令牌种类 + 档位 + link)、JSON 解析、zod 校验、错误码 → 状态都在这里;`settings-panel.ts` 的 30 个 `url.pathname ===` 和 7 个 `mobile-*.ts` 的手工解析收成处理器函数。
- 守卫测试换成一条:生成物与表一致(快照)。

### 2.2 跟手机网页收敛的关系

wechat-cc-2a 在列网页收敛清单(只留配对 + 在不在 + 一起做列表)。路由表落地时,被收掉的页面对应的路由直接不进表;标「私事,收敛时再看」的 9 条读路由一并定掉。

## 3. 功能模块与装配(DaemonModule)

```ts
interface DaemonModule {
  name: string
  needs: string[]                    // 依赖的服务名
  provides: Record<string, unknown>  // 本模块对外的服务
  init(c: Container): Promise<void> | void
  commands?: Command[]               // 进 CommandRegistry
  routes?: RouteHandlers             // 进路由表
  ticks?: Tick[]                     // 进调度(第三批的 SpeechPolicy 接这里)
  stop?(): Promise<void>             // 关闭时按倒序调用
}
```

- 启动:按 `needs` 拓扑排序,依次 `init`;有环 ⇒ 启动失败并写明是哪几个模块。`internalApi.set*` 与各种 ref 都去掉(路由从容器取服务)。
- 关闭:按倒序调 `stop`,不再一半手写一半 `LifecycleSet`。
- 模块划分(第一版):`wechat`(ilink / 收发 / 入站流水线)、`workbench`、`matters`、`phone`(配对 / 令牌 / 中继)、`companion`(陪伴 tick)、`memory`、`jobs`(定时 / 早报 / 周报)、`cli-sessions`(终端会话)、`calendar`、`letters`、`selfmaint`(自改 / 自检 / 升级);插件:`social`、`atelier`、`customer-review`、`hunt`、`chatroom`、`pet`。
- 目录:`src/daemon/modules/<name>/`(index.ts 导出模块,其余文件跟着搬);顶层平铺的约 120 个文件归进去。

## 4. 执行者描述(ExecutorDescriptor)

- 每家一份:id、显示名、对端、登录提示、`chat?` 能力、`workbench?` 能力、错误分类、档位执行方式(第一批的 #464 表直接从这里读)。
- `bootstrap/providers.ts` 那段每家一套的 if 梯子(探测 / 注册 / 重试 / 晚注册)改成对描述表循环。
- 这一批**只统一描述与注册**;「每家 3 个适配器合成一个」「Policy 编译器」放第三批,避免一次动太多执行路径。

## 5. 怎么证明行为没变

- 入站快照:真机常见的 200 条消息(含 77 条命令的例子)× 主人 / trusted / 访客,记录「命中哪条命令 / 进对话 + 回了什么」;重构前后逐条一致(1.5 的 bug 修复单独标出)。
- 路由快照:生成的 allowlist / 白名单 / 状态码表与重构前逐条一致。
- 启动快照:模块装配后,`/v1/health` 与 selftest(workbench / chat)PASS。

## 6. 顺序与分工(每一步单独可合、合完部署 + 自检)

| 步 | 内容 | 谁 | 依赖 |
|---|---|---|---|
| 1 | 入站快照 + 冲突测试基线(只加测试) | 我 | — |
| 2 | `CommandRegistry` 骨架 + 把 `chainReplyHandlers` 和 `command-router` 那 11 条搬进来;修 1.5 的 2 | 我 | 1 |
| 3 | 其余命令搬进来(admin / mode / onboarding / permission-reply / 访问闸);修 1.5 的 1、3、4、5 | 我 | 2 |
| 4 | `wechat-control` 拆成注册表条目 + 微信收敛(1.3,主人过目后) | wechat-cc-2a(工作台是它的) | 3 |
| 5 | 路由表 + 生成物 + 统一 HTTP 层(先手机,再桌面) | wechat-cc-2a(三端界面) | — |
| 6 | `DaemonModule` + 容器;main.ts 缩短;目录归位 | 我 | 3 |
| 7 | `ExecutorDescriptor` + 注册循环 | 我 | 6 |
| 8 | 插件化:social / atelier / customer-review / hunt / chatroom / pet 进 `plugins/`,默认关 | 我 | 6 |

步 5 与步 1–4 可以并行(一个动入站、一个动 HTTP);步 6 开始前两边都要合干净。整批预计一周多,期间不接新功能。

## 7. 要主人过目的

1. **1.3 的划分**:哪些留在微信、哪些引去软件、哪些进插件。
2. **1.5 的五个 bug** 修了以后,行为会变(变成该有的样子)。
3. **插件默认关**:关掉以后,手 / 背包 / 串门 / 回信 / 心愿 / 介绍 这些在微信上会回「这个功能没开,到设置里打开」。
