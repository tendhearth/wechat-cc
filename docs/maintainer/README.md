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
wechat-cc selftest workbench --executor cursor --image --resume
wechat-cc selftest chat --provider cursor --resume

# 4. 推 dev,看 CI
git push origin dev
gh run list --branch dev --limit 3
```

任何一步失败都有机器可读的输出:`selftest --json` 给 `{ ok, checks: [{ name, ok, detail }] }`,`self deploy` 失败会自己回滚并把 launchd 的退出原因打出来。

## 索引

| 文件 | 讲什么 |
| --- | --- |
| [deploy.md](deploy.md) | sidecar 构建、`self deploy`、inode 陷阱、launchd 崩溃循环怎么看、plist 为什么指主二进制 |
| [verify.md](verify.md) | `selftest` 两种用法、两种 token 分别够得着什么、必须主人在场的检查清单 |
| [ci-and-flakes.md](ci-and-flakes.md) | 三平台作业、Windows 排除清单的规矩、已知 flake 与处置、PR 与合并纪律 |
| [migrations.md](migrations.md) | `user_version` 是计数、新迁移要改的三处测试、指纹与 `foreign_keys` 坑 |
| [rules-from-real-machines.md](rules-from-real-machines.md) | 真机(而不是单测)抓到的规矩清单 —— 写代码前先扫一眼 |

## 为什么有这份手册

2026-09 那几天,四个功能的闭环里单测一个真 bug 都没抓到,全靠真机 smoke;而 smoke 是临时写的脚本、部署是手工 `cp`、规矩全在控制器的私人记忆里。手册 + `selftest` + `self deploy` 就是把这三段搬进仓库。

真机报文也在仓库里:`src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`(脱敏后的 cursor-agent ACP 报文),回放契约测试 `src/core/acp/fixtures.test.ts`,重新生成用
`bun scripts/acp-fixture-from-transcript.ts <transcript.jsonl> src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`。
