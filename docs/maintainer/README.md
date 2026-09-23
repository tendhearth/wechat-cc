# 维护者手册

给**维护这个仓库的 LLM**(也包括 CC 自己)看的一页索引。目标:任何一个新来的模型不靠人类的口头知识,也能跑完「改 → 验 → 部署 → 再验 → 推 → 看 CI」。

## 协作规则入口

以根目录 [AGENTS.md](../../AGENTS.md#三条硬规矩) 为准:各自分支和工作区开发,单一整合者合入 `dev`;`master` 仍只接受 squash PR。

## 多 agent 协作

两个 agent 可以同时改代码,但不能同时写同一个工作区。工作树负责隔离文件,整合者负责让两份改动最终一起成立。

1. **开工先分配。** 每个任务记录负责人、工作区路径、分支和起点提交,并明确本批的整合者。从已确认的 `dev` 提交创建独立分支和 worktree;已有别人使用的工作区不得接管。未指定整合者时可以开发和提交,不能自行开始共享部署或推送 `dev`。
2. **按职责拆任务。** 尽量让两个实现者修改不同模块。共享接口、数据库迁移和依赖锁文件提前约定负责人及先后顺序;确实需要修改同一处时,先完成的一方提交,另一方基于该提交继续。worktree 不会消除接口和行为上的冲突。
3. **交付可复核的提交。** 开发者交付分支、提交号、基线、改动范围、验证结果和已知限制。整合者在自己的集成工作区逐项合入,不去开发者目录修改文件。冲突退回对应负责人处理或由整合者明确接手,不能通过整文件覆盖来消除冲突。
4. **验证整合结果。** 分支各自通过不代表组合正确。每次合入后检查累积差异,按改动范围验证;代码改动走下面的本地闸门,随后才部署、真机自检和推送。纯文档改动检查差异、链接与规则一致性,无需构建部署。不得重写共享的 `dev` 历史,进 `master` 仍走 squash PR。
5. **运行环境也要分开。** worktree 不隔离端口、数据库、daemon、账号配置和已安装的 app。并行验证使用各自的测试数据目录和端口,不要连生产数据做试验。共享 daemon 的重启、桌面安装、部署和 `dev` 推送归整合者串行执行;自动 `self change` 也纳入这份安排。这是协作约定,不代表已有跨进程锁自动替你排队。

收尾只清理自己负责且已确认不再使用的分支和工作树。遇到集成工作区有未知改动或正在被别人使用,先交接,不能 `reset`、`clean` 或替别人 `stash`。

## 最短路径

```bash
# 1. 开发者在独立分支改代码并验证;整合者合入 dev 后复验(四条都要绿)
bun run test                         # bun --bun vitest run
npm run test:node                    # 同一套源码在 node 下再跑一遍(见 ci-and-flakes.md)
bun run typecheck                    # tsc --noEmit
bun run depcheck                     # 模块边界

# 2. 以下由整合者串行执行:构建已验证 dev 的 sidecar 并原子换进 .app(macOS)
cd apps/desktop && bun run build-sidecar && cd -
wechat-cc self deploy                # 换 inode + kickstart + 健康门,不过自动回滚

# 3. 真机自检(daemon 在跑的前提下)
wechat-cc selftest workbench --executor cursor --image --resume   # 加 --keep 保留 scratch 项目
wechat-cc selftest chat --provider cursor --resume

# 4. 推 dev,看 CI
git push origin dev
wechat-cc ci triage --wait --rerun   # 退出码 0 绿 / 1 真红 / 2 没运行或 gh 出错 / 3 是已知 flake

# 5. 自动自改也纳入整合安排,不与人工部署/推送并发(专用工作树 + 五道闸门 + 主人微信拍板)
wechat-cc self change "<需求>"       # --no-deploy 只合 dev;--list / --resume / --unhalt
```

第 4 步不再是人的判断:`ci triage` 自己拉日志、按「这轮动过的文件」分桶、对照 `src/cli/ci-flakes.json`,给出 `green / flake / real / unknown` 和一个退出码;`--rerun` 时已知 flake 会自动重跑,**第二次仍红一律算真红**。判不出来的 `unknown` 只打证据,绝不自动重跑。细则见 [ci-and-flakes.md](ci-and-flakes.md)。

任何一步失败都有机器可读的输出:`selftest --json` 给 `{ ok, checks: [{ name, ok, detail }] }`(`archived` 也是其中一项 —— 自检自己收尾没收干净同样算 FAIL),`self deploy` 失败会自己回滚并把 launchd 的退出原因打出来。部署完立刻自检是设计内的用法:接线窗口里的 503 由 CLI 自己等。

开关一览(手册里提到的每一个都真的存在):

| 命令 | 开关 |
| --- | --- |
| `self deploy` | `--binary` `--app` `--no-rollback` `--health-timeout-ms` `--json` |
| `selftest workbench` | `--executor`(必填) `--image` `--resume` `--json` `--timeout-ms` `--keep` |
| `selftest chat` | `--provider`(必填) `--text` `--resume` `--json` `--timeout-ms` |
| `ci triage` | `--sha` `--branch` `--wait` `--rerun` `--max-reruns` `--timeout-min` `--json` |
| `self change` | `<需求>` `--resume` `--list` `--unhalt` `--approve <id>` `--deny <id>` `--from` `--budget-usd` `--no-deploy` `--json` |

## 索引

| 文件 | 讲什么 |
| --- | --- |
| [deploy.md](deploy.md) | sidecar 构建、`self deploy`、inode 陷阱、launchd 崩溃循环怎么看、plist 为什么指主二进制 |
| [verify.md](verify.md) | `selftest` 两种用法、两种 token 分别够得着什么、必须主人在场的检查清单 |
| [mobile-presence.md](mobile-presence.md) | 手机此刻、待处理入口、成果与回忆,断线提交和冻结资产的接线边界 |
| [ci-and-flakes.md](ci-and-flakes.md) | 三平台作业、Windows 排除清单的规矩、`ci triage` 与 flake 登记表、PR 与合并纪律 |
| [self-change.md](self-change.md) | 让 CC 自己改自己:五道闸门、修复轮上限、退出码、停机与 `--unhalt`、微信不通时怎么拍板(`--approve` / 桌面卡)、禁改清单、费用、微信「自改」 |
| [migrations.md](migrations.md) | `user_version` 是计数、新迁移要改的三处测试、指纹与 `foreign_keys` 坑 |
| [rules-from-real-machines.md](rules-from-real-machines.md) | 真机(而不是单测)抓到的规矩清单 —— 写代码前先扫一眼 |

## 为什么有这份手册

2026-09 那几天,四个功能的闭环里单测一个真 bug 都没抓到,全靠真机 smoke;而 smoke 是临时写的脚本、部署是手工 `cp`、规矩全在控制器的私人记忆里。手册 + `selftest` + `self deploy` 就是把这三段搬进仓库。

真机报文也在仓库里:`src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`(脱敏后的 cursor-agent ACP 报文),回放契约测试 `src/core/acp/fixtures.test.ts`,重新生成用
`bun scripts/acp-fixture-from-transcript.ts <transcript.jsonl> src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`。
