# 3b 核心链进模块容器(设计稿)

> 2026-10-23。第三批 3b 的最后一块:会话、ilink、拉消息、工作台、internal API 这五样,从 `main.ts` 手排的 `lc.register` 搬进 `DaemonModule` 容器。前情:[DaemonModule 设计](2026-10-22-daemon-module-design.md);那一批有意把核心链留到「跑一阵再说」。现状勘察以 `origin/dev` b94e286b 为准,行号会漂,以函数名为准。

## 为什么要做,做完是什么样

今天开机顺序和关机顺序写在两个地方:开机是 `main.ts` 里的先后,关机是 `lc.register` 的**登记先后倒过来**,再加上 `bootstrap` 的 teardown 列表,最后是 db 和锁。核心五样的关机次序是被可选模块的登记位置夹出来的(比如 ilink 的 flush 必须在 polling 停了之后,靠的是 837 行写在 844 行前面)。还有五处「晚一点再接上」的写法守卫看不见(`workbenchRef`、`wiredRef` 是裸对象,`bootRef`、`pollingLcRef`、`ticksRef` 是 `let`)。

做完以后:每一样声明自己 `needs` 谁、哪条边是 `lazy`(环)、自己是不是 `optional`;开机顺序和关机顺序都**从声明推出来**(理念 1)。`main.ts` 只剩「地基」和一次 `startModules`。

同类做法:systemd 的 unit(`Requires` / `Wants` / `After` 声明依赖,顺序由它排;`Requires` 的那个起不来,依赖它的也不起)和 socket activation(**先占住端口、服务就绪了再接活**);Kubernetes 把「活着」和「能接活」分成两个探针。下面 internal API 的做法就是后两者。

## 什么不进容器:地基

锁、心跳、db、`conversationStore`、`turnRecordStore`、`guardRt` 在任何模块之前存在、在所有模块停了之后才关。它们不是子系统,是容器跑起来的前提 —— 跟 systemd 的早期启动一样,不当 unit 管。`main.ts` 里它们照旧手写,但**收拢到一个 `foundation()` 里**,出错时的清理清单(今天的 `undo`,只管锁、心跳、db)和它在同一处,关机时容器停完再按相反顺序关。

## 五样各自怎么声明

| 模块 | needs | lazy(环的那条边) | optional | 副作用挪到哪 |
|---|---|---|---|---|
| `internal-api` | (地基) | `sessions`、`workbench` 等 —— 今天的 `bootRef?.` 闭包和 `provide(...)` 注入都换成 lazy | **是**(见下面「起不来怎么办」) | init 里**占端口**(拿到 `baseUrl` 给会话拼 MCP 配置);start 阶段才**写 `internal-api-info.json` 并开门** |
| `sessions` | `internal-api`(要 mint / invalidate、`baseUrl`)、执行者登记 | `workbench`(`setExecutionGuard`,轮到执行时才问) | 否 | 闲置清扫改 `ctx.interval` |
| `workbench` | `sessions`、`internal-api`、`cli-sessions`、权限闸 | — | **是** | 构造里的 `store.recover()` / 各 domain `recover()` 挪进 `onStart` |
| `ilink` | (地基) | `speech` | 否 | 30 秒清扫计时器改 `ctx.interval`;`flush` 用 `ctx.own` |
| `polling` | `ilink`、`pipeline` | — | 否 | `startLongPollLoops` 挪进 `onStart`(今天构造即开跑) |

`pipeline`(入站流水线)随 polling 一起进,`lazy: ['polling']` 换掉 `refs.polling` 那个 Ref。工作台通知 / 产物(`wb-notifications`、`wb-artifacts`)今天是最后构造、却提前登记停止的,随 workbench 进,`needs: ['workbench', 'ilink']`。

### internal API:先占端口,就绪再接活

勘察里最不合容器形状的一处:会话在**构造时**就要 `baseUrl`,所以 internal API 必须在 init 里 listen,而 listen 之后到开机完成之间,请求可能已经进来,这时 `ctx.lazy` 会抛。

做法:
1. init 里 `listen`,但门是关的:任何请求回 503 `daemon_starting`,`/v1/health` 也一样。进 `workbench-errors.ts` 那张表,写成 `{ desktop: 503, phone: [503, 'unavailable'] }`;桌面把它当「正在启动」、退避着等,不弹错(9d 接)。
2. 门在 internal-api **自己的 `onStart`** 里开,同时写 `internal-api-info.json`。容器的 start 阶段按依赖顺序跑:到这一步时所有模块的 init 都已经做完(lazy 可以调了);internal-api 不依赖 polling,所以它的 `onStart` 排在 polling 开始拉消息**之前** —— 第一条微信那一轮的 MCP 工具不会碰到 503(9d 审稿)。这个先后由 PR 6 一起加的开机顺序快照钉住。桌面 / 手机 / MCP 是读这个文件找端口的,文件没写之前它们根本找不到新端口;门只是兜底(老 info 文件指着上一个进程的端口,连不上)。
3. 这样 lazy 在门开之前不会被调到,`bootRef?.` 那一批「还没好就返回 null」的分支全删 —— 它们今天返回的空结果,对调用方来说跟「真的没有」分不出来,这是在说假话。

### 关机顺序

容器按依赖的反序停:polling → pipeline → wb-* → workbench → sessions → ilink → internal-api,最后地基。和今天比有两处要逐条核:

- **ilink 在 sessions 之后停**:今天是 ilink(837)比 sessions(836)先停。反过来以后,sessions 关会话时如果还要发一句收尾(比如「重启中」的通知),ilink 还在,是好事;要核的是 sessions 的 `shutdown` 里有没有等 ilink 的东西。
- **非依赖的先后**(勘察里的「phone 要在 polling 之后停」):不为它造一条假的 `needs`。先用快照看清楚它到底是不是真约束;是,就说明有一条依赖没写出来,写出来;不是,就让它按依赖走。

## 步骤:先拍快照,再一样一样搬

| PR | 内容 | 什么时候能合 |
|---|---|---|
| 0 | **只加测试**:关机顺序快照(起真 daemon、正常关掉,从日志读出先后;#595)。开机顺序快照挪到 PR 6:今天五样开机没有统一的日志行,硬加就改了行为;进了容器以后容器本来就按模块记 | 随时(不改行为) |
| 0b | **健康门补两条**(`self deploy`):今天只认 `/v1/health` 200、版本 / head 对得上、插件报了上来,**不看拉消息**。补:每个账号的拉消息循环在跑;`daemon_starting` 的 503 当「接着等」(在原有超时内),不当失败回滚 | 随时;PR 2 之前必须在 |
| 1 | `workbench`(+ wb-*):离微信最远,optional | 0d075422 跑满一整天、日志里没有 MODULES / 关机异常(9d 定) |
| 2 | `internal-api`:只搬家(#599)。门 + info 文件挪到 onStart + 开机顺序快照挪到 PR 6(那时 `bootRef?.` 才换成 lazy) | 上一步部署、真机核对过 |
| 3 | `sessions`(+ 闲置清扫) | 同上 |
| 4 | `ilink`(lazy speech;`speechRef` 删掉) | 同上 |
| 5 | `polling` + `pipeline`(lazy polling;`refs.polling` / `refs.pipeline` 删掉) | 同上;离主人最近,最后做 |

**两段走(2026-10-23 补,写 PR 1 时定)**:PR 1–5 每一样先**就地**搬(`startLifecycleModule(…, { required: true })`,停法登记在它原来 `lc.register` 那一行的位置)—— 关机先后一位不动,快照只多一行该模块自己的 `module <名>/stop`;起不来照旧整个开机失败。等五样都进了容器,**PR 6** 再把它们收进一个容器、换成声明 `needs` / `lazy`,关机顺序从声明推出来 —— 顺序真正变的只有这一步,一次看清。降级(上面「起不来怎么办」那两行)也放在 PR 6 或其后,按主人的回答来。这样前五步每步风险只在「搬」,不在「顺序」。

每个 PR:快照的 diff 逐行讲得出为什么;守卫 `daemon-module` 的基线照着减(`main.ts` 的 `lc.register` 14 → 最后只剩桥接那一条;那五个守卫看不见的晚绑定顺手删掉,删不掉的加进守卫的识别范围);**不带迁移、不改存储格式**,所以回滚只是换回上一个 sidecar。部署由 9d 挑主人不在微信上聊的时候。

## 起不来怎么办、中途失败怎么回滚(9d 要求的一节)

**今天**:五样都不经 `SubsystemSupervisor`,任何一样在开机时抛错 ⇒ `startup failed mid-init` ⇒ 整个 daemon 退出,按连续失败次数等 10s、20s … 封顶 30 分钟再退,launchd 再拉。这期间**微信一句也收不到**;消息留在 ilink 服务端,恢复后按 `get_updates` 的游标补拉(服务端留多久没核实过,不能保证一定补得回来)。

**做完以后**,按「这一样不在,还能不能如实地接住微信」分两类:

| 模块起不来 | 处理 | 微信还收得到吗 | 主人看到什么 |
|---|---|---|---|
| `ilink` / `polling` / `pipeline` / `sessions` | **必需**:跟今天一样整个起不来、指数退避 | 收不到。宁可不在,也不假装在线 —— 一个收消息但回不了、或者回得了但收不到的 CC,在说假话 | 桌面 / 手机连不上 daemon(今天就是这样);日志 `startup failed` |
| `internal-api` | **降级**:会话照起,只是不给执行者配 wechat MCP 工具 | **收得到、回得了**(回复已经是「最终文字即回复、daemon 统一交付」,不靠 MCP) | 开机通知照实说:「桌面、手机和 CC 的工具暂时用不了」;`/v1/health` 本身也在 internal API 上,所以这一条只能走微信说 |
| `workbench` | **降级**:「一起做」整块不可用 | 收得到、回得了;微信里的「任务 …」回「一起做现在起不来」 | 开机通知;`/v1/health.subsystems.workbench` 标降级 |

后两行是**只在出错时才看得到**的行为变化(今天这两种情况是整个 daemon 起不来)。它让主人在工作台坏掉的时候还能在微信上跟 CC 说话,我认为是该做的,但它改的是主人会碰到的东西,合之前请 9d 转给主人一句话确认(规矩:主人看得见的行为变化要主人点头)。主人不同意,这两样就也标必需,其余设计不变。

**部署中途失败**:每一步都是 `self deploy`(换 inode、健康门、失败自动回滚到上一个 sidecar)。健康门今天不看拉消息(9d 查过),由 PR 0b 补上,并把 `daemon_starting` 当成「接着等」。因为这几步都不带迁移,回滚后的旧 sidecar 读得懂新 sidecar 留下的一切。

**部署成功但真机上不对**:核对清单(9d 每步跑)—— 主人微信发一句、收到回复;桌面打开、手机打开;`wechat-cc selftest chat` / `selftest workbench`;再触发一次重启(`self deploy` 自己就会),看关机日志里五样的先后和快照一致、没有 5 秒超时的 `stop timed out`。有一项不对就 `self deploy` 回上一版,下一步不开。

## 不做的

- 不把地基做成模块(见上)。
- 不改 `SubsystemSupervisor` 的语义,只是让核心五样也经它登记状态。
- 不在这一轮动 guard / companion / phone 这些已经进容器或另有安排的模块。
- 不改任何对外协议,除了新加一个错误码 `daemon_starting`。
