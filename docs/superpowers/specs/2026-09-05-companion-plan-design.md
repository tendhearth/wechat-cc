# 伙伴日程判断:出门前先想一下(2026-09-05)

上游:`2026-07-09-proactive-care-design.md`(校准门 `shouldSpeak`、care ledger)、`2026-09-03-companion-presence-design.md`(红线:桌宠只报真实动作)、`2026-09-05-social-tools-design.md`(AI-native 第 1 项;这是第 2 项)。
先例:画室的 `atelier-planner.ts` —— 模型只回严格 JSON,`{"shouldPaint":false}` 就是「此刻没有冲动」。

## 0. 这轮要解决的事

现状(`tick-bodies.ts` `pushTickForChat`):主人会话每一拍按固定顺序查冷却 —— agenda 到期 → 发;否则打猎冷却到了 → **马上**打;否则串门冷却到了 → **马上**去;否则安静够久 → 问候。于是打猎总在冷却过后的第一拍发生,时间由调度器抖动决定,和主人在不在、今天已经发生过什么、包袱里堆了多少没看的都无关。

这轮把「冷却到了就做」换成「冷却到了 → 问伙伴一句现在要不要做」。**冷却、care 档、无回复暂停、安静天数一律不变**:它们仍是代码里的硬上限,模型只能在通过了它们的候选里选一个或选「不做」。

owner 拍板(2026-09-05):
- **颗粒度:每拍问一次「现在做什么」**,不排整天计划。无状态判断 + 一个小日志。
- **范围:只判自发的三样(打猎 / 串门 / 问候)**,到期的 agenda 意图照旧准时由代码发 —— 那是记下来的承诺,不该被临时心情否掉。

## 1. 判断点

`pushTickForChat(chatId)` 里,agenda 段之后、原 hunt / visit / gap 三段的位置,改成:

1. **算候选集**(纯代码):对 `hunt`(仅主人会话、`prefs.hunt !== false`)、`visit`(仅主人会话、`prefs.visit !== false`、`boot.social?.penpal` 存在)、`gap` 各跑一次现有的 `shouldSpeak`。通过的进候选,没通过的把 `reason` 记下来(照旧 `CARE skip … reason=` 日志,一条不少)。
2. **候选为空** → 这一拍结束(和现在完全一样)。
3. **候选非空**:
   - 先看退避(§3):上一次判断是「不做」且不到 `PLAN_REASK_MS` → 记 `PLAN skip reason=backoff`,结束。
   - `evaluate = deps.planEval ?? boot.registry.getCheapEval()`;没有 → **回退到今天的固定顺序**(候选里按 hunt → visit → gap 取第一个执行),记 `PLAN fallback reason=no_evaluator`。
   - 有 → 组 prompt(§2),调一次,`PLAN_EVAL_TIMEOUT_MS` 超时;解析(§2);超时 / 抛错 / 解析失败 → 同样回退到固定顺序,记 `PLAN fallback reason=<timeout|error|parse>`。
   - 解析成功:`action` 不在候选里(含模型编造的)→ 视为 `none`,记 `PLAN downgraded action=<x>`;`none` → 记日志 + 写 plan-log,结束;否则执行选中的那一个,登记方式和现在逐字相同(`claimHunt` / `claimVisit` / `claim` 先于动作,at-most-once)。

执行段(打猎的 `dispatchToChat` + 旁听入库 + `hunt` busy token;串门的 `claimVisit` + `startVisit`;问候的 `buildGapCheckinText`)**原样搬进各自的执行函数,一行逻辑不改**。`visit` 选中且带 `target` 时,`startVisit(target)`;`target` 必须是 `social.provenChannels` 里某一项的 **id**(§2),否则忽略 target 走 `startVisit()`。

非主人会话:候选集只可能有 `gap`,同样走这套(问一次「现在该不该问候」),没有 evaluator 就照旧发。

## 2. 模型看到什么、回什么

**只给衍生信号,不给聊天原文**(和画室同一姿态)。`buildPlanPrompt(ctx)` 的输入 `PlanContext`:

| 字段 | 来源 | 上限 |
|---|---|---|
| `nowLocal`(本地时间 + 星期) | `nowIso` 转本地 | — |
| `ownerLastInboundMinutesAgo` | `messagesStore.latestInboundTs(chatId)` | `null` = 从没聊过 |
| `today`:`lastHuntAt / lastVisitAt / lastProactiveAt`(几小时前,或「今天还没」) | `careLedger.get(chatId)` | — |
| `candidates`:`[{ action, why_allowed }]` + `rejected`:`[{ action, reason }]` | §1 第 1 步 | — |
| `journal`:`{ unread, latest:[{kind,title,ts}] }` | `huntStore.summary(readJournalSeen(stateDir))` + `huntStore.list(3)` | 3 条,title 各 ≤ 40 字 |
| `social`:`{ openWishes, pendingOffers, provenChannels:[{ id, label }] }` | `boot.social.wish.list()` 里 `effective === 'open'` 的条数、`boot.social.intro.offers().length`、`boot.social.penpal.provenChannels()`(新增,§4);社交层没接线时整段为 `null` | label ≤ 5 个 |
| `observations`:`[{ tone, body }]` | `makeObservationsStore(db, chatId).listActive()` 最近 3 条 | body 各 ≤ 80 字 |
| `personaExcerpt` | `memory/<chatId>/persona.md` | ≤ 300 字 |
| `earlierToday`:`[{ at, decision, why }]` | plan-log(§3) | 最近 5 条 |

没看的回音不单独算:明信片本来就进 journal,`journal.unread` 已经含它们,不重复计数。

prompt 骨架(中文,严格 JSON 输出,照 atelier-planner 的口吻):

```
你是伙伴自己。下面是此刻的处境,请判断现在要不要出门做一件事。
可选的只有 candidates 里列出的动作;不想做就 "none"。理由一句话,写给自己看。
判断时想想:主人是不是正在跟你聊(几分钟内有入站就别打扰);今天已经做过什么;
包袱里是不是已经堆了主人没看的东西(堆着就别再往里塞);现在这个时间点合不合适;
earlierToday 里你之前怎么想的,别每拍都翻来覆去。
只输出 JSON:{"action":"hunt"|"visit"|"gap"|"none","why":"…","target":"可选,只能是 social.provenChannels 里某一项的 id"}
【当前】…【今天】…【候选】…【被拒的】…【包袱】…【社交】…【最近观察】…【我的表达倾向】…【今天之前的判断】…
```

`parsePlan(raw)`(纯,fail-closed):去掉 ```json 围栏后 `JSON.parse`;必须是对象、`action` 是四个字面量之一、`why` 是 ≤ 120 字的字符串、`target` 缺省或字符串;多余字段 → 失败。返回 `{ ok:true, plan } | { ok:false, reason }`。

## 3. 状态与节流

`<stateDir>/companion/plan-log.json`:`{ day: 'YYYY-MM-DD', entries: [{ at, chatId, candidates, decision, why, source: 'model'|'fallback'|'downgraded' }] }`。读到的 `day` 不是今天就整个丢掉(每天清零)。写用 `readJsonFile`(BOM 容忍)+ 同目录其它 JSON 同款写法。用途:喂回 prompt 的 `earlierToday`;实现退避。

- `PLAN_REASK_MS = 90 分钟`:同一 chat 上一条 `decision === 'none'` 且 `source === 'model'` 的 entry 距今不到 90 分钟 → 不问、不做。回退和降级不计入退避(它们没「想过」)。
- `PLAN_EVAL_TIMEOUT_MS = 20 秒`:超时视为 evaluator 失败 → 回退固定顺序。
- 每次真调用记 `PLAN ask chat=… candidates=[…]`,结果记 `PLAN → <action> (why)`,一行一拍,真机看日志就够。
- 理由**只进日志和 plan-log**:不进 journal,不改桌宠状态,不发给主人(红线:桌宠只报真实动作)。

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `src/core/companion-plan.ts`(新,纯) | `PlanAction`、`PlanContext`、`Candidate`、`computeCandidates(...)`(把三次 `shouldSpeak` 的调用集中到一处,输入是 chat 的 prefs / ledger / lastInbound / social 存在与否)、`buildPlanPrompt(ctx)`、`parsePlan(raw)`、`pickFallback(candidates)`(hunt → visit → gap)、`shouldReask(log, chatId, nowMs)`、常量 `PLAN_REASK_MS` / `PLAN_EVAL_TIMEOUT_MS` / 各字段上限 |
| `src/daemon/companion/plan-memory.ts`(新) | `readPlanLog(stateDir, today)` / `appendPlanLog(stateDir, entry)`(跨天自动清零) |
| `src/daemon/wiring/tick-bodies.ts` | hunt / visit / gap 三段收成 `runHunt` / `runVisit` / `runGap` 三个执行函数(逻辑逐字搬);中间插 §1 的判断;`TickDeps` 加 `planEval?: CheapEval`(测试注入,缺省取 registry) |
| `src/daemon/bootstrap/wire-visit.ts` + `types.ts` | `penpal.provenChannels(): Array<{ id: string; label: string }>`(复用 `startVisitInner` 里已有的 `proven` 计算,不复制);`startVisit(target)` 已接受 label / 信道 id,不改 |
| 测试 | `companion-plan.test.ts`(新)、`plan-memory.test.ts`(新)、`tick-bodies.test.ts`(追加)、`wire-visit.test.ts`(一条) |

不动:`calibration.ts`(三个冷却和所有 reason)、`care-ledger.ts`、agenda 段、`buildHuntText` / `buildGapCheckinText`、桌面、路由、command-router。

## 5. 测试

- `companion-plan.test.ts`:`computeCandidates` 对四种 prefs / ledger 组合给出正确候选与被拒理由(与直接调 `shouldSpeak` 的结果一致);`buildPlanPrompt` 含候选、被拒、`earlierToday`,并且 observations / persona / title 都被截到上限、不含任何原始 chat 字段;`parsePlan` 接受四个动作、剥围栏、拒多余字段 / 非法 action / 过长 why;`pickFallback` 顺序;`shouldReask` 90 分钟边界、`fallback` 不计入。
- `plan-memory.test.ts`:缺文件 / 坏 JSON / BOM / 跨天清零 / 追加。
- `tick-bodies.test.ts`(用现有 `buildTickBodies` 夹具 + 注入 `planEval`):
  - 候选 `[hunt, visit]`,模型回 `visit` → 只出门不打猎,`claimVisit` 被调、`claimHunt` 没被调;
  - 模型回 `none` → 什么都不发,plan-log 多一条,同一拍再跑一次(时间 +10 分钟)→ 不再调 `planEval`(退避);
  - 模型回 `gap` 但候选里没有 gap → 降级为 none,日志含 `downgraded`;
  - `planEval` 抛错 / 回非 JSON / 超时 → 执行 `pickFallback` 的第一个(和旧行为一致);
  - 没有 `planEval` 且 registry 没有 cheapEval → 旧行为;
  - agenda 到期 → 直接发 agenda,`planEval` 从未被调;
  - 候选为空(全在冷却)→ `planEval` 从未被调。
- `wire-visit.test.ts`:`provenChannels()` 只列收到过 visit 回信的 open 信道,返回 `{ id, label }`。

真机:看 `PLAN` 日志。一天里应能看到「ask … → none(主人正在聊)」「ask … → hunt(上午,包袱是空的)」这类行;打猎和串门仍然各不超过一天一次。

## 6. 明确不做 / 待办

- 不排整天计划;不让模型决定 agenda;不让模型突破任何冷却或 care 档;派心愿仍是主人的事。
- 桌面不加「伙伴今天在想什么」展示;理由只在日志。
- 选串门对象只在 `provenChannels` 里选;邻居(`neighbor`)的选择仍由代码按天轮换。
- 下一步候选:把「问候」的措辞也交给模型看 `earlierToday` 决定(现在仍是模板);把 `daemonOpsAvailable` 等兄弟标志按 provider 关掉(上一轮遗留)。
