# 架构终态与升级计划(2026-10-25)

> 主人 10-25:「项目架构是否清晰,实现优雅,对标现有产品」→「不希望是补丁,希望是清晰的,你再 review 下,写好后续升级计划」→「设计好后,按照计划继续完成,中途不要打扰我」。
> 做法:三路只读审查(daemon 组装与功能组织、core 与执行者、接口 / 三端 / 状态),关键结论我对源码核过(文中数字都是 dev `6a5fc89a` 上量的)。对照 [10-20](architecture-review-2026-10-20.md)、[10-21](architecture-review-2026-10-21.md) 两份复查。
> 这一份取代 10-21 第三批里**还没做完**的那几步的做法;已经落地的(四张表、SpeechPolicy、状态文件写法、迁移一版一个文件)照旧。

## 一句话结论

三份复查找到的是同一种病,前两批给它开的是**守卫**,没换**结构**。守卫数的是症状(`node:` 这个字符串出现几次、一个函数里套几个内函数、某个调用出现几次),代码放在哪、一个功能怎么接进来、一个执行者有几套实现,这些没变。结果是每条规矩都带一张例外表,而例外表只许少不许多 —— 这本身就是补丁的形状。

这一份定**终态**:代码按什么形状放、一样东西只有一种写法、每一步怎么算做完(旧机制删掉、守卫变成零基线的路径规则)。

## 现在的样子(量出来的)

| 方面 | 现在 | 为什么算结构问题 |
|---|---|---|
| 功能怎么接进来 | 启停五种写法(`lc.register` / `teardown.add` / `phoneLc.add` / `sup.start` / 单模块容器 ×13),晚绑定六种(`Ref`、`{current}`、`let`、`provide` ×25、setter、`bootRef?.x ?? null`);容器的 `needs` 全仓只用了一次(`bootstrap/social-module.ts:50`) | 新人照着抄,会抄到六种里的随便一种 |
| 依赖包 | `InternalApiDeps` 111 个字段、`Bootstrap` 49、`WireMainOpts` 约 35;68 个不同的 `*_not_wired` 错误码 | 「还没接上」被拆成 68 种说法;每加一个功能,三个包各加几个字段 |
| 一个功能在哪 | 删掉打猎要碰约 18 处,画室约 15,信约 13,工作台约 15,手机约 40 个平铺文件;没有一个功能能「删一个目录就没了」 | 「少用的功能收成可选模块」(10-20 拍板)落不了地 |
| 执行者 | 对话和工作台共用 `AgentProvider` 一个口,但 Codex(SDK vs app-server)和 OpenAI 兼容(自建循环 vs 文件工具会话)各有两份实现;便宜模型 / 强模型的一次性调用散在几处(`cursor-eval.ts`、`codex-cheap-model.ts`);脚本化的测试替身放在生产代码里 | 接一家新执行者时,该照哪一份抄说不清;两份实现的行为会慢慢分叉 |
| 权限 | `compilePolicy` 是一张翻译表,但 Claude 对话不走它(`tierProfileToClaudeSdkOpts` + 自己的 `canUseTool`),Claude 工作台在 `features/workbench/wire.ts`(原 `wire-workbench.ts:63-73`) 又手写一套;逐工具判定在五处;主人的放行规则只接了终端会话和一起做 | 「这一步能不能做」没有一个地方说了算,只能靠表格**描述**缺口(`tier-enforcement.ts`) |
| core 层 | 276 个文件里约 126 个是适配器(起进程、写文件、SDK、直接 SQL);`core-no-node` 守卫只数 `node:` 字符串,把 `node:child_process` 换成 `lib/runtime/process` 就过了 | 守卫在洗白,不是在分层 |
| 协调器 | `createConversationCoordinator` 一个 1200 行闭包;档位 / 准入在七处重算;回复交付新旧两条路并跑(`shadow` 12 处) | 按函数拆文件(#605 的稿子)会把纠缠原样搬进六个文件 |
| 接口 | `routes.ts` 273 条只管鉴权;请求 / 响应的 schema 一半在 daemon(`internal-api/schema.ts:774`,约 48 条)、一半在协议包(`PHONE_API_SCHEMAS`);`/m` 与 `/set` 是 `url.pathname ===` 链(`settings-panel.ts` 28 处);没有生成的客户端 | 三端各自手写路径;同一份数据两份契约(`/v1/matters` 无 schema、`/m/api/matters` 有) |
| 桌面 | 2.2 万行纯 JS,26 个文件没 `@ts-check`,直接改 DOM;调 daemon 四种方式(直连、`workbench_api` 代理、`customer_review_api` 代理、起 CLI 读 JSON);Rust 里七处各自找状态目录 | 改一个接口,桌面那边没有类型会红 |
| 记忆 | 约 18 种表示(14 个记忆文件 + 三张表 + `facts.db` / `graph.db`);知识库四个 SQLite 自己建表、就地补列,不在迁移框架里 | 「CC 对主人知道什么」没有一个源 |

**同类产品是怎么做的**(上一份已经列过,这里只取结构那一半):VS Code 的扩展、Home Assistant 的集成都是「一个目录 + 一份清单,装上即接线、拔掉即无」;Codex 把权限编成两个正交轴,执行时只认编译结果;Claude Code 的 allow / deny / ask 是一份配置、一个判定;tRPC / ts-rest 这类做法是「契约声明一次,服务端处理器和客户端都从它推类型」。Paseo、Orca 这层编排工具都小而专 —— 它们没有我们这么宽的功能面,所以更需要「功能能整块拔掉」。

**做得好的,保留**:分层规则真的在跑(depcruise 的 no-circular 是 error);错误码到每家边界产码(`lib/provider-error-code.ts`);DaemonModule 容器本身的设计(init / start / stop 三段、降级、`lazy` 显式);App(`apps/app`)的 `Backend` 接口 + demo / live 双实现 + 协议包推类型;18 万行代码只有 26 处 `as any` / `@ts-ignore`。

## 终态:六条结构决定

### 1. 目录就是分层

```
src/domain/      纯规则:档位、Policy、模式、讨论主持、一件事的模型、放行判定、免打扰……
                 规则:不 import 任何 I/O(node:*、lib/runtime、SDK、db)。depcruise 判路径,零例外。
src/ports/       接口:Executor、Store、Transport、Clock、Spawner、DeliveryPort……
src/adapters/    实现接口的东西:executors/<家>/、store/sqlite/、git/、ilink/、fs/
src/app/         用例:协调器(一轮怎么跑)、工作台服务、记忆合成。只依赖 domain + ports。
src/features/<名>/  一个功能一个目录,出口只有一个 feature 清单(见第 2 条)
src/daemon/      壳:地基(锁、心跳、db、守护)、容器、HTTP、信号。main.ts 只列模块。
src/lib/         最底层工具(保留)
```

`core-no-node` 这类数字符串的守卫删掉,换成 depcruise 的路径规则:`domain` 不许依赖 `adapters` / `daemon` / `lib/runtime` / SDK 包;`app` 不许依赖 `adapters`(只经 ports);`features/<a>` 不许 import `features/<b>` 的内部文件。**规则一上就是零基线** —— 搬完一块再给那块开规则,而不是先开规则再记一张例外表。

### 2. 一个功能 = 一个目录 + 一份清单

```ts
export default feature({
  name: 'letters',
  needs: ['speech', 'store'], wants: ['phone'], lazy: [], optional: true,
  enabled: () => cfg.letters,               // 一件事只有一个开关
  init(ctx) { … return provides },          // 只造和登记(ctx.interval / ctx.own)
  routes:   { 'GET /v1/letters': h, … },    // 键必须在 packages/protocol 的路由表里,且标了 module: 'letters'
  commands: [ … ],                          // 优先级仍按全局一张顺序表(commands/order.ts),快照钉住
  promptSections: [ … ],                    // 取代 main.ts 里给提示词拼的 15 个 thunk
  settings: [ … ],                          // 这个功能自己的配置键
  mcpTools?: [ … ],
})
```

- 容器把各模块交出的东西收拢:HTTP 在 start 段挂处理器,命令表按顺序表排序,提示词拼装吃 `promptSections`。
- 模块关着或降级 ⇒ 它的路由统一回 `module_unavailable`(带模块名和原因,从容器状态来),68 个 `*_not_wired` 收成这一个。
- `InternalApiDeps` / `Bootstrap` / `WireMainOpts` 三个大包消失:处理器从自己模块的 `init` 闭包里拿依赖。
- `main.ts` 只剩:地基 → `startModules([...PLATFORM, ...FEATURES])` → 信号。目标 150 行以内。
- `IlinkAdapter`(37 个方法)拆成窄口:传输、权限卡、语音、页面。不拆的话所有功能都 `needs: ['ilink']`,耦合只是换了个地方。
- 陪伴的定时(`tick-bodies`)直接调打猎 / 贴纸 / 画室 / 信,改成一个「陪伴候选」的贡献点:各功能交候选,陪伴只挑。不然打猎永远成不了目录。

### 3. 一个执行者 = 一个适配器

```ts
interface Executor {
  descriptor: ExecutorDescriptor        // 名字、端点、能力、能执行哪几维策略(已有 executor-facts / provider-capabilities 收进来)
  open(req: { cwd, resume?, policy: CompiledPolicy, tools, onPermission, onInput }): Promise<Run>
  oneShot?(prompt, opts): Promise<string>   // 取代 CheapEval / StrongEval 各自的实现
}
interface Run {
  events: AsyncIterable<ExecutorEvent>  // 一种归一的事件 + ProviderErrorCode
  send(input); steer?(input); cancel(); close(); nativeRef(): NativeRef | null
}
```

- 对话和工作台用的是**同一个**适配器,区别只在策略和事件送到哪(微信回复 / 工作台时间线)。
- 一张登记表。工作台不再自建 registry。
- 脚本化的测试替身(`claude-scripted.ts`、`codex-scripted.ts`、`acp/scripted-agent.ts`)搬出生产代码,实现同一个接口。
- 每家一个目录:`adapters/executors/<家>/{index,events,errors}.ts`。Codex 选一条协议(app-server,工作台已经在用、能力更全),SDK 那条退休;Claude 同理选 SDK 一条(工作台的 `claude-workbench-process` 是它的超集还是另一条路,搬的时候逐项核)。

### 4. 「能不能做」只有一个判定

```ts
authorize(subject, descriptor, action) → allow | ask | deny
```

- 档位、权限模式、主人的放行规则、地板(红线)、网络守护都在里面。
- 执行者只做两件事:把要做的动作**报上来**(`onPermission`),**照着** `compile()` 给的静态子集设置自己(沙箱、工具白名单)。
- 派发时:描述里做不到的维度 ⇒ 这一档拒掉(已有的 `provider-policy` 收进来)。
- `tier-enforcement.ts` 从「描述缺口的表」变成 `compile()` 的测试快照。
- **不改行为**:C2 收进 `authorize` 时放行规则照旧只在终端会话和一起做上生效(按 `subject.surface` 判)。对话要不要也走,是看得见的变化,单列等主人 —— 2026-10-25 主人点头,改成「主人自己的对话也走」,见进度表「C2 补 · 对话走放行规则」。

### 5. 协调器是一条流水线

```
admit(msg) → TurnPlan            纯函数:模式、参与者、编译好的策略,一次定完(今天在七处重算)
TurnRunner.run(plan, run) → TurnOutcome   超时 / 取消 / 进度 / 记账,所有模式共用一份
solo / parallel / chatroom        只编排 TurnRunner 的调用
DeliveryPort                      吃 TurnOutcome;旧的 / shadow 交付路删掉
```

取代 #605 按函数拆文件的稿子。

### 6. 契约声明一次,客户端生成

- 协议包每条路由:`{ method, path, 鉴权…, module?, req?: zod, res: zod }`。`internal-api/schema.ts` 搬进协议包。表仍然是纯数据,Rust 和 App 照样能读。
- daemon 用 `defineRoute(key, handler)` 挂处理器,类型从契约推;`/m`、`/set` 的 `if` 链换成查表。开发和测试时校验响应。
- 一个生成的类型化客户端(`api.matters.list()`),底下换传输:直连 / Tauri 代理 / 中继 v2。桌面、网页、App 都用它。网页切到 v2,v1 退休。
- Tauri 的两个代理收成一个 `daemon_request`,白名单从表生成;Rust 一个 `DaemonInfo` 模块代替七处找状态目录。
- 桌面不再为 daemon 已经提供的东西起 CLI(只留装服务 / 起停 / daemon 没起时的 doctor)。
- 桌面照 App 的形状逐页迁 TypeScript:`Backend` 接口、小 store、纯视图模型(`view.js` 已经是)。先要求每个文件 `@ts-check`,再一页一个 PR,desktop-e2e 兜底,先换 `api.js`。

### 7. 状态:主人的事实只有一个源(放最后)

- 主库里一张事实表(带状态、来源、更正),`memory.md` / 概览变成渲染出来的东西。`corrections.md`、输出时脱敏、`facts.db` 的 `set_fact_status` —— 三种「收回一句话」收成一种。
- 知识库的四个库进迁移框架,搬出 `core`。
- 这条碰主人看得见的记忆,动手前单独出设计稿;已有的「记忆改了算数」那一串([2026-10-23 设计稿](superpowers/specs/2026-10-23-memory-edits-stick-design.md))先合完,不和它抢。

## 做法:这一轮和前两批不一样的地方

1. **每一步有终点。** 一步做完 = 旧机制的代码删掉 + 守卫变成零基线的规则。不再出现「基线 17 行,以后慢慢降」。迁不完的那一步就不算开始,拆小。
2. **新代码只有新写法。** 新功能必须是 `features/<名>/`;新执行者必须实现 `Executor`;新路由必须带 `res`。旧写法的守卫只认「零」:新文件一出现旧写法就红,没有登记的口子。
3. **守卫量结构,不量症状。** 用 depcruise 判路径和依赖方向;删掉数字符串、数行数、数内函数的守卫(`core-no-node`、`workbench-service-ratchet`,以及搬完以后的 `daemon-module`、`speech-send` 的 primitive 行)。
4. **每一步行为不变。** 关机顺序、命令路由、回复交付都有快照,快照的 diff 逐行讲得出为什么。行为会变的单独成 PR,标「等主人点头」。
5. **搬家和改逻辑不在一个 PR。** 先搬(行为不变、测试一行不改),再改。
6. **新功能照样能进,但走新形状。** 这一轮期间,新功能要么写成 feature 模块,要么等它要用的那块搬完。

## 步骤

每一步单独合、单独部署(动 daemon 的),`self soak` 绿了再下一步。括号里是「做完怎么算」。

### 阶段 A:组装有根(先做,后面都靠它)

| # | 内容 | 做完怎么算 |
|---|---|---|
| A1 | 核心链 PR 6:五样收进一个容器,`needs` / `lazy` 声明;`speechRef`、`refs.polling`、`refs.pipeline`、`bootRef?` 删掉;internal-api 的 `daemon_starting` 门 + info 文件进 `onStart`;ilink 30 秒清扫进 `ctx.interval`;internal-api / 工作台降级(主人 10-23 已确认);开机顺序快照;抽出 `foundation()` | main.ts 的 `Ref` / `lc.register` / `sup.start` 归零;开关机快照逐行讲得清 |
| A2 | 其余启停全进容器:`wire-cli-sessions`、`wire-jobs`、`wire-idle-sweep`、`wire-phone`(7 个 `phoneLc.add`)、各处裸 `setInterval` 和自己续命的 `setTimeout` 循环(守卫顺手认 `setTimeout` 续命) | `daemon-module` 守卫基线清空 ⇒ 删掉 `LifecycleSet`、`Ref`、`SubsystemSupervisor`、收尾清单四样 |
| A3 | `DaemonModule` 加贡献字段:`routes` / `commands` / `promptSections` / `settings` / `mcpTools`;`module_unavailable` 一个码 | 容器收拢测试;协议表里 `module` 字段对得上处理器 |
| A4 | 样板功能:日历整块搬进 `features/calendar/`(约 6 处),写进「怎么加一个功能」 | 删掉 `features/calendar/` 后 typecheck 只在功能清单那一行红 |
| A5 | 逐个功能搬:提醒 → 信 → 定时任务 → 报告 → 记忆 → 语音 → 终端会话 → 工作台 → 社交 / 信箱 / A2A → 手机 → 陪伴(先做「陪伴候选」贡献点)→ 打猎 / 贴纸 / 画室 | 每搬一个,`InternalApiDeps` 少几个字段(守卫只许少);全部搬完,三个大包和 68 个 `*_not_wired` 消失,main.ts ≤ 150 行 |
| A6 | `IlinkAdapter` 拆窄口(和 A5 交错:谁搬到需要哪一口就拆哪一口) | 没有模块 `needs` 整个 ilink |

### 阶段 B:执行者一个口

> **2026-10-25 逐家核过之后改写**(初稿照审查结论写成「每家两三套」,说重了):对话和工作台本来就共用 `AgentProvider` /
> `AgentSession` 这一个口(工作台多一个可选的 `workbenchRuntime`),工作台那张登记表是跟着主表走的视图(`onRegister`),
> 便宜模型也已改走主表。真正「一家两份实现」的只有两家:

| 家 | 对话 | 工作台 | 现状 |
|---|---|---|---|
| Cursor | `acp-cursor-chat.ts` → `acp-agent-provider.ts` | `acp-workbench-provider.ts`(9 行,桥到同一个 ACP 客户端) | 已经一份 |
| Claude | `createClaudeAgentProvider` | 同一个,换工作台的 SDK 选项(`features/workbench/wire.ts` 的 `workbenchClaudeOptions`)+ `claude-workbench-runtime` 管长寿命 | 一份;选项的拼法要收进 C(权限一个判定) |
| agy / Gemini | 各自的 provider | 同一个(免审执行者) | 一份 |
| **Codex** | SDK(`codex-agent-provider.ts`,408 行) | app-server(`workbench/codex-app-server.ts`,902 行) | **两份** |
| **OpenAI 兼容** | 自己的循环 + MCP 桥(`openai-agent-provider.ts`) | 文件工具 + 持久会话(`workbench/api-task-provider.ts`) | **两份** ⟨10-25 B2 合成一种会话 `openai-session.ts`,见进度⟩ |

| # | 内容 | 做完怎么算 |
|---|---|---|
| B1 | Codex 对话改走 app-server(工作台那条已经更全:中途插话、后台任务、原生历史);SDK 那条退休。**先出逐项差异表**(中途插话、思考过程、工具调用显示、恢复会话、额度报错),有主人看得见的差异 ⇒ 攒进「等主人点头」 | `codex-agent-provider.ts` 删掉 |
| B2 | OpenAI 兼容:一个会话类型,工具面按用途配(对话 = 微信工具 + 内置工具,工作台 = 只有文件工具 —— 和 Claude / Codex 的工作台一样不给 `mcp__wechat__*`;10-25 更正,初稿写成「文件工具 + 微信工具」是错的);会话持久化统一用 `api-sessions` | 两份实现合成一份 |
| B3 | `oneShot` 收 CheapEval / StrongEval 的散实现(`cursor-eval.ts`、`codex-cheap-model.ts`);脚本替身(`*-scripted.ts`)搬出生产代码 | `src/` 里没有 `*-scripted.ts` |

### 阶段 C:权限一个判定(B 之后,适配器只报不判)

| # | 内容 | 做完怎么算 |
|---|---|---|
| C1 | `authorize()` 落地,先接工作台和终端会话(今天就走放行规则的两处) | `permission-gate` 只被 `authorize` 调 |
| C2 | 对话的逐工具判定(`permission-relay`、Gemini gate、openai gate、`wire-model-options`)全换成 `authorize` | 逐工具判定只有一处;Claude 工作台手写的 ask / deny 删掉 |
| C3 | `tier-enforcement.ts` 变成 `compile()` 的快照测试 | 那个文件没了 |

### 阶段 D:协调器流水线(不依赖 B;`admit` 做完后 C 接得更顺)

| # | 内容 | 做完怎么算 |
|---|---|---|
| D1 | 抽 `admit()` 纯函数,七处重算收成一处 | 协调器里不再调 `resolveTier` / `providerDenialFor` |
| D2 | 抽 `TurnRunner`,三种派法改成编排 | 超时 / 取消 / 进度只有一份 |
| D3 | 删旧的 / shadow 交付路 | 协调器里没有 `shadow` |

### 阶段 E:目录即分层(和 B–D 交错:每搬完一块就把它挪进新目录、开那块的路径规则)

| # | 内容 | 做完怎么算 |
|---|---|---|
| E1 | 建 `src/domain`、`src/ports`、`src/adapters`、`src/app`;先把已经是纯函数的文件(`policy`、`user-tier`、`chatroom-conductor`、`provider-policy`、`permission-rules/decide`、`quiet-hours`、`envelope`…)挪进 `domain`,开 depcruise 规则 | `domain` 规则零例外 |
| E2 | 执行者适配器(B 搬完的)进 `adapters/executors/`;store 进 `adapters/store/` | — |
| E3 | `src/core` 清空 | 删掉 `core-no-node` 守卫和 `src/core` 目录 |
| B1b | Claude 对话和一起做核过一遍(主人 2026-10-25 定:一家一条实现,直接改):**本来就是同一条路** —— 两边都是 Agent SDK 的 `query()`(流式输入),同一个 `provider.spawn`、同一份 `sdkOptionsForProject`(权限回调、MCP、档位)、同一套执行选择 / 续接 / abort / 端点捕获;`claude-workbench-runtime` 是在它上面加了进程组所有权、常驻、后台任务、逐字流、中途插话、事件预算,会话生命周期不同(一整段一个事件流 vs 一轮一个)。所以不硬合成一个会话类:对话搬到常驻那一边会丢 Windows(它拒 win32)、改掉回复分段和 `finalText`(看得见)。做了的:SDK 消息 → 事件的共用部分收进 `claude-sdk-messages.ts` 一份(用户消息内容 / 工具调用 / 活动标签与 detail 清洗 / 「API 失败 or 没登录」的判法 / API 失败的码和话),运行时不再靠 provider 注入 `helpers`;删掉对话循环里按 `workbenchTimeline` 开的时间线抄本(生产里只和 `workbenchLifecycle` 一起传过,走不到)和它的 6 条测试(时间线顺序 / 不抄输入 / detail 清洗 / 失败结果 / 错父结果这几条搬进运行时测试)。权限 / 档位一行没动(C3 快照不变)。逐项差异见下表 |
| B1b 补 | 一起做的 `is_error` 判定和对话对齐(主人 2026-10-26 定):result 标了 `is_error: true`、subtype 是 success、而这一轮没有带 `error` 标注的助理消息也没有哨兵 ⇒ 两边都收成 `provider_error`,同一个函数 `claudeResultFailure`(`claude-sdk-messages.ts`),对话的 spawn 和 `claude-workbench-runtime.ts` 都调它,没有第二份。一起做那边不推 result、带码收掉这一轮(和 SDK 标注的 API 失败同一个收法)⇒ 以前显示「完成」的这种回合现在是「失败」。工作台的码表 `taskErrorForProviderCode`(`src/adapters/store/workbench/execution-settings.ts`)给 `provider_error` 一个任务失败码 `provider_failed` 和一句人话(桌面 `apps/desktop/src/modules/workbench-execution.js` 有同一句的桌面版,微信完成通知说原因,原文跟在任务记录的那条错误后面);以前 `provider_error` 落成原文当 `task.error` —— Codex / Cursor 报的 `provider_error` 也跟着换成这句(仍是失败,只是说法)。测试:`claude-result-is-error.test.ts` 同一组 SDK 样本喂两边、结局逐条一样;`src/features/workbench/service-provider-code.test.ts` 管 `provider_error ⇒ provider_failed` |
| E4 | 工作台服务:`Options` 原样传成 `deps`(删掉那行 2245 字符的复制);十个域按依赖顺序构造,彼此依赖接口,`Ref<ServiceActions>` 删掉 | 删掉 `workbench-service-ratchet` 守卫;service 里没有 `Ref` |

### 阶段 F:契约与客户端(和 A–E 并行,碰的文件不重叠)

| # | 内容 | 做完怎么算 |
|---|---|---|
| F1 | 协议表每行加 `req` / `res`;`internal-api/schema.ts` 搬进协议包;没 schema 的路由补上 | 每条路由都有 `res`(守卫:零例外) |
| F2 | `defineRoute` + 查表分发;`settings-panel.ts` 的 `if` 链换掉 | 没有 `url.pathname ===` |
| F3 | 生成类型化客户端 + 可换传输;App 的 `live.ts` 先换(它已经用协议包) | App 里没有手写 `/m/api` 字符串 |
| F4 | 网页切 v2 传输,v1 退休 | 中继只剩 v2 |
| F5 | 桌面:`@ts-check` 全覆盖 → `api.js` 换生成的客户端 → Tauri 两个代理合成 `daemon_request` + `DaemonInfo` → 逐页 TS | 桌面没有手写 `/v1` 字符串;`lib.rs` 不再复制路径表 |
| F6 | 桌面里 daemon 已经提供的东西不再起 CLI | `wechat_cli_json` 只剩装服务 / 起停 / doctor |

### 阶段 G:记忆一个源(最后,先出设计稿)

见第 7 条;设计稿:[2026-10-25 记忆一个源](superpowers/specs/2026-10-25-memory-single-source-design.md)(切法 G0–G8 在稿 §3)。

## 顺序为什么这样排

- A 先做:后面每一步都要往「一个模块」里放东西,模块的形状不定,搬过去还得再搬一次。A1 的设计稿和主人的降级确认都已经有了。
- B 只剩两家要合(Codex、OpenAI 兼容),而且合的时候要真机核对行为差异,所以不挡别的:D(协调器)先做,`admit` 一处定档位以后,C 的 `authorize` 正好接在那里。
- E 跟着 B–D 走:目录挪动本身不改逻辑,在每一块搬完时顺手挪,不单独来一轮大挪动(大挪动会跟所有在途分支冲突)。
- F 碰的是协议包、`internal-api` 的处理器挂法、桌面和 App,和 A–E 的文件基本不重叠,可以并行。
- G 碰主人看得见的记忆,而且有一串在途的 PR,放最后。

## 等主人点头的(攒在这里,不中途问)

已定(2026-10-25,主人):
- ~~Codex 对话换 app-server~~:统一到能力强的那条、直接改(B1,差异表见进度);原则推广到每家执行者只留一份(B2、B1b)。
- ~~对话也走主人的放行规则~~:只在主人自己的对话里、红线照旧问、放了就在回复里说一行(C2 补)。
- ~~网页 v1 传输退休~~:直接退,老页面提示重新扫码配对(F4)。

已定(2026-10-26,主人:「1 好 2 好 3 好 4 照建议」):
- ~~F6~~:桌面剩下的 CLI 调用换成 `/v1`(接受 daemon 没起时那几样用不了)。
- ~~Claude 一起做的 `is_error` 判定~~:和对话对齐(B1b 补做了)。
- ~~Codex 对话逐条问~~:admin 的危险命令经 app-server `on-request` 问主人。
- ~~G 记忆一个源~~:设计稿 §4 五条全照建议。

## 和别的文档的关系

- [architecture.md](architecture.md) 是**现状**一页图,每一步做完照实更新;这一份是**终态和路线**。
- [10-21 复查](architecture-review-2026-10-21.md)的五条理念不变;这一份把理念 1、4、5 落成具体的目录和接口。
- [协调器拆分稿](superpowers/specs/2026-10-23-coordinator-split-design.md)被第 5 条和阶段 D 取代。
- [核心链设计稿](superpowers/specs/2026-10-23-core-chain-modules-design.md)就是 A1。

## 进度

| 步 | 状态 |
|---|---|
| A1 | 整个 daemon 一个容器(`foundation.ts` + `daemon-modules.ts`,main.ts 1062 → 约 190 行);main.ts 的 Ref / lc.register / sup.start 归零,关机顺序一位不变(#665)。`daemon_starting` 门与 internal-api / 工作台降级挪到 F2:降级要求所有用 internal-api 的模块改成 wants 并自己兜「没有」,换来的只是覆盖「127.0.0.1:0 绑不上」这种几乎不发生的失败;F2 重做路由挂法时顺手做最自然 |
| A2 | bootstrap 拆成一组模块进同一个容器(boot-base / knowledge / boot-core / self-restart / idle-sweep / social / mailbox-poller / a2a-server / pairing / yi / bootstrap);收尾清单、module-group 桥删掉;`enabled()` 能读上游 |
| A3 + A4 | 功能目录 `src/features/<名>/`:模块自己 `internalApi.mount` 路由(路由表 `module` 字段,关 / 坏 / 还没挂上 ⇒ module_off / module_degraded / module_starting);depcheck 三条边界;日历整块搬进去做样板,`InternalApiDeps` 少一个字段;[加一个功能](maintainer/add-a-feature.md) |
| A5 · 提醒 | `src/features/reminders/`(store / sweeper / routes / 模块清单),路由自己挂;重试退避挪到 `lib/delivery-backoff.ts`(任务回报共用,不再伸进提醒内部) |
| A5 · 信 | `src/features/letters/`(写、排版、调度、存档、手机只读页、路由、模块清单);`InternalApiDeps.letters` 去掉。定下功能的写法:功能声明它要的 `deps` 类型,组装的地方(daemon-modules.ts)从上游模块填 |
| A5 · 定时 | `src/features/jobs/`(命令、早报 / 周报、runner、手机页、模块清单:必需的 `jobs` + 可选的 `scheduled-jobs`);「做过的事」单独成 `activity` 模块;`ReplyHandler` 类型归命令平台(`commands/registry.ts`);容器新规矩:必需模块不许 needs 可选模块(开机就抛) |
| A5 · 画室 | `src/features/atelier/`(存画、想画什么、画笔:本机 sd-cli 旁车 / 托管接口、颜料下载、画一拍 `tick.ts`、路由、模块清单);`InternalApiDeps.atelier` 和两个 `atelier_not_wired` 去掉,路由自己挂、紧跟 internal-api。伙伴反省那一拍经 `makeAtelierTick` 调它,改配置的两处(`/v1/config/set`、设置面板)经 `index.ts` 踢颜料下载;模块清单只引 `InternalApi` 的 `mount`(引 internal-api/lifecycle 会和 routes-config 成环) |
| A5 · 贴纸 | `src/features/stickers/`(表情库、初始表情包、联网表情源、反馈、自己画、路由、模块清单);表情库不再在地基里造,`stickers` 是必需模块(搬家前造不出来也挡开机),bootstrap(提示词里的贴纸段)和 wired(手机页 / App 对话 / 自省)经 `needs` 拿它的 `lib`;`InternalApiDeps` 少 `stickers` / `stickerSource` / `stickerFeedback` 三项。自省那一步(`stickerArtistStep`,IntrospectStep 贡献点)归功能自己,登记表照旧。`/v1/turn/attach` 的表情附件留在回复交付那条通用路由里:按路由键经功能挂上的处理器发、经 `GET /v1/stickers` 预检 tag;tag 的比法进 `domain/sticker-tag.ts`(internal-api 不能反过来 import 功能目录,会成环) |
| A5 · 打猎 | 先查清楚:`journal` 表(背包)不是打猎独有的 —— 打猎、社交(串门见闻、明信片)、串门来客、回忆四路在写,桌宠、手机首屏、设置面板、微信「背包」在读。所以拆成三处:表的 store 进 `src/adapters/store/journal-store.ts`,地基里一份,字段 `huntStore` 改名 `journal`;`/v1/journal*` 六条路由进 `src/features/journal/`,自己挂,路由表标 `module: 'journal'`;打猎本身进 `src/features/hunt/`,包括陪伴候选 `huntAction`(tick-bodies 的候选表经 `index.ts` 登记)和「默认关」那次开机步骤(从地基挪进模块 init,仍排在 internal-api 之前)。`InternalApiDeps.hunt` 去掉,presence 只留一个窄口 `journal: Pick<Journal, 'summary'>`。几样有意留在原处:拆猎物的纯函数 `domain/hunt-catch.ts`;提示文字 `buildHuntText`(和推送、问候共用一套口吻常量和对照测试);chat-prefs 的 `hunt` 开关;calibration 的冷却、care-ledger 的登记、companion-plan 的候选名(陪伴层按动作 id 认);`outbound-taps`(它是发送路径上的通用旁听) |
| A5 · 语音 | `src/features/voice/`(合成器:自建网关 / 通义、统一超时、语音配置、路由、模块清单);`InternalApiDeps.voice` 和处理器里的 `voice_not_wired` 去掉(STT 三条在接口上是可选的,缺了照旧回),路由自己挂、紧跟 internal-api;和 TTS 共用同一个语音口的 STT 三条路由(`/v1/companion/transcribe`、`/v1/stt/*`)一起标 `module: 'voice'`。本轮回复的语音附件交付时经路由表复用 voice 模块挂的 reply_voice(和表情一样)。语音口本身(合成 → 经 ilink 上传发送、网络闸门、媒体镜像)还在 `ilink/voice.ts`、经 `index.ts` 拿合成器 —— 发送绑着 ilink 的 context_token 与账号路由,等 A6 拆窄口;入站转文字(`src/daemon/stt`、`mw-transcribe-voice`)不动 |
| A5 · 回报 | `src/features/reports/`(投递队列 outbox、ReportSink、投递那一拍 sweeper、模块清单)。工作台开在 wired 之前、投递要 wired 的开口那道门,所以拆两个模块:必需的 `report-outbox`(队列 + ReportSink,排在工作台前面,工作台 `needs` 它;搬家前队列在地基里造,造不出来照样挡开机)和可选的 `reports`(投递那一拍,名字和位置都没动,关机顺序快照不变)。地基少 `reportOutbox`;`wireWorkbench` 不再自己造 ReportSink,收的是 core 的口 `ReportSink`(`core/matters/report.ts`);读任务标题 / 成果数 / 静音用功能自己的一份 WorkbenchStore(db 上的一层查询,「放弃投递」留痕本来就是这么做的)。退避仍在 `lib/delivery-backoff.ts`(和提醒共用);没有路由 |
| A5 · 终端会话 | `src/features/terminal/`(hook 事件登记处、权限中继 + 放行规则、脑手转发、CC 代主人说一句、开着的窗口、手机拍板 / 说一句、推到 App、接上 hooks、「今天」两路来源、微信「终端 / 看 码 / @码」那条命令、路由、模块清单);模块名 `cli-sessions` 改成 `terminal`(还是必需的),`/v1/cli/event|permission|sessions|say|hooks/*` 和 `/v1/overseer/today` 九条路由自己挂、路由表标 `module: 'terminal'`,`InternalApiDeps` 少 `cliEvents` / `cliPermissions` / `terminalSay` / `cliHooks` / `overseerToday` 五项,六个 `*_not_wired` 换成模块门。微信那条命令和手机的拍板 / 说一句也在功能里造好,owner-commands、wired 经 `needs` 拿模块的值;工作台(放行规则那道门、撞文件夹)、「做过的事」(拍板记录、登记处)、定时(「今天」)同样经模块的值。几样有意留在原处:`src/core/cli-*`(纯逻辑,`wechat-cc hook` 子命令和工作台也用);`daemon/permission-gate.ts`、`daemon/permission-decisions-store.ts`(和工作台、「做过的事」共用,功能只是造它们的地方);`listSessions`(那是令牌登记处的会话,不是终端会话)。日历借的「起进程、到点掐进程组」那个 `defaultRunner` 经 `features/terminal/index.ts` 拿 |
| A5 · 社交 | `src/features/social/`(心愿 / 明信片、介绍、串门、笔友信件与信箱轮询、判官、来信分发、告诉主人的那一句、几条微信命令的解析、心愿 / 介绍的状态文件、路由、模块清单;从 core 搬 13 个、bootstrap 10 个、companion 2 个,加上 `daemon/social/owner-grounding.ts` 和 `routes-penpal.ts`)。`social` / `mailbox-poller` 两个模块的名字、开关、位置都没动(仍在 bootstrap 那一组里,由 `socialFeature` 交出;关机顺序快照不变)。路由表标了 `module: 'social'` 的 14 条(串门、心愿 ×4、介绍 ×4、笔友信箱 ×5)由 `social` 在 init 里自己挂,处理器里的 SOCIAL_MODULE_OFF 兜底删掉。`InternalApiDeps.social` 去掉,换成窄口 `socialView`(信道列表、信道往来只读、进行中的串门):只给不标模块的关系视图和桌宠的「在串门」用,由模块自己 `provide`;boot-api 不再碰社交。信箱里给对端叫名字仍经 A2A 服务那一侧(`a2a-server` wants social ⇒ 环边,`lazy` 现取)。有意留在原处:A2A 传输(`core/a2a-*`、registry / client / server —— 手、终端会话远程、delegate、`wechat-cc agent` 共用);配对(`core/pairing*`、`bootstrap/wire-pairing.ts`、`/v1/pair/*`:开关是 mailbox_relays 不是 social_enabled,CLI 直接用,路由不标模块,单成一个功能要先给路由标模块 —— 那会把 `pairing_not_wired` 改成 module_off,是看得见的变化)和它用的信道 / 信箱底子(`core/penpal-channel-store`、`penpal-crypto`、`mailbox-client`、`mailbox-crypto`、`self-agent-id`);`core/relationships.ts` 与关系视图 / 社交总开关 / 入站开关三条路由(社交关着也要能用);`core/a2a-disclosure.ts`(回忆那边也用它的超时);`Bootstrap.social` / `penpal`(命令表、伙伴的串门动作、socialState 经 `bootstrap` 拿,类型改从 `index.ts` 引) |
| A5 · 记忆 | `src/features/memory/`(每晚整理 `nightly*` 与它的文件格式、更正 / 今天的草稿、证据审阅、LLM 概览 / 画像 / 小像 `llm-ops.ts`、gardener、回忆 / 快照、导入记忆命令、提示词素材 `prompt-reads.ts`、路由、模块清单)。`InternalApiDeps` 少 `memory` / `memoryProjectsRoot` / `memoryLlm` / `memoryNightly` 四项(`LATE_KEYS` 少两个);十三条 `/v1/memory/*` 标 `module: 'memory'`,由必需模块 `memory` 自己挂,紧跟 internal-api(读 / 写 / 列 / 删四条以前在总表里,MCP 的 memory_* 工具和桌面开机就来)。bootstrap `needs: ['memory']` 拿提示词素材;LLM 操作要 bootstrap 的执行者登记、每晚整理的运行时要 wired 里 CC 开口那道门 ⇒ 这一头经 `lazy` 现取,没有照旧 503 `memory_not_wired` / `memory_nightly_not_wired`。运行时本身仍由 wired(pipeline-deps)经 `index.ts` 的 `wireMemory` 造(它要那道门),定时那一拍 `memory-nightly` 名字和位置都没动。记忆文件那一层 MemoryFS 是通用 store(社交串门、伙伴推送 / 消化、信、提示词都在读写)⇒ `src/adapters/store/memory-fs.ts`,地基里一份;`localParts`(按时区算哪天几点)挪到 `lib/local-time.ts`,信和定时不必为一个时间函数伸进记忆。有意留在原处:记忆编辑的纯函数 `lib/memory-edit.ts`(CLI 也用,只算不落盘)、`lib/memory-*` 那几样(合成、更正、主人原话、生成物状态 —— CLI 和桌面也在用)、手机 / 设置面板的 `/m/api/memory*`(设置面板那一簇,等「手机」搬家)、欢迎时写一条观察(不是记忆的事,回 pipeline-deps 自己造) |
| A5 · 手机 | `src/features/phone/`(设置面板与 `/set` 页、F2 的处理器登记 `phone-route-table.ts`、谁能走哪条 `phone-routes.ts`(PHONE_ROUTES / LINK_*,连理由)、各块 `/m/api/*` 处理器 `mobile-*.ts`、手机页生成物与 presence 美术两份 json、推送 / 在线设备 / 订阅 / 主题来源 / 批准说明 / 进展概括 / 看改动 / 出码 / 手机对话 `phone-*.ts`、两条隧道、中继配置与身份、已配对设备;从 daemon 搬 34 个源文件 + 3 份 json 连同测试;除了 `internal-api/routes-phone.ts` 改叫 `routes.ts`,文件名都没变)。新模块 `phone`(必需,紧跟 internal-api):`/v1/phone/link|devices` 标 `module: 'phone'`、自己挂,出码要的面板在 wired 里建 ⇒ `lazy` 现取,没建好照旧 503 `phone_not_wired`;`InternalApiDeps.phoneConnect` 去掉(`LATE_KEYS` 少一个),关机顺序快照不变(模块不 own 东西)。别的功能的 `/m/api/*` 归它们自己:面板加了贡献口 `featureRoutes`,信 / 定时的表由它们的 `index.ts` 导出、组装的地方(`wiring/wire-settings-panel.ts`)交进来,面板不再 import 这两个功能(不然信 / 定时 → 手机 → 面板 → 信 / 定时成环);合表顺序没变。终端会话的 App 推送类型直接取协议包的 `PushPlaintextT`(同一个定义),也是为了不成环。链接令牌那条规矩(送话给执行者只给设备、LINK_WRITE_OK 带理由)一字没动,守卫照旧对着它:`routes-snapshot` / `phone-routes` / `link-routes-from-source` / `mobile-web-errors`。`executor-display-names` 守卫的扫描范围加上 `src/features`(设置页跟着搬走了;定时的 command.ts 早先搬走时就漏扫)。有意留在原处:手机那一簇的装配 `wiring/wire-phone.ts`、`wire-settings-panel.ts`、`phone-lifecycle.ts` —— 在 wired 里建(要 CC 开口那道门、主人对话入口,App 主动通道又是记忆通知要的,真环),还伸进 tick-bodies / companion / bootstrap,搬进来就成环,等 wired 拆开。下一步各功能经 `featureRoutes` 交自己的表:记忆 `/m/api/memory`、`/m/api/memory/correct`;终端会话 `/m/api/cli/*`、`/m/api/today`(现在在 `mobile-reads.ts`);工作台 / 一件事 `/m/api/matter*`、`/m/api/entry/*`、`/m/api/attachment/*`、会话续接(`mobile-workbench.ts` 与面板里的 changes / review-* / insight / say);贴纸 `/m/api/sticker/`;「做过的事」`/m/api/activity`;会话 `/m/api/sessions`、`/m/api/session`。这样做要先让面板的表能晚到(模块 init 时 `mount`,像 `/v1` 那样),现在是建面板时一次合好 |
| A5 · 工作台 | `src/features/workbench/`(服务 `service.ts` 与十个域 `service/*`、微信「任务 …」那一族 `wechat-*` / `task-reference` / `quota-takeover`、审阅 / 回退 / 检查点 / 交接 / 脚本 / 工作区端口这些只给服务用的、接线 `wire.ts` / `wire-notifications.ts` / `wire-artifacts.ts` / `workbench-api.ts` / `issue-fetch.ts`、桌面路由 `routes.ts`、模块清单;从 core 搬 56 个连测试 82 份,daemon 搬 6 个连测试)。模块名 `workbench` 进 `MODULE_NAMES`,44 条 `/v1/workbench/*` 标 `module: 'workbench'`,由模块自己挂;`workbench-notifications` / `workbench-artifacts` 两个模块也由功能交出,名字、needs、位置都没动(关机顺序快照不变)。`InternalApiDeps.workbench` 去掉,换成窄口 `workbenchSuspended`(只给 `GET /v1/matters` 打「已暂停」标记)。44 个 `workbench_not_wired` 字面量删掉;桌面和 workbench-errors 表认的是这个码,所以模块门对工作台不回 module_*,而是查 protocol 的 `MODULE_UNAVAILABLE_CODE` 原样回 503 `{ error: 'workbench_not_wired' }`(还没挂上 / 关着 / 坏了都是,和搬家前一字不差;改成 module_* 是看得见的变化,不在搬家里做)。daemon 与别的功能(定时用「换一家来审」的措辞)经 `index.ts` 拿。有意留在 `src/core/workbench`:store(`store.ts` 和它的十几张子表、`timeline-events`、`task-entry` …)与执行者 / 协调器 / 「一件事」/ 自改也在用的零件(权限、提问、补充、附件、原生历史、模型目录、能力表、子进程环境、文件夹占用、锚定文件、成果读取)—— 适配器和 core 不许依赖功能目录,搬进来就得先把类型抽进 ports,等 E3 拆 core 时分进 ports / domain / adapters/store。手机那几条(`/m/api/*`、`mobile-workbench.ts` 里自己抛的 `workbench_not_wired`)不动,等「手机」搬家 |
| A5 · 陪伴 | `src/features/companion/`(四拍:知识入库 `tick-ingest`、主动找主人 `tick-push`、每天反省 `tick-introspect`、定时那一轮 `tick-job`,共用的出口 `tick-dispatch` 与提示文字 `tick-texts`;组装 `ticks.ts` 的 `makeCompanionTicks`;起停 `lifecycle.ts`;care 档 / 台账 / agenda / 日程判断留痕 / 来访 / 主动关心邀请、反思 `introspect*`、知识入库 `ingest/*` 与 `knowledge-distill` / `hearth-*`;陪伴自己的候选「问候」`gap-action.ts`;路由、模块清单。从 `daemon/companion` 搬 22 个、`daemon/wiring` 搬 8 个,连同测试)。新模块 `companion`(必需,紧跟 internal-api):`/v1/companion/status|enable|disable|snooze|import-local|thoughts` 六条标 `module: 'companion'`、自己挂,`InternalApiDeps.companion` 去掉,处理器里的 `companion_not_wired` 换成模块门(没有客户端认这个码),`/v1/health.subsystems` 多一项 `companion`;三个定时器模块 `companion.push / introspect / ingest` 名字、位置都没动(关机顺序快照不变)。贡献点的类型 `CompanionAction` / `IntrospectStep` / `MemorySnapshot` 进 `src/ports/companion-contributions.ts`:贴纸在 bootstrap 那条链上,引陪伴的 `index.ts` 就成环,交东西的功能只引这份口。**登记表在组装的地方**:`daemon/wiring/tick-bodies.ts` 把候选(打猎 → 串门 → 问候)、自省的几步(贴纸 → 小像 → 园丁 → 画室)和记忆快照(`buildMemorySnapshot`)经 `CompanionContributions` 交进去,陪伴一个功能都不 import;贴纸库 / 小像 / 画室三项从陪伴的 `TickDeps` 挪到组装这一层的 `IntrospectStepExtras`。companion 配置本来就在 `lib/companion-config.ts`(全 daemon 和 CLI 都读,主人那条对话也在里面,是 daemon 级的),`daemon/companion/config.ts`、`paths.ts` 两个转发删掉、55 处引用直接改到 lib;CLI `sessions` 和画室认默认对话也直接读它(cli-ratchet 38 → 37)。有意留在原处:`daemon/companion` 里主动开口的出口 `proactive-channel` / `app-channel`(SpeechPolicy 和信都走它)、`media-mirror`(ilink 发送路径)、抖动定时器 `scheduler`(信、每晚整理、信箱也用)、`resolve-admin`、`neighbor-memory`(社交串门);开关的实现 `ilink/companion.ts`(等 A6);串门候选 `visitAction` 和小像 / 园丁 / 画室三步(`wiring/companion-actions.ts`、`introspect-steps.ts`,读 bootstrap 的社交 / 记忆的 LLM 操作,是组装这一层的胶水);桌宠的 `/v1/companion/presence`(internal-api 的共用视图,手机页经 `getPresence` 读)、`/v1/companion/pet` 与「跟 CC 说」`/v1/companion/converse`(对话那一层,`petTurn` / `companionConverse` 由 wired 造);`getChatPrefs` / `setChatPref`(对话设置,不只是关心档);四拍仍在 wired 里造(要 pipeline-deps 造的 App 出口和 SpeechPolicy,等 wired 拆开) |
| F1 第 1 步 | `/v1` 的 zod 契约搬进协议包(`packages/protocol/src/desktop-api.ts`,daemon 的 `internal-api/schema.ts` 只转出);守卫:契约表的键都在路由表里。现在 36 / 209 条 `/v1` 路由有响应契约 |
| A6 第 1 步 | 项目登记(别名 → 文件夹)搬出 ilink 适配器:`src/daemon/projects.ts`,地基里一份;`IlinkAdapter` 少 `projects` / `loadProjects` 两项 |
| A6 | `IlinkAdapter` 拆成十个窄口(`src/ports/wechat.ts`):`WechatSend`(文字 / 文件 / 编辑 / 群发 / 打字中 / 媒体镜像)、`WechatVoice`、`WechatCompanionControls`、`WechatAccounts`(chat ↔ 账号路由、context_token、最近活跃)、`WechatContacts`(称呼)、`WechatPages`、`WechatPermissions`(拍板卡与待批登记处)、`WechatLinkStatus`(外发健康、推送窗口、会话过期)、`WechatWorkbenchTransport`、`WechatPolling`;`IlinkAdapter` 就是它们的并集,同一个对象。容器加了「口」:模块经 `ports` 交出几样从自己的值里取的东西,别的模块 needs 口名(`wechat.send` …)⇒ 拓扑上 needs 的是交出口的模块,拿到的只是那一块;口不进 status、不进关机顺序(快照不变)。`ilink-adapter` 模块挂 `ports: ILINK_PORTS`,十七个模块(连日历、工作台通知 / 成果)都改成只 needs 用到的那几口,组装的地方用 `pick` 从各口挑出接线函数要的那几样;各接线函数的 `ilink` 类型只列它用的方法(bootstrap 少了从没用过的编辑 / 群发 / 页面 / 称呼 / 语音,伙伴那一拍和开机清扫的 `ilink` 本来就没用,删掉)。语音口和开关口的实现留在 `daemon/ilink/voice.ts`、`ilink/companion.ts`(要 context_token、账号路由、媒体上传、最近活跃的 chat),只是实现口;`WechatVoiceDep` / `WechatCompanionDep` 搬进 ports。守卫 `scripts/ilink-ports.guard.test.ts`(零例外):`IlinkAdapter` 只在 ilink 自己(`ilink-glue.ts` 与它的测试、`daemon/ilink/**`)和 `daemon-modules.ts` / `foundation.ts` 出现,`'ilink-adapter'` 只在模块定义那一行;`speech-send` 守卫改从口的类型读发送原语(清单不变)。行为不变 |
| C1 第 1 步 | 档位 × 工具类别 ⇒ 放 / 问 / 拒,收成一个纯函数 `core/tool-decision.ts`:Claude(permission-relay)、Gemini(原来为躲 import 环逐字抄的一份)、OpenAI 兼容三家共用;逐格对照测试证明每个档位 × 类别 × 能力表设置都没变 |
| B3 第 1 步 | 照剧本说话的假执行者(Claude SDK / Codex / ACP)搬出 `src/core`,进 `src/test-support/executors/`;depcheck:生产代码不许 import test-support;core-no-node 基线少一行 |
| D1 + D2 | 协调器拆进 `src/app/coordinator/`(`conversation-coordinator.ts` 只转出):`planTurn` 一轮读一次 access、过一次守护,纯函数 `admit()` 定档位 / 被拒 / 参与者 / 回落,产出 `TurnPlan`;`TurnRunner` 管会话锁、超时、进度、取消登记、TurnRecord,solo / /both / /chat 一拍都用它。`resolveTier` / `providerDenialFor` 只在 `admit()` 里调,而且在锁里、开跑那一刻(排队之前的计划只用来选排队方式,评审抓到的越权已修) |
| D3 | 交付只剩一条路:删 legacy / shadow 两档、`replyDeliveryFor` / `setReplyDeliveryOverrides`、agent-config `reply_delivery`(旧盘上写着照样开机、被忽略)、`WECHAT_REPLY_DELIVERY` 与 wechat MCP 的 reply 族工具注册、FALLBACK 连击、shadow 旁听、prompt 的「用 reply 说话」版、reply-once 实验代码(数据留着);`replyDelivery` 端口在协调器 / 推送里改成必填。`/v1/wechat/*` 路由留着(附件经它们真发,`reply` 等几条现在没有调用方,另做) |
| E1 第 1 步 | `src/domain/` 开张:档位 / 放行、开口、伙伴判定、提示词、能力表这 43 个纯规则文件从 core 搬进去(codemod 改了 256 个文件的 import);`guestSafe` 与 Confinement 类型抽成 `domain/confinement.ts`。depcheck 两条零例外:domain 运行时只依赖 domain 自己和 lib 里不碰 I/O 的;不碰 node 内置。只引类型暂时放行(core 还没拆完)。下一步:app(协调器)、adapters(执行者、store) |
| E1 第 2 步 | `src/app/`(协调器 `coordinator/*`、会话管理、执行者登记)与 `src/ports/`(执行者的口 `agent-provider`)开张;`auth-fail` 进 domain、`async-mutex` / `async-queue` 进 lib。depcheck 四条:ports 零例外只依赖 ports / domain / 纯 lib;app 不往上依赖、不碰 node(过渡期还能用 core 里没搬完的 store / 工作台)。speech-send 守卫扫到 app / domain / ports |
| E2 | 六家执行者的适配器搬进 `src/adapters/executors/<家>/`(claude / codex / acp(含 Cursor)/ agy / gemini / openai,85 个文件连同测试;原来散在 core 根目录和 core/workbench 里)。depcheck `adapters-implement-ports` 零例外:适配器不往上依赖 app / daemon / cli / features。core-no-node 基线少 19 行(用 node 的是适配器,本来就不该算 core 的账) |
| E3 第 1 步 | 通用的 store(对话、会话、会话状态、回合记录、终端会话、「一件事」)进 `src/adapters/store/`;`TurnRecord` 形状进 `domain/turn-record.ts`(store 不再引协调器的类型 —— 新规则当场抓到的)。功能自己的 store(社交、知识库、定时 …)等那个功能搬进 features 时跟着走 |
| E4 第 1 步 | 工作台服务:`Options` 原样当 `ServiceDeps` 传(删掉那行 2245 字符的逐字段复制),被行数上限挤成一行的字段表 / import / 域构造 / service 对象 / `actions.set` 全部按一项一行摊开(service.ts 没有超过 180 字符的行了);删掉数内函数的 `workbench-service-ratchet` 守卫 —— 它管的两条环 depcruise 早有(`workbench-service-no-circular` / `wechat-control-must-not-link-service`),剩下的只是量症状。`Ref<ServiceActions>` 晚绑定还在,下一步 |
| E2 补 | 工作台错误码的反向守卫扫整个 `src/adapters/executors`(原来只扫 core/workbench 那几份)。「归了类」多一种:任务失败记录认得的码(`executionFailureMessage` 有人话)—— 于是 INTERNAL_ONLY 少了 12 个本来就有人话的;新扫进来的 Claude 工作台运行时不变式、ACP 收尾码列进去。`docs/architecture.md` 的分层图补上 adapters |
| E4 第 2 步 | 工作台服务:`Ref<ServiceActions>` 与 `ctx.actions` 删掉,各域按依赖顺序构造、只拿自己要的那几个域(依赖图写在 `service.ts` 顶部)。反指的边逐条正过来:pump → execute 改成 run 自带 `launch`;`drainInputs` 的 start 由 execute 调下来时带着;lifecycle ↔ inputs 共用的记账搬进 `pending-inputs.ts`;native ↔ execute 共用的核对搬进 `native-check.ts`;`matterSync` 进只认 ctx 的 `matter-sync.ts`;view 只要额度交接的只读一半。剩一条真环(一轮做完 → 检查没过 → 接着改)用一个具名回调 `UntilResume` 在构造时注入 |
| C2 | 逐工具判定只有一处:纯函数 `domain/authorize.ts` 的 `authorize(subject, descriptor, action) → allow / ask / deny`,按序组合旁路(权限模式,经 `compilePolicy`)、扇出拒 reply、坏名字、一起做的登记表、定时任务只读档(污点 / 读的范围 / 红线;要碰路径的事实由调用方算好)、档位 × 类别(`decideTool`)、问不了(`relayAs`)、主人的放行规则。调它的:对话的 `permission-relay`、Gemini gate、openai gate、`wire-model-options` 的定时任务闸门、一起做 Claude 的 `makeWorkbenchClaudeCanUseTool`(`wire-workbench` 外面手包的「没登记就拒」收进来,登记表当 descriptor)、一起做放行规则的落点(`makeRunPermissions`)、终端会话(`permission-gate.makeTerminalDecide`)。放行规则只在 `subject.surface` 是 terminal / workbench 时看(`OWNER_RULE_SURFACES`);对话要不要也走,等主人(10-25 主人点头,见下面「C2 补」)。`effectivePolicy` 删掉。逐格对照 `authorize.parity.test.ts`:改之前的七份实现原样抄进测试,约 16 万格一位不差(结果、问主人的话 / 码 / 时限、日志、通道调用)。没做:放行规则的 floor / rules-file / decide 还在 `core/permission-rules`(靠 node:path 的 posix / win32 归一,搬进 domain 要先把路径归一做成纯的),`authorize` 经 `permission-gate.decide` 拿它的裁决;ACP 对话侧按模式选放行 / 拒绝项(`compilePolicy('cursor-acp')`)是编译好的常量答案,没过 `authorize`;网络守护按调用目标判、不是逐工具,不在里面 |
| C3 | 每家 × 每档 × 每类工具实际会怎样,从真判定推出来:纯函数 `domain/enforcement-matrix.ts`(派发拒走 `providerDenialFor`;有逐工具回调的取 `authorize` 在对话面上的结论;没有的看档位那一格 + wechat MCP 按会话档位注册(`adminMcpTools` 为假 ⇒ 钉成 trusted)+ `compilePolicy` strict 设置里问不了时怎么落:codex `approvalPolicy` never ⇒ 放,ACP Cursor 应答 reject ⇒ 拒,agy 没有应答项 ⇒ 放)。`noAskNotice` 改成看「哪一档哪一类出现『档位说问、它放了』」算出来,不再读手设的 `doesNotAsk`;算出的提醒对象和原来一位不差(codex、agy)。`tier-enforcement.ts` 与它的两份测试删掉:整张表在 `enforcement-matrix.test.ts` 钉快照(能力表 / 档位 / `authorize` / `compilePolicy` 一改就有 diff),每家缺口的理由搬到快照旁的 `WHY_GAPS`(有缺口没理由、有理由没缺口都红);真调三家闸门的证明测试留着,改名 `enforcement-matrix.proof.test.ts`,并和推出来的格子对照。推导比原来的手写表细一格:agy 在主人聊天里 admin 专用工具(含 `daemon_remediate`)根本不注册,是「调不到」不是「不问」 |
| B1 | Codex 对话改走 `codex app-server`(主人 2026-10-25 拍板:统一到更强的那条协议,直接改)。协议客户端只有一份:`codex-app-server.ts` 的 `spawnCodexAppServerSession`,工作台不传 `chat` ⇒ 行为一字不变;对话侧 `codex-chat-provider.ts` 传 `CodexChatProfile`(compilePolicy 的沙箱 / 审批、daemon 的 MCP 作线程配置、老形状的事件、审批请求一律拒)。起子进程的那一下单独成接缝 `codex-app-server-process.ts`,daemon e2e 把它换成剧本 app-server(`test-support/executors/codex-scripted.ts`,同一个替身也给对话侧单测和交付测试用)。删掉:`codex-agent-provider.ts` 与测试、`watchCodexEvents`(超时归 app-server 的回合看门狗)、`@openai/codex-sdk` 依赖(CLI `memory` 命令的一次性评估改用同一个 provider;codex-autofix 只对齐 `@openai/codex`)。C3 快照不动(对话仍是审批 never)。差异见下表 |
| F4 | 网页切 v2、v1 退休(主人 10-25 定:直接退,不等生产中继):手机网页与公网壳页跟 App 用同一个 `makeProtocolClient`(经 `CCP`,握手自报 `client:'web'`,出生地照记 web);`messages.ts` 改用协议包自己的小校验器 `shape.ts`(完整版 zod 会把整页撑出中继一帧;`zod/mini` 跟完整版同进 `bun build --compile` 的包会初始化失败)。删掉:协议包 `v1.ts` / v1 向量 / v1 消息与 `requireV2`、daemon 的 v1 流与老中继连接(`tunnel-id.json`、`remote_relay_url` 不再用)、`src/lib/tunnel-crypto.ts`、VPS 的 `relay/tunnel.ts` 与 `/tunnel/*`。不带 v2 的握手回明文 `upgrade_required` 并关流;网页 / 壳页拿着老中继 id(`t…`)、收到 `upgrade_required` 或被降级 ⇒「连接方式升级了，请在电脑上重新扫码配对」。**发版顺序**:① 中继 Worker(它打包新的 `relay/pset.html`)→ ② daemon `self deploy` → ③ 可选:VPS 换新 `relay/server.ts`(只剩 mailbox)与静态 `pset.html`;①不能晚于②,见 [relay.md](maintainer/relay.md) 第 8 节 |
| F3 | 手机面板的类型化客户端:`packages/protocol/src/phone-calls.ts` 一张表 `PHONE_CALLS`(`命名空间.方法 → 路由键` + 查询 / 正文的类型),`makePhoneApi(send)` 推出 `api.matters.list()`、`api.chat.say({ body })` …,返回类型从 `api.ts` 的同一份 schema 推(`PhoneApiOk<K>`);传输可换(`PhoneTransport`,App 今天是 `live.ts` 里经中继 v2 的那一个,`toProtocolRequest` 拼协议请求)。不生成代码,全在 TS 类型层。路径只在路由表 `routes.ts` 写一次:表的键留成字面量类型(`DeclaredRouteKey` / `PanelRouteKey`),`PHONE_API_SCHEMAS`、`PHONE_CALLS`、daemon 的处理器表 `PhoneRouteTable`(`src/features/phone/phone-route-table.ts`,`sharedRoute` 的路径也是)都按它定型,写一个表里没有的键编译就不过。App:`live.ts` 全部 63 处调用与 `net/pairing.ts` 换过去;查询串逐字照旧(`undefined` 不带、字符串编码、数字原样,`phone-calls.test.ts` 钉着)。守卫:`scripts/client-paths.guard.test.ts` 对 `apps/app/src`(测试除外)改成「一条引号起头的 `/m/api`、`/set/api` 都不许有」;链接令牌扫描器(`scripts/link-routes-scan.ts`)多认一种 App 配对的写法 `linkClient.request(toProtocolRequest(phoneCallRequest(PHONE_CALLS.set.pair, …)))`。运行时不 import zod。下一步:网页(`apps/mobile`)把 `PHONE_CALLS` / `phoneCallRequest` 挂进 `CCP`(`browser.ts`)就能用同一张表,先量一下 IIFE 长多少再换;桌面那半是 F5 |
| F5 | 桌面的类型化客户端:桌面里没有手写的 `/v1` 字符串了,`lib.rs` 的两个代理合成一个。**拼法共用**:协议包新增 `calls.ts`(`callSpec` / `callRequest` / `queryString` / `makeApi`;F3 的 `phone-calls.ts` 改用它,对外名字不变),`desktop-calls.ts` 一张表 `DESKTOP_CALLS`(115 条,键按 `DesktopRouteKey` = 路由表 `/v1` 那半定型,写错编译不过;`makeDesktopApi(send)`,返回先是 unknown —— `RESPONSE_SCHEMAS` 的键是 string 推不出来)。查询串多认 `URLSearchParams`(桌面搬家前有几处这么拼:原样 `String()`、空的不带 `?`)。**桌面**:webview 引不到协议包,`gen:routes` 顺手写 `apps/desktop/src/generated/daemon-calls.js`(纯数据:`V1` 表 + 主人工作区路径;`/** @type {const} */` 让 `@ts-check` 的文件拿到字面量类型),`src/daemon-client.js` 照 `calls.ts` 拼(`v1(transport, V1.ns.m, { query, body }, opts)`、`v1Path`、`v1Request`);传输照旧是各模块拿到的那个函数,实参个数和搬家前一样,所以测试注入的假传输、Playwright 拦的路径一条没动。34 个文件 150 处调用换过去;`api.js` 的 `OWNER_WORKSPACE_PATHS` 不再照抄,读生成物。**Tauri**:`workbench_api` + `customer_review_api` ⇒ 一个 `daemon_request`,按生成物分两半(`DaemonChannel::Workbench` / `OwnerWorkspace`),两半的超时 / 正文上限 / 错误串 / dev 隔离目录逐字照旧,两份名单都不在 ⇒ `daemon_request refuses request`;新模块 `daemon_info.rs`(`DaemonInfo` + `state_dir()`)代替六处照抄的「状态目录 → internal-api-info.json → operator 令牌」,错误串一字没改,令牌不出 Rust(所以是模块不是命令)。`lib.rs` 测试里照抄的放行名单删掉,改成逐条读生成物(近似路径的拒绝用例留着)。test-shim / 两个浏览器 smoke / `shim-invoke-error.js` 跟着改名。守卫:`client-paths.guard` 把 `apps/desktop/src`(测试与 `src/generated/` 除外)挪进「一条都不许有」、扫 `V1.ns.m` 都在表里(没开 `@ts-check` 的文件写错也红)、两边拼法对全表 × 9 组样例逐字比;`route-registry.guard` 盯 `daemon-calls.js` 是最新的、`daemon_request` 那几个函数里没有手写 `/v1/`。`cargo test` 53 过(本地没 sidecar 时加 `TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":[]}}'` 才编得过)。**发版**:命令改了名,webview 和宿主同在 .app 里一起换,`self deploy` 换不到,随下一版桌面发。**`@ts-check` 全覆盖**(10-25 补):`apps/desktop/src` 里(测试、`src/generated/`、`src/vendor/` 的压缩第三方包除外)每个 .js 都开着;根 `tsconfig.json` 改成 `apps/desktop/src/**/*.js` 整个收进程序 —— 以前逐个列文件,没列、也没被 .ts import 到的(`aquarium-atlas.js` / `pet-lab.js` / `animation-lab.js`)写了 `@ts-check` 也没人查,`a2a-agents.js` / `converse.js` / `memory.js` 的 `@ts-check` 写在第一行 import 后面、同样不生效。补上的报错全用 JSDoc 类型 / typedef / `/** @type */` 收窄修,运行行为不变(`icons.js` 两个重复键删了先写的那份,运行时本来就是后写的赢)。守卫 `scripts/desktop-ts-check.guard.test.ts`:零基线,新 .js 不在开头注释段写 `// @ts-check` 就红,tsconfig 的 include 被改窄也红。**欠着**:逐页 TS;返回类型(先把 `RESPONSE_SCHEMAS` 改成字面量键) |
| F6 | 做完(2026-10-26,主人点头「接受 daemon 没起时那几样用不了」):桌面里 daemon 能回的一律走 `/v1`(`apps/desktop/src/daemon-client.js` 的 `V1`,表在 `packages/protocol/src/desktop-calls.ts`),daemon 没起 ⇒ 那几页说「CC 没在运行」(`apps/desktop/src/daemon-errors.js`,`formatInvokeError` 也认),不崩。**已有路由、直接换**:`mode set` ⇒ `POST /v1/conversation/set-mode`(简写表搬到桌面 `apps/desktop/src/modules/conversations.js` 的 `modeFromShorthand`,逐字照抄 CLI);`memory view|edit` ⇒ `POST /v1/memory/view|edit` 打上 `tauri` / `devProxy` 经宿主(失败翻回 CLI 那时的 `{ ok:false, code }`:`apps/desktop/src/modules/memory-line-edit.js` 的 `memoryEditFailure`;路由的 4xx 正文补 `error` 同码,宿主只留这一个字段)。**核对后不等价、另加路由**:`memory list|read|write` 对应的 `/v1/memory/list|read|write` 是 CC 自己(MCP)看的那一份(过期总览藏起来、读时加过期标签、不给大小 / 时间、整份写不过 `wholeFileWriteRefusal`),桌面要主人看的原样文件 ⇒ 记忆模块加 `src/features/memory/owner-routes.ts`:`GET /v1/memory/files|file|profile|profile/status|projects`、`POST /v1/memory/file/write`;`sessions list-projects` 对应的 `/v1/projects/list` 是项目登记(projects.json),不是会话表 ⇒ 另加。**原来没有路由的**:新模块 `src/features/console`(`console`,只挂路由):`GET /v1/conversations/list`、`/v1/observations/list` + `POST …/archive`、`/v1/milestones/list`、`/v1/events/list`、`/v1/access/list`、`/v1/avatar/info` + `POST …/set|remove`、`/v1/sessions/projects|chats` + `POST …/delete`、`/v1/dialogue/timeline|threads|thread|search` + `POST …/unlock`。每条调的是原来那条 CLI 命令调的同一个函数,回包用 `src/cli/schema.ts` 同一个契约 parse(形状一字不差);CLI 非 0 退出的两处(头像设置失败、线索不存在)回 4xx,宿主把它变成失败,和以前一样。这 23 条全是 admin + operator + `tauri` / `devProxy`(别人的聊天记录、所有对话的记忆,trusted 那把 file token 别人对话的会话也有),桌面经 `invokeWorkbenchApi`(`daemon_request`);`scripts/routes-snapshot.guard.test.ts` 的 operator 新增与 `src/daemon/internal-api/token-registry.test.ts` 逐条点头。dev 代理(`apps/desktop/workbench-proxy.ts`)把名单里非工作台的 devProxy 行都当主人那一类;test-shim 的演示数据从「按 CLI 参数拦」挪到按路径答(`dryRunOwnerRoute`),没有演示数据的读在本进程跑同一个处理器、写照 dev-guard 默认拒。**留在 CLI**(守卫 `scripts/desktop-cli-calls.guard.test.ts` 的名单,零基线,每条写着为什么,死条目也红):计划里那族 `service *`、`install-progress`、`doctor`、`daemon kill|kill-residual|api-info`、`setup --qr-json` / `setup-poll`、`update`、`logs`;清点后再留:`guard *` 与 `provider show|set`(向导第 4 步就用,服务还没装,装服务读的就是这份配置)、`connection probe` 与 `log`(重连诊断:恰在 daemon 连不上时用)、`account remove`(解绑,和 setup 一族;删账号目录、要重启 daemon)、`plugin setup|sync|setup-status`(在 app 身份下起安装子进程,进度写文件)、wxvault 开机刷新前的 `plugin list`(`GET /v1/plugins/list` 按设计不列 hidden 插件,wxvault 正是 hidden 的)。**发版**:宿主放行名单是生成物,随下一版桌面发(和 F5 一样 `self deploy` 换不到)。**欠着**:`apps/desktop/dev-guard.ts` 的只读 CLI 名单里还留着桌面已经不调的读命令(终端里照样能用,不碍事) |

### B1:Codex 对话 SDK → app-server 差异表

| 项 | 以前(SDK,每轮一个 `codex exec`) | 现在(app-server,每条会话一个常驻进程) | 主人看得见? |
|---|---|---|---|
| 中途插话 | 没有:一轮跑着时新消息只能排队或抢占 | `session.steer()` → `turn/steer` 接好、有测试;对话协调器还不调它(没有新界面),消息照旧排队 | 否(留作后续) |
| 思考过程 | reasoning 条目丢掉 | 照旧丢掉(不映射 reasoning 增量) | 否 |
| 工具调用显示 | 每个工具类条目一次 `tool_call`;MCP 带 server / tool,shell / 改文件 / 搜索有固定名 | 同一张映射(驼峰类型名),每个条目 id 一次;`userMessage` / 上下文压缩不算工具;不认识的新类型照样是分段边界 | 否(TurnRecord 的工具名不变) |
| 恢复会话 | `resumeThread(id)`,每一轮 `codex exec resume`;坏 id 每轮都失败 | 起会话时 `thread/resume`;续接不上 ⇒ 记 `SESSION_RESUME_FAILED`、起新线程;进程中途没了 ⇒ 下一轮换新进程续接同一个 thread | 很少:坏掉的续接现在变成新对话,而不是每轮报错 |
| 额度报错 | 只靠文本(`usage limit` …)⇒ `quota` | 先看 `codexErrorInfo`(`usageLimitExceeded` ⇒ `quota`),文本兜底 | 否(同一个码、同一句通知) |
| 认证报错 | 文本:没凭证 ⇒ `auth_failed`,401 ⇒ `auth_rejected`;exec 退出时 stderr 里认 | `codexErrorInfo: unauthorized` + 同一套文本;app-server 自己退出时带上 stderr 末尾再认;`auth-fail` 的宽集合兜底照旧 | 否 |
| 图片输入 | provider 只传文字(SDK 的 `--image` 没用上) | `dispatch(text, attachments)` 支持图片(和工作台同一个 `turnInput`);对话协调器照旧只传文字 | 否 |
| 取消 | AbortController 杀掉这一轮的 exec,迭代器抛 AbortError | `turn/interrupt`,确认后这一轮以「Codex 本轮已停止。」收尾,进程留着;协调器按 /stop 代数不发出错通知 | 否 |
| MCP 工具 | `--config mcp_servers.*` 进 argv(会话令牌出现在 ps 里),每轮重起 MCP 子进程 | 线程配置 `config.mcp_servers`(令牌不进 argv),MCP 子进程活一整条会话;dangerously ⇒ 同一个 bypass 键 + 每个服务器 `default_tools_approval_mode = "approve"`;strict ⇒ codex 拒(发来的审批请求我们拒) | 否(预期);免审那一项要真机核一次 |
| 沙箱 / 网络 | `--sandbox` + `approval_policy`;不给网的档关联网搜索 | `thread/start` 的 `sandbox` + `approvalPolicy`,起来后核对 codex 报回来的策略,对不上就不开;联网搜索照旧;沙箱网络照旧不设 | 否 |

另两处行为差别(不在上面十项里):系统指令从「前置到第一条消息」改成 app-server 的 `developerInstructions` 槽(每次起线程 / 续接都带);守护判端点从「每轮按此刻的配置」改成「会话起来时 codex 自己 `config/read` 报的有效配置」(常驻进程本来就是这样)。

**机会(这一步没做)**:app-server 能逐条问(`on-request` + `item/commandExecution/requestApproval`,工作台已在用)。对话侧可以像 Claude 那样把 admin 的危险命令转给主人拍板,C3 快照里 codex 的「问 ⇒ 放」就能补上;按主人的话这一步不改档位行为,快照不动。(2026-10-26 主人点头,已做:进度表「B1 补:Codex 对话逐条问」。)

**后续**:协调器在一轮跑着时把新消息走 `steer`(要先定产品行为);真机核 dangerously 下 `default_tools_approval_mode` / bypass 键在 app-server 上确实放过 MCP;对话侧没开网络守护的「暂停在跑的任务」(`suspension`,工作台沙盒验过,对话没验);Windows 上对话侧经 cc-jobspawn 起 app-server,没在真机跑过。
| C2 补 · 对话走放行规则 | 2026-10-25 主人点头的看得见的变化:`OWNER_RULE_SURFACES` 加上 `chat`,但对话只在 `subject.ownerChat` 为真时看规则 —— 由 `core/permission-rules/chat.ts` 的 `authorizeChatCall` 在判的那一刻调 daemon 接的 `isOwnerChat`(`daemon-modules` 里 `resolveTier(chatId, loadAccess()) === 'admin'`,原始档位,不看 --dangerously,模型的输入碰不到),访客 / 信任的对话连规则文件都不读(逐格对照里接上「什么都放」的规则,访客 / 信任 / 定时 / 审查各行仍一位不差、规则一次都没被问)。只接逐工具过闸门的三家(Claude `permission-relay`、Gemini gate、openai gate;openai 的规则在「问落成拒」之前看,规则没拿主意照旧拒);Codex / Cursor / agy 在对话里问不了单个工具,不动。红线照旧问(`decide` 里红线之上没有 allow);对话里只认规则表(by rule),不初审。规则替主人放了 ⇒ `reply-delivery.noteRuleAllow` 登记到这个对话开着的那一轮,交付时最后单独一条「按规则「<备注或 id>」放行了 <命令 / 工具>」,同一条规则一轮一行(多次记「这一轮共 N 次」),app 接收器那一轮接在文字末尾,轮出错没交付也单独送;没有开着的轮 ⇒ 不放、照旧问。规则拒绝 ⇒ 拒,理由交给执行者。路径:对话没有项目根(`project` 恒为 null),按项目 / 路径限定的规则只看输入里明写的**绝对**目标路径,每一条都在范围里才命中,空的 / 相对的 / 不明的一律不命中。留痕表 `permission_decisions.surface` 的 CHECK 加 `chat`(v85 重建表)。C3 快照不变:它算的是没有规则时的那张表 |
| B1 补:Codex 对话逐条问 | 主人 2026-10-26 点头的看得见的变化。`compilePolicy('codex')`:admin 档 strict 由 `never` 改 `on-request`(`domain/policy.ts`,按 `tierNameFromProfile` 认 admin);trusted 仍 never,访客 untrusted(派发时就拒),定时 / 审查档不变,--dangerously 仍 never + danger-full-access。对话侧 `codex-chat-provider.ts` 只在接了应答者 `approvals` 时才真开 on-request(没人可问的 delegate、CLI 一次性评估落回 never),线程带 `approvalsReviewer: 'user'` 并核对报回来的值,daemon 给的 MCP 每次调用都报上来(`default_tools_approval_mode = "prompt"`;主人自己 codex 配置里的 MCP 不认、照旧拒)。`codex-app-server.ts` 的 `CodexChatProfile.approve`:命令 / 改文件 / MCP 的审批走和工作台同一份核实(`approvalScope`、`codexMcpApproval`),核实不了的在对话里只拒这一条、不停会话;提问照旧一律拒。判定在 `adapters/executors/codex/codex-chat-gate.ts`,经 `authorizeChatCall`(`GateExecutor` 加 `codex`,`decide` 的 `CHAT_GATED_PROVIDERS` 加 `codex`):改文件和 MCP 调用翻成 Claude 会发出的同一个工具调用(每个文件一次 `Edit {file_path}`、`mcp__<server>__<tool>` + 参数),走 Claude 的 `canUseTool` 用的同一个入口 `authorizeChatToolUse`(`permission-rules/chat.ts`,permission-relay 也改成调它)⇒ 同一次写、同一个工具,两家同一个结论(admin 档写文件、绝大多数 wechat 工具直接放,删记忆 / 动 daemon 先过规则再问);命令按「执行者报上来要批」(`reported`,codex 只报越出沙箱 / 它认为危险的)⇒ 主人自己的对话先过放行规则,规则放 ⇒ 回复后面那一行「按规则「…」放行了 …」,规则拒 ⇒ 拒,红线照旧问;要问 ⇒ `ilink.askUser`,和 Claude 对话同一张微信拍板卡、同一个待批登记处,10 分钟没回 / 卡送不到 / 没有可问的人 ⇒ 拒。接线在 `daemon/bootstrap/providers.ts`。C3 快照只动一组:codex / admin 的 `daemon_remediate`、`memory_delete`、`shell_destructive` 由 `ask→allow` 变 `ask`(`enforcement-matrix.ts` 的 `asksEachRequest`:on-request 的档每一格取 `authorize` 的结论);compilePolicy 快照只动 `codex / admin / strict` 的 `approvalPolicy`(never → on-request)。`noAskNotice` 加档位参数:主人自己的对话切 /codex 不再说「它不会逐条问你」,信任的对话照旧说(`mode-commands.ts`、`internal-api/routes.ts`)。shell_destructive 记成「问」是按 codex 自己会把越出沙箱 / 它认为危险的命令报上来算的,沙箱里它不觉得危险的不会报(`enforcement-matrix.test.ts` 的 `WHY_GAPS` 写明)。e2e `daemon/__e2e__/codex-chat-approval.e2e.test.ts`:规则放、改文件直接放(和 Claude 同结论)、主人同意、主人拒绝、红线照旧问。**拍板卡在微信里当场答(B1 补的后一步,Claude 对话同样受益)**:以前一轮在等主人时这个账号的 poll loop 不取新消息(onInbound 整轮内联),同一个微信对话里回的「y」要等这一轮超时之后才读到。现在 `poll-loop.ts` 有快车道 `fastLane`(接的是 `daemon/permission-answer.ts` 的 `makePermissionAnswer`,命令表里 permission-reply 也调它):对待批卡片的回答一到就消费;快车道从不走流水线、从不内联跑一轮,没消费的(待批已被桌面拍掉 / 过期)按到达顺序进普通队列;普通消息照旧按到达顺序串行、loop 不等它们接着拉(最多攒 `READ_AHEAD_MAX` 条);每一批的游标排在这一批普通消息之后才落盘(至少一次不变);心跳每轮拉取、每处理完一条都盖;停下时等在跑的那一条收尾,没开始的跳过、游标停在它们之前 |
| B2 | OpenAI 兼容只剩一种会话(主人 2026-10-25 拍板:每家一份、留更强的那条、直接改):循环在 `openai-session.ts` 的 `openOpenAiSession`,底下同一个 AI SDK 接缝 `api-model.ts`(`stream` 带 AbortSignal / 用量 / finishReason,`generate` 给 cheapEval / strongEval);两边只差「用途」`OpenAiPurpose`:对话 `openai-agent-provider.ts`(MCP:wechat / delegate / 插件 + 内置 Read / Write / Edit / Bash / view_image,逐个过 openai gate → `authorize`,主人对话先看放行规则 —— #703 原样),工作台 `openai-workbench-provider.ts`(只有文件工具,每次都过 `ctx.requestPermission` 那张权限卡;不给 wechat / delegate / 插件 MCP,和 Claude / Codex 的工作台一致,有测试钉着)。历史都经 `api-sessions`:工作台照旧 `workbench_api_sessions`,对话新表 `openai_chat_sessions`(v86,绑对话 / 别名 / 文件夹 / 端点 + 密钥摘要,不绑钉的模型),`canResume` 接上 session-manager 的 7 天续接;会话报 `resumedHistory`,协调器据它决定补不补冷启动近况块(能力表 `supportsResume` 留 false 当兜底)。删掉:`api-task-provider.ts`(改名成工作台用途,循环删掉)、`openai-chat-model.ts` 与测试(`ChatModelClient` / `streamTurn` / `createAiSdkChatModel`,并进 `api-model.ts`)、对话那份自己的循环、`mapDeltaToEvent`。替身:`test-support/executors/openai-scripted.ts`(`scriptedOpenAiModel` / `scriptedMcpTools`),对话、工作台、集成、插件卡住、守护目标几处测试共用。错误码一个没改(workbench-errors 守卫、openai-error-code 测试原样过)。差异见下表 |
| E3 | `src/core` 清空、目录删掉(剩下的 108 个源文件、110 份测试和 3 份报文,codemod 改 import;零行为变化)。按层分:**domain** —— 微信「配对 / 允许」两条命令的解析、A2A 协议版本、乙的协议、会话记录渲染 `cli-transcript`、CLI 升级的规格 / 版本 / 配置 / 过期信号(`domain/cli-upgrade/`)、知识库的图与画像 / 事实 / 人 / 检索(`domain/knowledge/`,只引 store 的类型)、工作台的能力表 / 模型目录 / 原生工具 / 工具输入预览 / 附件预算(`domain/workbench/`)、「一件事」的回报 / 回忆 / 手机剧本(`domain/matters/`);**app** —— 终端会话的事件判定 `cli-events` 与权限中继 `cli-permission-relay`(`wechat-cc hook` 子命令和工作台也用,不进功能目录)、「一件事」服务 `matters/service.ts`、配对、关系视图、乙的 hub / hand、A2A 委派与披露闸、首次真跑探测、知识库的一轮与入索引(`app/knowledge/`);app 不碰 node,随机 id 经新的 `lib/random.ts`(同 `content-hash.ts` 的理由);**adapters** —— 工作台的 store 与十几张子表进 `adapters/store/workbench/`,工作台的文件层 / 附件 / 成果 / 原生历史 / 权限与提问登记 / 文件夹占用 / 任务入口进 `adapters/workbench/`(适配器也在用,不能进功能目录;功能和执行者都直接依赖它们,抽 ports 留到以后),独立工作区进 `adapters/git/`,A2A 传输 `adapters/a2a/`,信箱客户端与加密 / 自己的 agent id `adapters/mailbox/`,知识库的 store / 来源 / 嵌入子进程 `adapters/knowledge/`,CLI 升级探版本 / 布局 / 找程序 / 状态 `adapters/cli-upgrade/`,A2A 事件 / 信道 / 心跳 / 背包已读 / 主人问答 / 定时任务 / 头像 / 说一句回执几个 store 进 `adapters/store/`,`turn-emitter` / `mcp-stdio-spec` / `subprocess-env` 进 `adapters/executors/`,Claude 对话的 `permission-relay` 进 `adapters/executors/claude/`;**放行规则**(`chat` / `decide` / `floor` / `paths` / `rules-file`)进 `adapters/permission-rules/` 而不是 domain:路径归一靠 `node:path` 的 posix / win32 `resolve`(相对路径按 `process.cwd()` 解析)和 `node:os` 的 homedir,手写一个逐位相同的纯归一器不便宜,也不该在搬家里冒险;**features** —— 日历的 EventKit 进 `features/calendar/`,`cli-activity` / `cli-reply` 进 `features/terminal/`(只有它用);**daemon** —— `busy-registry`、CLI 升级引擎 `daemon/cli-upgrade/engine.ts`(只有 daemon 用;CLI 要的那几样在 domain / adapters,所以命令不必链 daemon);**test-support** —— `test-helpers.ts` 与三份真机报文(`test-support/fixtures/`)。守卫与规则:`core-no-node` 守卫删掉(`self-discover-ratchets` 认的棘轮少一个);depcruise 删 `core-must-not-depend-on-runtime`,别的规则里的 `core` 去掉,`lib` 的底改成不许依赖任何上层(app / adapters / domain / ports / features / test-support 也算,零违规);`executor-display-names` 扫 app / domain / adapters 代替 core,`speech-send` 少扫 core,`workbench-errors` 改扫 `adapters/store/workbench`、`adapters/workbench`、`domain/workbench`;vitest 的 win32 排除、`test:live-cli`、CI 的 js-embedder 冒烟路径跟着改 |
| E5 | `src/app` 只经 ports / domain 认 adapters:depcheck `app-does-not-reach-up` 的 `to` 加上 `adapters`,零例外(只引类型也不行)。app 原来直接用的形状搬进 ports(定义搬家、importer 改 import,adapters 反过来从 ports 引,`adapters-implement-ports` 照旧):`ports/a2a.ts`(A2AClient / AgentCard / SendRequest / SendResult、A2ARegistry / A2AAgentPatch、ExecResult)、`ports/mailbox.ts`(信封、信箱身份、MailboxClient、RendezvousIdentity、配对加密口 `PairingCrypto`)、`ports/penpal-channel.ts`(PenpalHandle、ChannelRow / ChannelStore)、`ports/session-store.ts`、`ports/conversation-store.ts`、`ports/cli-session.ts`、`ports/knowledge.ts`(domain/knowledge 也改引它)、`ports/matters.ts`(matter 与说一句的回执)、`ports/workbench.ts`(附件、成果、权限卡 / 提问卡、补一句)。纯函数进 domain:`domain/penpal-channels.ts`(primaryChannels)、`domain/cli-session-view.ts`(读时折算 / 排序)、`domain/workbench/input-request-id.ts`。session-store 自己那份 `ProviderId` 删掉,用 `domain/conversation` 的(本来就是同一个 string)。要 node 的小工具进 lib(同 `lib/random.ts` 的理由):`lib/claim-paths.ts`(pathsConflict / canonicalClaimPath,靠 node:path 与 realpath)、`lib/content-hash.ts` 的 `sayTextHash`。配对引擎的加解密(会面身份 / 封拆信封 / 取件签名,要 node:crypto)改成 `PairingDeps.crypto` 注入,`daemon/bootstrap/wire-pairing.ts` 传 `adapters/mailbox/pairing-crypto.ts` 的 `pairingCrypto`;配对的两份测试多传这一项,别的测试只改 import 路径。`docs/architecture.md` 分层图跟着改。零行为变化 |
| G 设计稿 | [记忆一个源设计稿](superpowers/specs/2026-10-25-memory-single-source-design.md):主库一张 `memory_facts` 表(状态 / 来源 / 历史事件),`memory.md` / `owner.md` / 总览「你写的」从表渲染、文件只作导出;四条收回(更正、出口过滤的名单、`set_fact_status`、证据审阅)收成 `retract` / `restore`(「已办」走 `resolve`,不算收回);`facts.db` 并进主库,另三个知识库各一张迁移表。切法 G0 金样 → G8 生成物缓存,每步删旧的 + 零基线守卫;五条等主人点头的在稿 §4 |
| G0 | 记忆金样:合成夹具 `src/test-support/fixtures/memory/`(主人 / 访客 / 空三个对话 + `facts.json`),`src/features/memory/memory-golden.test.ts` 用今天的代码产出、逐字节钉在 `fixtures/memory/golden/`(`memory.md` / `owner.md` 序列化、五段注入、整理的纠正段、`overviewForOthers`、`knowledge.md`)。零行为变化;夹具与读代码的发现见[设计稿](superpowers/specs/2026-10-25-memory-single-source-design.md) §6 |
| G1 | 知识库进迁移框架:`runMigrations(db, list)`;`source` / `semantic` / `graph` / `facts` 四个库各一张迁移表(`src/adapters/knowledge/migrations/<库>/`,`v001` = 原来 `store.ts` 的建表 + 守着的 `ALTER`,幂等,存量库跑一遍什么都不变),`store.ts` 里不再建表。新守卫 `scripts/schema-ddl-in-migrations.guard.test.ts`:生产代码建表 / 改表只在 `**/migrations/**`,基线 0(v056–v058 共用的建表语句随之进 `src/lib/db/migrations/shared-ddl.ts`)。冻结检查与 CI 路径过滤覆盖知识库目录。零行为变化 |
| G2 | 记忆表与渲染:迁移 v87 建 `memory_facts` / `memory_fact_events` / `memory_derived`;`src/domain/memory/facts.ts`(形状 + 今天的文档 → 行)、`src/domain/memory/render.ts`(`memory.md` / `owner.md` / 两段注入,从行渲染)、`src/ports/memory-facts.ts`、`src/adapters/store/memory-facts.ts`(唯一写这三张表的地方)。还没人读写;金样:`render(parse(夹具))` 与 G0 逐字节相等(纯渲染、进表再读出来各一份)。表和初稿的五处差别见[设计稿](superpowers/specs/2026-10-25-memory-single-source-design.md) §6。零行为变化 |
| G3 | 记忆文件开机导入主库:迁移 v88(`memory_import` / `memory_exports`);`src/features/memory/fact-import.ts` 在 memory 模块挂路由之前按对话逐个导(一个事务、先墓碑后条目、写回的旧话导成收回、`替换:` 链保留),表的渲染和今天的代码处理文件的结果逐字节相等才记指纹,不等整个对话回滚。原文件不改名、复制一份 `*.imported-<日期>`(读写者还在用文件,见[设计稿](superpowers/specs/2026-10-25-memory-single-source-design.md) §6)。还没人读表;零行为变化 |
| G4 | 记忆的写者切到表:`src/features/memory/memory-export.ts` 是 memory.md / owner.md / corrections.md 唯一的写者(先落表、再导出;没搬进表的对话照旧写文件),整理 / 纠错 / 编辑 / 导入 / 关待办都改调它,`writeOwnerAssertions` 删掉;守卫「往这三份文件写只许在导出器」基线 0。主人 10-26 第 4 条:导出头部写明「这是生成的」,手改的 memory.md 按记忆编辑比对表变成更正 / 原话、微信说一次。主人看得见的三处见[设计稿](superpowers/specs/2026-10-25-memory-single-source-design.md) §6 |
| G5 | 一种收回:店面 `retract` / `restore` / `resolve` / `supersede`,四个入口(记忆页删改、待办「不对」与 MCP superseded、证据审阅纠正 / 过期)都走每晚整理运行时同一个用例(清源头、关待办、生成物过期),名单从表来(整理、出口过滤、导入命令),命中记 `redacted_on_output`;`correctedTexts` / `memory-redactions.json` 删掉。守卫:状态只在店面改,`'corrections.md'` 只在导入 / 导出器 / 分类表。`setFactStatusById` 到 G7 才能删;收回的话列表与恢复的路由和界面在 G6(见[设计稿](superpowers/specs/2026-10-25-memory-single-source-design.md) §6) |


### B2:OpenAI 兼容 对话 / 工作台 → 一种会话 差异表

「以前」是对话那一份(工作台那份的行为原样留在工作台用途里)。

| 项 | 以前(对话:自己的循环 + 内存历史) | 现在(一种会话,按用途配) | 主人看得见? |
|---|---|---|---|
| 工具调用 | 对话:MCP + 内置工具,逐个过 openai gate;工作台:只有文件工具 | 两边都不变(工作台照旧只有文件工具,和 Claude / Codex 的工作台一致);只多一处:对话里模型编出来的工具名回「there is no tool named …」(以前撞 TypeError 回一句「Tool error: Cannot read …」),历史里每个 call id 只有我们自己的一条结果 | 否 |
| 持久化 / 续接 | 只在内存:daemon 重启、会话被释放就从头来,靠协调器补的「冷启动近况块」接话;`canResume` 永远 false | 存进 `api-sessions`(对话表 v86):每一轮做完记 ready,session-manager 7 天内带 `resumeSessionId` 续上,系统提示换成这一次的;续不上(别的对话、换了端点 / 密钥、存的历史超过 192 KiB、一轮当中被杀掉留下 active)⇒ 记一行、开新会话、照旧补近况块;续上了就不再贴近况块(会话报 `resumedHistory`);存档写不进去 ⇒ 这条会话退回只在内存,不挡这一轮 | 是(重启 / 释放之后接得上刚才的上下文;改善) |
| 流式显示 | 一步的 delta 攒成一条 text 事件,工具调用前先把攒的吐出来 | 对话不变;工作台照旧逐字 append(itemId `会话:revision:步`,续接后不会和上一次撞上) | 否 |
| 错误 | `cancelled` / `step_budget`(都补一个 result)、边界产的 provider 码(`openaiErrorCode`)、分不出 ⇒ 按文字认 `auth_failed`;请求没有自己的重试之外的处理 | 码一个没改(对话同上,工作台 `api_task_*` + provider 码);多一条:对话失败后历史若停在半截工具调用,退回这一步之前(下一轮请求不会是坏的);对话的 result 现在带端点报的用量(以前不带) | 否 |
| 图片 | `[image:路径]` 挖出来缩好,作 `Uint8Array` 图块随消息送;view_image 的图另起一条用户消息 | 同样的整理,图块改成 data URL 字符串(和工作台一样,能原样存进 SQLite);存档里图换成一句「[图片:当时看过,存档里不留]」(一张就是几 MB),在跑的会话照样带着图 | 很少:续接来的会话看不到之前那张图本身,只知道有过 |
| 取消 | 只在步与步之间生效:请求不掐,`/stop` 要等这一步说完;剩下的工具回「Cancelled」 | 请求经 AbortSignal 真掐;剩下的工具照旧每个 call id 回「Cancelled」;对话的 `cancel()` 照旧不等,`close()` 最多等 4 秒再关 MCP(工作台照旧等不到就报 `api_task_close_unconfirmed`) | 是(/stop 更快;改善) |
| 网络 | 每次 spawn 建 `createAiSdkChatModel`;守护按构造时的端点 + 这次钉的模型判;边界超时 `makeTimeoutFetch`;AI SDK 缺省重试 2 次、不设输出上限 | 同一个 `createApiModel`,对话传 `maxRetries: 2`、`maxOutputTokens: null`(和以前一样),工作台照旧 0 次 / 4096;守护、超时、只剥开头 `<think>` 都是同一份 | 否 |

另:能力表 `OPENAI_CAPABILITIES.supportsResume` 仍是 false —— 它现在只是「会话没报 `resumedHistory` 时」的兜底;委派的光杆 peer 没有 DB,照旧每次从头来。

**后续**:真机核一次 DeepSeek / Kimi 对话「重启后接着聊」(含带思考的模型:存档里留着它的 reasoning 分块,回送时端点接不接);对话历史没有自动压缩,超过 192 KiB 就从头来,要接得更久得做摘要;v86 是这条分支取的号,和别的分支撞号按迁移规矩后合的改号重抄指纹。
### B1b:Claude 对话 vs 一起做 逐项

| 项 | 对话(`claude-agent-provider.ts` 的 spawn) | 一起做(`claude-workbench-runtime.ts`) | 合了没有 / 为什么不合 |
|---|---|---|---|
| 协议 | Agent SDK `query()`,流式输入;SDK 自己起 `claude` 子进程 | 同一个 `query()`;`spawnClaudeCodeProcess` 换成自己起(detached 进程组),加 `includePartialMessages`、`--replay-user-messages` | 同一条路。选项构造本来就一份(`sdkOptionsForProject` + spawn 里的执行选择) |
| 中途插话 | 没有:一轮在跑再 `dispatch` 抛错,协调器排队 | `submit()` 以 `priority: 'next'` 插进去,等原生 replay 确认 | 不合:对话侧要先定产品行为(同 B1 的「后续」) |
| 常驻会话 | 一轮一个事件流,`result` 收这一轮,会话留着等下一轮(会话管理器空闲回收) | 一整段一个事件流;后台任务 / 子助手在登记就 retained,只有验证过的原生版本才在 result 收尾 | 不合:生命周期就是两种用途的区别 |
| 进程组清理 | close = SDK close + interrupt + abort;子进程自己 setsid 出去的组不管 | 扫 ps 冻住全部子孙组 → SIGKILL → 核到全退;`processGroups()` 给「没确认退出」的证据;网络守护能冻 / 放 / 杀 | 不合:这是一起做「放开文件夹」要的证据;对话侧没这个需求,而且它是 POSIX 专用 |
| 权限回调 | `canUseTool` 由 `sdkOptionsForProject` 给(对话 = `permission-relay`,面 chat) | 同一个入口给(`makeWorkbenchClaudeCanUseTool`,面 workbench),运行时不碰 | 本来一份(`authorize`),按用途配 |
| MCP | `options.mcpServers`,对话 = 微信 MCP 等 | 同一个字段,一起做 = 这件事登记的原生 MCP | 按用途配 |
| 续接 | `options.resume = resumeSessionId` | 同 | 本来一份 |
| 图片 / PDF | `userContent`:图片、PDF 原样给,其他文件给元数据 | 同一个 `userContent` | 合了(`claude-sdk-messages.ts`;以前靠 `helpers` 注入) |
| 思考 | thinking 块丢掉;effort / thinking 选项同一套 | 同 | 本来一样 |
| 额度 / 认证报错 | SDK `error` 标注 → 码(`billing_error` ⇒ quota、`authentication_failed` ⇒ auth_rejected …),等 result 的 HTTP 状态;两句哨兵 ⇒ auth_failed | 同一个判法 | 合了(`claudeAssistantFailure` / `claudeApiFailure`)。`is_error` 而无标注那一条后来也合了(B1b 补,`claudeResultFailure`)。还剩一处不同,没动:auth_failed 的 message 对话带原文前 160 字、一起做不带(两边都按码说话,message 不给人看) |
| 取消 | `interrupt()`(吞掉 transport 已死的错),这一轮等 result 收尾 | `interrupt()`;关的时候整组收掉 | 不合:跟着生命周期走 |
| 文字 / 时间线 | 相邻文字块攒一段、遇工具冲出;子 agent 文字不发;成功轮带 `finalText` | 逐字流 append + 整块 replace(itemId)、工具活动开始 / 完成、子助手文字进它那条活动的 output | 工具活动的构造合了(`toolActivityStart`);对话侧那份时间线抄本删了 |
| Windows | 能跑 | 拒(`claude_workbench_process_groups_unsupported`,没有进程组) | **这是不合并成一个会话类的硬理由**:对话搬过去 Windows 上的 Claude 对话就没了 |

**后续**:~~一起做要不要也认「`is_error` 而无标注」那种失败~~(主人 2026-10-26 定对齐,B1b 补做了);对话侧的中途插话等协调器定行为后可以直接用运行时的 `submit` 那套确认法。

## 修订记录

- 2026-10-25:初稿。
- 2026-10-25:主人点头「对话也走放行规则」(只在主人自己的对话、红线照旧问、放了在回复里说一行),进度表加「C2 补」一行,等主人点头的那一条划掉。
- 2026-10-25:F4 做完(进度表);「等主人点头」里网页 v1 那条主人已定。
- 2026-10-25:F3 做完(进度表):App 里没有手写的 `/m/api`、`/set/api` 字符串了;网页换同一张表是下一步。
- 2026-10-25:B2 做完(进度表 + 差异表):OpenAI 兼容对话 / 工作台合成一种会话,对话历史进 api-sessions(v86);工作台照旧只有文件工具(计划里「工作台 = 文件工具 + 微信工具」更正)。
- 2026-10-25:G 设计稿出了(进度表「G 设计稿」),五条等主人点头的在稿 §4。
- 2026-10-25:B1b 做完(进度表 + 逐项差异):Claude 两条本来同一个 SDK,收共用的消息映射,删对话侧走不到的时间线抄本。
- 2026-10-25:F5 做完(进度表):桌面没有手写的 `/v1` 字符串,`lib.rs` 不再照抄路径表、两个代理合成 `daemon_request`;F6 只清点没换(换了 daemon 没起就读不到,要主人点头)。
- 2026-10-26:B1b 补做完(进度表 + 逐项差异):一起做的 `is_error` 判定和对话共用 `claudeResultFailure`,这种回合在一起做里从「完成」变「失败」(`provider_failed`)。
- 2026-10-25:E5 做完(进度表):app 只经 ports / domain 认 adapters,depcheck `app-does-not-reach-up` 零例外。
- 2026-10-26:G0 做完(进度表):记忆金样进库,G2 起每步都跑。
- 2026-10-26:G1 做完(进度表):知识库四个库进迁移框架,建表 / 改表只在迁移里(守卫基线 0)。
- 2026-10-26:G2 做完(进度表):主库三张记忆表(v87)+ 从行渲染,金样逐字节相等。
- 2026-10-26:F6 做完(进度表):桌面里 daemon 能回的都走 `/v1`,还起 CLI 的只剩守卫钉住的那张名单(每条写着为什么)。
- 2026-10-26:B1 补做完(进度表「B1 补:Codex 对话逐条问」):主人对话里 Codex 审批 on-request,逐条过 authorize / 放行规则 / 微信拍板卡;C3 快照 codex / admin 三格 ask→allow → ask;`noAskNotice` 按对话档位。
- 2026-10-26:poll loop 快车道(进度表「B1 补:Codex 对话逐条问」):拍板卡的「y / n」在等它的那一轮跑着时也当场生效(Claude / Codex 对话都是)。
- 2026-10-26:G3 做完(进度表):记忆文件开机导入主库(v88),核对不过不搬。
- 2026-10-26:G4 做完(进度表):记忆写者先落表再导出,手改 memory.md 照记忆编辑处理(主人 10-26 第 4 条)。
- 2026-10-26:G5 做完(进度表):一种收回,四个入口一路传到底(主人 10-26 第 1–3 条);列表与恢复的界面在 G6。
