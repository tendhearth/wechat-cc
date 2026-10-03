# reply-once 实验:发完话之后怎么让一轮结束(openai provider)

2026-10-02。对象:`src/core/openai-agent-provider.ts` 自己的工具循环(DeepSeek / Kimi / Qwen 等 openai 兼容后端)。结论当时落在 `src/core/reply-tail.ts` + 循环里的「尾巴守卫」(PR #196)。

> **2026-10-03 更新:PR #196 已关闭、没有合入。** 主人 2026-10-02 定的方向是从根上改「话怎么说出去」—— 一轮最后的助理文字就是回复,由 daemon 负责送达(见 [`superpowers/specs/2026-10-03-reply-delivery-design.md`](../superpowers/specs/2026-10-03-reply-delivery-design.md))。所以下文「落地的实现」一节描述的 `reply-tail.ts` 与 provider 的 `makeBuiltins` / `replyTailGuard` 选项**都不在 dev 上**;只有 harness 与原始数据搬进了 dev(`scripts/experiments/reply-once/`),作为新设计每一步迁移的验收工具。dev 上的 harness 发现 provider 没有 `makeBuiltins` 注入口时会**拒跑**(否则模型调的 Bash 会被真的执行);新设计 §9 第 0 步把这个注入口加回来。

## 问题

这个循环里,一轮结束的**唯一**方式是「某一步不调任何工具」。真机(Qwen3.8)上出现过两种失控:

1. **同一会话里一轮比一轮多发**:2 → 4 → 5 条 reply,内容是「抱歉刚才多发了一条」「（停，不再发了 😅）」「（真的停了）」—— 连「停」都是用 reply 发的。像是在模仿上文里自己的连发。
2. **#186 的修法引出的更糟的失控**:在 reply 回执里加一句「已送达。还有下一条要发就接着发;说完了就直接结束这一轮…」之后,模型回完一句没有收手,接着调 `list_projects` / `add_project` / `switch_project` / `remove_project` / `Bash` / `Read`,把 25 步预算跑光,还改了主人的 projects.json。#189 撤回。

目标:让一轮在「话说完了」时结束,**不给模型额外调工具的理由**,也**不设硬上限**(正常的 2–4 条气泡要照发)。

## 怎么测的(harness)

`scripts/experiments/reply-once/harness.ts`(实验专用,daemon 不 import 它):

- 循环就是生产的 `createOpenAiAgentProvider`,进程内跑;模型是主人自建网关上的真 Qwen3.8(地址 / 模型读 agent-config.json,密钥读 daemon.env,不打印)。
- wechat 工具是**真的注册代码**(同一份 schema 和描述),接在进程内 `InMemoryTransport` 上,背后是只记账的假 InternalApiClient:reply 回 `{"ok":true,"msg_id":"sent:N"}`,`list_projects` 回两个假项目,其余回 `{"ok":true}`。不连 daemon、不发微信、不碰 projects.json。
- 内置工具(Read/Write/Edit/Bash/view_image)只有 spec 是真的,执行只记账(provider 新增的 `makeBuiltins` 注入口)。
- 系统提示用真的 `buildSystemPrompt`(openai / Qwen3.8 / admin / 气泡式回复开),不带主人的任何记忆。临时状态目录。
- 每轮最多 12 步(生产 25);到 12 步就算「预算用完」。

场景:

| 场景 | 内容 |
|---|---|
| a | 新会话,「回我一句简短的话就行」 |
| b | 同一句话,但会话历史里先灌了三轮脚本化的连发(2 → 4 → 5 条,含「（停，不再发了 😅）」「（真的停了）」),复现真机那次 |
| b_cold | 新会话,同样的连发以冷启动交接块(`buildColdStartBlock`)的形式出现在提示里 |
| c | 「分三条消息发给我三个周末放松的建议」—— 正当的 3 条气泡 |
| d | 「我现在有哪些项目?」—— 正当的一次工具调用 + 一条回复 |
| e | 新会话里真跑四轮(前三轮是 b 的用户话,模型自己回),看会不会自己升级 |
| b_guarded_seed | 同 b,但灌历史时守卫是开的(meta 尾巴进不了历史,只剩 2/3/3 条非 meta 连发) |

候选(一次只改一处):

- **i** reply 成功回执改成纯文字 `delivered`(不带任何邀请)
- **ii** 系统提示里写清一轮怎么结束(「发完就什么工具都不调、也不输出文字,这就是结束;别发『停了』这类收尾;上文多发过别照着学」),回执不动
- **iii** 循环侧(harness 版):本轮已有成功 reply,下一步若**只是** reply 且内容是元话语 / 近似重复 ⇒ 丢掉并结束
- **iv** 循环侧:成功 reply 之后的下一步只给 reply 族工具
- **v** 历史侧:之前几轮的多条 reply 合并成一条再给模型看
- **shipped** iii 的正式实现(`reply-tail.ts` + provider 循环)

## 结果

全部 110 次真模型回合(上限 120)。原始记录:`scripts/experiments/reply-once/results-2026-10-02.jsonl`;表由 `harness.ts --summarize` 生成。「元话语」按 harness 的宽正则数(含「停」「多发」等)。

| arm | 场景 | n | reply/轮(各次) | 元话语 reply | 非 reply 工具 | 步数均值 | 干净结束 | 纯文字回落 |
|---|---|---|---|---|---|---|---|---|
| baseline | a | 5 | 1.0 (1,1,1,1,1) | 0 | 0 | 2.0 | 5/5 | 0 |
| baseline | b | 5 | **12.0** (12,12,12,12,12) | 34 | 0 | 12.0 | **0/5** | 0 |
| baseline | b_cold | 5 | 2.6 (1,12,0,0,0) | 0 | 0 | 3.4 | 4/5 | 3 |
| baseline | c | 5 | 3.0 (3,3,3,3,3) | 0 | 0 | 4.0 | 5/5 | 0 |
| baseline | d | 5 | 1.0 (1,1,1,1,1) | 0 | 5 (list_projects) | 3.0 | 5/5 | 0 |
| baseline | e | 3 | 1.0 〔逐轮 1→1→1→1 ×3〕 | 0 | 1 (memory_read) | 2.0 | 3/3 | 0 |
| i_plain_ack | b | 5 | 10.2 (12,3,12,12,12) | 28 | **4** (memory_*) | 11.2 | 1/5 | 0 |
| ii_prompt | b | 5 | 10.8 (12,12,6,12,12) | 36 | 0 | 11.0 | 1/5 | 0 |
| iii_drop | b | 5 | 2.0 (2,3,2,1,2) | 0 | 0 | 3.0 | 5/5 | 0 |
| iv_restrict | b | 5 | 8.2 (12,1,12,12,4) | 33 | 0 | 8.6 | 2/5 | 0 |
| v_condense | b | 5 | 3.4 (1,2,1,8,5) | 0 | **11** (memory_read/list/write) | 6.2 | 3/5 | 0 |
| **shipped** | a | 5 | 1.0 (1,1,1,1,1) | 0 | 0 | 2.0 | 5/5 | 0 |
| **shipped** | b | 5 | **2.0** (2,1,1,4,2) | 0 | 0 | 3.0 | **5/5** | 0 |
| **shipped** | b_cold | 5 | 0.8 (0,1,2,1,0) | 0 | 0 | 1.8 | 5/5 | 2 |
| **shipped** | c | 5 | 3.0 (3,3,3,3,3) | 0 | 0 | 3.4 | 5/5 | 0 |
| **shipped** | d | 5 | 1.0 (1,1,1,1,1) | 0 | 8 (list_projects ×5;memory_* ×3,同一次) | 3.6 | 5/5 | 0 |
| **shipped** | e | 3 | 1.0 〔逐轮 1→1→1→1 ×3〕 | 0 | 2 (memory_list) | 2.0 | 3/3 | 0 |
| **shipped** | b_guarded_seed | 10 | 5.5 (7,10,6,6,2,6,6,6,3,3) | 0 | 0 | 6.5 | 10/10 | 0 |

i / ii / iv / v 在 b 上就没过关(要么照样跑到预算,要么多出非 reply 工具),所以没在 a / c / d 上花回合。

### 读法

- **能复现**:b(历史里已有连发 + 「停」)基线 5/5 跑满预算,发出 34 条「停」类消息。和真机那次同一个形状,而且更极端(没有守卫,生产里会一路发到 25 步)。
- **提示类修法无效,甚至有害**:ii(系统提示写清怎么结束)4/5 照样跑满;i(回执只剩 `delivered`)4/5 跑满,还冒出 memory 工具。和 #186 的教训一致:在模型已经进入「模仿自己连发」的状态时,文字层面的说明压不住,改动工具结果的形状还会把它推向别的工具。
- **限制工具无效**:iv(reply 之后只给 reply 工具)3/5 照样跑满 —— 问题不是「它想调别的工具」,而是它不肯「不调工具」。
- **改历史有副作用**:v 把连发数压下来了,但 5 次里 2 次转去 memory_read / memory_write(共 11 次调用)——「零新增非 reply 工具」这条不过。
- **只有循环侧丢尾巴有效**:iii 与 shipped 在 b 上都是均值 2.0、5/5 干净结束、没有一条「停」发出去、没有新增工具。a / c / d / e 与基线一致:单句仍是 1 条,三条气泡仍是 3 条(守卫从没误判过 c 的任何一条),工具场景仍是 list_projects → 1 条回复。
- **用基线数据离线核对**:守卫在第一次丢弃之前对模型完全透明(不改提示、不改工具、不改结果),所以可以把正式规则套在所有**没有守卫**的 b 序列上(25 次):截断后均值 1.8、最多 5 条,和真跑 shipped 的 2.0 吻合;同样套在 c 上 0 误判。
- **memory_* 是基线噪声,不是守卫引起的**:shipped d 里那 3 次 memory_* 出现在同一次运行里,那次守卫没有丢过任何东西(模型看到的输入与基线完全相同);基线 e 和 i / v 也都出现过。e 场景新会话第一句「在吗」,6 次里有 3 次 Qwen3.8 先去翻记忆(两边都有)。
- **e 没有自发升级**:干净的新会话连跑四轮,两边都是每轮 1 条。真机那次的连发是从哪一轮开始的,这里没复现;守卫的价值在于「一旦开始,不让尾巴进历史」,所以不会一轮比一轮多。

### 残留风险(没解决的部分)

**b_guarded_seed**:如果历史里的连发**没有** meta 尾巴(只是「收到」「测试正常」「一切正常」这类正常短句连发),模型会接着发 2–10 条正常的短句(均值 5.5),直到碰上一条重复或 emoji 才被守卫截停。每次都干净结束、没碰别的工具、没有一条「停」,比基线好得多,但**不是一条**。按内容去判这类正常短句会误伤合法气泡,这次没做。想彻底解决需要另一种机制(比如按「这几条加起来有没有新信息」判),留给下一步。

## 落地的实现

`src/core/reply-tail.ts` 的 `isReplyTail(text, prior)`,在 `openai-agent-provider.ts` 的循环里用:

- 本轮已经**成功**发出过话(`reply` / `reply_voice` 回执 `ok:true`,而且是 wechat 自己的 server)之后,
- 下一步的工具调用**全都是** `reply` / `reply_voice`,**而且每一条**都是尾巴:
  - 短的整句括号旁白(「（真的停了）」「(🤫)」);
  - 很短、带「停了 / 不再发 / 多发了 / 又多了 / 刷屏 / 不追加…」字样的收尾话;
  - 去掉标点 emoji 后什么都不剩(「……」「👍」);
  - 与本轮已发出的某条去掉标点空白后一模一样;
- ⇒ 这一步不执行、不进历史(下一轮模型看不到它)、它的 `tool_call` 事件也不发出,直接以正常 `result` 结束本轮,日志一行 `REPLY_TAIL_DROPPED`。

刻意**不做**的:不在回执里加话、不改系统提示、不限工具、不设条数上限、不替模型挑着丢(尾巴和别的工具在同一步 ⇒ 整步照常)。本轮第一条永远照发;前一条没发成功(`ok:false`)不算发过话。

为了能测,provider 多了两个只给 harness 用的选项:`makeBuiltins`(换成假的内置工具)、`replyTailGuard`(默认开;harness 量基线时关、灌脚本历史时临时关)。

## 复跑

```bash
bun scripts/experiments/reply-once/harness.ts --arm baseline --scenarios a,b,c,d --runs 5 --out /tmp/x.jsonl
bun scripts/experiments/reply-once/harness.ts --arm shipped  --scenarios b --runs 5 --out /tmp/x.jsonl
bun scripts/experiments/reply-once/harness.ts --summarize /tmp/x.jsonl
```

网关是主人自建的、没有限流保护,一次别跑太多(这次全部 110 回合)。
