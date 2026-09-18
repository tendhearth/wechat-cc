# CI 与 flake

## 作业

`.github/workflows/ci.yml` 在 push / PR 到 `master` 与 `dev` 时跑:

- **build · ${{ matrix.os }}** —— `ubuntu-latest` / `macos-latest` / `windows-latest` 三平台,`fail-fast: false`(一条红不该让另外两条看不见)。每平台:`bun run typecheck` → `bun run depcheck` → 编译 `cli.ts` / `docs.ts` / `setup.ts` / `log-viewer.ts` → 编译版 sidecar smoke → `bun run test`。
- **node · core suite** —— `npm run test:node`,同一套源码在 node 下再跑一遍。这条不是冗余:`bun:sqlite` 的 URI 打开方式、`bun:test` 的 import,在 Mac 上看着好好的,换个运行时就炸。本地复现就是 `npm run test:node`。
- 重型 e2e / Playwright 作业按 base_ref 限定,dev 的日常推送不跑(`desktop-e2e` 在 dev push 上不跑,合并前请本地 `cd apps/desktop && bun x playwright test`,注意 4176 端口别被占)。

bun 版本在 workflow 里**钉死**(`bun-version: 1.3.14`),不用 `latest` —— 上游发新版能让 CI 在没有任何提交的情况下自己变红。升 bun 该是一件有人盯着的事。

## Windows 排除清单的规矩

`vitest.config.ts` 里有一段 `process.platform === 'win32' ? [...] : []` 的排除列表。规矩只有一条:

> **任何一个套件,只要它依赖的 provider / 运行时在第一行就拒绝 win32,就必须加进那张清单。**

不加的后果不是「红一条」,而是这套件在 Windows 上一路等 spawn 超时,把整个作业拖到超时才死,报错还看不出原因。清单里现在有 codex app-server、两个 ACP 执行者套件、Claude 保留会话、mkfifo 夹具、git-review、几个 POSIX 路径的原生历史读取器。加的时候在旁边写清楚**为什么**这套件在 Windows 上测的只是「平台不支持」这个事实。

## 已知 flake 类别(不是你的锅)

| 症状 | 说明 |
| --- | --- |
| `probeBinaryVersion` 超时 | 探测外部 CLI 版本有 3s 上限,CI 机器负载高时探不完 |
| `ECONNRESET` | 分块上传那条 socket 测试,偶发 |
| Windows hook 超时 | 明明没动的文件上 hook 跑超时,windows runner 磁盘 I/O 慢 |
| node 作业跑完没有 summary | 偶发,进程收尾丢了汇总行 |

## 处置

1. 先看**失败的文件是不是你这轮动过的**。动过 ⇒ 是你的 bug,别 rerun。
2. 没动过、症状对得上表里任一条 ⇒ 重跑失败的作业:
   ```bash
   gh run list --branch dev --limit 5
   gh run rerun <id> --failed
   ```
3. `gh run list --commit <sha>` **要全 40 位 SHA**,短 sha 查不到任何东西(会安静地返回空,不报错)。

## 合并纪律

- 只在 `dev` 上开发;`dev → master` **只走 PR,且只用 squash merge**。
- `delete_branch_on_merge` 的取值会被改动,每次合并前重新确认一次。
- CI 红着不合;flake 也要重跑到绿再合,不要口头宣布「这是 flake」。
