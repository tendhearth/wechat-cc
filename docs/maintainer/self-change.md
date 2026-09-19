# 让 CC 自己改自己

`wechat-cc self change "<需求>"` 让 CC 在**自己的专用克隆**里起一个 Claude 执行者实现改动,依次过五道闸门(本地测试 → 独立评审 → 真 CI → 主人在微信拍板 → 合进 `dev`),然后在 daemon 之外做 `self deploy` + 真机自检,不过就把二进制回滚,全程进展发到主人微信。

设计见 [`docs/superpowers/specs/2026-09-18-self-change-pipeline-design.md`](../superpowers/specs/2026-09-18-self-change-pipeline-design.md)。

## 命令

```bash
wechat-cc self change "在 ci-and-flakes.md 的 flake 表里加一行 …"   # 跑一条
wechat-cc self change "…" --no-deploy                               # 只合 dev,不部署不自检
wechat-cc self change "…" --budget-usd 8 --json                     # 压预算 + 机器可读输出
wechat-cc self change --list                                        # 最近 10 条
wechat-cc self change --resume 3f2a91bc                             # 接着跑(拍板超时之后会重发卡)
wechat-cc self change --unhalt                                      # 解除停机
```

| 开关 | 作用 |
| --- | --- |
| `<需求>`(位置参数) | 需求原文。新起一条时必填;`--resume` 时不要传(需求在存盘里) |
| `--resume <id>` | 从存盘的 `step` 接着跑。id 来自 `--list`。没有这条 ⇒ 退 1 |
| `--list` | 列最近 10 条:`id · 步骤 · 结果 · 起始时间`。`--json` 给数组 |
| `--unhalt` | 清 `halted_at` / `halt_reason`,`fail_streak` 归零(见「停机」) |
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
2. **tests** —— 在克隆里依次 `bun run typecheck` → `bun run depcheck` → `bun run test` → `npm run test:node -- --reporter=dot`,第一条红就停(后面几条在同一个坏状态上跑没有信息量)。
3. **review** —— **新会话**的只读 `claude -p`(`--disallowedTools Edit,Write,MultiEdit,NotebookEdit`),要一份 `{ verdict, findings }` 的 JSON。`critical` / `important` ⇒ 修复轮;只剩 `minor` 或 `approve` ⇒ 过,minor 带进拍板卡。评审会话要是动了工作树,流水线会还原,并**直接按 `changes` 算**。
4. **ci** —— 推 `self/<id>`,进程内调 `ci triage --wait --rerun`。绿才过;已知 flake 由 triage 重跑,第二次仍红一律真红。
5. **approval** —— 拍板卡发到主人微信(需求、分支、diffstat、测试摘要、评审 verdict、CI 链接、费用),回「y <码>」才合。`n` ⇒ 退 3;超时(缺省 24 小时)⇒ 退 4,`--resume` 会重发卡。

过了五道才 `git rebase` + `--ff-only` 合进 `dev` 并推上去,然后构 sidecar、`self deploy`、`selftest workbench` + `selftest chat`。自检红 ⇒ 二进制回滚到 `.prev`,**但代码已经在 `dev` 上了** —— 报告里会明说这件事,需要人去改好或 revert。

## 修复轮上限

`tests` / `review` / `ci` 三处**各自独立**计数,各最多 **2 轮**。失败原文(去 ANSI、尾巴 200 行)`--resume` 交回同一个实现会话,修完**一律跳回 guard** 重走四道闸门 —— 执行者修的时候可能顺手碰了禁改清单,不重过 guard 等于护栏有个后门。

超了就是 `tests_exhausted` / `review_exhausted` / `ci_exhausted`,分支保留供人看。

## 退出码

| 码 | 含义 | 典型 result |
| --- | --- | --- |
| 0 | 完成 | `done` |
| 1 | 这次改动没做成 | `implement_failed` `no_changes` `forbidden_paths` `tests_exhausted` `review_exhausted` `ci_exhausted` `merge_conflict` `deploy_failed` `selftest_failed_rolled_back` `crashed` |
| 2 | **不是这次改动的错**,重试同样的需求没意义 | 非 macOS、`self_change_halted`、`self_change_quota`、`daemon_not_running`、`owner_chat_unknown`、`self_change_busy`、`repo_url_unknown` |
| 3 | 主人回了 `n` | `declined`(分支保留) |
| 4 | 没等到拍板 | `approval_timeout`(`--resume <id>` 重发卡) |

## 停机与 `--unhalt`

部署或自检**连续失败两次** ⇒ 往 `agent-config.json` 的 `self_change.halted_at` / `halt_reason` 写一笔,并在微信里说一声。之后每条自改在 intake 就被拒(`self_change_halted`,退 2)。

再自动跑下去只会把机器越推越坏 —— 所以解除必须是人做的:

```bash
wechat-cc self change --unhalt     # 清 halted_at / halt_reason,fail_streak 归零
```

`fail_streak` 在一次完整成功(自检全绿)之后自己归零。

## 禁改清单

代码常量,**不是配置**(`src/cli/self-change/policy.ts`)。能改它的只有人,不能是「跑在 `--dangerously-skip-permissions` 下的执行者顺手把护栏拆了」。

| 文件 | 为什么 |
| --- | --- |
| `.github/workflows/publish-update.yml` `mirror-desktop-tag.yml` `desktop.yml` | 能把二进制发到所有用户机器上 |
| `scripts/publish-update*.ts` `scripts/update-hosting.json` | 同上(发版脚本与更新源) |
| `apps/desktop/src-tauri/tauri.conf.json` | 签名与更新源配置 |
| `src/cli/self-change/policy.ts` | 护栏本身(清单和缺省值) |
| `src/cli/self-deploy.ts` | 出事之后把机器救回来的那条路(回滚配方) |

需求确实需要动这几个文件时,只能人来改。

## 费用

| 配置 | 缺省 | 说明 |
| --- | --- | --- |
| `implement_budget_usd` | 20 | 实现会话的 `--max-budget-usd`。注意这是**每次调用**的封顶,不是整条的总额:修复轮虽然 `--resume` 回同一个会话,但每一轮各自按这个数封顶(最坏情况 = 实现 1 轮 + 三处各 2 轮修复) |
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
    "approval_timeout_h": 24,
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
| 专用克隆 | `<workdir>/repo`,缺省 `~/Library/Caches/wechat-cc/self-change/repo` |
| 给执行者的那份交代 | `<workdir>/briefs/<id>.md` |

克隆**刻意不在 `STATE_DIR` 下面**:执行者在 `--dangerously-skip-permissions` 下跑,不能离 `access.json` 和钥匙只有一个 `..`;也不在 tmpdir(克隆要跨次复用,不能被系统清掉)。

## 微信里怎么用

主人在微信里直接说(admin 命令,别人说了不算):

```
自改 在 ci-and-flakes.md 的 flake 表里加一行 …
自改 状态
```

daemon 收到之后 spawn 一个 detached 的 `wechat-cc self change --from wechat --json "<需求>"`,回一句「自改开始了」,之后每一步的进展、拍板卡、收尾报告都发到同一个会话。拍板就是回「y <码>」/「n <码>」,和权限卡是同一套。

`自改 状态` 列最近 5 条的 `#id · 步骤 · 结果`。要更细的(费用、CI 链接、失败原文)去终端 `wechat-cc self change --list` 或直接读存盘。

## 已知限制

- **rebase 之后不重跑 CI。** 合入前会 `git rebase origin/dev`,动了 HEAD 也不重跑 —— `dev` 上并发提交少,重跑要主人再等一轮。代价是 `ci_sha ≠ merge_sha`,报告里会单独说一句。
- **一次只跑一条。** 第二条进来直接 `self_change_busy` 退 2。
- **只支持 macOS。** 最后两步踩的是 launchd(`self deploy`)和真机自检,其他平台在第一行就退 2。
- **打包版必须配 `self_change.repo_url`。** 打包版身边没有 checkout 可问 `git remote get-url origin`,配不上就 `repo_url_unknown` 退 2。
- **执行者只有 `claude`。** Codex / Cursor / agy 的口子留着(`ImplementRunner`),v1 没接。
- **桌面工作台面板看不到这个会话**(`claude -p` 是流水线自己起的进程)。补偿是 `~/.claude/settings.json` 里装的 `wechat-cc hook` 照常把会话完成推到微信,`看 <码>` 也能用。
