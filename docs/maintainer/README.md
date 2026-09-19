# 维护者手册

给**维护这个仓库的 LLM**(也包括 CC 自己)看的一页索引。目标:任何一个新来的模型不靠人类的口头知识,也能跑完「改 → 验 → 部署 → 再验 → 推 → 看 CI」。

## 三条硬规矩

1. 只在 `dev` 分支上干活。
2. 进 `master` 只走 PR,而且只用 squash merge。
3. 不碰兄弟工作树(`~/Documents/tendhearth/` 下面还有别的 checkout;`…/wechat-cc` 不是这个仓库)。

## 最短路径

```bash
# 1. 改代码,然后本地闸门(四条都要绿)
bun run test                         # bun --bun vitest run
npm run test:node                    # 同一套源码在 node 下再跑一遍(见 ci-and-flakes.md)
bun run typecheck                    # tsc --noEmit
bun run depcheck                     # 模块边界

# 2. 构建 sidecar 并原子换进 .app(macOS)
cd apps/desktop && bun run build-sidecar && cd -
wechat-cc self deploy                # 换 inode + kickstart + 健康门,不过自动回滚

# 3. 真机自检(daemon 在跑的前提下)
wechat-cc selftest workbench --executor cursor --image --resume   # 加 --keep 保留 scratch 项目
wechat-cc selftest chat --provider cursor --resume

# 4. 推 dev,看 CI
git push origin dev
wechat-cc ci triage --wait --rerun   # 退出码 0 绿 / 1 真红 / 2 没运行或 gh 出错 / 3 是已知 flake

# 5. 让 CC 自己走完上面这四步(专用克隆 + 五道闸门 + 主人微信拍板)
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
| `self change` | `<需求>` `--resume` `--list` `--unhalt` `--from` `--budget-usd` `--no-deploy` `--json` |

## 索引

| 文件 | 讲什么 |
| --- | --- |
| [deploy.md](deploy.md) | sidecar 构建、`self deploy`、inode 陷阱、launchd 崩溃循环怎么看、plist 为什么指主二进制 |
| [verify.md](verify.md) | `selftest` 两种用法、两种 token 分别够得着什么、必须主人在场的检查清单 |
| [ci-and-flakes.md](ci-and-flakes.md) | 三平台作业、Windows 排除清单的规矩、`ci triage` 与 flake 登记表、PR 与合并纪律 |
| [self-change.md](self-change.md) | 让 CC 自己改自己:五道闸门、修复轮上限、退出码、停机与 `--unhalt`、禁改清单、费用、微信「自改」 |
| [migrations.md](migrations.md) | `user_version` 是计数、新迁移要改的三处测试、指纹与 `foreign_keys` 坑 |
| [rules-from-real-machines.md](rules-from-real-machines.md) | 真机(而不是单测)抓到的规矩清单 —— 写代码前先扫一眼 |

## 为什么有这份手册

2026-09 那几天,四个功能的闭环里单测一个真 bug 都没抓到,全靠真机 smoke;而 smoke 是临时写的脚本、部署是手工 `cp`、规矩全在控制器的私人记忆里。手册 + `selftest` + `self deploy` 就是把这三段搬进仓库。

真机报文也在仓库里:`src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`(脱敏后的 cursor-agent ACP 报文),回放契约测试 `src/core/acp/fixtures.test.ts`,重新生成用
`bun scripts/acp-fixture-from-transcript.ts <transcript.jsonl> src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`。
