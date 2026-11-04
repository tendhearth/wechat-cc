# M4:终端会话成为「一件事」(设计稿)

2026-11-04 · 承接 [一个伙伴一副骨架](2026-10-31-one-companion-one-skeleton-design.md) §4 M4,以及 U3 的终端那一半(App 的 `/terminal/[id]` 还是单独一整页)。

## 现在的样子(origin/dev 3d65a9fc)
- **存**:只有 `cli_sessions`(v76)一张表,一个原生会话一行:状态(running / waiting / idle / ended)、最近一句、等你的那一项(工具 + 概括)。
  - 和 matters 没有任何关联:`kind = 'terminal'` 只在枚举里,从没建过。
- **来**:`wechat-cc hook` 接四种钩子事件:`UserPromptSubmit`(发问)、`Stop`(答完,带最后一句)、`PermissionRequest`(要权限,同步等 150 秒)、`SessionEnd`。
  - 进 `makeCliEventHub`(`src/app/cli-events.ts`)记状态。
  - 权限的那把码(hash)只在内存里(`cli-permission-relay.ts`)。
- **重复解析**:「看着它跑」每次请求都把执行者的 transcript 尾巴整段重读重解析(`cli-activity.ts`),没有缓存。
  - App 详情每 4 秒拉一次 `/m/api/cli/activity`(256KB)。
  - 列表每 15 秒拉一次,每个在跑的会话再解析一遍 64KB。
  - 微信「看 码」、`terminal_say`、Cursor 的 Stop 各有一份自己的尾巴解析。
- **出口**:`/v1/cli/sessions`、`/m/api/cli/*`、App 的终端详情页与主页行、桌面的等你行、微信推送与「y/n 码」、日报、活动流。
  - M0 金样只钉了 `cli.m-api-cli-activity`。

## 定案
**每个终端会话第一次被看到时建一件 `kind = 'terminal'` 的事**,用 `matter_bindings(surface = 'cli', surface_key = session_id)` 连起来。
- 钩子事件和 transcript 里的步都经 MatterLog 写成这件事的轮和步。
- 「看着它跑」改读步,不再每次重解析。
- `cli_sessions` 退成原生会话指针:transcript 路径、读到哪了、在哪台机器。
- App 的终端详情并进 `/matter/<id>`。

### M4a 钩子事件 → 轮与步(和 cli_sessions 并行写)
- 第一次看到一个 session_id ⇒ 建这件事:标题 = 项目名,initiator = owner,出生地 = `cli`;再绑上 `cli` 那一条。A2A 远端来的也一样,带上 `origin_agent`。
- `prompt` ⇒ 开一轮(executor = source),写一步 `user_message`。钩子带的发问原文目前没存,M4a 只记「主人发了一句」,原文 M4b 从 transcript 补。
  - harness 自己注入的(`automated`)不开轮。
- `stop` ⇒ 写一步 `agent_message`(最后一句,截 2000 字)并收这一轮(completed)。这件事回到 open。
- `permission` ⇒ 写一步 `permission`(started,payload = 工具 + 概括)⇒ 这件事进「等你」。
  - 落定(放行 / 拒绝 / 超时)⇒ 这一步 completed / failed。
- `session_end` ⇒ 收还开着的轮(interrupted),这件事 done。
- 开机:没收的终端轮记中断,同对话。
- 写不上不挡钩子(钩子的回包有时限):一律 try,只少一步。
- 做完怎么算:
  - 真机副本上,一天里 `cli_sessions` 的状态变化和这件事的轮 / 步对得上。
  - M0 金样不变。

### M4b transcript 增量读进步,「看着它跑」改读步
- 每个会话记 transcript 读到的字节位置(读到哪了)。
  - 收到钩子事件 / 有人来看的时候,只读新增的那一段,解析成步:工具调用一步(started → completed 合成一行)、说的话、发问原文。
  - 第一次看到时把已有的整份导入一次。
- `/m/api/cli/activity`、列表的「此刻那一步」、微信「看 码」、`terminal_say` 的上一句,都从步读。
  - `cli-activity.ts` 的逐次重解析删掉,解析器只在增量读那一处用。
- 做完怎么算:`cli.m-api-cli-activity` 金样逐字节不变;`cli-activity.ts` 不再被出口直接调用。
- 落地(11-04):
  - 第一步 #796:解析结果按文件状态缓存。
  - 第二步:`feedActivity` 一套解析口径,内存(parseActivity)和库(features/terminal/terminal-steps.ts)两种放法。
    - 读到哪了存 `terminal_reads`(v98),带 gen:截短 / 换文件 / 一下子多出 4MB ⇒ 从头读、gen 加一,步的 key 撞不上旧的。
    - 钩子 stop / session_end 先读再收轮;prompt 先开轮再读。读进步的会话,钩子不再写空的 user_message 和最后一句(免得两份)。
    - 手机「看着它跑」、列表那一步、CC 的 terminal_sessions 从步读;还没有那件事的老会话退回直接解析。
  - 和上面的出入:第一次见不整份导入,只从尾巴 256KB 起(同以前读的那一截)—— 几十 MB 的记录整份导进来会卡住钩子。
  - 不切的(11-04 定):微信「看 码」和 terminal_say 的核对仍直接读记录。
    - 「看 码」要整段对话原文,步里每句截在 600 字,切过去页面会变短(看得见的变化)。
    - terminal_say 要拿回话和记录原文逐字比对,截过的步比不上。

### M4c App 一个详情页(U3 的终端一半)
- 主页的终端行、推送深链、活动流都指向 `/matter/<id>`。`/terminal/[id]` 只剩重定向:按 session_id 找到这件事。
- 详情页按 `kind = 'terminal'` 画:顶部是等你的那一项(同批准那一块),下面是步。「说一句」(`/m/api/cli/say`)照旧。
- 做完怎么算:`/terminal/[id].tsx` 只剩重定向;本机模拟器 Maestro 绿(在 mini 上跑)。

### M4d cli_sessions 收成指针(soak 之后)
- 状态、最近一句、等你那一项都从这件事推,列都删掉,只留 session_id → matter、transcript_path、机器、读到哪了。
- 分两步:**第 1 步**读改从这件事推(没有这件事的老会话照旧读列),列照旧写;**第 2 步**(soak 之后)停写、删列。
- 第 1 步拿真库副本对过(11-04,119 行):113 行一样;不一样的 6 行是两处 M4a / M4b 的缺口,第 1 步一起补了:
  - harness 自己塞的 prompt(后台任务回报)以前不开轮 ⇒ 它干活时这件事显示没在做。改成也开一轮(`policy.automated`,不写「主人说了一句」、不算最近一次发问)。
  - 答完那一刻最后一句和钩子同一秒才写进记录,那一次读不到 ⇒ 过 3 秒补读一次。
  - 另:开机不再收还有动静的终端轮(终端在 daemon 外面跑,重启它照样在做),只收 30 分钟没动静的;开着的卡照样收(码只在内存里)。

## 不做 / 推后
- **权限码(hash)落库**:不做。它本来就只在 150 秒的等待里有效,重启后作废;M4a 的 permission 步只记事实,不记码。
- **终端里的「改动 / 回退」**:不做。那是一起做的深度区,终端会话不归 CC 管。
- **桌面的终端行并进主页列表**:跟桌面下一版一起做,不在 M4。

## 风险
- **钩子的时限**:`PermissionRequest` 是同步钩子,写库要快。和今天 `cli_sessions` 的那一次写放在同一个事务里,多两行。
- **transcript 读到一半的那一行**:增量读只消费到最后一个换行,不完整的行留到下一次。
- **会话很多**:`cli_sessions` 今天会按时间修剪;这件事不删,超过 30 天没动静的归档。

## 进度
- M4a(11-04):`src/ports/terminal-turns.ts` + `src/adapters/store/terminal-turns.ts`,登记处(`makeCliEventHub` 的 record / permissionAsked / permissionSettled)同时写。和设计的一处差别:「这一轮」在跑时再发问,记进同一轮,不另开(Claude Code 会把排队的话并进当前这一轮)。

## 顺序
M4a → M4b → M4c → soak → M4d。M4a / M4b 只动 daemon(`self deploy` 生效);M4c 动 App(随下一个 build)。
