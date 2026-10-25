# 加一个功能

> 架构终态 A3 / A4([架构终态与升级计划](../architecture-end-state-2026-10-25.md) 第 2 条)。样板是日历:`src/features/calendar/`。
> 还没搬进功能目录的老功能照旧在 `src/daemon/` 下;**新功能只有这一种写法**。

## 一个功能 = 一个目录 + 一个模块

```
src/features/<名>/
  index.ts      模块清单:要什么(needs)、给什么(init 的返回值)、挂哪些路由 —— 外面只许 import 这个文件
  <名>.ts       功能本身(纯逻辑尽量放 src/core,这里是接线和状态)
  routes.ts     它的 HTTP 路由(可选)
  *.test.ts
```

`index.ts` 导出一个返回 `DaemonModule` 的函数(`src/daemon/modules/container.ts`):

```ts
export function calendarFeature(d: { stateDir: string; isOwner(chatId: string): boolean }): DaemonModule<CalendarFeature> {
  return {
    name: 'calendar',                       // = /v1/health.subsystems 里的名字 = 路由表里的 module
    needs: ['internal-api', 'ilink-adapter'],
    init(ctx) {
      const calendar = makeCalendar(...)
      ctx.get<InternalApiLifecycle>('internal-api').mount('calendar', calendarRoutes(calendar))
      return { calendar, command: makeCalendarCommand(...) }
    },
  }
}
```

- **只造,不干活**:`init` 里只造对象、登记;定时器用 `ctx.interval`,要停的东西用 `ctx.own`,开动用 `ctx.onStart`。
  会被别的模块 `wants` 的可选模块,能失败的事(占端口、连出去)放在 `init` 里。
- **开关**:有整块开关的写 `enabled`(可以读上游的值,比如配置快照);一件事只有一个开关。
- **可选**:起不来不该拖垮开机的写 `optional: true`(⇒ degraded,`/v1/health.subsystems` 和「CC 现在怎么样」看得见)。
- **晚到的东西**(真环):写进 `lazy`,经 `ctx.lazy` / `ctx.late` 拿;别的一律 `needs` / `wants`。

## 接进 daemon

1. `src/daemon/daemon-modules.ts` 的模块表里加一行,位置放在它要的模块之后、要它的模块之前(表的顺序就是开机顺序,关机倒过来;
   `__e2e__/shutdown-order` 的快照会显示变化)。
2. 有路由:`packages/protocol/src/routes.ts` 里每一行写 `module: '<名>'`,把名字加进 `MODULE_NAMES`;处理器在模块的 `init` 里
   `internalApi.mount('<名>', routes)`,**不进** `internal-api/routes.ts` 的总表,也不往 `InternalApiDeps` 加字段。
   模块关着 / 坏了 / 还没挂上,路由层自己回 `module_off` / `module_degraded` / `module_starting`,处理器里不用写分支。
3. 有手机 `/m/api/*` 处理器:写在功能自己的目录里(用 `src/features/phone/index.ts` 导出的 `ownsMethod` / `PhoneRouteTable`),
   从功能的 `index.ts` 导出那张表,由 `src/daemon/wiring/wire-settings-panel.ts` 放进面板的 `featureRoutes`(样板是信、定时);
   路由表里那几行照旧写 `phone` 块(给不给链接令牌、为什么)。手机功能不 import 别的功能。
4. 有微信命令:模块交出 `command`,在命令表里放到它该在的优先级(现在是 `owner-commands` 那一组的列表,顺序就是优先级)。

## 机器管着的

- `bun run depcheck`:`core` / `lib` / `mcp-servers` 不许依赖功能;功能目录外面只许经 `index.ts` 用它;功能之间不许伸进对方的内部文件。
- `scripts/daemon-module.guard.test.ts` 也扫 `src/features`:裸 `setInterval`、`Ref`、`lc.register` 一出现就红。
- `scripts/speech-send.guard.test.ts` 也扫 `src/features`:直接发微信的调用要登记成 `reply`(回主人刚发来的那一句),主动开口走 `policy.say`。
- `internal-api` 的 `mount`:只能挂路由表里标给自己的那几条,重复挂直接抛。

## 删掉一个功能

删目录 + 模块表里那一行 + 路由表里那几行。typecheck 会指出还在用它的地方。
