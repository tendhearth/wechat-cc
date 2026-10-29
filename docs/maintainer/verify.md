# 验证

改完 + 部署完,用 `wechat-cc selftest` 做真机闭环。它不发微信、不碰主人的聊天记忆、不改主人的默认 provider。

推上去之后还有最后一步 —— **看 CI**,也是一条命令:

```bash
wechat-cc ci triage --wait --rerun
```

退出码 0 绿 / 1 真红(`unknown` 也算)/ 2 这个 SHA 上没有运行、`gh` 出错、或开关写错了 / 3 是 `src/cli/ci-flakes.json` 里登记过的 flake。给了 `--rerun` 的话已知 flake 会自动重跑一次,**第二次仍红一律改判真红**。细则、退出码全表、怎么往登记表里加一条,见 [ci-and-flakes.md](ci-and-flakes.md)。

## 测试只增不减

AI 写代码有两个老毛病(Kent Beck 说过):为了变绿把测试删掉、跳过、改松;事后补一条「没有修复也会过」的测试。前一个在 diff 里看得见,只是评审时没人去数 —— 所以让机器数(2026-10-27 主人定)。

`scripts/test-shrink-check.ts` 比 PR 头和它跟 base 的 merge-base,逐个测试文件看(判法写在 `scripts/test-shrink-lib.ts` 开头):

- 用例少了(按标题配对,**跨文件**配:搬家、拆文件、git 认出或没认出的改名都不算;只改标题的在同一文件里按顺序配上);
- 配上的用例 expect 少了(含 `expect.soft` / `expect.poll` / `assert.*`),或精确断言(`toBe` / `toEqual` / `toHaveLength` / 快照 …)少了 —— `toBe(3)` 改成 `toBeDefined()` 就是这一条;
- `skip` / `skipIf` / `runIf` / `todo` / `fails` 变多;任何地方新出现 `.only`;
- `.snap` 少了条目;`vitest*.config.*` 的 `exclude` 多了项(Windows 排除清单就是这么长出来的)。

报了不等于错:功能删了、测试跟着删是正常的。规矩是**说出来**:PR 描述里写一节 `## 删掉/放松的测试`,每个被点名的文件一行(全路径或文件名)加理由,CI 才放行。只看 TS / JS 测试和快照;Rust / Swift / Kotlin 不管,`it.each` 表格少几行也看不出来 —— 这些靠评审。把断言挪进 helper 会被当成 expect 变少,写一句理由即可。

本机先看一眼:`bun scripts/test-shrink-check.ts`(只报告、退出 0;`--base <ref>` 换基线)。整合者按某个 PR 判、跟 CI 同一个结论:`bun scripts/test-shrink-check.ts --pr <N>`。

## 红/绿

**修 bug 的 PR,描述里要有 `## 红/绿`**:贴出那条命令,证明新加/改过的测试在**撤掉修复时红、带上修复时绿**。只「带上修复时绿」证明不了测试抓得住这个 bug。做法:

```bash
git stash push -- <被修的源文件>        # 或 git checkout origin/dev -- <源文件>,只撤修复、留着测试
bun x vitest run <测试文件>            # 红:贴失败的那一行
git stash pop
bun x vitest run <测试文件>            # 绿
```

写不了测试的修复(纯配置、只有真机能复现)也写这一节,说为什么、怎么验的。CI 怎么认「修 bug」:分支以 `fix/` 开头,或标题以 `fix` / 「修」开头(「修改」「修订」不算;自改的标题是「自改 #…」,不在内)。

两条都在 `ci.yml` 的 **pr · 测试只增不减 + 红/绿** 作业里查,只在 PR 上跑、只改 Markdown 时跳过。它读的是触发那一刻的 PR 描述:红了改完描述,**重跑作业没用**,推一次或 `gh pr close <N> && gh pr reopen <N>`。自改流水线的 PR 也查:自改删了测试就停在 CI 红,交给人看。dev → master 的发版 PR 不查 —— 它的 diff 是两次发版之间 dev 的累计,里面每个 PR 进 dev 时都查过(1.7.8 那次累计报了 102 个文件);别的分支直接开进 master 照查。

## 跨模块的行为至少一条走真实接线(沙盒)的测试

**mock 只许替身系统边界**(微信 ilink、模型 SDK、外网、外部进程);daemon 自己的模块不许 mock。单测里 mock 内部模块测的是「我以为它们怎么接」,
接错了照样绿 —— 2026-10-26 #729 在 boot-api 里多取了一样没登记的东西,单测和 CI 全绿,真机开机三连败、自动回滚。

- 真实形状沙盒:`bun run test:sandbox`(`src/daemon/__e2e__/real-shaped.ts`)起整台照主人真机配置的 daemon —— 知识库、社交、配对、手机中继、
  网络守护都开着 —— 从开机走到收发、拍板卡、记忆导入、关机再开机。`bun run verify` 每次都跑它(本机几秒),CI 在三个平台的 build 里跑。
- 改到跨模块的行为(开机顺序、可选子系统、两个模块之间的口子),至少一条测试走沙盒或 `__e2e__/` 的真接线。
- 加新的可选子系统 / 配置开关:在沙盒里照真机把它开上;开不了的写进 `src/daemon/__e2e__/README.md` 的「没开的」,说清为什么。

这条由 `scripts/mock-internal.guard.test.ts` 按文件数(判法在 `scripts/mock-internal-lib.ts`):`vi.mock` / `vi.doMock` / `mock.module`
的目标解析进仓库自己的模块就算一处;node 内置、npm 包、`src/adapters/**`、`src/test-support/**` 和 `BOUNDARY_FILES` 里写了理由的几个真边界放行。
没登记的文件出现内部 mock 就红,登记过的只许降。清一处的换法三选一:用真模块;经参数 / 端口注入假实现;
或者把要测的行为搬进沙盒 / `__e2e__/` 的场景。只验「mock 被这样调了」的测试,沙盒或 e2e 已经覆盖那个行为的,直接删,
在 PR 描述的 `## 删掉/放松的测试` 里逐个列出。清完把守卫里 `BASELINE` 的数字调下来(降到 0 的行删掉)—— 少了不调,守卫也红。

## 推之前跑过 verify,由机器查

`bun run verify` 一开始记下它检查的那份内容(工作区原样的 git 树),全绿才记进这个 worktree 的 git 目录;`git push` 时
`scripts/git-hooks/pre-push` 看每个要推的提交的树在不在记录里,不在就拦下(先 verify 再 commit 也认,树一样)。只改 Markdown、删分支不查。
判法和测试:`scripts/verify-stamp.ts`。装一次就行(主仓库的配置,所有 worktree 共用):`git config core.hooksPath scripts/git-hooks`。
真要绕过:`git push --no-verify`,并在 PR 里写为什么。这条管的是「agent 说跑了 verify」—— 以前只写在提示词里。

## 评审只报影响正确性的

评审(人、整合者、派出去的评审 agent)只报**会让结果错**的问题:行为错、数据丢、权限放宽、边界条件漏、该有的测试没有。**跳过风格**,
**不要求给不可能发生的情况补测试**。叫评审者找问题,它总能找到点什么;每条都修,最后多出几层抽象、一堆测不到真东西的测试 ——
测试越写越多、越写越像实现细节,一部分就是这么来的。派评审时提示词里写明「只报正确性,跳过风格」。

动开机 / 关机顺序、数据迁移、权限判定的 PR,合进去之前再要一道**没看过写代码过程**的评审,由 **Codex** 来做(2026-10-29 主人定;
写代码和日常评审多是 Claude,换一家模型看,盲区不重合)。在分支的 worktree 里跑:

```bash
codex exec --ignore-user-config --disable plugins --disable browser_use --disable computer_use \
  --disable apps --disable hooks -s read-only \
  review --base dev
```

`--base` 不能再带自定义提示词(codex-cli 0.165 直接报错退出),用它内置的评审提示:按 P0–P3 列问题,本身就偏正确性;
照上一节只处理会让结果错的,风格类的不改。它只拿到 diff 和仓库,不拿对话,也不拿设计稿 —— 设计稿里定下的取舍它可能当成问题报,对着稿判。
一次约半分钟到几分钟。整合者自己写过或审过的,看 diff 时带着写的时候的推理,容易顺着它读过去。
前面那串 `--ignore-user-config --disable …` 不能省:本机 Codex 配了能操作电脑和浏览器的 MCP,只读沙箱管不住它们
(同 `src/cli/self-change/runner.ts` 的 `CODEX_REVIEW_LOCKDOWN`)。api.openai.com 要走 bx,先看 `wechat-cc guard status`。
Codex 用不了(额度、登录)时退回 Claude Code 的 `/code-review` 子 agent,PR 里写一句。

## 两种用法

```bash
wechat-cc selftest workbench --executor cursor [--image] [--resume] [--json] [--timeout-ms N] [--keep]
wechat-cc selftest chat --provider cursor [--text "…"] [--resume] [--json] [--timeout-ms N]
wechat-cc selftest phone [--json] [--timeout-ms N]
```

**workbench**:在 `<tmpdir>/wechat-cc-selftest/wb-<ts>` 建一个 scratch 项目(mkdir + README + `git init` 一次提交),`POST /v1/workbench/create`,长轮询 `GET /v1/workbench/task`,碰到权限卡就 `POST /v1/workbench/permission` 放行;跑完(或超时)时任务状态还没到终态就先 `POST /v1/workbench/cancel` 并最多等 20s,再 `POST /v1/workbench/archive`。检查项:`created`、`replied`、`text_seen`、`activity_seen`、`permission_roundtrip`、`permission_executed`、`file_written`(`--image` 时换成 `answer_mentions_red`)、`resume_replied`(带 `--resume` 时)、`no_error_event`、`archived`(归档那一下的 HTTP 结果本身也是一项)。

`--resume` 那一步走哪条路**看执行者的那次 run 还活着没有**:claude / codex 这种答完还留着会话的(`status: running` + `phase: replied`),续接走 `POST /v1/workbench/input`(带任务详情里的 `runId` 和一个新生成的 UUID v4 `requestId`)—— 这种任务上 `POST /v1/workbench/continue` 只会一直回 409 `workbench_busy`(2026-09-18 真机就是被这条假红回滚了一次好部署);run 已经收了的(cursor,`status: completed`)才走 `continue`(那条路上偶发的 409 会每秒重试、最多 10 次)。`resume_replied` 的 detail 里写着这次走的是 `via input` 还是 `via continue`。

scratch 项目**不在 STATE_DIR 底下**(它跟 token / account.json 同级,而 scratch 里跑的是权限全放行的真执行者);归档成功后默认删掉；归档失败时强制保留，避免删除仍有执行者使用的目录。`--keep` 保留它、把路径打在 `scratch: …` 那行上给人去翻现场。daemon 侧 `selftest chat` 用的 scratch 项目同理,固定在 `<tmpdir>/wechat-cc-selftest/project`。

`--timeout-ms` 是**整轮**上限(workbench 缺省 240000;chat 缺省 180000,daemon 侧轮次看门狗缺省 120000)。非数字 / ≤0 当场报错退 1,不会悄悄按缺省值跑。

**chat**:`POST /v1/selftest/converse { providerId, text }`,daemon 内部代 spawn 一次自检对话。检查项:`replied`、`tool_seen`(缺省 text 让它调 wechat MCP 的 `ping`)、`no_error`、`resume_replied`。那次对话的会话 token 只被授予 `GET /v1/health`、并且带 10 分钟 TTL —— 自检对话里的 wechat MCP 只能 ping,发不出消息。

刚 `self deploy` 完就跑 `selftest chat` 是**正常用法**:端口和 info 文件比 bootstrap 接线早,那个窗口里路由会答 503 `selftest_not_wired`,CLI 每 2s 重试、最多等 60s,等到了就在 `replied` 的 detail 里写一句 `waited …ms for selftest wiring`。

输出:逐行 `✓ / ✗ name — detail`,末行 `PASS` / `FAIL`;`--json` 给 `{ ok, kind, target, checks, taskId?, sessionId?, durationMs, scratchPath? }`。退出码 0 通过 / 1 有检查项失败 / 2 daemon 没在跑。

**phone**(手机协议 v2 真机闭环,`src/cli/selftest-phone.ts`):用 operator 凭据读 `GET /v1/settings/link`(admin 档,计划 7a 起)拿链接令牌 → 连**真中继** → 配对一台一次性设备 → 用设备令牌重连并确认协商到 v2 → 订阅 `agents` 主题 → 经 operator(内部)API 派一个最小工作台任务,确认它的生命周期出现在订阅上 → 局域网撤销这台设备,确认被撤的令牌再也连不上。

- **前提**:设置页「出门也能用」(远程中继)已开;daemon 在跑;本机连得上中继。没开会当场 FAIL,不会悄悄跳过。
- 它会**配对一台一次性设备再撤销**。正常结束时不留痕迹。
- FAIL 时中途没撤成功的话,输出里会写怎么手动清理:设置页 → 已配对设备 → 按 id / 配对时间「忘掉」那台。**任何输出都不打印令牌**(设备令牌是永不过期的活凭据);不知道 id 时先走局域网取列表再撤销。
- 刚 `self deploy` 完跑也是正常用法(接线窗口的 503 由 CLI 自己等)。

**device**(Tendhearth iPhone 真机全自动验收,`bun run e2e:device` = `bun scripts/device-e2e.ts`,2026-10-01):USB 连着的 iPhone + 在跑的 daemon(中继 v2 已开),没人碰屏幕跑完:收起手机原有的配对 → 桌面「连接手机」同一条路铸码、经 `devicectl --payload-url` 送进 app、核对码一致、连接后此刻在线 → 同码重用被拒 → 跟 CC 说一句等回复 → app 退后台、派一个要删探针文件的工作台任务、点**扩展解密后**的真 APNs 横幅、批准页允许、daemon 那头任务答完探针被删 → 局域网撤销测试设备、app 显示「不再配对」→ 收尾归档任务、放回原配对。UI 步骤是 XCUITest(`apps/app/native/ios-e2e/`,Maestro 2.11 认不到 iOS 27 真机),构建是 Release + `e2eBuild` 标记(Expo SDK 57 的 Debug 包内嵌 JS 启动即红屏)。

- 报告在 `<tmpdir>/tendhearth-device-e2e/<时间>/report.md`,失败步骤带截图;退出码 0 / 1 / 2(2 = 要主人在手机上动一下:解锁、开发者模式、手机重启后第一次跑时弹的「Enable UI Automation」触控 ID)。
- 只撤销它自己配的那一台(配对前后设备列表的差);**不碰**主人手机原有的那台设备位(收起来再放回,见 `apps/app/README.md`「真机全自动验收」)。
- 会往主人的 CC 对话里说一句 `device-e2e <随机串>: reply with one short sentence`(跟 CC 说走的就是主人会话);批准那一步默认用 claude 执行者(`--executor` 可换;cursor 额度用完会当场报)。
- 期间会铸两枚 10 分钟链接令牌(配对、撤销各一),会作废桌面上正开着的那枚码。

## 两种 token 分别够得着什么

daemon 起来后写 `~/.claude/channels/wechat/internal-api-info.json`,里面有 `baseUrl`、`tokenFilePath`、`operatorTokenFilePath`。**两把钥匙不通用**:

| | 文件 | 档 | 够得着 |
| --- | --- | --- | --- |
| file token | `tokenFilePath` | trusted | `GET /v1/health` 这类 trusted 路由 |
| operator token | `operatorTokenFilePath` | admin,但按 `routeAllow` 逐条放行 | 工作台那一串、`POST /v1/selftest/converse`、桌宠权限 resolve 等 |

**operator token 拿不到 `GET /v1/health`** —— 它不在 `routeAllow` 里,拿它去戳 health 会 403 `route_not_allowed`。健康探测一律用 file token。`routeAllow` 的口径是「桌面 app / CLI 真会调的那几条」,不调的就不给;新路由要加请看 `src/daemon/internal-api/token-registry.ts` 里的注释。

手动戳一下:

```bash
INFO=~/.claude/channels/wechat/internal-api-info.json
BASE=$(python3 -c "import json;print(json.load(open('$INFO'))['baseUrl'])")
FILE_TOKEN=$(cat "$(python3 -c "import json;print(json.load(open('$INFO'))['tokenFilePath'])")")
curl -s -H "Authorization: Bearer $FILE_TOKEN" "$BASE/v1/health" | head -c 400
```

报告里永远不要贴 token 原文;要证明读到了就贴长度或哈希前 8 位。

## 工作台路由名(照抄,别凭印象)

```
POST /v1/workbench/create        { path, providerId, title, text, draftId?, attachmentIds? }
GET  /v1/workbench/task?id=&since=&wait_ms=20000      长轮询,返回 events + permissions
POST /v1/workbench/permission    { id, requestId, decision: 'allow' | 'deny' }
POST /v1/workbench/continue      { id, text }
POST /v1/workbench/cancel        { id }
POST /v1/workbench/archive       { id, archived: true }
POST /v1/workbench/attachment    { id, draftId, name, mime, base64 }
```

## 变异测试(定期传感器,不进 verify / 每个 PR 的 CI)

测试绿只说明「没写错的地方没红」,说明不了「写错了会不会红」。变异测试把被测代码一处一处改坏(`===` 换 `!==`、`&&` 换 `||`、条件换成 `true`、字符串清空……),每改一处跑一遍覆盖到它的测试:有测试红 = 这处被护住(killed);全绿 = **没有任何测试在乎这一处**(survived)。

```bash
bun run test:mutation                      # 先 uptime:load 过 20 别跑(主人在用这台机器)
bun run test:mutation -- --concurrency 6   # 机器空着时
bun run test:mutation -- --force           # 不用增量,全量重测
```

- **什么时候跑**:发版前、大重构之后(权限 / 红线 / 记忆 / 迁移 runner 动过),或者想删一批测试之前看看删的是不是在干活的那批。不是每个 PR 都跑。
- **范围**:`stryker.config.mjs` 的 `mutate`,只放最要紧的纯逻辑(authorize 与它组合的几层、放行规则、记忆渲染 / 收回);迁移 runner `src/lib/db.ts` 单独一份 `stryker.db.config.mjs`,只用库层测试(`vitest.mutation-db.config.ts`)—— 放进主配置会牵出 5000 多条测试、跑一个半小时(原因见那份配置的注释)。`src/lib/db/migrations/` 下的冻结迁移**不变异**(一字不许改)。加文件就往 `mutate` 里加。工作台生命周期 / 协调器 / 回复交付 / 拉消息快车道在第三份 `stryker.areas.config.mjs`(牵连的测试和权限那批几乎不重合)。
- **跑在 Node 上**(Stryker 进程里直接起 vitest,用 `vitest.node.config.ts`,跟 CI 的 node 作业同一份);只跑 import 图上牵连到被变异文件的测试(`vitest.related`)。沙箱在 `.stryker-tmp/`,自己 `git init` 一个根(有测试断言 cwd 是仓库根);Bun 专属的测试不在这里面。
- **依赖在 `tools/mutation/`**(独立 `package.json` + `bun.lock`,不进根 workspace,`bun run test:mutation` 第一步自己 `bun install`):Stryker 10 带 `@babel/core` 8,装进根 lockfile 会把 bun 隔离安装的兜底目录里的 `@babel/core` 从 7 换成 8,手机 app 的 Expo / Metro 可能靠它解析。根 lockfile、CI、三平台都不受影响。
- **耗时**:主配置 2448 个变异,首轮(不变异)约 4 分钟,空闲机器 4 个 worker 全部跑完约 15–20 分钟(默认 2 个 worker,再翻倍);迁移 runner 那份 3 分钟。**增量**:结果存在 `reports/mutation/stryker-incremental.json`(db 那份在 `reports/mutation/db/`),下次只重测改过的源码 / 测试;中途 Ctrl-C 也会存一份。报告:`reports/mutation/index.html`、`reports/mutation/db/index.html`(看哪一行哪个变异活下来)和同目录的 `mutation.json`。
- **主人用机时**:load 高会把正常变异判成 Timeout(算「护住」,虚高)。结果里 Timeout 突然变多,就删掉增量文件里 `"status": "Timeout"` 的那几条,机器空了重跑。
- **怎么读**:活下来的变异不全是测试的错 —— 有的是等价变异(改了也没区别,比如永远走不到的分支)。基线和逐条解读见 [mutation-baseline-2026-10.md](mutation-baseline-2026-10.md)。补测试时先在报告里确认那个变异活着,补完再跑一次看它死了(红 / 绿),别凭感觉补。**补完用增量复跑之前,先把增量文件里 `Survived` / `NoCoverage` 的条目删掉**(或 `--force`):增量看不出新加的测试能不能杀一个原来活着的变异,会原样沿用「存活」(2026-10-27 第二轮踩过)。数「哪个测试文件一个独有的都没杀」:`--disableBail` 跑,再 `bun tools/mutation/unique-kills.ts <报告>...`。

## 必须主人在场的检查清单

`selftest` 覆盖不到的、只有人眼能判的四件事(改了相关代码就请主人跑一遍):

1. 桌面 app 在本仓库 `cd apps/desktop && bun run tauri build` 之后,任务里的**逐字流**是真的一个字一个字出来,不是整段蹦出来;
2. **免审执行者**(agy / cursor)第一次要输入时,桌面弹的那张确认对话框能点、点完不再问;
3. 「**改动**」面板里逐文件「接受 / 打回」按下去有效,打回的文件下一轮真的回到执行者手里;
4. 微信里一句真的 `/cursor …`,回一条、只回一条(对话侧协调器一条 text 事件发一条微信,流式 provider 必须按助理消息攒)。


### 工作台的文件与审批验收

普通自检明确要求在项目根目录创建 `hello.txt` 并回读验证。项目代码和指定路径的文件留在项目原位置；没有指定路径的独立报告、图片放入任务成果目录，由 CC 保存快照。这两种位置不互相替代，根目录检查失败不能用“其他位置找到同名文件”放宽通过。

`uname -a` 和普通写文件不保证触发审批。自检会预先创建一次性 `cc-selftest-permission-probe.txt`，要求执行者用 `rm -- cc-selftest-permission-probe.txt` 删除它，并分别检查审批往返和文件消失。Claude 走删除操作审批；Codex 的工作区写入默认允许，因此自检明确对这一条命令请求原生提权审批，不改变执行者权限配置。没有权限请求仍为未通过，不能当作已验收；测试只针对这份自建临时项目，不用于真实用户目录。

成果收集在每轮答复和最终收尾采用同一流程：区分项目身份变化、成果目录不可读、快照保存失败。后续收集成功会记录恢复；已有快照始终保留。执行者“已答复”只表示本轮回复结束，不等于内容正确或检查通过。
