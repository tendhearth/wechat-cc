# daemon busy 登记处 —— 把"空闲"从"用户不在"修正为"没有工作在跑" 设计

**日期**: 2026-08-11
**状态**: 已批准(架构 review 后对话确认)
**一句话**: 一个引用计数的 busy 登记处,所有不经 SessionManager 的长任务干活时各持一个 token;自我重启的空闲判定改为"会话不在途 且 登记处为空 且 poll 最近成功过",一个概念关死全部盲区。

## 动因

空闲自动重启(spec 2026-08-03)已上线并真机验证,但它对"忙"的感知只有两个信号:`SessionManager.anyInFlight()` 和 2 分钟活动打点。这建模的是"**用户**在不在",而该建模的是"**工作**在不在"。清点(2026-08-11,dev)发现四类运行中会被重启杀掉的工作:

1. **A2A 委派会话**(`bootstrap/delegate.ts` `dispatchDelegate`)——独立 HTTP 端口,三个信号全摸不到,trusted 档位有真实 Bash/Write;被杀 = 副作用半截留在磁盘、无回滚,对端只见连接中断。
2. **ingestTick / introspectTick**(`wiring/tick-bodies.ts`)——cheapEval 不走 SessionManager;且 ingest 自己的门槛(3 分钟静默)比重启阈值(2 分钟)**更严**,所以它运行时 daemon 恒被判为空闲。被杀 = 整轮作废白烧 token。
3. **客户回顾 >2 分钟**(`internal-api/routes-customer-review.ts` fire-and-forget Set)——打点只在请求到达时一次;运行期无信号。被杀 = "分析失败"+token 白烧(有 `reclaimStranded` 自愈,不卡死)。
4. **觅食扇出 / A2A 异步应答**(`social-broker.ts` `schedule` 默认 fire-and-forget;`social-async-responder.ts` 同)——被杀在中途 = seek 永远停在"觅食中"直到 7 天兜底。

另有一条被放大的旧伤:`companion/scheduler.ts` 的 `stop()` 只清定时器、**不等在途的 `onTick()`**,`exit(0)` 直接掐;自动重启恰恰发生在"最像空闲"的时刻,正是 ingest 挑来干活的时刻。

以及一条已知未修的唤醒盲区(终审 I3):睡眠 8 小时后 `quietFor` 恒为最大值,开盖瞬间"最像空闲",其实 poll 还在重连。核实:`connection-health` 的 `HealthState` **没有** `lastSuccessAt`,且睡眠期间无失败记录、唤醒瞬间状态是"健康"的,所以 `shouldSuspend` 挡不住这条——需要补时间戳。

## §1 busy 登记处(新模块,纯)

`src/core/busy-registry.ts`:

```ts
export interface BusyRegistry {
  /** 拿一个 token;返回 release。release 幂等,多次调用无害。 */
  hold(label: string): () => void
  busy(): boolean
}
export function makeBusyRegistry(): BusyRegistry
```

- 内部计数即可(Map<symbol, string> 存 label 仅为将来诊断,当前不暴露枚举 —— YAGNI)。
- **永不抛**。release 幂等靠闭包内一次性标志。
- 放 `src/core/`:cli 与 daemon 都可依赖(daemon↛cli 分层不破)。

## §2 谁持 token

| 持有者 | 位置 | 范围 |
|---|---|---|
| internal-api 分发层 | `internal-api/index.ts` `handleRequest` | 每个**带认证的非 GET** 请求,handler await 期间持有(finally 释放)。覆盖 memory synthesize、以及一切未来的长 POST handler。GET 不持有(桌面 5s 轮询)。 |
| 客户回顾 | `routes-customer-review.ts` `launch()` | fire-and-forget 的 `runReview` 全程,`.finally()` 释放(与既有 `inFlight.delete` 同点)。 |
| A2A 委派 | `bootstrap/delegate.ts` `dispatchDelegate` | 整个一次性会话,try/finally。 |
| companion 三 tick | `companion/scheduler.ts` | `onTick()` 执行期间持有(见 §3)。 |
| 觅食扇出 / 异步应答 | `wire-social.ts` 接线处 | 给 `social-broker` 与 `social-async-responder` 传自定义 `schedule`:包一层 hold/release 再 `void fn()`。核实:两者都已有 `schedule` 注入缝,默认 `(fn) => { void fn() }`,生产接线当前未传 —— 正好补上。 |

**不持 token 的,明确排除**:pushTick/gapCheckin/hunt(走 `sessionManager.acquire`,已被 `anyInFlight` 覆盖);微信入站与 App 对话(同);插件 install/upgrade(`execFileSync` 同步阻塞事件循环,重启检查根本没机会插入执行,结构性免疫)。

## §3 scheduler 的优雅关闭(旧伤,一并治)

`companion/scheduler.ts`:

- 每个 tick 记录在途的 `onTick()` promise;运行期间持 busy token。
- `stop()` 改为:清定时器 + **等在途 promise,上限 4 秒**(`Promise.race`)。4 秒 < `lc.stopAll()` 既有的 5 秒/项预算,不会把整体关闭拖爆。等不完就放弃(现状行为),但 busy token 已经让自我重启根本不会在 tick 运行中触发 —— 这条 await 是给**手动重启**(App 按钮)兜底的第二道线。

## §4 唤醒闸门(终审 I3)

- `connection-health.ts` 的 `HealthState` 增加 `lastSuccessAt: number | null`(初始 null):`recordSuccess` 置为 now,`recordFailure` **不动它**(跨失败保留)。
- 自我重启的空闲判定增加第三个条件:`now - lastSuccessAt('wechat') <= POLL_FRESH_MS`(`POLL_FRESH_MS = 120_000`,与 IDLE_QUIET_MS 同量纲)。**取不到(null / health 未注入)⇒ 不空闲 ⇒ 不重启**,与整套机制的失败方向一致。
- 语义:唤醒后 `lastSuccessAt` 是 8 小时前 ⇒ 挡住,直到 poll 真的成功一次;正常运行时 poll 每 ~2 秒成功一次 ⇒ 恒新鲜;长断网 ⇒ 挡住(断线时该做的是更少,不是更多 —— 与"断线不发消息"的既有共识同向)。
- 数据源:`poll-loop.ts:399` 已在每次成功 poll 调 `health.recordSuccess('wechat')`,不需要新埋点。

## §5 自我重启侧的改动

`self-restart/wire.ts` 的 `SelfRestartDeps` 增加两个**必填**字段(汲取 `as never` 教训,必填让编译器守门):

```ts
busy: () => boolean
/** 最近一次 wechat poll 成功距今 ms;null = 从未成功/取不到。 */
lastPollSuccessAgoMs: (nowMs: number) => number | null
```

空闲判定:`!anyInFlight() && !busy() && quietFor(now) >= IDLE_QUIET_MS && fresh`,其中 `fresh = lastPollSuccessAgoMs(now) !== null && <= POLL_FRESH_MS`。临门复查同步扩展为四个条件全查。`busy()` 抛异常 ⇒ 整个 check 的外层 catch 兜住 ⇒ 不重启(方向正确,无需特判)。

## §6 顺手项(同一轮做掉)

- **接线搬家**:self-restart 的组装从 `bootstrap/index.ts`(现 8 处引用)搬到 `bootstrap/wire-self-restart.ts`,遵守"新接线进 wire-*.ts"的仓库约定。busy 登记处在 bootstrap 构造并挂到 `Bootstrap` 上(internal-api 经 main.ts 的 thunk 取,同 `markInboundActivity` 的既有模式)。
- **共享常量**:`WECHAT_CC_SUPERVISED` 字面量现横跨 `cli/service-manager.ts` 与 `daemon/main.ts`,抽到 `src/core/supervised-env.ts`(一个导出常量),两侧引用。
- `companionConverse` 入口那笔打点与 internal-api 分发层重复:**保留**,作为文档化的纵深防御(删除无收益,留着有注释价值)。

## §7 错误处理与测试

- 登记处永不抛;所有 hold/release 包 try/finally;任何信号取不到 ⇒ 不重启。
- 单测:登记处(hold/busy/release 幂等/并发多 holder);wire.ts 新增两条件的两侧边界 + 取不到 ⇒ 不重启;scheduler stop 等待与 4 秒上限;connection-health 的 lastSuccessAt 跨失败保留。
- 接入点各一条行为测试:客户回顾运行期 busy() 为真;委派运行期为真;internal-api 非 GET handler await 期间为真、GET 不置;social schedule 包裹后 forage 期间为真。
- 全量 `bun run test` + `bunx tsc --noEmit` 零新错(既有基线红除外)。

## 非目标

- 不做 busy 的可视化/诊断接口(将来要再加,label 已留)。
- 不改插件 install 的同步 exec(另一个问题:无超时可能挂起,不属本轮)。
- 不动 lockfile 单向闸门、不动 `MIN_RESTART_INTERVAL` 死代码(已认可的取舍)。
- 不给 A2A 委派加超时(值得做,但属 A2A 域,单独立项)。
