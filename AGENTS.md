# wechat-cc

wechat-cc 是一个把 Claude Code / Codex / cursor 一类的编码 agent 接到主人微信与桌面 app 上的常驻服务:daemon 管会话、执行者与权限,桌面「工作台」和微信是它的两个操作面。

**维护者(包括 LLM)从这里开始:[`docs/maintainer/README.md`](docs/maintainer/README.md)。**

## 三条硬规矩

1. 只在 `dev` 分支上干活。
2. 进 `master` 只走 PR,而且只用 squash merge。
3. 不碰兄弟工作树(`~/Documents/tendhearth/` 下还有别的 checkout,它们不是这个仓库)。

## 标准回路

```bash
bun run test          # bun --bun vitest run
npm run test:node     # 同一套源码在 node 下再跑一遍
bun run typecheck     # tsc --noEmit
bun run depcheck      # 模块边界

cd apps/desktop && bun run build-sidecar && cd -
wechat-cc self deploy                                          # 原子换 sidecar + 重启 + 健康门,失败自动回滚
wechat-cc selftest workbench --executor cursor --image --resume
wechat-cc selftest chat --provider cursor --resume

git push origin dev && wechat-cc ci triage --wait --rerun      # 看 CI(0 绿 / 1 真红 / 2 没运行 / 3 flake)

wechat-cc self change "<需求>"                                  # 让 CC 自己走完上面整套(五道闸门 + 主人微信拍板)
```

细节:部署见 `docs/maintainer/deploy.md`,验证见 `verify.md`,CI 与 flake 见 `ci-and-flakes.md`,迁移见 `migrations.md`,自改见 `self-change.md`,真机规矩见 `rules-from-real-machines.md`。
