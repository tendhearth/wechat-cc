# P1:一件事的变化只有一个信号源(设计稿)

2026-11-02 · 承接 [一个伙伴一副骨架](2026-10-31-one-companion-one-skeleton-design.md) §4 P 线。M2 已全部上真机(v95)。

## 现在的样子

- **信号**:一起做每次写库都 `store.bump` 一次 `workbench_tasks.seq`,服务再把这个数 `publish` 进内存里的 `TaskChangeHub`(`src/features/workbench/task-changes.ts`)。约 85 处在发。
- **一半多不是步**:状态 / 错误、原生会话、交接、成果(加 / 批准)、评审标记 / 评论 / 块、回退、做到条件成立、工作区标记、补充输入回执、权限卡 / 提问的开与落、网络冻结、脚本运行态、执行者自报模型。只有时间线那一半写了 `matter_items`。
- **等的人**:
  - 桌面详情的长轮询 `GET /v1/workbench/task?since=<version>&wait_ms=`(`routes.ts:213`):`since` 只拿来筛事件(`payload.v > since`),其余内容每次整份返回。
  - `matter-activity`:节流刷新 `matters.updated_at`。
  - 手机的 `phone-events`:被戳一下就重算一遍。
- **手机 / App / 网页**:`phone-events` 每 2 秒把每个订阅的 topic 整份快照算一遍、排序后比对,不一样就整份推出去(P2 要换掉的就是这个)。
- **桌面合并**:事件按 id 合并,不用 `v`;其余整份替换。

## 问题

1. 两套「变了」:`workbench_tasks.seq`(只有一起做有)和 MatterLog 的全库 `cursor`(轮与步有)。对话、终端、CC 自己做的事(M3–M5)搬进来以后,只有 cursor 一套对得上。
2. 非步的变化不进 cursor:光看 cursor 订阅,会漏掉状态变化、权限卡、成果批准。
3. Hub 在内存里、按任务分:别的种类的事接不进来,重启也不留痕(这一条无所谓,读的人会重读)。

## 定案

**一件事的任何变化都推进全库 cursor,只经 MatterLog;变化通知从 MatterLog 发出,TaskChangeHub 删掉。**

### P1a 信号源换成 MatterLog(不改任何出口)
- `matters` 加一列 `cursor`(v96):这件事最后一次有动静时的全库游标。MatterLog 每写一轮 / 一步都顺手更新它。
- MatterLog 加 `touch(matterId)`:非步的变化(上面那一串)用它推进 cursor。这件事的 cursor 也跟着改,不写行。
  - 一起做里 `store.bump` 的每一处同一事务里 `touch` 一次,做法是把 `bump` 收进同一个函数,不用 85 处挨个改。
  - `workbench_tasks.seq` 留着照算:`version` 和事件的 `v` 是今天的出口,M0 金样钉着。
- MatterLog 加 `onChange((matterId, cursor) => …)`:写口提交以后通知。
  - 嵌在别的事务里时,等最外层提交以后才发。做法:写口记下待发的那几件,外层 `atomic` 提交后统一发,回滚就丢。今天的 hub 有「幻影 seq 回落」那段补丁,就是因为没做这一步。
- 新的 `MatterChangeFeed`(`src/adapters/store/matter-feed.ts`):`wait(matterId, sinceCursor, maxMs)` 加 `onChange`。它就是今天 hub 的那几行 waiters,只是数换成 cursor、来源换成 MatterLog。
- 换接线:长轮询路由、`matter-activity`、`phone-events` 的戳改订这个 feed。
  - 长轮询仍按 `since=<version>` 答,出口一字不变;它只是改成等 feed。
  - 服务里的 `touched / bumped` 只剩「落库」那一半,通知交给 MatterLog。
- **删 `TaskChangeHub`**,外加 `ctx.hub.touched` 的 55 处调用和「读详情时重发一次 seq」那行(`view.ts:214`,纠偏用的,没有幻影就不用纠)。`ctx.hub` 只剩 `bumped`(它本身是一次落库)和关机时的 `dispose`。
- **进度(11-02)**:P1a #786 已合 dev;P1b 已做(桌面随下一版桌面发版生效,daemon 侧 `self deploy` 就有)。
- 做完怎么算:`task-changes.ts` 不在 src;M0 金样不变;守卫「`matters.cursor` 只有 matter-log.ts 写」。

### P1b 出口带上 cursor(只加字段)
- 一起做详情多一个 `cursor` 字段;长轮询多认 `since_cursor=`:按步的 `cursor > since_cursor` 筛事件(改过的步也会再来一次;桌面本来就按 id 合并,不会重复)。`since=` 照旧能用。
- 桌面 `workbench-live.js` 改用 `since_cursor`。
  - 界面上看不出区别。
  - 有一种情况会变:一条工具调用从「在跑」变成「做完」时,桌面以前要等下一次整份刷新才看得到,现在增量里就带回来。
- 做完怎么算:桌面不再送 `since=`;`since=` 进别名表,等 P3 收。

### P2(下一步,不在本稿)
- `matter/<id>` 等 topic 改成订 feed:有变化才算、才推,不再 2 秒轮询比快照。
- 推的仍是今天那份小快照(`{found, kind, version, phase}`)加上 cursor。
- 增量推步留到 M3 之后,对话也有步了再说。
- 落地(11-04,第一步):
  - 任务、终端会话的 `matter/<id>` 主题不再每 2 秒算一次快照,改成等变化信号;另外每 30 秒兜一次底,漏一次信号也不会一直不对。
  - 一件事变了,只重算那件事的主题和不分事的主题(home / approvals / agents),不再把每个订着的 `matter/<id>` 都算一遍。
  - 聊天照旧轮询:消息不进变化信号。home / approvals / agents 照旧每 2 秒(在场、未读也不进变化信号)。
  - 推的内容、形状都不变。

## 不做 / 被否决
- **「非步的变化也写成一步(kind=system)」**:否决。评审标记、补充输入回执、权限卡的落定一天几百次,写成步会把时间线淹掉;步是给人看的,cursor 才是给机器看的。
- **「直接删 `workbench_tasks.seq`」**:否决,M6 再删。今天桌面、手机、金样都读 `version` / `v`,换出口和换信号源分开做。
- **「feed 落库(变化表)给断线重连补发」**:不做。读的人重连以后整份重读一次就对了,和今天一样。

## 风险
- **提交后才通知**:漏掉一处 `atomic` 包装,那次变化就晚到(等下一次变化或 20 秒超时),不会错。用测试钉:事务里写、回滚 ⇒ 不通知;提交 ⇒ 正好一次。
- **cursor 写放大**:每个 `touch` 是一次 `UPDATE matter_log_cursor` 加一次 `UPDATE matters`,同一事务里 `bump` 本来就在写,多两行而已。

## 顺序
P1a → P1b → (M3 对话进 MatterLog) → P2。P1a 只动 daemon,`self deploy` 就生效;P1b 动桌面,随下一版桌面发版生效,界面验收在 mini 上跑。
