# Tendhearth CC

Tendhearth CC 是住在用户自己电脑上的个人 AI,日常称呼为 CC。daemon 管会话、执行者与权限;桌面、手机和微信是同一个 CC 的操作入口。原生手机 app 在 `apps/app`,浏览器/PWA 在 `apps/mobile`。对外文案遵守[产品命名规范](docs/reference/product-naming.md);`wechat-cc` CLI、仓库地址与持久化标识继续保留。

**维护者(包括 LLM)从这里开始:[`docs/maintainer/README.md`](docs/maintainer/README.md)。**

> 项目指令只有这一份。Claude Code(v2.1.277+)直接读 `AGENTS.md`,Codex 本来就读它——**别再加 `CLAUDE.md`**:两份并存时 Claude 只读 CLAUDE.md、完全忽略这份,2026-09 就是这么漂出两套规矩的。真要在读不到 AGENTS.md 的环境跑(Amazon Bedrock、关掉遥测),或者你本地有 `CLAUDE.local.md`(它会把这份顶掉),加一份只有一行 `@AGENTS.md` 的 CLAUDE.md。

## 三份总图(动手前先看对应的那一份)

| 想知道 | 读 |
|---|---|
| 某件事的文档在哪、哪一份还可信 | [`docs/INDEX.md`](docs/INDEX.md) |
| 现在往哪走、卡在哪、欠什么账 | [`docs/roadmap.md`](docs/roadmap.md) |
| 定了什么、为什么这样定、什么被否决过 | [`docs/全景导图.md`](docs/全景导图.md)(HTML 是生成物,永不手改;改完 md 跑 `bun run build:map`) |

## 三条硬规矩

1. 功能开发和修复从 `dev` 起独立分支,在各自独立的 worktree 中完成;`dev` 用于集成与验收。同一批任务指定一名整合者,串行负责合入 `dev`、部署和推送。
2. 进 `master` 只走 PR,而且只用 squash merge。
3. 只修改分配给自己的工作区和分支。其他工作区只读,不得替别人切分支、清理、暂存或覆盖未提交修改;不得让两个执行者同时写同一工作区。

## 标准回路

开发者在自己的分支完成修改、验证和提交,交给整合者。测试只增不减:删掉/放松的测试在 PR 描述 `## 删掉/放松的测试` 写理由;修 bug 的 PR 描述带 `## 红/绿`(撤掉修复时测试红、带上时绿),CI 会查,见 `docs/maintainer/verify.md`。整合者在指定的集成工作区逐项合入 `dev`,对合并后的版本重新验证,再部署、推送。分工、冲突处理和运行环境隔离见[维护者手册](docs/maintainer/README.md#多-agent-协作)。

```bash
# 开发分支本地验证:只跑改动牵连到的(typecheck + depcheck + 牵连的测试 + 全部守卫 + 真实形状沙盒)
# 全绿才记下这份内容;git push 时 pre-push 钩子查(装一次:git config core.hooksPath scripts/git-hooks)
bun run verify
# 整合者合入 dev 后、部署前:跟 CI 一样四条全跑(test / test:node / typecheck / depcheck)
bun run verify --full

# 以下由整合者在已验证的 dev 版本上串行执行
wechat-cc self ship                                            # 负载 → 网络守护 → 构建 → self deploy → 两条自检(红了回滚)
wechat-cc self soak                                            # 过几个小时:部署稳不稳看信号(改开机/关机顺序的加 --min-restarts 1)

git push origin dev && wechat-cc ci triage --wait --rerun      # 看 CI(0 绿 / 1 真红 / 2 没运行 / 3 flake)

# 自动自改也要纳入同一整合安排,不要与人工部署/推送同时运行
wechat-cc self change "<需求>"                                  # 让 CC 自己走完上面整套(五道闸门 + 主人微信拍板)
```

细节:部署见 `docs/maintainer/deploy.md`,验证见 `verify.md`,CI 与 flake 见 `ci-and-flakes.md`,迁移见 `migrations.md`,自改见 `self-change.md`,真机规矩见 `rules-from-real-machines.md`。

## 双 Mac 测试分工（主人 2026-10-30 指定）

- 当前主工作 Mac 不得被自动测试接管鼠标、键盘、焦点或窗口；也不在这里跑重型测试和构建。后续无界面浏览器回归、原生 UI 交互与截图验收均放到专用 Mac mini。
- Mac mini 通过既有 SSH 别名 `homes-mac-mini` 使用独立测试工作区和图形会话。只运行离线测试包、本地模拟接口及测试驱动；不启动真实 CC daemon，不调用真实模型或微信，不复制模型凭据、微信登录、私人数据库或生产插件。
- 原生控制程序必须实际在 mini 执行，不能把本机电脑控制或本机屏幕共享操作当作远端验收。测试服务只监听 mini 回环地址，通过 SSH 访问，不启用不安全脚本执行或绕过系统授权。
- 真实外网联调、签名和最终日常部署留在已有网络保护的主机，由整合者串行执行。UI 验收必须先在 mini 通过，日常应用有完整整包回滚备份后再更新。
