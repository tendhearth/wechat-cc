# 让 CC 自己改自己

`wechat-cc self change "<需求>"` 让 CC 在**这条运行自己的 git 工作树**里起一个 Claude 执行者实现改动,依次过五道闸门(本地测试 → 独立评审 → 真 CI → 主人在微信拍板 → 合进 `dev`),然后在 daemon 之外做 `self deploy` + 真机自检,不过就把二进制回滚,全程进展发到主人微信。

设计见 [`docs/superpowers/specs/2026-09-18-self-change-pipeline-design.md`](../superpowers/specs/2026-09-18-self-change-pipeline-design.md)。

## 命令

```bash
wechat-cc self change "在 ci-and-flakes.md 的 flake 表里加一行 …"   # 跑一条
wechat-cc self change "…" --no-deploy                               # 只合 dev,不部署不自检
wechat-cc self change "…" --budget-usd 8 --json                     # 压预算 + 机器可读输出
wechat-cc self change --list                                        # 最近 10 条
wechat-cc self change --resume 3f2a91bc                             # 接着跑(拍板超时之后会重发卡)
wechat-cc self change --unhalt                                      # 解除停机
wechat-cc self change --approve 3f2a91bc                            # 在终端替它拍「放行」(微信卡没送到时)
wechat-cc self change --deny 3f2a91bc                               # 在终端拍「拒绝」
```

| 开关 | 作用 |
| --- | --- |
| `<需求>`(位置参数) | 需求原文。新起一条时必填;`--resume` 时不要传(需求在存盘里) |
| `--resume <id>` | 从存盘的 `step` 接着跑。id 来自 `--list`。没有这条 ⇒ 退 1 |
| `--list` | 列最近 10 条:`id · 步骤 · 结果 · 起始时间`。`--json` 给数组 |
| `--unhalt` | 清 `halted_at` / `halt_reason`,`fail_streak` 归零(见「停机」) |
| `--approve <id>` / `--deny <id>` | 替停在 `approval` 的那条拍板(和微信「y / n」、桌面权限卡是同一个 consume)。和 `<需求>` / `--resume` / `--list` / `--unhalt` 互斥。拍成了退 0,hash 过期或已被拍过退 1。见「微信不通时怎么拍板」 |
| `--from cli\|wechat` | 进件口,缺省 `cli`。daemon 从微信接单时传 `wechat`,只进存盘、不改行为 |
| `--budget-usd N` | 这一条的**实现**预算上限,美元。覆盖 `self_change.implement_budget_usd` |
| `--no-deploy` | 合完 `dev` 就收工:不构 sidecar、不换 inode、不自检 |
| `--json` | 打整份 state(不是人读摘要) |

## 五道闸门

```
intake ─► repo ─► implement ─► guard ─► tests ─► review ─► push+ci ─► approval ─► merge ─► deploy ─► selftest ─► report
                     ▲            │ fix ◄──┘ fix ◄──┘    fix ◄──┘
                     └────────────┴────────────────────────┘
```

1. **guard(禁改清单)** —— 改动碰了下面那张表里的文件,整条**立刻失败**,不给修复轮。这是护栏,不是意见。
2. **tests** —— 在工作树里依次 `bun run typecheck` → `bun run depcheck` → `bun run test` → `npm run test:node -- --reporter=dot`,第一条红就停(后面几条在同一个坏状态上跑没有信息量)。
3. **review** —— **新会话**的只读 `claude -p`(`--disallowedTools Edit,Write,MultiEdit,NotebookEdit`),要一份 `{ verdict, findings }` 的 JSON。`critical` / `important` ⇒ 修复轮;`approve` 且只剩 `minor` ⇒ 过,minor 带进拍板卡。判了 `changes` 却一条 `critical` / `important` 都列不出来的,**照样算一轮修复轮**(说要改又说不出哪里要改,不该当成放行)。评审会话要是动了工作树,流水线会还原,并**直接按 `changes` 算**。
4. **ci** —— 推 `self/<id>`,进程内调 `ci triage --wait --rerun`。绿才过;已知 flake 由 triage 重跑,第二次仍红一律真红。triage 退 2(压根没有运行 / 等超时 / `gh` 没登录)⇒ `ci_unavailable`,**不进修复轮** —— 交给执行者修一个它看不见的 CI 是白烧预算,这条要人去看。
5. **approval** —— 拍板卡发到主人微信(需求、分支、**执行者最后那段交代**、diffstat、测试摘要、评审 verdict、CI 链接、费用),回「y <码>」才合。`n` ⇒ 退 3;超时(缺省 24 小时)⇒ 退 4,`--resume` 会重发卡。daemon 回的 `delivered` 说的是**卡片有没有进微信**:`false` 时条目照样在登记处等着(存盘里记成 `approval.delivered: false`),流水线照常轮询,只是会在终端和微信各说一句「换个面拍」—— 见下一节。

过了五道才 `git rebase origin/dev` + **快进 push**(`git push origin HEAD:refs/heads/dev`,不带 `--force` —— 普通 push 天然只许快进,语义和 `merge --ff-only` 一样;被拒就是远端在这中间前进了 ⇒ `merge_conflict`)合进 `dev`,然后构 sidecar、`self deploy`、`selftest workbench` + `selftest chat`。工作树里**不 `checkout dev`**:git 不许同一条分支在两棵树里检出,而且也不需要 —— rebase 完 HEAD 本身就是 `origin/dev` 的直系后代。自检红 ⇒ 二进制回滚到 `.prev`,**但代码已经在 `dev` 上了** —— 报告里会明说这件事,需要人去改好或 revert。

**一次运行,一个工作树。** `<workdir>/repo` 只是**中枢克隆**:只用来 `fetch` 和管工作树,不在里面构建、不在里面 checkout 业务分支。每条运行 `git -C <hub> worktree add -B self/<id> <workdir>/runs/<id> origin/<branch>`(`-B` 而不是 `-b`:同名分支照样丢掉重开,省掉一条每轮都注定失败一次的 `branch -D`),之后 implement / guard / tests / review / ci / merge / deploy 全在这棵树里跑。以前所有运行共用一个克隆(每次 `checkout -B` + `reset --hard`),B 的 `repo` 步会在 A 的树底下把文件换掉 —— 2026-09-21 审查 #4 就是这个类。

**构建之前只剩一条断言。** 上一轮给「共用克隆」打的补丁(部署前 `fetch` + `merge-base --is-ancestor` + `checkout`/`reset --hard`/`clean -fd` 把克隆钉回批准的那条提交,再验一遍)**整条删掉**了:一棵树只有一条运行在用,没有别人能动它。现在 `deploy` 只问两句话:`HEAD == merge.sha`、`status --porcelain` 干净。工作树整个不在了(人手工删过、被顺手清理过)⇒ 先 `git -C <hub> worktree prune`(目录没了但中枢里还登记着,不 prune 的话 `worktree add` 直接拒绝)再 `worktree add --detach <workdir>/runs/<id> <merge.sha>` 重开一个、`bun install --frozen-lockfile` 补上依赖,然后照样断言。对不上、重开不出来(比如批准的那条被 force-push 抹了)、或者存盘里压根没记 `merge.sha` ⇒ `deploy_tree_mismatch`,退 1,不构建不部署;这不算「机器坏了」,所以不推 `fail_streak`、不停机 —— 正因为它不会自动重来,通知里会写明「把 `self_change.workdir` 下的 `runs/<id>` 整个删掉(下一次会按批准的那条提交重开一个)之后 `wechat-cc self change --resume <id>`」。真换上去的那条记在 `deploy.sha` 里(构建出来没装上去的不算)。

**清理是机会性的,门是「还有没有人可能接着跑」。** 每条运行的 `repo` 步开头顺手做一次:`git -C <hub> worktree prune`,再把**结局是 `done` 或 `declined`、且 `updatedAt` 超过 24 小时**的那几条运行(`StateStore.list()` 列得出来)的 `runs/<id>` 用 `worktree remove --force` 删掉。

门**不是「收场了没」**:`approval_timeout` / `ci_unavailable` / `merge_conflict` / `tests_exhausted` / `deploy_failed` 都有结局,但它们全是 `--resume` 能接着跑的。而 `--resume` 是从 `state.step` 起步的,只有 `deploy` 会重开工作树 —— 扫掉一条停在 `approval` 的树,`--resume` 的第一条 git 就在一个不存在的目录里 spawn,拿到的只是一句 ENOENT;`refs/heads/self/<id>` 还在中枢里,但没有一条命令能把那轮花过钱的实现接回来(走 `repo` 步会重开分支,等于把它扔掉)。所以只有 `done`(装上去了)和 `declined`(主人回了 n)这两种**不可恢复的终局**能扫。

代价是别的失败码的树会留在盘上(磁盘泄漏),这是**有意的取舍**:宁可占着盘,也不能把一轮付过钱的实现扫掉;回收它们的活记在 backlog 里。清理失败只记一笔,绝不把新的一条判红。

**回滚之后盘上写的是「现在跑的是什么」。** 自检红、二进制换回 `.prev` ⇒ `deploy.ok=false`、`deploy.version=null`、`deploy.rolledBack=true`,并且**步退回 `deploy`**。老代码把步留在 `selftest`、`deploy.ok` 还留着 `true`,`--resume` 于是对着那个已经被换回去的旧二进制再跑一遍自检 —— 旧的当然绿,报告就写「部署:绿」、`fail_streak` 清零,而机器上根本没有这条改动(审查 #8)。恢复一条收在 `deploy_failed` / `selftest_failed_rolled_back` 的,一律重新构建、重新部署、再自检。

自检的 `--resume` 那一步(`POST /v1/workbench/continue`)会**吞掉那个转瞬即逝的 409 `workbench_busy`**:每秒重试一次、最多 10 次,还不通才算真红。2026-09-18 真机(`f65f4c09`)第一次撞见这个红:`resume_replied` 是整场自检**唯一**一条红,就这么把一次本来好好的部署回滚掉了——当时的成因是旧租约模型下「答复已释放租约、差异快照还在截」的那一瞬(`acquireTurnLease`)。2026-09-21「一个文件夹一个会话」把那整套租约模型删掉了,那个 409 窗口不复存在。这段重试是历史残留,留着当便宜的保险;删掉它要另跑一轮 selftest 验证,这一波没做。

## 微信不通时怎么拍板

微信外发是会整个不通的(2026-09-18 真机:`ilink/sendmessage errcode=-2: prepare failed`,一条实现 / 测试 / 评审 / CI 全绿的自改就这么白等到 `approval_timeout`)。所以拍板卡**送不出去也不会把待批条目撤掉** —— 同一条 hash 还有两个面能拍,从哪边拍都算数(都是同一个 `PendingPermissions.consume`):

* **桌面权限卡** —— 桌宠那张卡照常弹,点就行(`POST /v1/permissions/resolve`)。
* **终端** —— `wechat-cc self change --approve <id>`(或 `--deny <id>`)。id 用 `wechat-cc self change --list` 看,停在这一步的那条会显示 `等拍板 <hash 前 8 位>`。

发不出去时流水线会在终端 `log` 并且试着往微信发一句:

```
微信卡没送到(外发不通);桌面权限卡或终端 wechat-cc self change --approve <id> 都能拍板
```

这句话本身多半也送不到(同一条外发链路)—— 但跑流水线的那个终端看得见,而终端正是另一个拍板口。

`--approve` / `--deny` 只在这条停在 `approval` 且还没收场时管用;别的步骤会直接告诉你它停在哪儿并退 1。

## 修复轮上限

`tests` / `review` / `ci` 三处**各自独立**计数,各最多 **2 轮**。失败原文(去 ANSI、尾巴 200 行)`--resume` 交回同一个实现会话,修完**一律跳回 guard** 重走四道闸门 —— 执行者修的时候可能顺手碰了禁改清单,不重过 guard 等于护栏有个后门。

超了就是 `tests_exhausted` / `review_exhausted` / `ci_exhausted`,分支保留供人看。

## 修复轮的范围纪律

2026-09-18 真机(`f65f4c09`)那条自改的需求是一句「只改这一个文件」的文档改动。整套测试在满载的机器上超时红了一次(跟这次改动毫无关系),修复轮里执行者顺手改了 **10 个文件** —— 把 vitest 的超时从 5s 放宽到 20s,再加夹具和三个测试;评审看见了却只记成一条 `minor`,于是这份 **$10** 的「修复」合进了 `dev`。两条规矩从此写死在流水线里:

* **抖动先重跑,不交给执行者修。** tests 闸门里某条命令红了,先算两件事:输出里 `FAIL <某个>.test.ts` 的那些文件,和这一轮改过的文件(`git diff --name-only origin/<branch>...HEAD`,`x.test.ts` 也算 `x.ts` 的红)。一个都不沾边就**原样重跑一次**:绿了记一笔 `tests.flakes`(存盘里、拍板卡和收尾报告上都有一行「测试抖动重跑:…」)接着往下走,还红才进修复轮。红的文件本来就跟改动有关的,一次都不重跑,立刻进修复轮。`git diff` 问不出来时当「有关」,宁可白走一轮也不把真红当抖动。
* **一条 FAIL 都解析不出来时分两种。** `bun run test` / `npm run test:node` 那两条当抖动(整套被超时或 OOM 杀掉就是这个样子,输出里没有任何指向这次改动的证据),重跑一次;`typecheck` / `depcheck` 直接进修复轮 —— 它们的红是确定性的,没有 FAIL 行只是因为它们不长那个样子,重跑只是白等。
* **越界的文件是还原,不是修。** 评审的提示词里明说:改动里有需求用不到的文件(尤其是与需求无关的测试超时、`vitest` 配置、别处的夹具)要报 `important`,`summary` 以 `scope:` 开头;**为这次改动新增 / 调整的测试与夹具属于需求范围,不算越界**。流水线看到带 `scope:` 的 `important`,交回执行者的就不是普通的修复说明,而是一条「把这几个文件 `git checkout origin/<branch> -- …` 还原掉再提交」的指令 —— 让它去「修」那些文件等于让它接着改。
* **还原清单是校验过的,而且不吞别的意见。** 评审报的那个文件名要和执行者**真改过的文件**对得上(`git diff --name-only` 求交集)才会进还原清单:「scope:与需求无关」这种取不出文件名的、或者评审自己想出来的路径,一律丢掉;丢完空了就退回普通的修复提示词(没有文件列表的 `git checkout -- ` 会把整棵树还原掉)。同一轮里别的 `critical` / `important` 在提示词里单起一节照常要修 —— 只还原不修的话,下一轮评审会把它们原样打回来。
* 实现那份交代和 tests 的修复说明里也各有一段范围纪律:改动范围 = 需求需要的文件;顺手修别的要单独说明;**绝不**为了让测试变绿而放宽阈值。

## 退出码

| 码 | 含义 | 典型 result |
| --- | --- | --- |
| 0 | 完成 | `done` |
| 1 | 这次改动没做成 | `implement_failed` `no_changes` `forbidden_paths` `tests_exhausted` `review_exhausted` `ci_exhausted` `ci_unavailable` `merge_conflict` `deploy_failed` `deploy_tree_mismatch` `selftest_failed_rolled_back` `crashed` |
| 2 | **不是这次改动的错**,重试同样的需求没意义 | 非 macOS、`self_change_halted`、`self_change_quota`、`daemon_not_running`、`owner_chat_unknown`、`self_change_busy`、`repo_url_unknown` |
| 3 | 主人回了 `n` | `declined`(分支保留) |
| 4 | 没等到拍板 | `approval_timeout`(`--resume <id>` 重发卡) |

## 停机与 `--unhalt`

部署或自检**连续失败两次** ⇒ 往 `agent-config.json` 的 `self_change.halted_at` / `halt_reason` 写一笔,并在微信里说一声。之后每条自改在 intake 就被拒(`self_change_halted`,退 2)。

**恢复也过这道门。** `--resume <id>` 是从存盘的 `step` 起步的,停机期间恢复一条停在 `deploy` 的自改,老代码会照样构建、照样部署(2026-09-21 审查 #9)。现在只要 `halted_at` 还在,不管存盘停在哪一步,`--resume` 一律当场收在 `self_change_halted`(退 2):不跑步骤、不碰 git、不构建、不部署,不推 `fail_streak`,**也不动存盘**(被挡下的这一次等于没跑过 —— 盘上的 `step` / `result` / `approval` 原样留着,`--unhalt` 之后再恢复才接得上「回滚过的要重新部署」那条)。停机的意思是「先别自动动这台机器」,不是「先别开新的」——**`--unhalt` 是唯一的出口**。

再自动跑下去只会把机器越推越坏 —— 所以解除必须是人做的:

```bash
wechat-cc self change --unhalt     # 清 halted_at / halt_reason,fail_streak 归零
```

`fail_streak` 在一次完整成功(自检全绿)之后自己归零。

## 禁改清单

代码常量,**不是配置**(`src/cli/self-change/policy.ts`)。能改它的只有人,不能是「跑在 `--dangerously-skip-permissions` 下的执行者顺手把护栏拆了」。

| 文件 | 为什么 |
| --- | --- |
| `.github/workflows/**`(整个目录) | 发版通道就在里面(`publish-update.yml` `mirror-desktop-tag.yml` `desktop.yml`),能把二进制发到所有用户机器上;按确切路径列会漏掉新加的那个 |
| `package.json` | `scripts` 里的 `typecheck` / `depcheck` / `test` 就是 tests 那道闸门的定义 —— 一条 `"test": "true"` 能让它变成橡皮图章 |
| `scripts/publish-update*.ts` `scripts/update-hosting.json` | 发版脚本与更新源 |
| `apps/desktop/src-tauri/tauri.conf.json` | 签名与更新源配置 |
| `src/cli/self-change/policy.ts` | 护栏本身(清单和缺省值) |
| `src/cli/self-deploy.ts` | 出事之后把机器救回来的那条路(回滚配方) |

**唯一的例外**(`FORBIDDEN_EXCEPTIONS`,确切路径的白名单):

| 文件 | 为什么放行 |
| --- | --- |
| `.github/workflows/ci.yml` | 它只决定**这次改动自己**要过哪些检查,不是发版通道;改坏了下一次 CI 立刻红给人看。整个目录关死等于自改永远碰不了自己的测试矩阵 |

需求确实需要动别的文件时,只能人来改。

## 费用

| 配置 | 缺省 | 说明 |
| --- | --- | --- |
| `implement_budget_usd` | 20 | 实现侧的**总额**:实现那一轮加上后面所有修复轮合起来最多花这么多。每一轮 `--resume` 拿到的 `--max-budget-usd` 是「总额减去已经花掉的」(花超了仍留 1 刀,好让那一轮把话说完)。评审另算,见 `review_budget_usd` |
| `review_budget_usd` | 5 | 评审会话(新会话、只读) |
| `max_turns` | 300 | 兜底,真正管钱的是预算 |
| `max_per_day` | 5 | 每天最多几条(按存盘目录里当天的记录数),超了 `self_change_quota` 退 2 |

`--budget-usd N` 只覆盖**实现**那一份。实际花掉多少写在 state 的 `implement.costUsd` / `review.costUsd`,也印在拍板卡和收尾报告里。

## `--no-deploy`

合完 `dev` 就收工:不 `build-sidecar`、不换 inode、不自检、不碰 `fail_streak`。用在「只想让 CC 把代码提上去,部署我自己挑时间」的场景 —— 报告里会写一行「部署:按 `--no-deploy` 未部署」。

## 配置

`agent-config.json`(`$STATE_DIR/agent-config.json`)的 `self_change`,全部可选:

```jsonc
{
  "self_change": {
    "repo_url": "git@github.com:…/wechat-cc.git",  // 缺省:源码模式问 git remote get-url origin
    "branch": "dev",
    "workdir": "~/Library/Caches/wechat-cc/self-change",
    "implement_budget_usd": 20,
    "review_budget_usd": 5,
    "max_turns": 300,
    "max_per_day": 5,
    "approval_timeout_h": 24,             // 掐在 [1, 48] 小时:daemon 的拍板卡只认这个范围,写 72 会被按 48 算并提示一句
    "selftest_executor": "claude",   // 部署后自检用哪个执行者 / provider
    "selftest_provider": "claude"
  }
}
```

`halted_at` / `halt_reason` / `fail_streak` 也在这块里,由流水线自己写,人只用 `--unhalt` 碰。

## 文件都在哪儿

| 东西 | 位置 |
| --- | --- |
| 每条自改的存盘 | `$STATE_DIR/self-change/<id>.json`(缺省 `~/.claude/channels/wechat/self-change/`,0600 —— 里面有需求原文和会话 id) |
| 「一次只跑一条」的锁 | `$STATE_DIR/self-change/lock`(写着持有者 pid;持有者死了会被下一条抢过来) |
| 中枢克隆(只 fetch / 管工作树) | `<workdir>/repo`,缺省 `~/Library/Caches/wechat-cc/self-change/repo` |
| 每条运行自己的工作树 | `<workdir>/runs/<id>`(终局满 24 小时后由下一条运行顺手删) |
| 给执行者的那份交代 | `<workdir>/briefs/<id>.md` |

这些**刻意不在 `STATE_DIR` 下面**:执行者在 `--dangerously-skip-permissions` 下跑,不能离 `access.json` 和钥匙只有一个 `..`;也不在 tmpdir(中枢克隆要跨次复用,不能被系统清掉)。

## 微信里怎么用

主人在微信里直接说(admin 命令,别人说了不算):

```
自改 在 ci-and-flakes.md 的 flake 表里加一行 …
自改 状态
```

daemon 收到之后 spawn 一个 detached 的 `wechat-cc self change --from wechat --json -- "<需求>"`(`--` 不能省:需求以 `-` 开头会被当成开关,「自改 --unhalt」曾能静默解除停机),回一句「自改开始了」,之后每一步的进展、拍板卡、收尾报告都发到同一个会话。拍板就是回「y <码>」/「n <码>」,和权限卡是同一套。

`自改 状态` 列最近 5 条的 `#id · 步骤 · 结果`。要更细的(费用、CI 链接、失败原文)去终端 `wechat-cc self change --list` 或直接读存盘。

## 已知限制

- **工作树只回收两种终局:`done` 与 `declined`。** 其余的终局——`approval_timeout` / `ci_unavailable` / `merge_conflict` / `tests_exhausted` / `deploy_failed`,这些都还能 `--resume` 接着跑——以及压根没跑完就被杀掉的运行(`result` 永远是 `null`,比如进程被强杀、机器意外重启),它们的 `runs/<id>` 目前**永不回收**,磁盘随运行次数单调增长(`bun install` 的 `node_modules` 是 CoW 链接,占块不大,但目录数只增不减)。这是有意的取舍:宁可占着盘,也不能把一轮已经花过钱的实现扫掉;回收它们缺一个显式的"这条我不接了"的入口(比如一条主动作废某条运行的命令),目前还没有做。
- **rebase 之后不重跑 CI。** 合入前会 `git rebase origin/dev`,动了 HEAD 也不重跑 —— `dev` 上并发提交少,重跑要主人再等一轮。代价是 `ci_sha ≠ merge_sha`,报告里会单独说一句。
- **一次只跑一条。** 第二条进来直接 `self_change_busy` 退 2。
- **只支持 macOS。** 最后两步踩的是 launchd(`self deploy`)和真机自检,其他平台在第一行就退 2。
- **打包版必须配 `self_change.repo_url`。** 打包版身边没有 checkout 可问 `git remote get-url origin`,配不上就 `repo_url_unknown` 退 2。
- **执行者只有 `claude`。** Codex / Cursor / agy 的口子留着(`ImplementRunner`),v1 没接。
- **桌面工作台面板看不到这个会话**(`claude -p` 是流水线自己起的进程)。补偿是 `~/.claude/settings.json` 里装的 `wechat-cc hook` 照常把会话完成推到微信,`看 <码>` 也能用。
- **微信外发不通时拍板卡送不到**(`ilink/sendmessage errcode=-2`)。登记项不会被撤掉,用桌面权限卡或终端 `wechat-cc self change --approve <id>` 都能拍板 —— 2026-09-19 真机验证过。详见「微信不通时怎么拍板」。
