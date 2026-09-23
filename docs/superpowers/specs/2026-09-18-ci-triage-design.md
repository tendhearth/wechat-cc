# CI 信号面:triage 工具 + flake 登记表 + 桌面 e2e 按路径在 dev 上跑

日期:2026-09-18。承接 `2026-09-18-self-maintenance-design.md`(自维护三件套)。对应「自动化开发缺什么」清单第 5 项:**Windows 永远事后才红、flake 靠人判断重跑、desktop-e2e 在 dev 推送上不跑**。

## 问题

自维护三件套之后,一个 LLM 维护者能「改 → 验 → 部署 → 再验 → 推」,但最后一步「看 CI」仍然是人的判断:

1. `ci-and-flakes.md` 的处置规则是散文:「先看失败的文件是不是你这轮动过的;没动过、症状对得上表里任一条 ⇒ 重跑」。这条规则每次都要 LLM 自己拉日志、去 ANSI、按文件分桶、对照表格。本轮(09-17 ~ 09-18)dev 上 6 次红,5 次是 Windows,每次都是我手工做这套。
2. flake 表是 Markdown 表格,不是机器能对的东西;新增 flake 类别没有契约,写错了没人知道。
3. `desktop-e2e` 只在 master / PR 上跑。dev 上改了 `apps/desktop/**` 要等到合并前才知道红,而合并前本地跑 Playwright 的规矩靠自觉。
4. 缺口清单里还写了「一条 daemon 能自己触发的 Windows 真机 lane」。**本轮不做**:win-test 那台走 WLAN 会掉线(09-16 就 ssh 不上),而且 Windows 目前根本拿不到工作台(产品缺口),先把 windows-latest 这条 CI 作业变成可自动处置的信号,比再加一条不稳定的 lane 有用。

## 目标

- `wechat-cc ci triage` 一条命令回答「我刚推的这个 SHA,CI 绿了吗?红的是我的锅还是 flake?要不要重跑?」,输出人读 + `--json`,退出码可编排。
- flake 类别变成仓库里的 JSON 登记表,有契约测试。
- `apps/desktop/**` 有改动的 dev 推送也跑 `desktop-e2e`。
- 维护者手册的「看 CI」一步改成调这条命令。

## 非目标

- 不做 Windows 真机 lane(理由见上)。
- 不自动新增 flake 条目:`unknown` 类别只打印证据,加条目是人(或 LLM)开 PR 的事。
- 不动 `e2e`(vitest e2e 配置)那条作业的触发条件。
- **2026-09-18 修订**:做成 `wechat-cc ci triage` 子命令(纯逻辑 `src/cli/ci-triage.ts`,外壳 `src/cli/ci-triage-run.ts`,登记表 `src/cli/ci-flakes.json`),因为自改流水线(`2026-09-18-self-change-pipeline-design.md`)要在进程内调 `runCiTriage`;它和 `self deploy` 一样只在开发机上有意义(依赖 `gh` 登录态)。

## 设计

### 1. 登记表 `src/cli/ci-flakes.json`

```json
{
  "$comment": "已知 flake 类别。triage 只在失败测试的文件本轮没动过、且症状匹配时才判 flake。加条目要写清 note 和 since。",
  "entries": [
    { "id": "win-hook-timeout", "jobs": ["build · windows-latest"], "symptom": "Hook timed out in \\d+ms", "note": "windows runner 磁盘 I/O 慢,未动的工作台服务测试 beforeEach 超时", "since": "2026-09-16" },
    { "id": "win-test-timeout", "jobs": ["build · windows-latest"], "symptom": "Test timed out in \\d+ms", "note": "同上,单条测试超时", "since": "2026-09-16" },
    { "id": "probe-binary-version", "symptom": "probeBinaryVersion", "note": "探测外部 CLI 版本有 3s 上限,runner 负载高时探不完", "since": "2026-09-10" },
    { "id": "econnreset-chunked", "files": ["src/daemon/internal-api/routes-workbench*.test.ts"], "symptom": "ECONNRESET", "note": "分块上传那条 socket 测试偶发", "since": "2026-09-10" },
    { "id": "node-no-summary", "jobs": ["node · core suite"], "symptom": "__NO_SUMMARY__", "note": "node 作业跑完没有 Test Files 汇总行,进程收尾丢了汇总", "since": "2026-09-16" }
  ]
}
```

字段:`id`(唯一)、`symptom`(正则,对失败块的文本匹配;特殊值 `__NO_SUMMARY__` 表示「作业失败但日志里没有 `Test Files` 汇总行且没有任何 FAIL 块」)、可选 `jobs`(限定作业名)、可选 `files`(glob,限定失败测试文件)、`note`、`since`。契约测试(`src/cli/ci-flakes.test.ts`):id 唯一、正则可编译、每条有 note 和 since、glob 用的是 `picomatch`/`minimatch` 已有依赖之一(实现时查 `package.json`,没有就用简单的 `*` → `.*` 转换,不新增依赖)。

### 2. 纯逻辑 `src/cli/ci-triage.ts`

不碰网络和进程,全部可单测:

- `stripAnsi(s)`:去 `\x1b[...m` 与 `^[[...m` 两种写法(`gh` 的日志里两种都见过)。
- `stripLogPrefix(line)`:`gh run view --job --log-failed` 每行是 `<job>\t<step>\t<ISO 时间戳> <文本>`,去掉前三段。
- `parseFailures(log, jobName) → Failure[]`:从 vitest 输出里抓 ` FAIL  <file> > <suite> > <test>` 块(块到下一个 ` FAIL ` 或 `⎯⎯⎯` 分隔线为止),得到 `{ job, file, test, excerpt }`;同一 file+test 去重。另抓 `##[error]` 行作为 `stepErrors`。返回 `{ failures, stepErrors, hasSummary }`(`hasSummary` = 日志里有 `Test Files` 行)。
- `relatedSources(testFile)`:`x.test.ts` ⇒ `[x.test.ts, x.ts]`;其他文件 ⇒ 自身。
- `classify(failure, ctx) → Classified`,`ctx = { changedFiles: Set<string>, registry, hasSummary }`:
  1. `relatedSources(file)` 与 `changedFiles` 有交集 ⇒ `{ kind: 'real', reason: 'file changed since last green' }`。
  2. 否则遍历登记表:`jobs` 不含该作业则跳过;`files` 有且不匹配则跳过;`symptom` 对 `excerpt` 匹配 ⇒ `{ kind: 'flake', id }`。
  3. 否则 `{ kind: 'unknown' }`。
- `classifyJob(job, parsed, ctx)`:失败步骤不是 `Run tests` / `Unit tests under Node…`(即 typecheck / build / depcheck / smoke)⇒ 整个作业一条 `real`(`stepErrors` 作证据)。测试步骤且 `failures` 为空且 `!hasSummary` ⇒ 按 `__NO_SUMMARY__` 条目判 flake,否则 `unknown`。
- `verdict(classifiedAll) → 'green' | 'flake' | 'real' | 'unknown'`:没有失败 ⇒ green;全部 flake ⇒ flake;有任何 real ⇒ real;否则 unknown。
- `pickBaseSha(runs, sha, isAncestor)`:`runs` 是该分支最近的 CI 运行(新到旧),取第一个 `conclusion === 'success'` 且 `headSha !== sha` 且 `isAncestor(headSha, sha)` 的 headSha;找不到返回 `null`(shell 层退化成 `sha~1`)。

### 3. 外壳 `src/cli/ci-triage-run.ts`(`runCiTriage(deps, opts)`)+ `cli.ts` 的 `ci triage`

```
wechat-cc ci triage [--sha <sha|HEAD>] [--branch dev] [--wait] [--rerun] [--max-reruns 1] [--timeout-min 30] [--json]
```

- 解析 SHA 为 40 位(`git rev-parse`)。`gh run list --commit <sha> --workflow CI --json databaseId,status,conclusion,headSha,event,createdAt` 取最新一条;没有 ⇒ 退出码 2 `no_run`(`--wait` 时先等最多 2 分钟让 Actions 建出运行)。
- `--wait`:每 30s `gh run view <id> --json status,conclusion` 直到 `completed`,总上限 `--timeout-min`。
- `conclusion === 'success'` ⇒ verdict `green`,退出 0。
- 否则:`gh run view <id> --json jobs` 取失败作业及其失败步骤;每个失败作业 `gh run view --job <jobId> --log-failed`;`changedFiles = git diff --name-only <base>..<sha>`,`base = pickBaseSha(gh run list --branch <branch> --limit 30 …)` 或 `<sha>~1`;分类、出 verdict。
- `--rerun`:verdict 为 `flake` 且重跑次数 < `--max-reruns` ⇒ `gh run rerun <id> --failed`,`--wait` 时继续等并重新 triage 同一个 run id;**第二次仍红的失败一律改判 `real`**(哪怕症状匹配)—— 连着两次红的 flake 就当真的看。
- 退出码:0 green;1 real / unknown;3 flake(可重跑但没重跑,或没给 `--rerun`);2 no_run / gh 出错。
- 输出:人读版一行 verdict + 每条失败 `job · file · test → kind[:id]`,unknown 的附 excerpt 前 12 行;`--json` 给 `{ sha, runId, url, verdict, base, changedFiles, jobs: [{ name, step, classified: [...] }], reruns }`。
- `gh` / `git` 通过 `deps.exec(cmd, args) → { code, stdout, stderr }` 注入;`spawnSync` 带 `windowsHide: true`。`--wait` 的 sleep 也注入。

### 4. `ci.yml`:desktop-e2e 按路径在 dev 上跑;push 分支加 `self/**`

`push.branches: [master, dev, 'self/**']` —— 自改流水线推的分支要有 CI 才有闸门二。

新作业 `changes`(ubuntu,`dorny/paths-filter@v3`,过滤器 `desktop: ['apps/desktop/**']`),输出 `desktop`。`desktop-e2e` 加 `needs: changes`,条件改为:

```yaml
if: github.base_ref == 'master' || github.ref == 'refs/heads/master' || needs.changes.outputs.desktop == 'true'
```

`e2e` 作业不动。桌面 e2e 一次约 3 分钟,只在桌面目录有改动时多付这一次。

守卫测试 `scripts/ci-workflow.guard.test.ts`:读 `ci.yml`,断言 push 分支含 `self/**`; `changes` 作业存在且过滤器含 `apps/desktop/**`;`desktop-e2e` 的 `needs` 含 `changes`,`if` 含 `needs.changes.outputs.desktop == 'true'`;三处 `setup-bun` 仍钉 `1.3.14`(把这条已有规矩也钉进测试)。

### 5. 文档

- `docs/maintainer/ci-and-flakes.md`:「已知 flake 类别」表格改为指向 `src/cli/ci-flakes.json`(表格留一份人读摘要,注明以 JSON 为准);「处置」改为 `wechat-cc ci triage --wait --rerun`,写清退出码与「两次红就是真红」;加「怎么加一条 flake」。
- `docs/maintainer/README.md`、`AGENTS.md`、`verify.md` 的「看 CI」一步改成这条命令。

## 验证

- 单测:`src/cli/ci-triage.test.ts`(用本轮真实红日志的脱敏片段做夹具:Windows hook 超时、selftest 的 basename 真红、node 无汇总)、`ci-flakes.test.ts`、`ci-workflow.guard.test.ts`。
- 真机:对 `25113589`(Windows 真红)跑 triage ⇒ `real`,指到 `src/cli/selftest.test.ts`;对 `35173091848`(hook 超时)⇒ `flake:win-hook-timeout`;对 `15cb7c37` ⇒ `green`。
- 推 dev 一次含 `apps/desktop/**` 的改动(文档级即可),确认 `desktop-e2e` 在 dev push 上跑了;推一次不含的,确认跳过。
