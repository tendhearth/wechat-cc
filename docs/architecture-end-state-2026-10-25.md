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
| 权限 | `compilePolicy` 是一张翻译表,但 Claude 对话不走它(`tierProfileToClaudeSdkOpts` + 自己的 `canUseTool`),Claude 工作台在 `wire-workbench.ts:63-73` 又手写一套;逐工具判定在五处;主人的放行规则只接了终端会话和一起做 | 「这一步能不能做」没有一个地方说了算,只能靠表格**描述**缺口(`tier-enforcement.ts`) |
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
- **不改行为**:放行规则今天只在终端会话和一起做上生效,收进 `authorize` 以后照旧只在这两处生效(按 `subject.surface` 判)。对话要不要也走放行规则,是看得见的变化,单列等主人。

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
| Claude | `createClaudeAgentProvider` | 同一个,换工作台的 SDK 选项(`wire-workbench.ts` 的 `workbenchClaudeOptions`)+ `claude-workbench-runtime` 管长寿命 | 一份;选项的拼法要收进 C(权限一个判定) |
| agy / Gemini | 各自的 provider | 同一个(免审执行者) | 一份 |
| **Codex** | SDK(`codex-agent-provider.ts`,408 行) | app-server(`workbench/codex-app-server.ts`,902 行) | **两份** |
| **OpenAI 兼容** | 自己的循环 + MCP 桥(`openai-agent-provider.ts`) | 文件工具 + 持久会话(`workbench/api-task-provider.ts`) | **两份** |

| # | 内容 | 做完怎么算 |
|---|---|---|
| B1 | Codex 对话改走 app-server(工作台那条已经更全:中途插话、后台任务、原生历史);SDK 那条退休。**先出逐项差异表**(中途插话、思考过程、工具调用显示、恢复会话、额度报错),有主人看得见的差异 ⇒ 攒进「等主人点头」 | `codex-agent-provider.ts` 删掉 |
| B2 | OpenAI 兼容:一个会话类型,工具面按用途配(对话 = 微信工具,工作台 = 文件工具 + 微信工具);会话持久化统一用 `api-sessions` | 两份实现合成一份 |
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

见第 7 条。

## 顺序为什么这样排

- A 先做:后面每一步都要往「一个模块」里放东西,模块的形状不定,搬过去还得再搬一次。A1 的设计稿和主人的降级确认都已经有了。
- B 只剩两家要合(Codex、OpenAI 兼容),而且合的时候要真机核对行为差异,所以不挡别的:D(协调器)先做,`admit` 一处定档位以后,C 的 `authorize` 正好接在那里。
- E 跟着 B–D 走:目录挪动本身不改逻辑,在每一块搬完时顺手挪,不单独来一轮大挪动(大挪动会跟所有在途分支冲突)。
- F 碰的是协议包、`internal-api` 的处理器挂法、桌面和 App,和 A–E 的文件基本不重叠,可以并行。
- G 碰主人看得见的记忆,而且有一串在途的 PR,放最后。

## 等主人点头的(攒在这里,不中途问)

- 对话要不要也走主人的放行规则(今天不走;收进 `authorize` 后照旧不走)。
- Codex 对话从 SDK 换到 app-server、Claude 对话和工作台合一:目标是行为不变,但两条协议细节(比如中途插话、思考过程)可能有差异;做的时候逐项列出差异,有看得见的再问。
- 网页 v1 传输退休:旧的已配对网页要不要提示重新配对。

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
| F1 第 1 步 | `/v1` 的 zod 契约搬进协议包(`packages/protocol/src/desktop-api.ts`,daemon 的 `internal-api/schema.ts` 只转出);守卫:契约表的键都在路由表里。现在 36 / 209 条 `/v1` 路由有响应契约 |
| A6 第 1 步 | 项目登记(别名 → 文件夹)搬出 ilink 适配器:`src/daemon/projects.ts`,地基里一份;`IlinkAdapter` 少 `projects` / `loadProjects` 两项 |
| C1 第 1 步 | 档位 × 工具类别 ⇒ 放 / 问 / 拒,收成一个纯函数 `core/tool-decision.ts`:Claude(permission-relay)、Gemini(原来为躲 import 环逐字抄的一份)、OpenAI 兼容三家共用;逐格对照测试证明每个档位 × 类别 × 能力表设置都没变 |
| B3 第 1 步 | 照剧本说话的假执行者(Claude SDK / Codex / ACP)搬出 `src/core`,进 `src/test-support/executors/`;depcheck:生产代码不许 import test-support;core-no-node 基线少一行 |
| D1 + D2 | 协调器拆进 `src/app/coordinator/`(`conversation-coordinator.ts` 只转出):`planTurn` 一轮读一次 access、过一次守护,纯函数 `admit()` 定档位 / 被拒 / 参与者 / 回落,产出 `TurnPlan`;`TurnRunner` 管会话锁、超时、进度、取消登记、TurnRecord,solo / /both / /chat 一拍都用它。`resolveTier` / `providerDenialFor` 只在 `admit()` 里调,而且在锁里、开跑那一刻(排队之前的计划只用来选排队方式,评审抓到的越权已修)。D3(删 legacy / shadow 交付)未做 |
| D1 + D2 | 协调器拆进 `src/app/coordinator/`(`conversation-coordinator.ts` 只转出):`planTurn` 一轮读一次 access、过一次守护,纯函数 `admit()` 定档位 / 被拒 / 参与者 / 回落,产出 `TurnPlan`;`TurnRunner` 管会话锁、超时、进度、取消登记、TurnRecord,solo / /both / /chat 一拍都用它。`resolveTier` / `providerDenialFor` 只在 `admit()` 里调,而且在锁里、开跑那一刻(排队之前的计划只用来选排队方式,评审抓到的越权已修) |
| D3 | 交付只剩一条路:删 legacy / shadow 两档、`replyDeliveryFor` / `setReplyDeliveryOverrides`、agent-config `reply_delivery`(旧盘上写着照样开机、被忽略)、`WECHAT_REPLY_DELIVERY` 与 wechat MCP 的 reply 族工具注册、FALLBACK 连击、shadow 旁听、prompt 的「用 reply 说话」版、reply-once 实验代码(数据留着);`replyDelivery` 端口在协调器 / 推送里改成必填。`/v1/wechat/*` 路由留着(附件经它们真发,`reply` 等几条现在没有调用方,另做) |
| E1 第 1 步 | `src/domain/` 开张:档位 / 放行、开口、伙伴判定、提示词、能力表这 43 个纯规则文件从 core 搬进去(codemod 改了 256 个文件的 import);`guestSafe` 与 Confinement 类型抽成 `domain/confinement.ts`。depcheck 两条零例外:domain 运行时只依赖 domain 自己和 lib 里不碰 I/O 的;不碰 node 内置。只引类型暂时放行(core 还没拆完)。下一步:app(协调器)、adapters(执行者、store) |
| E1 第 2 步 | `src/app/`(协调器 `coordinator/*`、会话管理、执行者登记)与 `src/ports/`(执行者的口 `agent-provider`)开张;`auth-fail` 进 domain、`async-mutex` / `async-queue` 进 lib。depcheck 四条:ports 零例外只依赖 ports / domain / 纯 lib;app 不往上依赖、不碰 node(过渡期还能用 core 里没搬完的 store / 工作台)。speech-send 守卫扫到 app / domain / ports |
| E2 | 六家执行者的适配器搬进 `src/adapters/executors/<家>/`(claude / codex / acp(含 Cursor)/ agy / gemini / openai,85 个文件连同测试;原来散在 core 根目录和 core/workbench 里)。depcheck `adapters-implement-ports` 零例外:适配器不往上依赖 app / daemon / cli / features。core-no-node 基线少 19 行(用 node 的是适配器,本来就不该算 core 的账) |
| E3 第 1 步 | 通用的 store(对话、会话、会话状态、回合记录、终端会话、「一件事」)进 `src/adapters/store/`;`TurnRecord` 形状进 `domain/turn-record.ts`(store 不再引协调器的类型 —— 新规则当场抓到的)。功能自己的 store(社交、知识库、定时 …)等那个功能搬进 features 时跟着走 |
| E4 第 1 步 | 工作台服务:`Options` 原样当 `ServiceDeps` 传(删掉那行 2245 字符的逐字段复制),被行数上限挤成一行的字段表 / import / 域构造 / service 对象 / `actions.set` 全部按一项一行摊开(service.ts 没有超过 180 字符的行了);删掉数内函数的 `workbench-service-ratchet` 守卫 —— 它管的两条环 depcruise 早有(`workbench-service-no-circular` / `wechat-control-must-not-link-service`),剩下的只是量症状。`Ref<ServiceActions>` 晚绑定还在,下一步 |
| E2 补 | 工作台错误码的反向守卫扫整个 `src/adapters/executors`(原来只扫 core/workbench 那几份)。「归了类」多一种:任务失败记录认得的码(`executionFailureMessage` 有人话)—— 于是 INTERNAL_ONLY 少了 12 个本来就有人话的;新扫进来的 Claude 工作台运行时不变式、ACP 收尾码列进去。`docs/architecture.md` 的分层图补上 adapters |
| E4 第 2 步 | 工作台服务:`Ref<ServiceActions>` 与 `ctx.actions` 删掉,各域按依赖顺序构造、只拿自己要的那几个域(依赖图写在 `service.ts` 顶部)。反指的边逐条正过来:pump → execute 改成 run 自带 `launch`;`drainInputs` 的 start 由 execute 调下来时带着;lifecycle ↔ inputs 共用的记账搬进 `pending-inputs.ts`;native ↔ execute 共用的核对搬进 `native-check.ts`;`matterSync` 进只认 ctx 的 `matter-sync.ts`;view 只要额度交接的只读一半。剩一条真环(一轮做完 → 检查没过 → 接着改)用一个具名回调 `UntilResume` 在构造时注入 |
| C2 | 逐工具判定只有一处:纯函数 `domain/authorize.ts` 的 `authorize(subject, descriptor, action) → allow / ask / deny`,按序组合旁路(权限模式,经 `compilePolicy`)、扇出拒 reply、坏名字、一起做的登记表、定时任务只读档(污点 / 读的范围 / 红线;要碰路径的事实由调用方算好)、档位 × 类别(`decideTool`)、问不了(`relayAs`)、主人的放行规则。调它的:对话的 `permission-relay`、Gemini gate、openai gate、`wire-model-options` 的定时任务闸门、一起做 Claude 的 `makeWorkbenchClaudeCanUseTool`(`wire-workbench` 外面手包的「没登记就拒」收进来,登记表当 descriptor)、一起做放行规则的落点(`makeRunPermissions`)、终端会话(`permission-gate.makeTerminalDecide`)。放行规则只在 `subject.surface` 是 terminal / workbench 时看(`OWNER_RULE_SURFACES`);对话要不要也走,等主人。`effectivePolicy` 删掉。逐格对照 `authorize.parity.test.ts`:改之前的七份实现原样抄进测试,约 16 万格一位不差(结果、问主人的话 / 码 / 时限、日志、通道调用)。没做:放行规则的 floor / rules-file / decide 还在 `core/permission-rules`(靠 node:path 的 posix / win32 归一,搬进 domain 要先把路径归一做成纯的),`authorize` 经 `permission-gate.decide` 拿它的裁决;ACP 对话侧按模式选放行 / 拒绝项(`compilePolicy('cursor-acp')`)是编译好的常量答案,没过 `authorize`;网络守护按调用目标判、不是逐工具,不在里面 |
| C3 | 每家 × 每档 × 每类工具实际会怎样,从真判定推出来:纯函数 `domain/enforcement-matrix.ts`(派发拒走 `providerDenialFor`;有逐工具回调的取 `authorize` 在对话面上的结论;没有的看档位那一格 + wechat MCP 按会话档位注册(`adminMcpTools` 为假 ⇒ 钉成 trusted)+ `compilePolicy` strict 设置里问不了时怎么落:codex `approvalPolicy` never ⇒ 放,ACP Cursor 应答 reject ⇒ 拒,agy 没有应答项 ⇒ 放)。`noAskNotice` 改成看「哪一档哪一类出现『档位说问、它放了』」算出来,不再读手设的 `doesNotAsk`;算出的提醒对象和原来一位不差(codex、agy)。`tier-enforcement.ts` 与它的两份测试删掉:整张表在 `enforcement-matrix.test.ts` 钉快照(能力表 / 档位 / `authorize` / `compilePolicy` 一改就有 diff),每家缺口的理由搬到快照旁的 `WHY_GAPS`(有缺口没理由、有理由没缺口都红);真调三家闸门的证明测试留着,改名 `enforcement-matrix.proof.test.ts`,并和推出来的格子对照。推导比原来的手写表细一格:agy 在主人聊天里 admin 专用工具(含 `daemon_remediate`)根本不注册,是「调不到」不是「不问」 |

## 修订记录

- 2026-10-25:初稿。
