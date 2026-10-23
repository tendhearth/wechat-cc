# CI 与 flake

## 作业

`.github/workflows/ci.yml` 在 push 到 `master` / `dev`,以及所有 PR 上跑。自改流水线推 `self/<id>` 时开一个进 `dev` 的 PR,它「CI 绿才进 dev」的闸门架在那个 PR 的 CI 上(2026-10-23 起;以前是 `self/**` 的推送单跑,两处都列会让同一提交跑两遍)。

- **build · ${{ matrix.os }}** —— `ubuntu-latest` / `macos-latest` / `windows-latest` 三平台(**进 dev 的 PR 只跑前两个**,见下面「提速的边界」),`fail-fast: false`(一条红不该让另外两条看不见)。每平台:`bun run typecheck` → `bun run depcheck` → 编译 `cli.ts` / `docs.ts` / `setup.ts` → 编译版 sidecar smoke → `bun run test`。
- **node · core suite** —— `npm run test:node`,同一套源码在 node 下再跑一遍。这条不是冗余:`bun:sqlite` 的 URI 打开方式、`bun:test` 的 import,在 Mac 上看着好好的,换个运行时就炸。本地复现就是 `npm run test:node`。
- **changes · paths** —— 一个只算一件事的小作业(`dorny/paths-filter`):这一推里 `apps/desktop/**` 动没动过。
- **e2e**(vitest e2e 配置)所有 PR 和 master 推送都跑,dev 的日常推送不跑。
- **desktop-e2e**(Playwright)master / PR 照旧跑;**dev 推送里只要动过 `apps/desktop/**` 也跑**(靠上面那个 `changes` 输出)。没动桌面的推送仍然跳过。本地要先跑一遍就是 `cd apps/desktop && bun x playwright test`,注意 4176 端口别被占。

## 提速的边界(2026-10-23)

一次 CI 原来约 20 分钟,长杆是 Windows(18 分钟,其余都在 9 分钟内)。三处提速,每处都有守卫(`scripts/ci-workflow.guard.test.ts`「提速的边界」):

- **只改 Markdown ⇒ 构建和测试整块跳过。**`changes` 作业的 `code` 输出:除 `*.md` 以外任何文件动过才是 true。没有测试读仓库里的 `.md`;以后有了,把那份文件从排除里拿出来。
- **不进 master 的 PR 不跑 Windows**(进 dev 的、叠在别的分支上的)。推 `dev`、进 `master` 的 PR、自改的 PR(head 是 `self/…`,没人盯、合完就部署)照旧三平台,发版前必须绿。代价:Windows 才有的问题合进 dev 后才看见 —— 推 dev 那次 CI 红了就补修复,不回退别人的提交。
- **同一个 PR 推了新版本,旧的那次作废**(`concurrency`,只对 PR)。推送一条都不取消:`ci triage --wait` 和自改闸门按提交看结果。

**叠起来的一串 PR**:整合者不用每层等一遍 PR CI。上层包含下层的全部改动,只看最上面那个 PR 的 CI(`pull_request` 不限 base,上层 PR 也有 CI;它的 `changes` 输出全部强制 true,因为 paths-filter 只看得见这一层);一条没跑的 rollup 不算绿;绿了按顺序合进 dev,合完推 dev 那一次(三平台)才是正式闸门。中间层 rebase 后被取消的运行不用重跑。

这一套是一条命令:`wechat-cc ci land <最上面那个 PR>`(在整合者自己的 detached worktree 里跑;`--dry-run` 先看认出的那一串)。它先记下每层旧 head、钉死最上面那个的 head 等 CI(非 skipped 至少 5 条全绿,只改文档的串给 `--min-checks 1`),再从下往上 `rebase --onto origin/dev <下层旧 head>` → tsc → 带租约推 → 改 base → `--match-head-commit` squash 合。停下来的情形(退出码):1 CI 红 / 2 前提不满足 / 3 head 或 dev 被人动过 / 4 rebase 冲突(已 abort,前面合了的留着)/ 5 超时;有兄弟 PR(两个叠在同一个下层上)第一版直接停。给的不是最上面那个(比如核心链一步一部署,只合 #598、#599 还叠在它上面)⇒ 只合到给的那层,上面的不动、不算兄弟;它们的 base 还指着合掉的分支,以后 `ci land <上面那个>` 接着来(起点从 force push 事件里找,找不到就 `--parent-old`)。等的那个 head 三分钟一条检查都没有 ⇒ 打一行「多半没触发 CI」和重触发的办法:`gh pr close N && gh pr reopen N`(改 base 紧接着 force push 时 GitHub 有时一条运行都不建,10-23 #599);十分钟还是没有才判红。合完照旧 `wechat-cc ci triage --wait --rerun` 看 dev 推送那一次。

bun 版本在 workflow 里**钉死**(`bun-version: 1.3.14`),不用 `latest` —— 上游发新版能让 CI 在没有任何提交的情况下自己变红。升 bun 该是一件有人盯着的事。

## Windows 排除清单的规矩

`vitest.config.ts` 里有一段 `process.platform === 'win32' ? [...] : []` 的排除列表。规矩只有一条:

> **任何一个套件,只要它依赖的 provider / 运行时在第一行就拒绝 win32,就必须加进那张清单。**

不加的后果不是「红一条」,而是这套件在 Windows 上一路等 spawn 超时,把整个作业拖到超时才死,报错还看不出原因。清单里现在有 codex app-server、两个 ACP 执行者套件、Claude 保留会话、mkfifo 夹具、git-review、几个 POSIX 路径的原生历史读取器。加的时候在旁边写清楚**为什么**这套件在 Windows 上测的只是「平台不支持」这个事实。

## 已知 flake 类别(不是你的锅)

**唯一事实源是 [`src/cli/ci-flakes.json`](../../src/cli/ci-flakes.json)**,`wechat-cc ci triage` 直接读它。下面这张表只是给人看的摘要,跟 JSON 对不上时**以 JSON 为准**。

| id | 症状 | 说明 |
| --- | --- | --- |
| `win-hook-timeout` | `Hook timed out in <N>ms`(限 `build · windows-latest`) | windows runner 磁盘 I/O 慢,没动过的工作台服务测试 `beforeEach` 超时 |
| `win-test-timeout` | `Test timed out in <N>ms`(限 `build · windows-latest`) | 同上,单条测试超时 |
| `probe-binary-version` | `probeBinaryVersion` | 探测外部 CLI 版本有 3s 上限,runner 负载高时探不完 |
| `econnreset-chunked` | `ECONNRESET`(限 `routes-workbench*.test.ts`) | 分块上传那条 socket 测试偶发 |
| `node-no-summary` | 作业红了但日志里既没有 FAIL 块也没有 `Test Files` 汇总行(限 `node · core suite`) | 进程收尾丢了汇总 |

## 处置

```bash
wechat-cc ci triage --wait --rerun          # 缺省看 HEAD
wechat-cc ci triage --sha <sha> --json      # 给机器看的一份
```

它替你做完了「拉日志 → 去 ANSI → 按文件分桶 → 对照登记表」这套:

- **失败测试的文件本轮动过**(`x.test.ts` 动了、或它对应的 `x.ts` 动了)⇒ 一律 `real`,**不重跑**。「本轮」= 从这条分支上一次绿的 commit 到这个 SHA(找不到上一次绿就退化成 `<sha>~1`)。
- 没动过、且症状对上登记表 ⇒ `flake`。给了 `--rerun` 就 `gh run rerun <id> --failed`,`--wait` 时等它跑完再判一次。
- **第二次仍红一律改判 `real`** —— 哪怕症状还对得上。连着两次红的 flake 就当真的看。
- **唯一的例外:Windows runner 卡死(`runner-stall`,2026-09-29 起)。** 三条同时成立才算:作业是 `build · windows-latest`;同一次运行里别的 `build · *` 都绿;至少三条 `Hook timed out` 挤在两秒之内。这时整条作业判一个 flake,**先于**「动过相关文件 / 重跑后仍红 ⇒ real」,并且多给一次重跑(`--max-reruns` + 1);还卡就报 flake(退出 3),不冒充 real 也不冒充 green。来历:09-28 #142、#145 两次 —— 后者是纯文档 PR,Windows 两连红,日志里同一秒六条 `Hook timed out in 40000ms`,第三跑绿。只看「同一秒批量超时」不够:一个改动让公共 setup 卡住,几个并行文件也会同一刻超时 —— 但那样 Linux / macOS 也会红,所以才要求兄弟构建都绿。
- 判不出来的是 `unknown`:打印证据片段,**不会自动重跑**。要么是新 bug,要么该往登记表里加一条(人/LLM 开 PR 的事,triage 自己不写)。
- **日志取不回来**(gh 抖一下、超时)也一律记 `unknown`,不会当成「作业红了但没有汇总行」那条 flake。空日志跟 `__NO_SUMMARY__` 长得一模一样,认错了就会把一条真红自动重跑掉。

退出码:

| 码 | 含义 |
| --- | --- |
| 0 | 绿 |
| 1 | 真红(`unknown` 也算 —— 没判明白就别放行) |
| 2 | 这个 SHA 上没有运行 / 还没跑完又没给 `--wait` / `gh` 出错(没登录、网络断)/ 开关写错了(没能去判,不是判出来真红) |
| 3 | 是已知 flake(可重跑但没重跑,或没给 `--rerun`) |

开关:`--sha`(缺省 HEAD)`--branch`(找「上一次绿」的分支,缺省当前分支)`--wait`(等运行出现,最多 2 分钟;再等它跑完,上限 `--timeout-min`,缺省 30)`--rerun` `--max-reruns N`(缺省 1;设 >1 只对 `__NO_SUMMARY__` 那类作业级 flake 有意义 —— 具体测试的失败第二轮一律判真红,再重跑也翻不过来)`--timeout-min N` `--json`。进度和诊断走 stderr,`--json` 的 stdout 是干净的一份 `TriageReport`。

要自己动手时,记住:`gh run list --commit <sha>` **要全 40 位 SHA**,短 sha 查不到任何东西 —— 而且是**安静地**返回空数组,看上去和「这次推送没有 CI」一模一样。(`ci triage` 自己先 `git rev-parse` 过,所以 `--sha 25113589` 是可以的。)

## 本地满载下反复红的那一批(2026-10-21 收口)

两路并行开发时本机负载常年 20–40,下面这些单跑全过、整套跑反复红(四轮里 1–8 次)。逐条摸过原因后按性质处理,**没有一律放宽超时**:

| 文件 | 卡在哪 | 处理 |
| --- | --- | --- |
| `settings-panel-workbench`(两条大文件)、`apps/mobile/continuation-materials`、`apps/mobile/attachments` | `toEqual` 比几百 KB 的 Buffer —— vitest 逐字节递归,700KB 空闲就 5.6s | 改 `Buffer#equals`(sha256 那条照留) |
| `lib/migration-order` | 每个锁定版本都从零重建库:O(n²) 次迁移 | 一个库按序迁移、每步取一次 schema(6.5s → 2.3s,锁定指纹全对) |
| `apps/desktop/.../cc-asset-kit` | 纯 JS 解约 50 张 512² PNG;一条测试校验三遍;另一条拿 `toEqual` 比 512² 的 alpha | 校验一遍;四份改过的整套那条给 60s;alpha 改 `Buffer.compare` |
| `lib/timeout-fetch`(流一直在动就不掐) | 真时钟:每 10ms 一块对 idle 30ms,满载下一个 10ms 定时器迟到就被掐 | 假时钟推进(仍是 60ms > 30ms,证明每块都重置;把 idle 调到 5ms 它就红) |
| `guard/owner-table` | 墙钟断言「国内调用 < 60ms」 | 改成跟 0ms 定时器赛跑(首次探测等 10 分钟的运行时里,不等探测的路径永远先出来) |
| `core/acp/rpc` | harness 给每条都设 50ms 的 RPC 期限 | 缺省 10s,只有测超时那条传 50ms |
| `reminders/reminders.e2e` | `waitForReplyTo` 缺省 5s 要盖一次真 daemon 启动 | 30s |
| `bootstrap/openai-plugin-stall` | 3s 启动预算同时管卡住的插件和必需的 wechat MCP | 10s(生产是 20s) |
| `workbench/wechat-create`、`workbench/service-entry` | `settle` 用缺省 10s poll 等真 git 整轮 | 同 `service-one-session`:testTimeout 60s、settle 30s、until 45s |
| e2e(`__e2e__/*`,每个文件第一条) | 冷启动 import 整个 daemon 超过 e2e 的 10s;boot-failure-lock 还因此串台(上一条超时后迟到的 finally 改回环境变量) | e2e testTimeout 30s;boot-failure-lock 预热放 beforeAll、环境变量在 afterEach 还原 |
| `scripts/cli-help.guard`(`plugin --help` 等;只读命令 `cli status` 等) | 一条测试里同步冷启 1 + 子命令个 `bun cli.ts`;只读命令自己还要挨个跑各家 CLI 的 `--version` | 每族 60s(每次 spawn 仍 15s 上限);只读命令单次 45s、每条 60s |
| `workbench/codex-app-server`(两条) | **生产 bug**:关闭循环先查期限再发 SIGKILL,一次卡顿就抛 `codex_process_not_exited` 而一次 SIGKILL 都没发 | 单独 PR 修生产代码 |
| `workbench/service-one-session`(f99.txt) | **生产**:`git-review.ts` 的审阅期限写死 15s,忙时报告悄悄缺文件 | 交工作台那一路:做成可注入 |
| `workbench/service-rewind`(eol) | 偶发 `rewind_unavailable`,疑似 settle 没等后台 git | 交工作台那一路:先把 reason 打出来 |

**以后这里面哪条再在满载下红,先当新问题看**(上面的病因已经拿掉了);不在表里的,按同样的三类去摸:墙钟断言 ⇒ 注入时钟 / 赛跑;等完成的期限 ⇒ 只给那一处放宽或给旋钮;真吃 CPU ⇒ 先找自找的开销(大对象 `toEqual`、重复计算),再考虑单独串行。

## 怎么加一条 flake

往 `src/cli/ci-flakes.json` 的 `entries` 里加一条:

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 全表唯一,报告里就印这个(`→ flake:win-hook-timeout`) |
| `symptom` | ✓ | **正则**,对失败块的文本匹配。特殊值 `__NO_SUMMARY__` = 「作业红了但日志里既没有 FAIL 块也没有 `Test Files` 汇总行」,这种条目必须同时给 `jobs` |
| `jobs` | | 限定作业名(`build · windows-latest` / `node · core suite`),不给 = 所有作业 |
| `files` | | 限定失败测试的文件,glob(只支持 `*` 和 `**`),不给 = 所有文件 |
| `note` | ✓ | 为什么这是 flake。写给三个月后的自己看 |
| `since` | ✓ | 头一次见到的日期 |

然后跑契约测试(id 唯一、正则能编译、`note`/`since` 都在):

```bash
bun x vitest run src/cli/ci-flakes.test.ts
```

**范围写窄一点**。`symptom` 越泛、`jobs`/`files` 越空,越容易把一个真 bug 盖成 flake —— 而盖住之后没有任何人会发现。

## 合并纪律

- 开发在独立分支和 worktree 中完成,由指定整合者串行合入 `dev` 并验证、部署、推送;详见[协作规则](README.md#多-agent-协作)。`dev → master` **只走 PR,且只用 squash merge**。
- `delete_branch_on_merge` 的取值会被改动,每次合并前重新确认一次。
- CI 红着不合;flake 也要重跑到绿再合,不要口头宣布「这是 flake」—— 让 `wechat-cc ci triage --wait --rerun` 说,退出码 0 才算绿。
