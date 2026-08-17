# Subsystem 降级启动(消灭 all-or-nothing boot)— 设计

日期:2026-08-17
状态:已评审(方案 B,三个前置决策见 §0)
解决:docs/ops/2026-06-07-reliability-backlog.md 条目 #1(daemon 启动是 all-or-nothing)

## 0. 背景与已定决策

现状:`src/daemon/main.ts` 的 `bootDaemon` 用一个大 try(`:189-435`)包住全部
`register*` 与 `buildBootstrap`,catch 走 `shutdown(); throw`。companion / guard /
social / knowledge / a2a / mailbox / pairing 任何一个**可选**子系统启动抛错,
整个 bot 下线——而这些子系统没有一个是"能收微信消息并回复"所必需的。
customer-review 已经示范了正确姿势(启动失败 ⇒ 返回 null ⇒ daemon 健康、
路由 503),但这个姿势是它一家的临时实现,没有统一出口。

评审中已定的三个决策:

1. **恢复模型:降级 + 上报,重启时恢复。** 不做自动重试(无重试风暴风险,
   start 不要求可重入);恢复靠下次重启(self-restart 机制已存在)。
   管理员手动重试子系统是自愈计划 step 2 的自然延伸,本轮不做,但状态表
   为它留好了地基。
2. **核心链范围:**"收到微信消息能回复"的最小链路 + internal-api,即
   lock / access / accounts / db → internal-api → bootstrap 核心
   (providers + coordinator + sessions + wireHealth)→ pipeline →
   ilink + polling。这些失败**仍然拒绝启动**。其余全部可降级。
3. **范围边界:只做启动降级。** boot 锁竞争、restart 断开桌面 app 连接
   是独立问题域,不纳入本轮。

方案取舍(评审记录):

- 方案 A(散装 tryStart 包装)被否——降级状态没有统一出口,对结构无沉淀;
- 方案 C(核心链也 Subsystem 化 + 声明式依赖排序)被否——启动顺序里的微妙
  约束(internal-api 先于 bootstrap、thunk-over-bootRef)不值得抽象化,
  且是对最高频改动文件的 big-bang;
- **方案 B(本设计):抽象只覆盖"允许失败"的部分;不允许失败的部分保持
  朴素的顺序代码。**

## 1. 契约与状态模型

新文件 `src/daemon/subsystems.ts`(daemon 层;core/lib 不需要它):

```ts
export type SubsystemState = 'ok' | 'degraded' | 'off'

export interface SubsystemStatus {
  name: string
  state: SubsystemState
  /** 仅 degraded 时存在:err.message 一行摘要(不含 stack)。 */
  error?: string
  sinceIso: string
}

export class SubsystemSupervisor {
  constructor(log: (tag: string, line: string) => void)

  /**
   * 包住一个可选子系统的启动。语义:
   *   fn 抛错(同步或 reject)   → 记 degraded + log,返回 undefined,绝不向外抛
   *   fn 返回 null/undefined     → 记 off(未配置;沿用仓库 "undefined ⇒ 惰性" 约定)
   *   其余返回值                 → 记 ok,原样返回
   * 同名重复 start 是编程错误,直接 throw(启动代码是一次性顺序代码,
   * 不该出现;fail-fast 好过静默覆盖状态)。
   */
  start<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined>

  statuses(): SubsystemStatus[]
  degraded(): SubsystemStatus[]
}
```

要点:

- **`Lifecycle` 接口与所有 `register*` 函数签名零改动。** supervisor 是
  调用侧包装,不是新的注册协议。
- **状态只在内存,不持久化。** 每次启动重新推导,没有陈旧状态问题。
  刻意不复用 `health/incident-store.ts`——那是连接健康的领域模型
  (`Dependency`/`FailureKind` 枚举),硬塞子系统名进去是错误的耦合。
- `error` 只存一行 message;完整 stack 进 `log('SUBSYS', ...)`。
- 不做 start 超时(v1 non-goal,见 §4)。

子系统命名(状态表 + /v1/health + 管理员消息统一使用):
`companion.push`、`companion.introspect`、`companion.ingest`、`guard`、
`mailbox-poller`、`customer-review`、`knowledge`、`social`、`a2a-server`、
`pairing`、`self-restart`。

## 2. 两处接入点

supervisor 在 `bootDaemon` 早期(`registerInternalApi` 之前)创建,同一实例
贯穿两处。

### 2a. main.ts — 可选 lifecycle

六个可选 register 改为经 supervisor 拉起,成功才进 `LifecycleSet`:

```ts
const pushLc = await sup.start('companion.push', () => registerCompanionPush(wired.companionPushDeps))
if (pushLc) lc.register(pushLc)
```

覆盖:`companion.push` / `companion.introspect` / `companion.ingest` /
`guard` / `mailbox-poller` / `customer-review`。

- `mailbox-poller`:门逻辑移进 start 的 fn——deps 缺失时 fn 返回
  undefined(⇒ off),否则返回 `registerMailboxPoller(...)`。
- `customer-review`:现有"返回 null ⇒ 可选"的临时姿势收编进 supervisor,
  null 自动落成 off——行为不变,状态可见了。
- `ingest` 成功时照旧 `wireRef(wired.refs.ingestNudge, ingestLc.nudge)`;
  失败则 ref 不 set(消费方语义见 §4)。guard 同理。

### 2b. buildBootstrap — 可选 wire 块

`buildBootstrap` 的 `deps` 新增 `supervisor: SubsystemSupervisor`(必传,
e2e/eval 调用方一并更新)。内部五个可选块各自包进 `sup.start`:

| 名称 | 现有代码块 | 失败后的产物 |
|---|---|---|
| `knowledge` | knowledge_enabled 块(store/embedder/adapter timer) | `knowledge = undefined` |
| `social` | `wireSocial(...)` | `socialWiring = undefined` |
| `a2a-server` | `wireA2aServer(...)` | `a2aServer = null`、`a2aDeps` 缺省 |
| `pairing` | `wirePairing(...)` | `pairingEngine = undefined` |
| `self-restart` | `wireSelfRestart(...)` | 机制不启用 |

下游现有的 `if (boot.social)` / `boot.knowledge?.` / `boot.pairing?` 分支
原样生效——降级在类型上等同于"未配置"。`Bootstrap` 类型里目前非可选的
对应字段(如 `a2aDeps`)改为可选,main.ts 消费点补 `if` 门(与 social/
knowledge 现有姿势一致)。

**核心链一行不包**:providers 注册、coordinator、sessionManager、wireHealth、
以及 main.ts 侧的 internal-api / pipeline / ilink / polling / sessions,
失败照旧走 `shutdown(); throw`。

**可选块间的依赖规则**(必须遵守,plan 中含审计任务):可选块只能消费
**可空**的上游产物;若依赖另一个可选块,拿到 undefined/null 时必须走自己
的"未配置"路径。现状已合规的例子:`wireSocial` 对 `a2aServer` 的
`getServerBaseUrl` thunk 返回 null 时社交侧自行降级。审计范围:
social↔a2a-server↔pairing 三者的共享 infra(registry/client/eventsStore
属核心侧,不在降级范围)。

失败后的**部分构造清理**:每个被包的块若在抛错前已创建持资源对象
(如 knowledge 的 sqlite store、a2a 的端口监听),块内自行 try/finally
释放后再让错误冒给 supervisor。supervisor 不承担清理职责——它看不见
块内部。

## 3. 上报路径

1. **`/v1/health` 增加 `subsystems: SubsystemStatus[]`。**
   `internal-api/schema.ts` 加 zod 定义,routes 从传入的 supervisor 读
   `statuses()`。supervisor 先于 `registerInternalApi` 创建,直接作为
   dep 传入——不需要 thunk-over-bootRef 姿势。桌面端后续可显示(本轮
   不改桌面 UI,遵守 keep-desktop-ui-simple)。
2. **启动完成后的一次性管理员汇总。** `didStartup = true` 之后:若
   `sup.degraded()` 非空,`log('SUBSYS', ...)` 并通过
   `ilink.sendMessage(adminChatId, ...)` 发**一条**汇总消息,形如
   "⚠️ 本次启动有 N 个子系统未能启动:companion.push(<一行错误>)…
   核心收发不受影响,重启可重试。" adminChatId 用现有
   `resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)`
   解析;解析不到(未配置 admin)只落日志。发送本身 try/catch,
   失败不影响启动结果。
3. **`off` 不通知**(未配置是常态),只出现在 `/v1/health` 供排查。
   `ok` 同样不通知。

## 4. 错误处理与 Ref 语义

- **degraded 的子系统不进 `LifecycleSet`**,shutdown 路径无需感知降级。
- **可选子系统的 `Ref` 消费方必须 null 安全。** guard 降级 ⇒
  `wired.refs.guard` 永不 set;ingest 降级 ⇒ `refs.ingestNudge` 永不 set。
  plan 含审计任务:这两个 ref 的全部消费点必须走 `.current ?? 兜底`,
  发现 `deref()` 硬取的改为可空路径。(核心链的 ref,如 `refs.polling` /
  `refs.pipeline`,不在此列——核心失败即拒启,deref 语义不变。)
- **不做 start 超时**(v1 non-goal)。现有可选块的 start 都是快路径
  (端口绑定 / 定时器 / 文件读);重活(knowledge 回填、embedder 预热)
  已经用 `setTimeout` 延迟到 boot 之后。若将来某个可选子系统引入慢启动,
  再补超时——写在这里作为显式取舍,不是遗漏。
- supervisor 自身必须极简可靠:`start` 的 catch 分支只做内存写 + log,
  不做任何可能再抛错的事(保护机制不能成为新的故障源,同
  incident-store 的既有原则)。

## 5. 测试策略

- **unit(`subsystems.test.ts`)**:三态语义(抛错→degraded / null→off /
  值→ok)、异步 reject、同名重复 start 抛错、`statuses()`/`degraded()`
  快照、错误摘要只含 message。
- **e2e(`src/daemon/__e2e__/`)**:通过注入必然抛错的可选子系统启动
  (harness 现有 deps 注入缝),断言:
  1. `bootDaemon` 正常 resolve(不再 throw);
  2. fake-ilink 里 bot 仍能收消息并回复(核心链完好);
  3. `GET /v1/health` 的 `subsystems` 含对应 degraded 项;
  4. 管理员 chat 收到一条降级汇总消息(fake-ilink 捕获);
  5. shutdown 干净(降级子系统未注册 lifecycle,不产生 stop 报错)。
- **回归**:现有全量 unit + e2e 保持绿,即核心链行为未变的证据。
  `injectable-default-seams.test.ts` 若因新增注入缝报警,按其约定补
  默认路径用例。

## 6. Non-goals(显式)

- 自动重试 / 运行时恢复(自愈 step 2 的地盘,状态表已为它留好接口);
- 管理员手动重启单个子系统的路由与命令(同上);
- boot 锁竞争、restart 断开桌面 app 连接(独立问题域);
- start 超时;
- 状态持久化;
- 桌面 UI 展示 subsystems(先有数据,UI 等需求)。
