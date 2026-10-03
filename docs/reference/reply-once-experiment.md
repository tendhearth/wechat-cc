# reply-once 实验:发完话之后怎么让一轮结束(openai provider)

2026-10-02。对象:`src/core/openai-agent-provider.ts` 自己的工具循环(DeepSeek / Kimi / Qwen 等 openai 兼容后端)。结论当时落在 `src/core/reply-tail.ts` + 循环里的「尾巴守卫」(PR #196)。

> **2026-10-03 更新:PR #196 已关闭、没有合入。** 主人 2026-10-02 定的方向是从根上改「话怎么说出去」—— 一轮最后的助理文字就是回复,由 daemon 负责送达(见 [`superpowers/specs/2026-10-03-reply-delivery-design.md`](../superpowers/specs/2026-10-03-reply-delivery-design.md))。所以下文「落地的实现」一节描述的 `reply-tail.ts` 与 provider 的 `makeBuiltins` / `replyTailGuard` 选项**都不在 dev 上**;只有 harness 与原始数据搬进了 dev(`scripts/experiments/reply-once/`),作为新设计每一步迁移的验收工具。dev 上的 harness 发现 provider 没有 `makeBuiltins` 注入口时会**拒跑**(否则模型调的 Bash 会被真的执行);新设计 §9 第 0 步把这个注入口加回来。
>
> **2026-10-03 第 0 步之后:** `makeBuiltins` 已加回 provider(`replyTailGuard` 没有,`arm=shipped` 仍拒跑);harness 扩到 a–i 九个场景(spec §5.8),过关线在 `gate.ts`(`--gate <jsonl>`),隔离护栏挪到第一个 import(`isolate.ts`)并只许打主人自建网关。

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

---

## 2026-10-03:回复交付第 1 步的闸门(openai → daemon)

对象:回复交付 spec(`superpowers/specs/2026-10-03-reply-delivery-design.md`)第 1 步 —— openai 兼容后端不再有 reply 族工具,一轮最后一段非空文字就是回复,经真的 `deliverTurnReply`(假的 sendText)送达。harness 新增 `daemon` 臂:同一份 wechat MCP 注册(`WECHAT_REPLY_DELIVERY=daemon` 时的工具表:附件工具 + admin 的 `message`)、final_text 版提示词、和协调器一样「开轮 → 跑 → 只有完成的轮交付」。场景 a–i 见 spec §5.8;g 用伙伴推送提示(一条一个多月前那晚的直播提醒,应当静默);b 在 daemon 臂里灌的是**文字形状**的连发历史(迁移后的样子)。

真模型调用共 145 轮(上限 150):基线 52、daemon 第 1 轮 52、第 2 轮 40、冒烟 1(e 每次算 4 轮)。原始记录:`scripts/experiments/reply-once/results-2026-10-03.jsonl`(基线 + daemon 第 1 轮)、`results-2026-10-03-r2.jsonl`(daemon 第 2 轮)。表由 `harness.ts --summarize` / `--gate` 生成。

### 基线(legacy,今天的 reply 工具)

| arm | 场景 | n | 外发气泡/轮 (各次) | 「停」类 | 非回复工具 | 步数均值 | 干净结束 | 跑满预算 | 静默 | 附件 |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | a | 5 | 1.0 (1,1,1,1,1) | 0 | 2 | 2.4 | 5/5 | 0 | 0 | 0 |
| baseline | b | 5 | **8.4** (12,12,5,1,12) | **28** | 0 | 8.8 | 2/5 | **3** | 0 | 0 |
| baseline | c | 5 | 3.0 (3,3,3,3,3) | 0 | 0 | 3.6 | 5/5 | 0 | 0 | 0 |
| baseline | d | 5 | 1.0 (1,1,1,1,1) | 0 | 5 (list_projects) | 3.0 | 5/5 | 0 | 0 | 0 |
| baseline | e | 3 | 1.0 〔逐轮 1→1→1→1 ×2,2→1→1→1〕 | 0 | 3 | 2.0 | 3/3 | 0 | 0 | 0 |
| baseline | f | 5 | 0.0 | 0 | 0 | 2.0 | 5/5 | 0 | 0 | voice ×5 |
| baseline | g | 5 | 1.0 (1,1,1,1,1) | 0 | 15 | 4.6 | 5/5 | 0 | **0** | 0 |
| baseline | h | 5 | 1.2 (1,1,2,1,1) | 0* | 17 | 4.0 | 5/5 | 0 | 0 | 0 |
| baseline | i | 5 | 1.0 (1,1,1,1,1) | 0 | 6 | 2.4 | 5/5 | 0 | 0 | 0 |

\* 原来的宽正则会把「blog **停**更」算成元话语,`gate.ts` 的 `META_RE` 已排除「停更 / 停车 / 停留 / 停顿」(2026-10-02 的数据重算结果不变);b 里的是真的「（停，不再发了 😅）」。

### daemon 第 1 轮(最初的 final_text 提示词)

| 场景 | 过关 | 明细 |
|---|---|---|
| a | 过 | 气泡 1,1,1,1,1;旁白外泄 0 |
| b | **不过** | 干净结束 5/5;跑满预算 0;均值 1.0;但 1 次把灌进去的连发历史原样复述成一条(含「停」) |
| c | 过 | 恰好 3 条 4/5(3,3,4,3,3);但有 1 次把附件写成文字「[voice: …]」「[attach_file: …]」,1 次自己加了「[wechat 1/3]」前缀 |
| d | **不过** | 先 list_projects 再 1 条:1/5(引子「你目前注册了两个项目:」、列表、收尾一句各成一段 ⇒ 2–3 条) |
| e | 过 | 逐轮 1→1→1→1 ×3 |
| f | 过 | 语音 1 个且文字 ≤1:5/5 |
| g | **不过** | 静默 4/5(基线 0/5);令牌外泄 0 |
| h | 过 | 旁白 0 外泄,结论在最后的话里 5/5 |
| i | 过 | 令牌外泄 0;没有一次静默(都回了一句) |
| 全局 | 过 | 非回复工具 7.4 vs 基线 10.0 |

### 第 1 轮之后的改动(原则性的,不针对单个场景)

- 分条:以冒号结尾的引导段并入下一段;同一个列表的各项之间有空行也不拆(第 2 轮之后补的,第 2 轮的 h#1 正好是这个形状,没有再花回合复测)。
- 提示词:「短回答(几句话、一个列表连同它的说明)写成一段;只有真的是两三件不同的事才空行分段;不要自己加编号 / 标记」;附件要真的调用工具,写成「[voice: …]」只会原样发出去。

### daemon 第 2 轮(改动之后;e 沿用第 1 轮)

| 场景 | 过关 | 明细 |
|---|---|---|
| a | 过 | 气泡 1,1,1,1,1 |
| b | 过 | 干净结束 5/5;0「停」;0 跑满预算;均值 1.0 |
| c | **不过** | 恰好 3 条 3/5(3,2,1,3,3):一次三条写在一段里没空行;一次第一条进了旁白(两步各说一部分) |
| d | **不过** | 先 list_projects 再 1 条:3/5(另两次是「列表 + 一句『要切换跟我说』」= 2 条) |
| e | 过 | (第 1 轮)逐轮 1→1→1→1 ×3 |
| f | 过 | 5/5 |
| g | **不过** | 静默 3/5;另两次一次照发问候,一次把「这事已经过期了」的推理当成推送写了出来 |
| h | 过 | 5/5 |
| i | 过 | 令牌外泄 0(表里的 1 次「旁白外泄」是模型工具前后说了同一句,只发出去一次,度量已修) |
| 全局 | 过 | 非回复工具 8.6 vs 基线 10.0 |

### 结论

**闸门没过(c / d / g),按约定不翻:openai 先 `shadow`。** 第 1 步要治的病确实治好了 —— b(历史里有连发)从基线 8.4 条 / 轮、3/5 跑满预算、28 条「停」,变成两轮共 10 次里 9 次恰好一条、0 次跑满预算;a / e / f / h / i 全过,非回复工具反而更少。没过的三项是**新路径的形状问题**,不是连发:

1. **d 与已定 ④ 冲突**:spec 要求 d「1 条」,但已定 ④ 去掉了 100 字门槛、按空行分条 —— 模型写「列表 + 一句收尾」就是两条,这在 ④ 下是合法的。要么 d 的线放宽到「≤2 条且列表完整」,要么收尾句并入上一条(再加一条规则)。需要维护者 / 主人定。
2. **c 的方差**:模型有时把三条写成一段(不空行),有时分两步说(第一条落进旁白)。前者是提示词「短回答写一段」的副作用,后者是「最后一段才是回复」在多步轮里的代价(spec §7 第一条风险的同一形状)。
3. **g 比基线好但不到 5/5**:基线 0/5 静默(legacy 推送提示同样要求过期就不发,模型全发了);daemon 3/5–4/5。一次把「为什么不发」的推理写成了最后的话 —— 推送提示需要更硬的一句「不发就**只**写 NO_REPLY,别解释」,或者对 tick 场合把「不该发的解释」识别成静默(那是按内容判,当初否决补丁路线的同一类做法,不建议)。

shadow 期间每轮记 `[REPLY_SHADOW] … match=same|contains|differs|legacy_empty|shadow_empty`,攒真机上的分布(spec §5.1 第 3 项)。翻到 daemon 只改 `OPENAI_CAPABILITIES.replyDelivery` 一处。

### 复跑

```bash
bun scripts/experiments/reply-once/harness.ts --arm baseline --scenarios a,b,c,d,f,g,h,i --runs 5 --out /tmp/x.jsonl
bun scripts/experiments/reply-once/harness.ts --arm baseline --scenarios e --runs 3 --out /tmp/x.jsonl
bun scripts/experiments/reply-once/harness.ts --arm daemon   --scenarios a,b,c,d,f,g,h,i --runs 5 --out /tmp/x.jsonl
bun scripts/experiments/reply-once/harness.ts --arm daemon   --scenarios e --runs 3 --out /tmp/x.jsonl
bun scripts/experiments/reply-once/harness.ts --gate /tmp/x.jsonl
```

---

## 2026-10-03(审稿后):按执行者类型分策略 + 修订的过关线,第 3 轮

审稿决定(维护者):聊天型模型(openai 兼容)本轮所有文字段按顺序全部交付(`replyText: all_segments`),编码型执行者仍取最后一段;过关线 d =「先 list_projects、≤2 条、列表完整」,c =「三项都完整送达、没有丢段、气泡 ≤3」(恰好 3 条只记),g =「≥4/5,且静默率比基线至少高 40 个百分点」。追加预算 60 轮,只做这一轮:daemon 臂 a–i 全跑,共 52 轮(e 每次算 4 轮);基线沿用上面那 52 轮。原始记录 `scripts/experiments/reply-once/results-2026-10-03-r3.jsonl`。

这一轮之前的改动:交付按策略(聊天型每段按 ④ 各自分条)、提示词按策略(聊天型:「这一轮写下的文字会按顺序发给对方……不写过程独白」)、推送提示按策略(「这一轮写下的文字都会原样发出去;不发就只写 NO_REPLY,别的一个字都不写,也别解释」)。

| 场景 | 过关线 | 第 3 轮 | 明细 |
|---|---|---|---|
| a | 5/5 一条 | **不过** | 气泡 2,1,1,1,1:一次模型先说「收到～我在呢」、调了一次(假的)Bash、再说一句 ⇒ 两段都交付 |
| b | 5/5 干净、0「停」、0 跑满、均值 ≤1.5 | **不过** | 干净 5/5、0 跑满、均值 1.0;但又有 1 次在回复里复述了灌入的「（停，不再发了 😅）」 |
| c | 三项完整、没丢段、≤3 条 | 过 5/5 | 气泡 3,3,1,1,1(三次写成一段三行);恰好 3 条 2/5(只记) |
| d | list_projects、≤2 条、列表完整;非回复工具不多于基线 | **不过** | 前三项 5/5;但非回复工具 6 次 vs 基线 5 次(一次多读了一次记忆) |
| e | 每轮 1 条 | 过 | 1→1→1→1 ×3 |
| f | 语音 1、文字 ≤1 | **不过** 3/5 | 两次工具后又说了一句「好了。」「晚安～」⇒ 两段文字;还有一次交付了一个只有「。」的段 |
| g | ≥4/5 静默且明显好于基线 | **不过** 3/5(基线 0/5) | 一次照发问候;一次把「不发了」的理由当成推送写了出来 |
| h | 没丢段、结论送达 | 过 5/5 | 气泡 4,1,3,3,3 |
| i | 令牌 0 外泄 | 过 | |
| 全局 | 非回复工具 ≤ 基线 | 过 | 8.9 vs 10.0 |

**结论:没过(a / b / d / f / g),openai 保持 `shadow`。** 卡在哪里:

1. **all_segments 的代价落在 a、f 上**:策略本身让 c 的「丢第一项」从根上没了(c 5/5),但模型在工具前后各说一句的习惯也一起被交付 —— a 的「先打招呼、调工具、再说一句」、f 的「调完语音再补一句『好了』」都成了两条。a / f 的过关线(1 条 / 文字 ≤1)是按「最后一段」写的;聊天型下要么放宽,要么在提示词里要求「调工具前后不要各说一句」(没有预算再验)。
2. **f 里一个真 bug,已修未复测**:只有「。」的段被当成一句话发了出去 —— 现在只有标点 / 空白的段不单独成条(单测钉住)。
3. **b 的复述**:三轮里每轮都有 1/5 把灌进去的连发历史(含「停」)复述成回复的一部分。这是历史形状被模仿,daemon 路径本身不再连发(15/15 都是一条、0 跑满预算);但「0 条『停』」这一条线一直没过。
4. **g**:三轮分别 4/5、3/5、3/5,基线 0/5。「推不推」由 shouldSpeak / 日程判断在调用模型之前决定(daemon 模式下仍然先于生成,测试钉住),模型的 NO_REPLY 是第二道闸,这道闸目前的命中率在 60–80%。
5. **d 的工具数**:严格按「不多于基线」判,一次多读记忆就不过(6 vs 5);全局非回复工具一直低于基线。

本轮所有真模型调用:第一批 145 轮 + 追加 52 轮(追加上限 60),都只打 llm.youdamaster.cc。

---

## 2026-10-03(审稿第二轮):切换前的复测 a / f / g

维护者决定 openai 切到 daemon(理由见 spec 修订记录),切换前补三处:聊天型提示词加结构性约束(「一轮只在最后说话;工具调用前不要先说一句,除非明显很慢」「发了语音就不要再补一句文字收尾」,只进聊天型那一版);推送的 compose 提示改成「已决定要推送,请写出这条推送」,NO_REPLY 只在「写不出值得发的内容」时用;运行时回滚开关 `reply_delivery`。然后复测 a / f / g 各 5 次(15 轮,上限 30),条件是「不比第 3 轮差」。原始记录 `results-2026-10-03-r4.jsonl`。

| 场景 | 第 3 轮 | 第 4 轮 | 明细 |
|---|---|---|---|
| a 一句话 | 4/5 一条 | **5/5** | 1,1,1,1,1,没有一次先说一句再调工具 |
| f 语音晚安 | 3/5 | **2/5** | 文字 2,0,2,1,2:三次发完语音又补了一句(「好了。」「晚安」「[voice attached]」)—— 新加的「发了语音就不要再补一句」没压住 |
| g 推送 + 已过期 | 3/5 | **4/5**(过修订线) | 一次把「写不出值得发的内容」的理由当成推送写了出来 |

**f 比第 3 轮差(3/5 → 2/5),按约定没有切换,openai 仍是 `shadow`。** a、g 都好于第 3 轮(g 达到修订后的过关线)。f 的失败形状三轮一致:语音工具调用之后的那一步模型还会写一句话,而聊天型策略会把它交付出去。可选的结构性做法(未实现、未验证):聊天型在一轮里调过 `voice` 后,把语音调用**之后**的文字段视为收尾不交付;或者接受 f 的线放宽到「语音 1、文字 ≤2」。

累计真模型调用:145 + 52 + 15 = 212 轮(每批都在给定上限内),只打 llm.youdamaster.cc。

---

## 2026-10-03:回复交付第 2 步的闸门(agy → daemon)

对象:spec 第 2 步 —— agy(订阅版 Gemini 的 Antigravity CLI 1.2.16,模型 `gemini-3.7-flash-medium`,生产默认)。两臂:`agy_legacy`(今天:reply 族工具说话)与 `agy_daemon`(没有 reply 族;一轮写下的文字按聊天型 `all_segments` 由真的 `deliverTurnReply`(假 sendText)交付;附件经 `/v1/turn/attach`,按共享令牌的**本轮绑定**挂上)。原始记录 `scripts/experiments/reply-once/results-2026-10-03-agy.jsonl`;表由 `--summarize` / `--gate … --gate-arms agy_daemon,agy_legacy` 生成。

### 沙盒怎么搭的(agy 是外部进程,和 openai 臂不一样)

agy 只读全局 `~/.gemini/config/mcp_config.json`,那里是**正在跑的 daemon** 的条目和真令牌,实验不能碰、也不能让 agy 看见。`scripts/experiments/reply-once/agy-sandbox.ts`:

- 临时工作区里放一个工作区自定义 agent(`.agents/agents/wccsandbox/agent.md`),`inheritCustomizations: false` + **`inheritMcp: false`**;我们的 MCP 放进 agent 带的插件(`plugin.json` + `mcp_config.json`,插件路径写绝对路径)。插件起的是**生产的** wechat MCP 入口(`src/mcp-servers/wechat/main.ts`),环境和 daemon 写进全局配置的同形(`WECHAT_SESSION_TIER=trusted`,daemon 臂多 `WECHAT_REPLY_DELIVERY=daemon`),`WECHAT_INTERNAL_API` 指向 harness 进程里的假 internal API(127.0.0.1,令牌校验,只记账)。
- 试出来的坑(都在代码注释里):frontmatter 里写 `mcpServers` ⇒ agent「not found」静默退回默认 agent(默认 agent 加载全局 MCP);只有 `inheritCustomizations: false` 不够,全局 MCP 要 `inheritMcp: false`;插件相对路径报 `AgentBasePath is not set`;`--new-project` 那一次找不到工作区 agent ⇒ 先 `--agy-init` 建项目(启动后、发消息前就杀掉),之后每轮 `--project <id> --agent wccsandbox`。
- **偏离 spec §5.3 的一处**:print 模式不带 `--dangerously-skip-permissions` 时,agy 把每一次 MCP 调用都软拒(`cli.log`:`Print mode: soft-denying tool confirmation "CallMcpTool"`,冒烟实测)—— 两臂都发不出东西,量的不是生产(生产对主人会话带这个开关)。所以保留它,补偿:临时工作区、不继承任何全局定制、工具全是假的、终端走 `--sandbox`。
- 每一轮之前 `bx status --json` 必须 protected + tunnel_healthy,否则整批中止(`assertBxProtected`);e 的每个暖场轮前也查。
- b:agy 的历史不能脚本化灌进去,用生产里换 provider 时的冷启动交接块(`buildColdStartBlock`)把同一段连发历史放进提示,两臂一样。

**agy 真正看到的工具表**(真 agy、各 1 轮,让它列出能用的 MCP 工具、不许调用):legacy 列出的是 `plugin_wechat/` 下的 37 个,含 `reply` / `reply_voice` / `send_file` / `edit_message` / `send_sticker` / `search_online_sticker` / `send_online_sticker_candidate` / `broadcast`;daemon 列出 32 个,上面 8 个都没有,多了 `voice` / `sticker` / `attach_file`,没有 `message`(钉死 trusted);两次都**没有**全局的 `wechat-cc-wechat`(同一个问题在没加 `inheritMcp: false` 时列出的正是全局那 37 个)。生产链路(能力表 → `wechatStdioMcpSpec('agy')` → `setupAgyGlobalMcp` 写的文件 → 用文件里的 env 起子进程 → tools/list)由 `src/mcp-servers/wechat/integration.test.ts` 钉住,翻回 legacy 时条目被改写、reply 工具回来。

### 结果(每场景 3 次,e 1 次 × 4 轮;两臂共 56 轮)

| 场景 | 过关线 | agy_legacy | agy_daemon | 明细(daemon) |
|---|---|---|---|---|
| a 一句话 | 1 条 | 过 1,1,1 | 过 1,1,1 | |
| b 历史有连发 | 干净、0「停」、0 跑满、均值 ≤1.5 | 过 | 过 | 都 1 条,没有复述「停」 |
| c 分三条 | 三项完整、没丢段、≤3 | 过 3,3,3 | 过 3,3,3 | |
| d 我有哪些项目 | list_projects、≤2 条、列表完整 | 过 1,1,1 | 过 1,1,1 | 非回复工具 7 vs 7 |
| e 新会话四轮 | 每轮 1 条 | 过 1→1→1→1 | 过 1→1→1→1 | |
| f 语音晚安 | 语音 1、文字 ≤1 | 过 | 过 | 语音都经 `/v1/turn/attach` 绑到本轮(共享令牌),文字 0 |
| g 推送 + 已过期 | ≥4/5 且静默率比基线高 40pp | 3/3 静默 | 3/3 静默 | **按线「不过」只因相对条件**:agy 的 legacy 推送本来就 3/3 不发(legacy 推送只认 reply 工具,模型没调) |
| h 3–4 次工具 | 没丢段、结论送达 | 过 1,1,2 | 过 2,2,2 | 「列表一段 + 建议一段」两条,结论都送到 |
| i 私聊「不用回」 | 令牌 0 外泄 | 过 | 过 | 都回了一句,没有静默 |
| 双发(新指标) | 重复气泡 + 「已回复…」旁白 | 0 | 0 | |
| 全局 | 非回复工具 | 15.0 | **10.3** | 差额主要是 agy 调 reply 前先 `view_file` 读工具 schema |

### 结论

**两臂打平,daemon 没有回归,但在 harness 能量到的故障点上也不是「明显更好」—— 按约定先 `shadow`,不翻默认。** agy 在沙盒里的 legacy 本来就没有坏:2026-09-08 的双发旁白已经被命名空间折叠修住(`agent-provider.ts` 的 `normalizeWechatMcpServer`),所以这里量不出差。daemon 的好处是**结构性**的,由测试而不是由回合数证明:

1. 双发旁白不再依赖「认出这一家的 tool_call 形状」—— `src/core/conversation-coordinator.agy-delivery.test.ts` 用真 agy 解析器喂一个没登记过的命名空间:legacy 复现双发(FALLBACK_REPLY 把「已回复用户的问候。」当第二条),daemon 只交付一次、没有 FALLBACK、server 名认得出认不出交付结果一字不差。
2. 共享令牌 `agy-static` 的 #199 缺口:daemon 下附件绑本轮、发送类路由只许本轮的聊天;legacy / shadow 下仍是豁免(见 `reference/internal-api-auth.md`)。

翻到 daemon 只改 `AGY_CAPABILITIES.replyDelivery` 一行,或 `agent-config` 的 `reply_delivery: { agy: 'daemon' }` + 重启(开机会把全局 MCP 条目改成 daemon 工具表)。shadow 期间看 `[REPLY_SHADOW] … provider=agy` 的分布。

真模型调用合计 74 轮(上限 80):探路 18 轮(其中 7 轮是为了不发消息而提前杀进程、但消息已经发出去的半轮,按整轮记;另有 1 次 TLS 握手超时在认证阶段就失败、没有到模型)+ 闸门 56 轮。每一批都在 bx protected + healthy 时跑。

### 复跑

```bash
bun scripts/experiments/reply-once/harness.ts --agy-init <临时目录>           # 打印 agy 项目 id,不发消息
bun scripts/experiments/reply-once/harness.ts --arm agy_legacy --scenarios a,b,c,d,f,g,h,i --runs 3 --agy-ws <临时目录> --agy-project <id> --out /tmp/x.jsonl
bun scripts/experiments/reply-once/harness.ts --arm agy_daemon --scenarios e --runs 1 --agy-ws <另一个临时目录> --agy-project <id2> --out /tmp/x.jsonl
bun scripts/experiments/reply-once/harness.ts --gate /tmp/x.jsonl --gate-arms agy_daemon,agy_legacy
```

两臂并行跑要各用一个工作区(每轮会重写工作区里的 agent / 插件配置)。

## 2026-10-03:回复交付第 3 步的闸门(Cursor → daemon,不连模型)

**为什么不用真模型**:Cursor 的真 API 没法沙盒化(`cursor-agent` 连 Cursor 的服务、用主人的登录与额度),主人的 Cursor 额度此刻也是用完的(「Upgrade your plan to continue」)。这一步**一次真 Cursor 调用都没有做**。闸门量的是**交付管道**,不是模型。

### 怎么搭的

- **假 `cursor-agent acp`**(`src/core/acp/scripted-agent.ts`):stdin / stdout 上是真的换行分隔 JSON-RPC,形状照 2026-09-17 真机录到的报文(`src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`)—— token 级 `agent_message_chunk`、`agent_thought_chunk`、MCP 调用先来一条不带身份的 `tool_call`(kind other、「MCP: tool」),身份(`rawInput.providerIdentifier / toolName`)在紧跟的 `tool_call_update` 里,再 in_progress → `session/request_permission` → completed。也能原样回放录到的 update。`pid` 是 undefined,provider 的 close() 走 `child.kill()`,不碰真进程组。
- **这边全是生产代码**:`createAcpCursorChatProvider`(ACP 客户端 + `acp/events` 翻译器,messages 模式)→ 协调器 solo 分支(legacy 的 FALLBACK_REPLY / daemon 的交付分支)→ `makeReplyDeliveryRuntime`(只把 sendText 换成记账)。伙伴推送(g)和 tick-bodies 一样不走协调器:legacy 只认 reply 工具,daemon 走同一个运行时、场合 tick。
- **同一个模型行为,两套词汇**(`scripts/experiments/reply-once/cursor-fixture.ts`):legacy 照今天的提示词用 `reply` / `reply_voice` 说话,说完补一句「已回复。」(记忆里 cursor 每轮双发的那句);daemon 没有 reply 族,话写在最后,语音走 `voice`。旁白、工具、正文两臂一字不差。
- **三种外部条件**(run 序号):① recorded —— 身份照真机带在 `tool_call_update` 里,`--dangerously`;② drift —— CLI 换了 envelope、不带 MCP 身份(下一版 cursor-agent 的风险;agy 2026-09-08 出过同形状的事);③ strict —— 身份照真机,但 daemon 跑在 strict 权限下(ACP 的 `permissions:'mode'` ⇒ 每张权限卡都拒 ⇒ MCP 调用全被拒),只跑纯说话的场景(a / c / e / i),模型看得到被拒、改用文字说。
- **场景 b 不适用**:b 量的是我们自研循环里「历史有连发 ⇒ 模型自己越说越多」;Cursor 的循环在 Cursor 那边,剧本演不出模型怎么接历史,演出来也只是我们写进去的东西。**i** 用的是最坏的剧本:模型照做,只写 `NO_REPLY`(两臂同一个输出)。
- **这一臂不衡量**模型会不会多说 / 少说、Cursor 在 final_text 提示词下会不会把结论写在最后一段 —— 那要真模型,等额度回来再补(见下面「残留」)。

### 结果(两臂 × 8 个场景 × 适用的外部条件,共 40 轮;e 每轮 4 回合)

| 场景 | 过关线 | cursor_legacy(recorded / drift / strict) | cursor_daemon(recorded / drift / strict) |
|---|---|---|---|
| a 一句话 | 1 条 | **不过** 1 / 2 / 0 | 过 1 / 1 / 1 |
| c 分三条 | 三项完整、≤3 | **不过** 3 / 4 / 0 | 过 3 / 3 / 3 |
| d 我有哪些项目 | list_projects、≤2、列表完整 | **不过** 1 / 3 | 过 1 / 1 |
| e 同一常驻会话四轮 | 每轮 1 条 | **不过** 1111 / 2222 / 0000 | 过 1111 ×3 |
| f 语音晚安 | 语音 1、文字 ≤1 | 过(drift 多一句「已发送语音晚安。」) | 过(文字 1 + 语音 1) |
| g 推送 + 已过期 | ≥4/5 且比基线高 40pp | 2/2 静默 | 2/2 静默 —— 按线「不过」只因相对条件(legacy 推送本来就不发),与 agy 同 |
| h 3–4 次工具 | 旁白 0 外泄、结论送达 | **不过** 1 / 4(drift 旁白外泄 2) | 过 1 / 1 |
| i 私聊「不用回」 | 令牌 0 外泄 | **不过**:3/3 把 `NO_REPLY` 原样发出去(FALLBACK) | 过:0 外泄,记 `REPLY_SILENT_IN_DM` |
| 全局 | 非回复工具 | 4.0 | 4.0(剧本相同,只是核对) |

按外部条件拆开:

| arm | 外部条件 | 轮数 | 双发 | 旁白外泄 | 令牌外泄 | 主人什么都没收到(私聊、非 i) | FALLBACK_REPLY |
|---|---|---|---|---|---|---|---|
| cursor_legacy | recorded | 8 | 0 | 0 | 1 | 0/6 | 1 |
| cursor_legacy | drift | 8 | **5** | **3** | 1 | 0/6 | 7 |
| cursor_legacy | strict | 4 | 0 | 0 | 1 | **3/3** | 1 |
| cursor_daemon | recorded | 8 | 0 | 0 | 0 | 0/6 | 0 |
| cursor_daemon | drift | 8 | 0 | 0 | 0 | 0/6 | 0 |
| cursor_daemon | strict | 4 | 0 | 0 | 0 | 0/3 | 0 |

原始数据 `scripts/experiments/reply-once/results-2026-10-03-cursor.jsonl`。闸门本身也是一条测试(`cursor-fixture.test.ts`,几秒),上面这些数字被钉住。

**回放真机报文**(`src/core/conversation-coordinator.cursor-delivery.test.ts`):2026-09-17 录到的 c1「新建 hello.txt」—— legacy 走 FALLBACK 发两条(「正在创建 `hello.txt`。」旁白 + 结果),daemon 只发结果;c2(命令被拒,一段两句)两臂内容相同。

### 读法

1. **legacy 在身份照真机时没坏**(recorded 列除了 i 都过)—— 今天的 ACP 翻译器认得出 reply。它的毛病都在「认 tool_call 的形状」上:CLI 一换 envelope,FALLBACK 就把「我先看一下」「已回复项目列表。」一段一段发出去(双发 5、旁白外泄 3);协调器测试用同一个剧本复现,server 名换成 `wechat-cc:wechat`(cursor 全局配置的命名空间键)也一样。
2. **strict 下 legacy 是静默吞话**:reply 调用的身份在权限卡之前就到了,被拒的调用照样算「回过了」⇒ 模型改用文字说的正文被整轮丢掉,主人一个字都收不到(3/3)。daemon 下说话不经工具,strict 只拦附件(语音挂不上,文字照常)。
3. **daemon 不看 tool_call 认不认得出来**:四种外部条件下交付结果一字不差,没有 FALLBACK_REPLY,私聊里的 `NO_REPLY` 不外泄。
4. 额度用完(整轮就是「Upgrade your plan to continue」)两臂都当错误收尾、只发通知(ACP 翻译器的 quotaRefusal),daemon 不交付原文。

### 结论

**daemon 无回归、结构上更好(一条路、不依赖认出 tool_call、strict 不再吞话、令牌不外泄)⇒ 按约定翻默认:`ACP_CURSOR_CAPABILITIES.replyDelivery = 'daemon'`,`replyText = 'last_segment'`。** 回滚:`agent-config` 的 `reply_delivery: { cursor: 'legacy' }` + 重启 daemon。

### 残留(这一步量不到的)

- **模型行为没量**:Cursor 在 final_text 提示词下会不会把结论写在最后一段、会不会在结论后再补一句「已完成。」(那句会变成回复、结论落进旁白)。提示词写了「结论要写在最后那段里、写全」;额度回来后用真 Cursor 补 a / d / h 各几轮,并按 §5.8(2)在真机 `selftest chat --provider cursor` + 主人微信聊几句。
- **Cursor 自己的错误文字混在助理消息里**:录到的 c4both 最后一段是复读的 MCP 报错 + 「Error: NonRetriableError: Agent Looping Detected …」,stopReason 仍是 end_turn。legacy 会把三段都 FALLBACK 出去,daemon 只交付最后一段 —— **两臂都会把这句 Cursor 报错当回复发出去**(#190 红线的同一类)。不是本步引入的,单独一件事:要在 ACP 边界上认出这句、当错误收尾。 **2026-10-03 已修**:ACP 边界认出这一整块、带码(`provider_error`)收尾,两臂都只发通知 —— 见 [provider-error-shapes.md](provider-error-shapes.md) §8。
- 已经在跑的常驻 `cursor-agent acp`:开关在开机定,重启 daemon 之后的新会话才是新工具表;`session/load` 续上的旧会话历史里还有旧提示词,新提示词照常在第一轮注入。

### 复跑

```bash
bun scripts/experiments/reply-once/harness.ts --arm cursor --out /tmp/cursor.jsonl     # 两臂一起,打印汇总 + 按外部条件 + 两份过关表
bun scripts/experiments/reply-once/harness.ts --gate /tmp/cursor.jsonl --gate-arms cursor_daemon,cursor_legacy
```

不连网、不需要 bx、不碰主人的 Cursor 登录。
