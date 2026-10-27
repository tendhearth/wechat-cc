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
