# DaemonModule:一种写法,启停成对(第三批 3b)

2026-10-22 · 架构复查 #507 理念 4「每个功能能整块拔掉」的落地 · 状态:设计稿,待 9d 评审

## 为什么

收敛清单 ①②(10-21 主人拍板)要求:社交、打猎这类少用的功能做成可选模块,新装默认关。前提是「一个功能」在代码里是**一样东西**。现在不是。一个功能的启停散在五套机制里:

| 机制 | 处数 | 管什么 |
|---|---|---|
| `LifecycleSet`(`lc.register`) | 25 | 关机时倒序 stop,单项 5 秒超时 |
| bootstrap 收尾清单(`teardown.add`,#508) | 6 | bootstrap 里起的定时器 / 服务 |
| `phoneLc.add` | 7 | 手机那一簇自己的收尾 |
| `SubsystemSupervisor`(`sup.start`) | 21 | 可选子系统起失败 ⇒ degraded,不拖垮开机 |
| `Ref<>` 晚绑定 | 10(5 个文件) | 构造顺序有环时先占位,之后 `.set()` |

后果:
- **关机顺序看谁先登记**。#508 修掉的三处漏停(yi 的 WebSocket、知识库定时器、空闲清扫)都是这么来的。
- **拔不掉**。关掉社交,得记住改 wire-social、bootstrap/index、路由、命令、伙伴那一拍好几处。漏一处就是「关了但还在跑」。
- **晚绑定没有规矩**:谁需要谁,看注释才知道。

## 同类产品怎么做(取什么、不取什么)

| 产品 | 做法 | 我们取 |
|---|---|---|
| **Obsidian 插件** | `onload` 里用 `this.registerEvent / registerInterval / addCommand` 登记,`onunload` 时框架统一撤掉,插件不用自己写清理 | **启停成对靠构造,不靠自觉**:模块拿不到裸的 `setInterval`,只能经 `ctx.interval()`,登记即托管 |
| **VS Code 扩展** | `activate(context)`,资源 push 进 `context.subscriptions`;命令、菜单在 manifest 里静态声明 | 声明和运行分开:路由、命令仍由第二批的表声明,模块只**提供**处理函数 |
| **Home Assistant 集成** | manifest 写 `dependencies`;`async_setup_entry` / `async_unload_entry`;单个集成装失败只标「设置失败」,HA 照跑;每个集成可以单独停用 | `needs` 依赖 + 失败隔离(并入现在的 degraded 语义)+ 按模块开关 |
| **systemd** | `Requires / After`,停止时严格逆序 | 拓扑序启动,**严格逆序**关机 |
| NestJS | DI 容器 + 装饰器 + `onModuleDestroy` | **不取**装饰器和反射式 DI:我们的模块不到 40 个,一张显式的表就够,读代码的人一眼看得到谁依赖谁 |

## 设计

### 一个模块

```ts
interface DaemonModule<P = unknown> {
  name: string
  needs?: string[]          // 必须先起、起失败我也不起
  wants?: string[]          // 有就用,没有(关着 / degraded)也能起;拿到的是 null
  optional?: boolean        // 起失败 ⇒ degraded,不拖垮开机(SubsystemSupervisor 的语义原样并进来)
  enabled?: (cfg: Config) => boolean   // 缺省 true;false ⇒ 不起,状态 off
  init(ctx: ModuleCtx): Promise<P> | P // 返回值 = 我对外提供的东西(别的模块 needs 我时拿到它)
}

interface ModuleCtx {
  get<T>(name: string): T             // 只能拿 needs 里写了的;拿没写的 ⇒ 开机就抛(不是运行时才炸)
  maybe<T>(name: string): T | null    // 只能拿 wants 里写了的
  lazy<T>(name: string): () => T      // 唯一的晚绑定:构造顺序有环时用,init 全部跑完前调用 ⇒ 抛
  interval(fn: () => unknown, ms: number, name: string): void   // 登记即托管,关机自动 clear
  own(name: string, stop: () => Promise<void> | void): void     // 别的资源(服务、连接):登记即托管
  log: Logger
}
```

**启停成对靠构造**:模块里不再有 `stop()` 要人记得写。起了什么就经 `ctx.interval / ctx.own` 登记,容器关机时按模块**逆拓扑序**、模块内**逆登记序**逐个停,单项 5 秒超时、失败不挡后面(`LifecycleSet` 现在的语义,原样保留)。

### 容器

```ts
const app = await startModules(MODULES, { config, log })
// 关机
await app.stopAll()
// 状态(健康页 / CC 现在怎么样)
app.status()  // [{ name, state: 'ok' | 'off' | 'degraded', error?, sinceIso }]
```

- 开机:按 `needs ∪ wants` 拓扑排序,**有环 ⇒ 开机就抛**,一条测试钉住真实的模块表无环。
- 一个 `needs` 的上游是 off 或 degraded ⇒ 下游也是 off 或 degraded,原因写「上游 X 没起」。不会半起。
- `MODULES` 是**一张显式的表**(`src/daemon/modules.ts`),按名字排,谁依赖谁写在每一行里。main.ts 只剩:读配置 → `startModules` → 等信号 → `stopAll`。

### 顺带消掉的一类空窗

现在不少地方把晚绑定当「可能还没有」来读:`speechRef.current` 取不到 ⇒ 不发、记一行(A2A 捎话、配对结果、自改、终端会话都是这样,#533–#539)。这是因为服务比门先起,开机那一小段里进来的话就只能丢掉、记一行。

按拓扑序起之后,`a2a-server` 在 `needs` 里写上 `speech`,门就一定先建好,这个空窗没了。所以 `ctx.lazy` **只给真正的环用**(pipeline ↔ polling 那种);不是环的「先后」一律写进 `needs`,容器排序。守卫数 `lazy` 的调用,只许降。

### 关掉一个功能 = 一个开关

社交、打猎、画室、来访这几样:`enabled: cfg => cfg.modules?.social !== false`。新装默认值按收敛清单:社交保持开,打猎新装默认关。

模块关着时,**它在表里的路由和命令由容器统一处理**,不用功能自己写分支:
- 路由回 `503 { error: 'module_off', module: 'social' }`,走第二批的错误码表,桌面 / 手机 / 微信的说法从同一张表来;
- 微信命令回一句「社交现在关着,在设置里打开」;
- 伙伴那一拍里属于它的那一步(串门 / 打猎)不跑。

这样就没有「关了但还在跑」:没 init 的模块,它的定时器根本没被登记过。

### 路由、命令怎么挂

第二批的四张表不动,仍是唯一的声明处。每条路由 / 命令在表里多一个字段 `module: 'social'`。模块 init 时只提供处理函数。守卫:
- 表里每个 `module` 都在 `MODULES` 里;
- 模块开着时,它在表里的每一项都有处理函数(少一个开机就抛);
- 模块关着时,它的项全部走上面的统一回复。

## 不做什么

- **不做运行时热插拔**。开关改了以后,走现有的空闲自动重启(#81)。热卸载要处理在途的轮次和半开的连接,收益小、风险大。Obsidian 能热卸,是因为插件没有在途的 LLM 回合。
- **不做第三方插件**。知识库那套 MCP 插件(`plugins/registry`)是另一回事,不并进来。
- **不引入 DI 框架、装饰器、反射**。
- **不改 bootstrap 和 wiring 的分层**,只换「起和停」的写法。

## 守卫(理念 5:数违规,不数行数)

`scripts/daemon-module.guard.test.ts`,按文件计数的棘轮(跟 speech-send 守卫一个做法),只许降:
1. `src/daemon` 里 `setInterval(` 出现在模块的 `ctx.interval` 以外的地方;
2. `new Ref<`;
3. `lc.register` / `teardown.add` / `phoneLc.add` / `sup.start(`。

全部降到 0 时,删掉 `LifecycleSet`、`Ref`、`SubsystemSupervisor`、收尾清单这四样,只剩容器。另外一条测试:用真实的 `MODULES` 拓扑排序,无环、每个 `needs` 都存在。

## 怎么迁(每一步单独合,随时可停)

1. **容器 + 守卫(基线 = 现在的数)**。容器内部先用现成的 `LifecycleSet` / `SubsystemSupervisor` 实现,不改任何功能。
2. **先迁两个最独立的**:yi、知识库。#508 的漏停就出在这两个,迁完它们的收尾由构造保证。
3. **社交整块迁成一个模块,加开关**。这一步兑现收敛清单 ①:关掉 = 一个开关,路由和命令统一回复。
4. **打猎、画室、来访**:同样做法,接上新装默认关(②)。
5. 剩下的 wire-* 逐个迁。`Ref` 逐个换成 `ctx.lazy`,每换一个守卫的数降一。
6. 全部降到 0 ⇒ 删掉旧的四样。

第 1–3 步做完,主人就能看到效果:设置里社交一个开关,关了就整块不跑。后面几步是还账,随时可以停。

## 要 9d 拍的

1. `ModuleCtx` 的形状,特别是 `lazy`:「init 全部跑完前调用就抛」这条够不够防住现在 `Ref` 防的那几种环?pipeline ↔ polling 那个环我还没逐个核过。
2. 路由 / 命令表加 `module` 字段:表是你那一路维护的,字段名和 `gen:routes` 的改法你定。
3. 模块关着时,路由一律 503 `module_off`,还是有些该 404(当它不存在)?我倾向一律 503:主人看到的是「关着,去打开」,比「没有这个功能」诚实。
