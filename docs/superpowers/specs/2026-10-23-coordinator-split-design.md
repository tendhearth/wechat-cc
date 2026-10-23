# 对话协调器按域拆开(设计稿)

> 2026-10-23。架构复查之后最大的三个文件之一:`src/core/conversation-coordinator.ts` 1604 行,其中 `createConversationCoordinator`
> 一个闭包约 1200 行。照 2026-09 工作台 service 拆分的做法(`src/core/workbench/service/` + `ctx.ts`,1965 → 179 行,十个 PR,
> 每步行为不变)。排在核心链(#598–#601 + PR 6)之后动手,稿子先写。

## 为什么

不是因为它坏了 —— 它是对的,也有测试。是因为一个人(或 CC 自己,等「CC 自己跑开发」开工)要改「讨论模式的一拍」时,得先在
1200 行的闭包里找到 `runBeat`,再搞清它碰了哪些闭包变量。同一个闭包里四件事搅在一起:

| 域 | 今天在哪(行号会漂,以函数名为准) | 大约 |
|---|---|---|
| 模式怎么定 | `defaultMode` / `getMode` / `resolveParticipants` / `validateMode` / `admitProviders` / `resolveAndAdmit` / `admitOrNull` | 300 行 |
| 出错怎么说 | 顶层 `authFailNotice` / `providerFailureReason` / `spawnFailedNotice` / `turnErrorNotice`;闭包里 `handleAuthFailed` / `handleTurnTimeout` / `notice` | 130 行 |
| 三种派法 | `dispatchSolo`(solo 与 primary_tool 共用)/ `dispatchParallel` / `dispatchChatroom` + `runBeat` | 730 行 |
| 一轮的进出 | `dispatchInner` / `submitTurn` / `oneTurnPerSession` / `registerHandleCancel` / `preemptInFlightChatroom` / `dispatch` | 200 行 |

`/chat`、`/both` 微信入口已经去掉(收敛清单 ③),但桌面的对话模式照旧能选(`apps/desktop/src/modules/conversations.js`)、CLI `mode set both|chat`
也还在 —— 所以讨论 / 并行是**拆出去**,不是删。

## 怎么拆

```
src/core/conversation/
  ctx.ts          共用的那一份:deps、noteDelivery、deliveryModeFor / textStrategyFor、stopMark、一轮的锁(oneTurnPerSession)
  modes.ts        模式怎么定 + 准入(admit*)
  failures.ts     出错怎么说(顶层四个纯函数原样搬;handleAuthFailed / handleTurnTimeout)
  solo.ts         dispatchSolo
  parallel.ts     dispatchParallel
  chatroom.ts     dispatchChatroom + runBeat + preemptInFlightChatroom
  index.ts        createConversationCoordinator:只剩组装 + dispatchInner 的路由 + submitTurn / dispatch
src/core/conversation-coordinator.ts   只转出(外部 import 一个不改),跟工作台拆分时 service.ts 一样
```

**一张路由表代替 switch**(理念 1):`dispatchInner` 今天是 `if (parallel||chatroom) {…降级…}` 再 `switch (mode.kind)`。改成

```ts
const STRATEGIES: Record<Mode['kind'], Strategy> = { solo, primary_tool: solo, parallel, chatroom }
```

键是 `Mode['kind']` 的全集,漏一个 TS 就报错 —— 以后加一种模式,写一个文件、表里加一行。「参与者为空 / 只剩一家就退成 solo」那段
是**进路由之前**的一步,单独一个函数,不散在 case 里。

**环经 ctx.actions**(工作台拆分时的做法):chatroom 的 `runBeat` 要回头调「派一家」,solo 出错要调 failures —— 不互相 import,
都经 ctx 上登记好的动作,避免模块环;`depcheck` 守。

## 每一步行为不变,怎么证明

- 拆分期间**不改任何一行逻辑**,只搬家 + 改成读 ctx;每个 PR 的 diff 里「删掉的块」和「新文件的块」逐行能对上(跟工作台拆分时一样,
  9d 当时就是这么审的:非空行比对,对不上的只能是 ctx 接线)。
- 协调器现有测试一个不改(`conversation-coordinator*.test.ts` 一共十来份);e2e 路由快照、关机快照不变。
- 加一条守卫:`src/core/conversation/` 下每个文件 ≤ 400 行;`conversation-coordinator.ts` 只许转出(行数棘轮,只许少)。

## 切法(每步一个 PR,各自可回滚)

1. 建 `conversation/ctx.ts` + 把顶层四个纯函数挪进 `failures.ts`(最安全,纯函数)。
2. `modes.ts`。
3. `parallel.ts`(最少被碰的派法)。
4. `chatroom.ts`(+ runBeat、preempt)。
5. `solo.ts`(最常跑、最后动)。
6. `index.ts` + 路由表;`conversation-coordinator.ts` 只剩转出;守卫。

协调器是**每一条微信都走**的路,所以跟核心链一样:一次合一个,9d 合了部署、真机发一句收到回复,再下一个。
不碰主人看得见的任何行为,不需要主人拍板。

## 不做的

- 不顺手改讨论模式的行为(争点聚焦、互评名次这些)—— 拆完以后要改,也是另一件事。
- 不动 `TurnRecord` / 回复交付(`reply-delivery`)的形状。
- 不和核心链同时进行:核心链 PR 6 合完、部署核对完,才开第 1 步(两件都动开机后第一条消息的路径,叠在一起出问题分不清是谁)。
