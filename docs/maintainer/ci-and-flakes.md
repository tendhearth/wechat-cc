# CI 与 flake

## 作业

`.github/workflows/ci.yml` 在 push 到 `master` / `dev` / `self/**`,以及 PR 到 `master` / `dev` 时跑。(`self/**` 是自改流水线推的分支 —— 那条流水线的「CI 绿才进 dev」闸门就架在这上面。)

- **build · ${{ matrix.os }}** —— `ubuntu-latest` / `macos-latest` / `windows-latest` 三平台,`fail-fast: false`(一条红不该让另外两条看不见)。每平台:`bun run typecheck` → `bun run depcheck` → 编译 `cli.ts` / `docs.ts` / `setup.ts` / `log-viewer.ts` → 编译版 sidecar smoke → `bun run test`。
- **node · core suite** —— `npm run test:node`,同一套源码在 node 下再跑一遍。这条不是冗余:`bun:sqlite` 的 URI 打开方式、`bun:test` 的 import,在 Mac 上看着好好的,换个运行时就炸。本地复现就是 `npm run test:node`。
- **changes · paths** —— 一个只算一件事的小作业(`dorny/paths-filter`):这一推里 `apps/desktop/**` 动没动过。
- **e2e**(vitest e2e 配置)按 base_ref 限定在 master / PR,dev 的日常推送不跑。
- **desktop-e2e**(Playwright)master / PR 照旧跑;**dev 推送里只要动过 `apps/desktop/**` 也跑**(靠上面那个 `changes` 输出)。没动桌面的推送仍然跳过。本地要先跑一遍就是 `cd apps/desktop && bun x playwright test`,注意 4176 端口别被占。

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
- 判不出来的是 `unknown`:打印证据片段,**不会自动重跑**。要么是新 bug,要么该往登记表里加一条(人/LLM 开 PR 的事,triage 自己不写)。

退出码:

| 码 | 含义 |
| --- | --- |
| 0 | 绿 |
| 1 | 真红(`unknown` 也算 —— 没判明白就别放行) |
| 2 | 这个 SHA 上没有运行 / 还没跑完又没给 `--wait` / `gh` 出错(没登录、网络断) |
| 3 | 是已知 flake(可重跑但没重跑,或没给 `--rerun`) |

开关:`--sha`(缺省 HEAD)`--branch`(找「上一次绿」的分支,缺省当前分支)`--wait`(等运行出现,最多 2 分钟;再等它跑完,上限 `--timeout-min`,缺省 30)`--rerun` `--max-reruns N`(缺省 1)`--timeout-min N` `--json`。进度和诊断走 stderr,`--json` 的 stdout 是干净的一份 `TriageReport`。

要自己动手时,记住:`gh run list --commit <sha>` **要全 40 位 SHA**,短 sha 查不到任何东西 —— 而且是**安静地**返回空数组,看上去和「这次推送没有 CI」一模一样。(`ci triage` 自己先 `git rev-parse` 过,所以 `--sha 25113589` 是可以的。)

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

- 只在 `dev` 上开发;`dev → master` **只走 PR,且只用 squash merge**。
- `delete_branch_on_merge` 的取值会被改动,每次合并前重新确认一次。
- CI 红着不合;flake 也要重跑到绿再合,不要口头宣布「这是 flake」—— 让 `wechat-cc ci triage --wait --rerun` 说,退出码 0 才算绿。
