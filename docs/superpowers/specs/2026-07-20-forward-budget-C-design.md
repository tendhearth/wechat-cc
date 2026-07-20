# 中间人转发预算 — 设计 spec（匿名笔友层 sub-project C）

> 状态：设计已定稿（2026-07-20 讨论）。这是 [匿名笔友社交层 spec](2026-07-18-anonymous-penpal-social-layer-design.md)
> §7「防滥用（无稳定声誉下）」的中间那层落地。sub-project A（笔友通道）+ B（信箱传输）已 SHIPPED 到 master。
> 落地计划由 writing-plans 另出。

## 0. 一句话

**给中间人 W 的"替别人转发"加一个 per-sender 令牌桶预算：每个上游好友每小时最多让 W 放大 N 个不同意图，超了就 W 只本地应答、不再转发。防止一个好友（或被攻陷的好友 CC）把 W 当免费广播管道。**

## 1. 为什么（C 补的缺口）

父 spec §7 的防滥用是三层:(1) 中间人真实好友门（已有 —— 要经 W 转发得先是 W 的真朋友）;(2) **每中间人转发预算**（← 本 spec）;(3) 两端 CC 各自过滤（另一回事，deferred）。

现有的转发（spec #2 forwarding hop，`makeForwarder`）已有三道闸:**hop 上限 ≤2**、**永不回转给发送方**、**seen-intent 去重**（同一 intent 不重复转发）。但它们只挡**环路**和**重复**——**没有任何东西限制一个发送方能推多少个"不同"意图穿过 W**。所以一个好友能给 W 灌 1000 个不同 seek → W 全转发给自己的 peer 网 → W 的 peers 被刷屏、W 烧 1000 次 judge/forward。**W 成了免费放大器。**

C 就是那道量级闸:**per-sender 转发预算**。

## 2. 铁律 / 原则

1. **超预算 = 静默本地应答**:W 仍**本地 judge + 应答**它自己的匹配,只是**不再放大**。**不给发送方任何信号**(不泄露 W 在限流;flooder 只是悄悄停止被放大)。fail-closed。
2. **per-sender 公平**:一个重度但合法的好友不该饿死别的好友的转发额度——每个上游发送方独立预算。
3. **信任门仍在**:预算是"真好友门"之上的量级闸,不替代它;要能触发预算你得先是 W 的真朋友。
4. **不做真币/声誉**:预算是本地、主观、无状态发布的;不攒全局声誉(父 spec 铁律)。

## 3. 设计

### 3.1 预算原语（daemon core，新）

- **`makeForwardBudget(opts)`**:一个 per-key 令牌桶,key = **上游发送方 agent id**。
  - `opts`: `{ perSender: number（桶容量，默认 30）, windowMs: number（重填窗口，默认 1 小时）, now?: () => number }`。
  - `try_consume(senderId): boolean` —— 有令牌则扣 1 返回 true;空了返回 false。按注入的 `now` 随时间重填(可测试;不内部 `Date.now()`,沿用 relay `makeRateLimiter` 的做法)。
  - **in-memory**(`Map<senderId, bucket>`):daemon 重启重置预算。可接受——重启罕见、攻击者无法强制 W 重启;放大的爆炸半径本就有限(hop≤2)。持久化计数 = v1 加固。
  - 形态复刻 `relay/rate-limit.ts` 的 `makeRateLimiter`(令牌桶 + 时间注入 + `Math.max(0, refill)` 防负、大跳变 cap 到容量),但住在 daemon core(不是 relay/ 那个独立进程)。**per-key Map 无淘汰 = v0 已知,同 relay。**

### 3.2 消费点（2 处）

1. **`src/core/social-forwarder.ts` `makeForwarder`（seek 转发,主放大面）**:在**决定要 fan `hop+1` 卡之前**(即现有 `alreadySeen || card.hop >= cap` 早返回之后、真正 `forwardSend` 之前),先 `budget.try_consume(event.agent.id)`。**false → 跳过转发,直接返回本地 `receipt`**(W 仍本地应答)。true → 照常转发。
   - 注入方式:`ForwarderDeps` 加一个 `withinBudget(senderId): boolean`(把预算原语注入,保持 forwarder 纯 + 可测),wiring 里接 `makeForwardBudget`。
2. **`src/core/penpal-relay-letter.ts` `routeLetter`（信件转发,B 之后是 push-only fallback,罕见)**:那行 `// TODO(sub-project C): budget.consume(relay_token) gate before re-posting` —— 换成真的:re-post 之前 `budget.try_consume(<letter 的上游发送方 agent id, = event.agent_id>)`,**false → drop,不 postLetter,响应复用现有「无匹配 relay leg」同款 `{ok:false, error:'unknown_channel'}`(NOT 一个新的 `over_budget` 字符串)**。
   - 注:B 让熟人/relay-direct 信件绕过 W;只有对方 push-only 时才走 routeLetter,所以这条消费点低频,但同一预算原语顺手盖住,闭掉 TODO。
   - **§2 铁律强制的伪装(CRITICAL,review 发现):`src/core/a2a-server.ts`(`/a2a/letter` 路由,约 416-419 行)把 `onLetter` 的完整返回值原样 `JSON.stringify` 回给调用方(HTTP 200)。若 over-budget 返回一个独有的 `error:'over_budget'`,发送方直接从响应里读出「我被限流了」——这就违反了 §2「不给发送方任何信号」。必须让 over-budget 的丢弃与「W 没有这条 relay leg」（已有的 loop-safety / 未知 channel_id 分支）**响应完全相同**(`{ok:false, error:'unknown_channel'}`),让 flooder 无法从响应区分「被限流」和「W 根本不认识这个 channel」。forwarder 消费点不受影响:它 over-budget 时返回的是和「无下游 yes」一样的本地 `receipt`,本来就已经不可区分,无需改动。

### 3.3 配置

- **`AgentConfig.forward_budget?`**:可选 `{ per_sender: number, window_ms: number }`,默认 `{ per_sender: 30, window_ms: 3_600_000 }`(30/小时/发送方)。缺省即默认。additive、optional —— 不破现有 config 解析。
- wiring(`wire-social.ts`)读 config → `makeForwardBudget` → 注入两个消费点。

### 3.4 可观测（轻量）

- 超预算跳过时,W **本地 log 一行**(`[forward-budget] over budget for <senderId>, local-only`)——运营方看得到限流在起作用,但**不通知发送方**(§2 铁律)。不加指标面/持久计数(v0)。

## 4. 与现有代码的接缝

| 现有 | C 里 |
|---|---|
| `makeForwarder`(hop 上限 + no-回转 + seen-dedup) | 加第 4 道闸:`withinBudget(senderId)` gate(超了→本地应答不转发) |
| `penpal-relay-letter.ts` routeLetter `// TODO(sub-project C)` | 换成真 `try_consume` gate(超了→drop) |
| `relay/rate-limit.ts` `makeRateLimiter`(令牌桶,relay 独立进程) | **形态参考**,但 C 的 `makeForwardBudget` 住 daemon core(独立实现,不跨 relay/ 边界 import) |
| `AgentConfig`(agent-config.ts) | 加 optional `forward_budget` |
| `wire-social.ts` | 构造 `makeForwardBudget`(读 config)+ 注入 forwarder & relay-letter |
| — | **新增:`src/core/forward-budget.ts`** |

## 5. 测试策略

- **预算原语单测**(`forward-budget.test.ts`):允许到容量 → 扣光后 `try_consume`=false → 随注入时间重填 → 再允许;per-sender 隔离(一个 sender 扣光不影响另一个);大时间跳变 cap 到容量、时间倒退不加令牌。
- **forwarder 消费点**:超预算的 sender → forwarder **本地应答但 `forwardSend` 不被调用**(assert 未转发);预算内 → 照常 fan-out。per-sender 隔离贯穿到 forwarder 层。
- **relay-letter 消费点**:超预算 → `routeLetter` drop 且返回 `{ok:false, error:'unknown_channel'}`(与「无匹配 relay leg」不可区分,§2 伪装要求),`postLetter` 不被调用;预算内 → 照常转发。
- **config**:`forward_budget` 缺省用默认 30/小时;显式配置覆盖;无该字段的旧 config 仍解析。
- **wiring**:两个消费点接**同一个**预算实例 → 断言同一 sender 的 seek-转发 与 letter-转发**共享额度**(在一条路上扣光,另一条路也被限)。

## 6. 分期（C 内，~5 任务）

writing-plans 细化,大致:
1. `forward-budget.ts`(令牌桶原语,时间注入,per-sender Map)+ 单测。
2. `AgentConfig.forward_budget` optional 字段 + 默认 + 解析测试。
3. forwarder 消费点:`ForwarderDeps.withinBudget` + gate + 测试(超预算不转发、只本地应答)。
4. relay-letter 消费点:换掉 TODO、`try_consume` gate + drop + 测试。
5. wiring(`wire-social.ts`):构造预算 + 注入两点 + log;bootstrap 测试;e2e-ish(一个 sender 灌爆预算 → 后续 seek 只本地应答不放大)。

## 7. 明确不做 / 开放点

**不做(v0,留 v1+):**
- **全局 W 上限**(你选了 per-sender;global 作为 backstop 是 v1)。
- **两端/接收方过滤**(§7 第三层,另一回事;低打扰 curation 已部分覆盖)。
- **持久化预算**(重启重置可接受)。
- **给发送方的限流信号 / 指标面**(§2 铁律 + YAGNI)。
- **per-key Map 淘汰**(同 relay,v0 已知)。

**RESOLVED:** seek-转发 和 letter-转发 **共享同一个 per-sender 预算实例**(同一 sender 两条路合计 30/小时,不管走哪条)。这更贴"限制这个人对 W 的总放大"的本意,且实现更简单(一个 `makeForwardBudget` 实例注入两个消费点)。wiring 测试断言两条路共享额度。

## 8. 硬骨头 / 记在案

- **in-memory 重启重置**:攻击者若能诱导 W 频繁重启可绕过——但 W 重启不受外部控制,且 hop≤2 限爆炸半径,可接受。持久化 = v1。
- **窗口边界突发**:令牌桶天然平滑(不是固定窗口计数),突发被容量 cap;可接受。
- **合法重度好友**:30/小时 对真人足够宽,但极端活跃者可能撞顶而静默停转——config 可调;§2 静默是刻意(不泄露限流)。

---

## 附:今日已定的决策清单（供 review 核对）

1. **per-sender 转发预算**(令牌桶,key=上游发送方 agent id)。
2. **两个消费点**:`makeForwarder`(seek 转发,主面)+ `penpal-relay-letter` routeLetter(letter push-only fallback,闭 TODO)。
3. **超预算 = 静默本地应答**(W 仍本地 judge/应答,不转发,不通知发送方)。
4. **in-memory v0**(重启重置)。
5. **config `AgentConfig.forward_budget`,默认 30/小时/发送方**,可调。
6. **deferred**:全局 W 上限、接收方过滤、持久化、限流信号。
7. **seek+letter 共享同一个 per-sender 预算实例**(RESOLVED:一个 sender 的总放大额度合计,不分路)。
