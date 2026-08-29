# 外发健康(被动追踪 + 恢复检测)— 设计

日期:2026-08-22
状态:已评审(范围三档经用户拍板选「可观测 + 恢复检测」;spike 证据见 §0)
背景:2026-08-21 reminders 真机验收撞出系统性盲区——所有 ilink 外发持续
`errcode=-2: prepare failed`,而 `/v1/health` 12 个子系统全绿、doctor 不知情。
主动性功能(reminders、companion push、penpal)静默退化成重试循环,没有
任何可观测面。本设计给外发链路一个诚实的健康信号。

## 0. Spike 证据(2026-08-21 真机探针,全部可复现)

- **`-2` 是账号级、服务端的**:同一 bot token 下 `getupdates`(收)正常、
  `getconfig` 正常(能发新鲜 typing_ticket),唯独 `sendmessage` prepare
  被拒;带不带 per-chat `context_token`、新旧 token 结果完全一致——
  **排除"per-chat 票据过期"假说**(context_tokens.json 按 chat 持久复用,
  与本故障无关)。
- **历史形态**(channel.log 考古):8/13 起零星阵发(单次逻辑发送 ×3 线上
  重试即 RETRY_FAIL),均无干预自愈;2026-08-21 首次持续型(25+ 分钟)且
  熬过 daemon 重启。最可疑相关变量:owner **3 天无入站**(上次 08-18
  07:20)。
- **最强假说(未证实,登记不依赖)**:ilink 消息信道是端到端会话式,
  `prepare` 需要对端(owner 的微信客户端)近期活跃参与;闲置过久对端
  会话失效,客户端无确定性自愈手段,对端活跃即恢复。§3 的 episode
  闭合日志就是将来验证该假说的经验数据源。
- ilink 拓扑:`baseUrl = https://ilinkai.weixin.qq.com`(腾讯官方 bot
  API);`src/lib/ilink.ts` 是薄 HTTP 客户端(227 行);所有文本外发
  经 `ilink-glue.ts` 的 `sendMessage`(内含 3 次线上重试,`{msgId,error?}`
  永不 reject 契约)。

**已定决策(2026-08-22 用户拍板):只做可观测 + 恢复检测。** 主动保活
实验(sendtyping/重握手等,全是未验证假说、有风控副作用风险)与生产者
门控(companion push 在 down 时跳轮)两档落选;reminders 已有指数退避,
天然正确消费本故障。

## 1. 追踪器:`src/daemon/ilink/outbound-health.ts`

纯状态机,零 I/O,时间注入:

```ts
export type OutboundState = 'unknown' | 'ok' | 'degraded'
export interface OutboundHealth {
  state: OutboundState
  consecutiveFailures: number      // 逻辑发送粒度(非线上重试粒度)
  lastOkAt: string | null          // ISO
  lastFailAt: string | null
  lastError: string | null
  episodeStartedAt: string | null  // 首次连续失败的时间;ok 时 null
}
export interface OutboundHealthTracker {
  recordSuccess(nowIso: string): void
  recordFailure(nowIso: string, error: string): void
  snapshot(): OutboundHealth
}
export function makeOutboundHealthTracker(deps: {
  log: (tag: string, line: string) => void
  /** 连续多少次逻辑失败转 degraded。缺省 2(≈6 次线上失败,置信足够)。 */
  degradedAfter?: number
}): OutboundHealthTracker
```

- 规则:boot 后未发过 = `unknown`;`recordFailure` 累计
  `consecutiveFailures`,达到 `degradedAfter`(缺省 **2**)转 `degraded`
  并记 `episodeStartedAt`(转档瞬间发一行
  `[OUTBOUND] degraded — <n> consecutive failures, last: <error>`,只在
  转档时发一次,不逐次刷屏);`recordSuccess` 归零并转 `ok`——若此前处于
  degraded,**闭合 episode**:
  `[OUTBOUND] recovered after <时长>, <n> failures — last error was: <error>`。
- **内存态,不落盘**:重启归 unknown;有任何在途主动发送(如 pending
  reminder 的退避重试)会在几分钟内重新标定。显式取舍:episode 跨重启
  的时长统计会失真(2026-08-21 的 episode 就熬过了重启),换取零持久化
  复杂度;doctor/health 展示的是"自本次 boot 以来"的诚实语义。
- `lastError` 截断 ≤200 字符(防日志体嵌套膨胀)。

## 2. 挂点:ilink-glue 的 sendMessage 咽喉

`src/daemon/ilink-glue.ts` 的 `sendMessage`(全部文本外发的单一咽喉:
reminders sweeper、companion push、guest 通知、degraded 摘要、penpal、
正常回复……都走它)在其现有 `{msgId,error?}` 归一点上挂
`recordSuccess/recordFailure`。**expired-rebind 分支除外**(账号被顶替的
`{expired:true}` 路径是绑定失效不是链路故障,不计入)。`sendFile`/
`broadcast` 若与 sendMessage 共享同一归一点则顺带覆盖,否则 v1 不追
(文本是主动性功能的全部载体)。

tracker 实例由 ilink-glue 构造并随 adapter 暴露
(`ilink.outboundHealth(): OutboundHealth`),不新增全局单例。

## 3. 暴露面

- **`GET /v1/health`**(routes-health.ts):新增兄弟字段
  `outbound: { state, consecutive_failures, last_ok_at, last_error }`。
  **不进 `subsystems[]`**——那是 SubsystemSupervisor 的 boot 期清单
  (ok/degraded/off 语义绑定启动结果),外发是运行期链路,混入会污染
  两边语义。desktop 零 UI 改动(加性字段,现有健康面不解析不受影响,
  符合 keep-desktop-ui-simple)。
- **`doctor`**(src/cli/doctor.ts):读 /v1/health,`outbound.state ===
  'degraded'` 时输出一行:
  `⚠️ 外发链路故障(连续 <n> 次失败,最近错误 <err>)。多为微信端会话闲置过期——给 bot 随便发条消息即可恢复;恢复后积压的提醒会自动补投。`
  `unknown`/`ok` 不输出(doctor 只说异常)。
- 恢复时**不**给 owner 发微信通知(补投的提醒本身就是恢复信号;且
  degraded 期间也发不出去——循环依赖)。

## 4. 测试策略

- 状态机单测:unknown 初态;1 次失败仍非 degraded(阈值边界);2 次转
  degraded + episode 起点 + 转档日志恰好一行;成功归零闭合 + recovered
  日志含时长与次数;lastError 截断;时间全注入。
- glue 挂点测试:构造 fake ilink server 令 sendmessage 失败,断言
  adapter 的 outboundHealth() 真实转档(不是 mock 状态机);expired
  分支不计入的断言。
- health 路由测试:outbound 字段形状 + 三态渲染。
- doctor 测试:degraded 渲染该行、ok/unknown 不渲染。
- 全量回归 `bun --bun vitest run`(容忍既知 2 个 bootstrap.test.ts 环境
  失败)。

## 5. 不做(YAGNI,显式登记)

- 主动保活/自愈实验(sendtyping、重握手——假说未验证,风控风险);
- 生产者门控(companion push 跳轮——reminders 的退避已示范正确消费姿势,
  等真实需求);
- episode 跨重启持久化;
- owner 恢复通知;
- 按 chat 维度的外发健康(故障是账号级的,spike 已证)。

## 6. 实现期批注(2026-08-22,SDD 执行完结)

- **[fix-wave 增补]** doctor 探针 fetch 加 `AbortSignal.timeout(3000)`——
  终审唯一 Important:daemon 假死(进程活、事件循环卡)时 TCP 能连上但
  永无响应,doctor 会无限挂起,恰是本功能针对的最重病类(680fb102)。
- **[偏差登记,评审背书]** §4 设想的 __e2e__ harness 测法在 Task 2 不可行
  (真 DaemonHandle 不暴露 adapter、__e2e__ 被默认 vitest config 排除):
  adapter 级测试落在 ilink-glue 高度直连 startFakeIlink(真实线上往返);
  端到端链(真 bootDaemon→HTTP /v1/health)由 Task 5 的
  __e2e__/outbound-health.e2e.test.ts 补齐。fake server 的
  failSendMessage 缺省 errcode -6(不可重试,省 2s/次的重试等待)。
- **[deferred]** 多账号共用一个 adapter 级 tracker(账号级信号会合流——
  现单账号,spec 范围内);记录性 minor 清单见 SDD ledger 与终审报告
  (log() 在 record 调用内直写 stderr 属既有系统模式等)。
