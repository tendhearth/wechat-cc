# 自改流水线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wechat-cc self change "<需求>"`(和微信「自改 <需求>」)让 CC 在自己的专用克隆里用 Claude 实现改动,过 tests → review → CI → 主人拍板 → 合 dev 五道闸门,再 self deploy + selftest,不过就回滚;顺路把 `wechat-cc ci triage` 做成 CI 闸门。

**Architecture:** 流水线是 daemon 外的 CLI 进程(`src/cli/self-change/`),每一步是注入依赖的纯函数,状态落 `STATE_DIR/self-change/<id>.json`;daemon 只提供三条路由(通知 / 问主人 / 查决定)和一个微信进件口;实现与评审直接起 `claude -p`(插件可用、预算封顶、`--resume` 修复轮);CI 闸门是 `src/cli/ci-triage*.ts`。

**Tech Stack:** Bun 1.3.14 + Node 24 双跑 vitest;citty;`gh` CLI;git;`@anthropic-ai/claude-code` CLI(`claude -p`)。

**Spec:** `docs/superpowers/specs/2026-09-18-self-change-pipeline-design.md`(主),`docs/superpowers/specs/2026-09-18-ci-triage-design.md`(CI 闸门)。

## Global Constraints

- 只在 `dev` 分支上干活;不碰兄弟工作树(`~/Documents/tendhearth/wechat-cc` 是另一个 checkout)。
- 生产代码里每个 `spawn` / `spawnSync` 必须带 `windowsHide: true`(`src/lib/spawn-windowshide.test.ts` 会扫)。
- 新根命令 / 子命令要进 `cli.test.ts` 的子命令表(`self` 的子命令变成 `['change','deploy']`,新增根命令 `ci`,子命令 `['triage']`)。
- 新内部 API 路由要同时进 `src/daemon/internal-api/route-tiers.ts` 的 `ROUTE_MIN_TIER`(admin)和 `token-registry.ts` 的 operator `routeAllow`(两处都有精确集合测试要改);不进 `lib.rs` / `workbench-proxy.ts`(桌面不调)。
- 不打印任何 token(只打长度 / 前 4 位);测试永远不发真微信。
- 测试目录用 `src/lib/test-temp.ts` 的 `makeTempDir` / `removeTempDir`(Windows EBUSY 规矩)。
- 供应商在第一行就拒绝 win32 的套件必须进 `vitest.config.ts` 的 win32 排除列表;流水线本身 darwin-only,但它的单测用假件,要能在三平台跑(整合测试里的 git 是真的,Windows 上路径用 `path.join`,不要手写 `/`)。
- 禁改清单(`policy.ts` 的 `FORBIDDEN_GLOBS`)与缺省值是代码常量,不是配置。
- 每个任务结束前:`bun run typecheck`、相关测试文件 `bun x vitest run <files>` 与 `npx vitest run -c vitest.node.config.ts <files>` 都绿;提交信息中文,说清为什么。

---

### Task 1: CI triage 纯逻辑 + flake 登记表

**Files:**
- Create: `src/cli/ci-triage.ts`
- Create: `src/cli/ci-flakes.json`
- Test: `src/cli/ci-triage.test.ts`, `src/cli/ci-flakes.test.ts`

**Interfaces (Produces):**

```ts
// src/cli/ci-triage.ts
export interface FlakeEntry { id: string; symptom: string; jobs?: string[]; files?: string[]; note: string; since: string }
export interface FlakeRegistry { entries: FlakeEntry[] }
export interface Failure { job: string; file: string; test: string; excerpt: string }
export interface ParsedJobLog { failures: Failure[]; stepErrors: string[]; hasSummary: boolean }
export type Classified =
  | { kind: 'real'; failure: Failure | null; reason: string }
  | { kind: 'flake'; failure: Failure | null; id: string }
  | { kind: 'unknown'; failure: Failure | null; excerpt: string }
export type Verdict = 'green' | 'flake' | 'real' | 'unknown'
export interface ClassifyCtx { changedFiles: ReadonlySet<string>; registry: FlakeRegistry; secondRun?: boolean }
export const NO_SUMMARY = '__NO_SUMMARY__'
export const TEST_STEP_NAMES: readonly string[]   // ['Run tests', 'Unit tests under Node (whole src, minus the ws server)']
export function stripAnsi(s: string): string
export function stripLogPrefix(line: string): string
export function parseJobLog(raw: string, jobName: string): ParsedJobLog
export function relatedSources(testFile: string): string[]
export function globToRegExp(glob: string): RegExp          // 只支持 * 与 **;不新增依赖
export function validateRegistry(raw: unknown): { ok: true; registry: FlakeRegistry } | { ok: false; errors: string[] }
export function classifyFailure(f: Failure, ctx: ClassifyCtx): Classified
export function classifyJob(job: { name: string; failedStep: string | null }, parsed: ParsedJobLog, ctx: ClassifyCtx): Classified[]
export function verdictOf(all: Classified[]): Verdict
export function pickBaseSha(runs: Array<{ headSha: string; conclusion: string | null }>, sha: string, isAncestor: (a: string, b: string) => boolean): string | null
export function formatTriage(report: TriageReport): string
export interface TriageReport { sha: string; runId: number | null; url: string | null; verdict: Verdict; base: string | null; changedFiles: string[]; jobs: Array<{ name: string; step: string | null; classified: Classified[] }>; reruns: number }
```

规则(按 spec §2):

- `stripAnsi`:`/\x1b\[[0-9;]*[A-Za-z]/g` 与 `/\^\[\[[0-9;]*[A-Za-z]/g` 都去。
- `stripLogPrefix`:`gh run view --job --log-failed` 的行是 `<job>\t<step>\t<ISO 时间戳> <文本>`;按前两个 `\t` 切,再去掉开头的 `\d{4}-\d{2}-\d{2}T[^ ]+ ` 时间戳。没有两个 `\t` 的行原样返回。
- `parseJobLog`:先 `stripAnsi` + 逐行 `stripLogPrefix`。FAIL 块以 `/^\s*FAIL\s+(\S+\.test\.ts)(?:\s*>\s*(.+))?$/` 开头,到下一个 FAIL 行或 `/^\s*⎯{5,}/` 为止;`test` = `>` 后的整串(去首尾空白),没有 `>` 时为 `''`;`excerpt` = 块内文本(≤ 60 行);同 `file+test` 去重(保留第一块)。`stepErrors` = 所有含 `##[error]` 的行(去前缀)。`hasSummary` = 存在 `/^\s*Test Files\s/` 行。
- `relatedSources('src/a/b.test.ts')` ⇒ `['src/a/b.test.ts','src/a/b.ts']`;其他 ⇒ `[file]`。
- `classifyFailure`:1) `secondRun` ⇒ `real`(reason `'still failing after rerun'`);2) related ∩ changed ≠ ∅ ⇒ `real`(reason `'file changed since last green'`);3) 登记表按顺序匹配(`jobs` 含 job 或缺省;`files` 每个 glob 用 `globToRegExp` 对 `file` 匹配,缺省不限;`new RegExp(symptom)` 对 `excerpt` 测)⇒ `flake`;4) `unknown`(excerpt 前 12 行)。`symptom === NO_SUMMARY` 的条目在 `classifyFailure` 里永远不匹配(只给 `classifyJob` 用)。
- `classifyJob`:`failedStep` 不在 `TEST_STEP_NAMES` ⇒ `[ { kind:'real', failure:null, reason: 'step '+failedStep+' failed' } ]`(stepErrors 拼进 reason,≤ 3 行)。测试步骤:`failures` 非空 ⇒ 每条 `classifyFailure`;为空且 `!hasSummary` ⇒ 找 `symptom === NO_SUMMARY && (jobs 含 job)` 的条目 ⇒ `flake`,找不到 ⇒ `unknown`;为空且 `hasSummary` ⇒ `unknown`(excerpt = stepErrors 前 12 行)。
- `verdictOf`:空 ⇒ green;有 real ⇒ real;全 flake ⇒ flake;否则 unknown。
- `pickBaseSha`:runs 新到旧,第一个 `conclusion === 'success' && headSha !== sha && isAncestor(headSha, sha)`。
- `validateRegistry`:顶层 `{ entries: [...] }`;每条 id 非空且唯一、symptom 非空且 `new RegExp` 不抛、note / since 非空字符串、jobs / files 若有则为字符串数组;错误逐条列出。
- `formatTriage`:第一行 `verdict=<v> sha=<8位> run=<id> <url>`;每条 classified 一行 `  <job> · <file or step> · <test> → <kind>[:<id>]`;unknown 的追加 excerpt 缩进两格。

`src/cli/ci-flakes.json` 内容照 spec §1 五条(`win-hook-timeout`、`win-test-timeout`、`probe-binary-version`、`econnreset-chunked`、`node-no-summary`)。

- [ ] **Step 1: 写 `src/cli/ci-flakes.json` 与 `src/cli/ci-flakes.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateRegistry } from './ci-triage'

describe('ci-flakes.json', () => {
  const raw = JSON.parse(readFileSync(join(__dirname, 'ci-flakes.json'), 'utf8'))
  it('validates: unique ids, compilable regexes, note + since on every entry', () => {
    const v = validateRegistry(raw)
    expect(v.ok, v.ok ? '' : v.errors.join('\n')).toBe(true)
    if (v.ok) expect(v.registry.entries.map(e => e.id)).toContain('win-hook-timeout')
  })
  it('rejects a duplicate id and a bad regex', () => {
    const v = validateRegistry({ entries: [{ id: 'a', symptom: '(', note: 'n', since: '2026-01-01' }, { id: 'a', symptom: 'x', note: 'n', since: '2026-01-01' }] })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.errors.join(' ')).toMatch(/duplicate id a/)
    if (!v.ok) expect(v.errors.join(' ')).toMatch(/regex/)
  })
})
```

- [ ] **Step 2: 写 `src/cli/ci-triage.test.ts`**(夹具内联;不要读网络)

用例(每条一个 `it`):
1. `stripLogPrefix('build · windows-latest\tRun tests\t2026-09-18T17:06:20.5714169Z  ✓ x')` ⇒ `'  ✓ x'`(注意时间戳后是两个空格时只去一个)。没有 `\t` 的行原样。
2. `parseJobLog` 对一段含两个 FAIL 块 + `⎯⎯⎯⎯⎯⎯⎯` 分隔 + `Test Files  1 failed | 576 passed` 的 Windows 日志(带 `^[[31m` 残留和 `\x1b[31m`):得到 2 条 failure、`hasSummary === true`、excerpt 不含 ANSI、同一 `file+test` 重复块只算一次。
3. `parseJobLog` 对没有 FAIL 也没有 `Test Files` 的日志 ⇒ `failures: []`、`hasSummary: false`、`stepErrors` 含 `Process completed with exit code 1`。
4. `classifyFailure`:文件在 `changedFiles` ⇒ real;`x.test.ts` 未动但 `x.ts` 动了 ⇒ real;未动 + excerpt 含 `Hook timed out in 20000ms` + job `build · windows-latest` ⇒ `flake:win-hook-timeout`;同症状但 job 是 `build · macos-latest` ⇒ unknown;`files` glob 限定(`routes-workbench*.test.ts` 匹配 `src/daemon/internal-api/routes-workbench-upload.test.ts`,不匹配 `src/x.test.ts`);`secondRun: true` ⇒ real 哪怕症状匹配。
5. `classifyJob`:failedStep `Typecheck` ⇒ 一条 real,failure null;`Run tests` + 空 failures + `hasSummary:false` + job `node · core suite` ⇒ `flake:node-no-summary`;同样但 job `build · ubuntu-latest` ⇒ unknown。
6. `verdictOf`:`[]` ⇒ green;`[flake, flake]` ⇒ flake;`[flake, real]` ⇒ real;`[flake, unknown]` ⇒ unknown。
7. `pickBaseSha`:跳过 `conclusion:'failure'` 与 `headSha === sha`;`isAncestor` 为 false 时继续找;都不满足 ⇒ null。
8. `globToRegExp('src/**/x*.test.ts')` 匹配 `src/a/b/x1.test.ts`,不匹配 `src/x1.test.tsx`。
9. `formatTriage` 第一行形状与 unknown 的 excerpt 缩进。

- [ ] **Step 3: 跑测试确认失败** — `bun x vitest run src/cli/ci-triage.test.ts src/cli/ci-flakes.test.ts` ⇒ 找不到模块。
- [ ] **Step 4: 实现 `src/cli/ci-triage.ts`** 直到全绿;`npx vitest run -c vitest.node.config.ts src/cli/ci-triage.test.ts src/cli/ci-flakes.test.ts` 也绿。
- [ ] **Step 5: `bun run typecheck`;提交** `feat(ci): triage 纯逻辑 + flake 登记表`。

---

### Task 2: `wechat-cc ci triage` 外壳 + ci.yml + 文档

**Files:**
- Create: `src/cli/ci-triage-run.ts`
- Modify: `cli.ts`(新根命令 `ci`,子命令 `triage`;`HELP_TEXT` 加一行)、`cli.test.ts`(根命令表加 `ci`;新 `it` 钉 `subs.ci.subCommands === ['triage']`)
- Modify: `.github/workflows/ci.yml`
- Create: `scripts/ci-workflow.guard.test.ts`
- Modify: `docs/maintainer/ci-and-flakes.md`、`docs/maintainer/README.md`、`docs/maintainer/verify.md`、`AGENTS.md`
- Test: `src/cli/ci-triage-run.test.ts`

**Interfaces (Produces):**

```ts
// src/cli/ci-triage-run.ts
export interface CiTriageDeps {
  exec: (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => { code: number | null; stdout: string; stderr: string }  // 内部 spawnSync 带 windowsHide:true
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (line: string) => void
  registry: FlakeRegistry            // 缺省 = import ci-flakes.json 经 validateRegistry
  cwd: string                        // git 仓库
}
export interface CiTriageOpts { sha?: string; branch?: string; wait?: boolean; rerun?: boolean; maxReruns?: number; timeoutMin?: number }
export const CI_TRIAGE_EXIT = { green: 0, real: 1, noRun: 2, flake: 3 } as const
export async function runCiTriage(deps: CiTriageDeps, opts: CiTriageOpts): Promise<{ report: TriageReport; exitCode: 0 | 1 | 2 | 3 }>
export function defaultCiTriageDeps(cwd: string): CiTriageDeps
```

算法照 spec §3:`git rev-parse <sha|HEAD>` → 40 位;`gh run list --commit <sha> --workflow CI --json databaseId,status,conclusion,headSha,url,createdAt --limit 5` 取 `createdAt` 最新;没有且 `wait` ⇒ 每 15 s 重查最多 2 分钟;仍没有 ⇒ `noRun`。`wait` ⇒ 每 30 s `gh run view <id> --json status,conclusion` 到 `completed`,总上限 `timeoutMin`(缺省 30)。成功 ⇒ green。失败 ⇒ `gh run view <id> --json jobs`(每个 job:`name, databaseId, conclusion, steps[{name,conclusion}]`),对 `conclusion === 'failure'` 的 job:失败步骤 = 第一个 `conclusion === 'failure'` 的 step 名;`gh run view --job <databaseId> --log-failed` 取日志;base = `pickBaseSha(gh run list --branch <branch> --workflow CI --status success --limit 30 --json headSha,conclusion, sha, (a,b) => git merge-base --is-ancestor a b 退出 0)` 或 `<sha>~1`;`changedFiles = git diff --name-only <base> <sha>`。verdict 为 flake 且 `rerun` 且 `reruns < maxReruns`(缺省 1)⇒ `gh run rerun <id> --failed`,`reruns++`,若 `wait` 则等完并以 `secondRun: true` 重新分类同一 run。退出码按 `CI_TRIAGE_EXIT`(unknown 也是 1)。`branch` 缺省 = `git rev-parse --abbrev-ref HEAD`。

`ci.yml` 改动:`push.branches: [master, dev, 'self/**']`;新作业 `changes`(`runs-on: ubuntu-latest`,`actions/checkout@v4` + `dorny/paths-filter@v3`,`id: filter`,`filters: | desktop: - 'apps/desktop/**'`,`outputs: desktop: ${{ steps.filter.outputs.desktop }}`);`desktop-e2e` 加 `needs: changes` 与 `if: github.base_ref == 'master' || github.ref == 'refs/heads/master' || needs.changes.outputs.desktop == 'true'`。`e2e` 不动。

`scripts/ci-workflow.guard.test.ts`(参考 `scripts/release-pipeline.guard.test.ts` 的写法,用 `yaml` 包解析):push 分支含 `self/**`;`jobs.changes` 存在且其 paths-filter 步骤的 `with.filters` 含 `apps/desktop/**`;`jobs['desktop-e2e'].needs` 含 `changes`,`if` 含 `needs.changes.outputs.desktop == 'true'`;所有 `oven-sh/setup-bun@v2` 步骤 `with['bun-version'] === '1.3.14'`。

`src/cli/ci-triage-run.test.ts`:用假 `exec`(按 `cmd+args[0..2]` 分派返回固定 JSON / 日志字符串)覆盖:green;real(失败文件在 changedFiles);flake + `rerun:true` ⇒ 调了 `gh run rerun <id> --failed` 且 `reruns === 1`,第二次仍红 ⇒ verdict real、exitCode 1;`--wait` 下 `in_progress` → `completed` 的轮询次数;没有 run ⇒ `noRun`。断言 `exec` 的调用序列里 `gh run list --commit` 用的是 40 位 sha。

文档:`ci-and-flakes.md` 的「已知 flake 类别」改为「以 `src/cli/ci-flakes.json` 为准,人读摘要如下」,「处置」改为 `wechat-cc ci triage --wait --rerun`(退出码 0/1/2/3,两次红就是真红,`unknown` 不会自动重跑),加「怎么加一条 flake」(id / symptom / jobs / files / note / since + `bun x vitest run src/cli/ci-flakes.test.ts`);README / AGENTS / verify 的「看 CI」行改成 `wechat-cc ci triage --wait --rerun`。

- [ ] Step 1: 写 `src/cli/ci-triage-run.test.ts` 与 `scripts/ci-workflow.guard.test.ts`,跑一遍确认红。
- [ ] Step 2: 实现 `ci-triage-run.ts`;改 `ci.yml`;cli.ts 加 `ci triage`(args:`sha`, `branch`, `wait`(bool), `rerun`(bool), `max-reruns`, `timeout-min`, `json`;`run` 里 `defaultCiTriageDeps(process.cwd())`,`--json` 打 report,否则 `formatTriage`,`process.exit(exitCode)`);cli.test.ts 更新。
- [ ] Step 3: 文档四处。
- [ ] Step 4: 真机核对(不进测试):`bun cli.ts ci triage --sha 25113589` ⇒ `real`,指到 `src/cli/selftest.test.ts`;`--sha 15cb7c37` ⇒ green。把两条输出的第一行贴进报告。
- [ ] Step 5: typecheck + 测试 + 提交 `feat(ci): wechat-cc ci triage + desktop-e2e 按路径在 dev 上跑 + self/** 分支进 CI`。

---

### Task 3: daemon 侧三条路由(通知 / 问主人 / 查决定)

**Files:**
- Create: `src/daemon/self-change-glue.ts`
- Create: `src/daemon/internal-api/routes-self-change.ts`
- Modify: `src/daemon/internal-api/types.ts`(`selfChange?: SelfChangeDep`)、`src/daemon/internal-api/index.ts`(挂路由,照 `permissionRoutes(deps)` 的挂法)、`route-tiers.ts`、`token-registry.ts`、`src/daemon/main.ts`(wire)
- Test: `src/daemon/self-change-glue.test.ts`、`src/daemon/internal-api/routes-self-change.test.ts`、`route-tiers.test.ts`、`token-registry.test.ts`

**Interfaces (Produces):**

```ts
// src/daemon/self-change-glue.ts
export type SelfChangeDecision = 'pending' | 'allow' | 'deny' | 'timeout' | 'undelivered' | 'unknown'
export interface SelfChangeDep {
  notice(text: string): Promise<{ ok: true } | { ok: false; error: 'owner_chat_unknown' | 'send_failed' }>
  ask(prompt: string, timeoutMs: number): Promise<{ ok: true; hash: string; code: string | null } | { ok: false; error: 'owner_chat_unknown' }>
  decision(hash: string): SelfChangeDecision
}
export interface SelfChangeGlueDeps {
  ownerChatId: () => string | null
  sendMessage: (chatId: string, text: string) => Promise<unknown>
  askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow' | 'deny' | 'timeout' | 'undelivered'>
  codeOf: (hash: string) => string | null
  newHash: () => string           // 缺省 randomBytes(8).toString('hex')
  now: () => number
  retainMs?: number               // 缺省 60 分钟:决定落定后还能查多久
}
export function makeSelfChangeGlue(deps: SelfChangeGlueDeps): SelfChangeDep
```

`ask`:没有 owner ⇒ `owner_chat_unknown`;否则 `hash = newHash()`,`decided.set(hash, 'pending')`,`void askUser(owner, prompt, hash, timeoutMs).then(d => decided.set(hash, d))`,返回 `{ hash, code: codeOf(hash) }`(`codeOf` 在 `askUser` 注册之后才有值——`askUser` 内部先 `register` 再发卡,所以 `await` 一个 microtask 或让 `askUser` 返回前就已注册;实现时确认 `ilink-glue.ts:417` 的顺序:`register` 是同步第一句,所以 `ask` 里 `askUser(...)` 调用返回 promise 后立即 `codeOf(hash)` 即可)。`decision(hash)`:`decided.get(hash) ?? 'unknown'`;落定的条目 `retainMs` 后清掉(每次 `ask`/`decision` 时顺手 sweep)。

路由(`routes-self-change.ts`):`POST /v1/self-change/notice`(body `{ text }`,非空字符串 ≤ 4000;503 `self_change_not_wired`;409 `owner_chat_unknown`)、`POST /v1/self-change/ask`(body `{ prompt, timeoutMs }`,`timeoutMs` 整数 60_000..86_400_000*2;返回 `{ hash, code }`)、`GET /v1/self-change/decision?hash=`(`{ decision }`)。三条都 `admin`,都进 operator `routeAllow`。

`main.ts` 接线:在 `permissions:` 旁边加 `selfChange: makeSelfChangeGlue({ ownerChatId: () => loadCompanionConfig(STATE_DIR).default_chat_id ?? null, sendMessage: (c, t) => ilink.sendMessage(c, t), askUser: (c, p, h, t) => ilink.askUser(c, p, h, t), codeOf: (h) => ilink.pendingPermissionCodeOf(h), newHash: ..., now: Date.now })`——`ilink` 上如果没有暴露 `codeOf`,加一个薄转发(`pending.codeOf`),照 `listPendingPermissions` 的先例。

测试:glue 用假件覆盖 `ask` 返回 hash+code、`decision` 从 pending 到 allow、timeout 传递、retain 过期后 `unknown`、无 owner 的 409;routes 测试照 `routes-permissions.test.ts` 的写法覆盖 400 / 503 / 200;`route-tiers.test.ts` 与 `token-registry.test.ts` 的精确集合各加三条。

- [ ] Step 1 测试先红 → Step 2 实现 → Step 3 接线 → Step 4 typecheck + 测试 + 提交 `feat(self-change): daemon 侧通知 / 问主人 / 查决定三条路由`。

---

### Task 4: 配置、策略、状态、锁

**Files:**
- Modify: `src/lib/agent-config.ts`(`self_change` 字段 + zod + load 路径)
- Create: `src/cli/self-change/policy.ts`、`src/cli/self-change/state.ts`、`src/cli/self-change/config.ts`
- Test: `src/cli/self-change/policy.test.ts`、`state.test.ts`、`config.test.ts`、`src/lib/agent-config.test.ts`(加用例)

**Interfaces (Produces):**

```ts
// src/lib/agent-config.ts —— AgentConfig 加:
self_change?: {
  repo_url?: string; branch?: string; workdir?: string
  implement_budget_usd?: number; review_budget_usd?: number; max_turns?: number
  max_per_day?: number; approval_timeout_h?: number
  selftest_executor?: string; selftest_provider?: string
  halted_at?: number; halt_reason?: string; fail_streak?: number
}
// zod: z.object({...全部 optional,数字 positive,budget 允许小数,max_turns/max_per_day/fail_streak int}).strict().optional()
// load 路径:typeof parsed.self_change === 'object' && parsed.self_change !== null ⇒ 透传经 schema.safeParse 过滤,失败就丢掉整块并 log

// src/cli/self-change/policy.ts
export const FORBIDDEN_GLOBS: readonly string[]   // spec §guard 的清单,含 'src/cli/self-change/policy.ts' 与 'src/cli/self-deploy.ts'
export function forbiddenPaths(changed: readonly string[]): string[]   // 用 ci-triage 的 globToRegExp
export const SELF_CHANGE_DEFAULTS = { branch: 'dev', implement_budget_usd: 20, review_budget_usd: 5, max_turns: 300, max_per_day: 5, approval_timeout_h: 24, selftest_executor: 'claude', selftest_provider: 'claude', max_fix_rounds: 2, tests_timeout_ms: 20 * 60_000, halt_after_fail_streak: 2 } as const
export function defaultWorkdir(homeDir: string, platform: NodeJS.Platform): string   // darwin: ~/Library/Caches/wechat-cc/self-change;其他:join(home, '.cache', 'wechat-cc', 'self-change')

// src/cli/self-change/config.ts
export interface SelfChangeConfig { repoUrl: string; branch: string; workdir: string; implementBudgetUsd: number; reviewBudgetUsd: number; maxTurns: number; maxPerDay: number; approvalTimeoutMs: number; selftestExecutor: string; selftestProvider: string; haltedAt: number | null; haltReason: string | null; failStreak: number }
export function resolveSelfChangeConfig(input: { agent: AgentConfig['self_change'] | undefined; homeDir: string; platform: NodeJS.Platform; originUrl: string | null; overrides?: Partial<Pick<SelfChangeConfig, 'implementBudgetUsd'>> }): { ok: true; config: SelfChangeConfig } | { ok: false; error: 'repo_url_unknown' }
export function writeSelfChangeConfigPatch(stateDir: string, patch: Partial<NonNullable<AgentConfig['self_change']>>): void   // load → spread → save,照 makeUnattendedAckStore

// src/cli/self-change/state.ts
export type SelfChangeStep = 'intake' | 'repo' | 'implement' | 'guard' | 'tests' | 'review' | 'ci' | 'approval' | 'merge' | 'deploy' | 'selftest' | 'report' | 'done'
export interface SelfChangeState { id: string; request: string; from: 'cli' | 'wechat'; branch: string; baseSha: string | null; step: SelfChangeStep; startedAt: number; updatedAt: number; noDeploy: boolean; implement: { sessionId: string | null; costUsd: number; turns: number; rounds: { tests: number; review: number; ci: number } }; review: { sessionId: string | null; costUsd: number; verdict: 'approve' | 'changes' | null; findings: ReviewFinding[] }; ci: { runId: number | null; url: string | null; verdict: string | null; sha: string | null }; approval: { hash: string | null; code: string | null; decision: string | null; askedAt: number | null }; merge: { sha: string | null; rebased: boolean }; deploy: { ok: boolean | null; version: string | null }; selftest: { workbench: boolean | null; chat: boolean | null }; result: string | null; error: string | null; stderrTail: string[]; notices: string[] }
export interface ReviewFinding { severity: 'critical' | 'important' | 'minor'; file?: string; line?: number; summary: string }
export function newState(input: { id: string; request: string; from: 'cli' | 'wechat'; noDeploy: boolean; now: number }): SelfChangeState
export interface StateStore { load(id: string): SelfChangeState | null; save(s: SelfChangeState): void; list(): SelfChangeState[]; countSince(ts: number): number }
export function makeStateStore(stateDir: string, fs = node:fs): StateStore        // 目录 STATE_DIR/self-change,原子写(.tmp + rename,0600)
export function acquireLock(stateDir: string, pid: number, fs, isAlive: (pid: number) => boolean): { ok: true; release: () => void } | { ok: false; holder: number }   // lock 文件含 pid;持有者不在世就抢
export function newSelfChangeId(random = crypto.randomBytes): string             // 8 位 hex
```

测试:`forbiddenPaths(['src/cli/self-change/policy.ts','src/x.ts'])` ⇒ 只有前者;`scripts/publish-update.platforms.ts` 命中;`docs/x.md` 不命中。`resolveSelfChangeConfig` 缺 originUrl 与 agent.repo_url ⇒ `repo_url_unknown`;缺省值填齐;`approvalTimeoutMs = h*3600e3`;overrides 生效。state store:save/load 往返、list 按 startedAt 倒序、`countSince` 只数 `startedAt ≥ ts`、原子写留下无 `.tmp`。lock:抢占死 pid、拒绝活 pid、release 删文件。agent-config:`self_change` 合法透传、非法(`max_turns: 'x'`)整块丢弃且其他字段不受影响。

- [ ] Step 1 测试 → Step 2 实现 → Step 3 typecheck + 测试 + 提交 `feat(self-change): 配置 / 策略 / 状态 / 锁`。

---

### Task 5: Claude 执行者适配 + daemon 客户端

**Files:**
- Create: `src/cli/self-change/runner.ts`、`src/cli/self-change/daemon-client.ts`、`src/cli/self-change/brief.ts`
- Test: `runner.test.ts`、`daemon-client.test.ts`、`brief.test.ts`

**Interfaces (Produces):**

```ts
// runner.ts
export interface RunnerInput { cwd: string; prompt: string; systemPromptFile?: string; budgetUsd: number; maxTurns: number; resume?: string; readOnly?: boolean; timeoutMs?: number }
export interface RunnerResult { ok: boolean; sessionId: string | null; text: string; costUsd: number; turns: number; stderrTail: string[]; error?: string }
export interface ImplementRunner { run(input: RunnerInput): Promise<RunnerResult> }
export interface ClaudeRunnerDeps {
  spawn: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>   // 内部 child_process.spawn 带 windowsHide:true,超时 SIGTERM 再 5 s SIGKILL
  env: NodeJS.ProcessEnv
  claudeBin?: string   // 缺省 'claude'
}
export function claudeArgs(input: RunnerInput): string[]
export function runnerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv      // workbenchSubprocessEnv(base) 再 delete CLAUDECODE / CLAUDE_CODE_ENTRYPOINT
export function parseClaudeJson(stdout: string): { sessionId: string | null; text: string; costUsd: number; turns: number; isError: boolean; subtype: string | null } | null   // 取 stdout 里最后一个能 JSON.parse 的行/整体
export function makeClaudeRunner(deps: ClaudeRunnerDeps): ImplementRunner

// daemon-client.ts
export type SelfChangeDecision = 'pending' | 'allow' | 'deny' | 'timeout' | 'undelivered' | 'unknown'   // 与 daemon 侧同名同值,故意复制:cli 层不 import daemon 层(depcheck 分层)
export interface DaemonClient { notice(text: string): Promise<boolean>; ask(prompt: string, timeoutMs: number): Promise<{ hash: string; code: string | null } | null>; decision(hash: string): Promise<SelfChangeDecision>; health(): Promise<boolean> }
export function makeDaemonClient(deps: { readApiInfo: () => ApiInfo | null; fetch: typeof fetch; timeoutMs?: number }): DaemonClient   // operator token;health 用 file token;每次调用重读 api-info(部署后会换)

// brief.ts
export function implementBrief(input: { id: string; branch: string; forbidden: readonly string[] }): string     // spec「系统追加提示」全文
export function fixPrompt(kind: 'tests' | 'review' | 'ci', detail: string): string
export function reviewPrompt(input: { request: string; branch: string; baseRef: string }): string               // 含输出契约
export function parseReviewVerdict(text: string): { verdict: 'approve' | 'changes'; findings: ReviewFinding[]; parsed: boolean }   // 最后一个 ```json 块;解析失败 ⇒ changes + parsed:false + finding summary = 原文前 20 行
```

`claudeArgs`:`['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--max-budget-usd', String(budget), '--max-turns', String(maxTurns)]` + (`resume` ⇒ `['--resume', resume]`)+(`systemPromptFile` ⇒ `['--append-system-prompt-file', path]`)+(`readOnly` ⇒ `['--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit']`)+ `[prompt]`。`run`:`code !== 0` 或 `parse` 失败或 `isError` ⇒ `ok:false`,`error` = `subtype ?? 'claude_exit_'+code`,`text` 尽量带上;stderrTail = stderr 最后 200 行。

测试:`claudeArgs` 四种组合;`runnerEnv` 删掉 `CLAUDECODE` 与 `WECHAT_*`、保留 `PATH`/`HOME`;`parseClaudeJson` 对「前面有噪声行 + 最后一行 JSON」、对纯 JSON、对无 JSON;`makeClaudeRunner` 用假 spawn:成功路径字段映射、非零退出、超时。daemon-client:用假 fetch 断言 URL / method / Authorization 头是 operator token(health 是 file token)、`ask` 的 body、非 2xx ⇒ null/false。brief:`parseReviewVerdict` 对多块取最后一块、severity 非法值归 `minor`、无块 ⇒ changes+parsed:false。

- [ ] Step 1 测试 → Step 2 实现 → Step 3 typecheck + 测试 + 提交 `feat(self-change): claude -p 执行者适配 + daemon 客户端 + 提示词`。

---

### Task 6: 步骤与运行器(含整合测试)

**Files:**
- Create: `src/cli/self-change/steps.ts`、`src/cli/self-change/run.ts`、`src/cli/self-change/git.ts`
- Test: `steps.test.ts`、`run.test.ts`、`run.integration.test.ts`

**Interfaces (Produces):**

```ts
// git.ts
export interface Git { run(args: string[], opts?: { cwd?: string; timeoutMs?: number }): { code: number | null; stdout: string; stderr: string } }
export function makeGit(spawnSync, cwd: string): Git   // windowsHide:true;env 去 GIT_* 照 git-review.ts 的 GitReader

// steps.ts —— 每步 (ctx) => Promise<StepOutcome>
export interface StepOutcome { ok: boolean; next?: SelfChangeStep; fail?: string; detail?: string; fixRound?: 'tests' | 'review' | 'ci'; fixPrompt?: string }
export interface PipelineDeps {
  config: SelfChangeConfig; state: StateStore; git: Git; runner: ImplementRunner; daemon: DaemonClient
  exec: (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>   // bun / npm / gh
  ciTriage: (opts: { sha: string; branch: string }) => Promise<{ report: TriageReport; exitCode: number }>
  deploy: (repoRoot: string) => Promise<SelfDeployResult>                    // 缺省:planSelfDeploy + executeSelfDeploy
  rollback: (repoRoot: string) => Promise<SelfDeployResult>                  // 缺省:同上但 binary = <sidecar>.prev
  selftest: () => Promise<{ workbench: SelftestReport; chat: SelftestReport }>
  fs: { exists(p: string): boolean; writeFile(p: string, s: string): void; mkdirp(p: string): void }
  now: () => number; sleep: (ms: number) => Promise<void>; log: (line: string) => void
  stateDir: string; homeDir: string
}
export const steps: Record<Exclude<SelfChangeStep, 'done'>, (s: SelfChangeState, d: PipelineDeps) => Promise<StepOutcome>>

// run.ts
export const SELF_CHANGE_EXIT = { done: 0, failed: 1, blocked: 2, declined: 3, approvalTimeout: 4 } as const
export async function runSelfChange(state: SelfChangeState, deps: PipelineDeps): Promise<{ state: SelfChangeState; exitCode: 0 | 1 | 2 | 3 | 4 }>
export function exitCodeFor(result: string | null): 0 | 1 | 2 | 3 | 4
```

步骤语义照 spec §流程(逐条实现,不要省):

- `intake`:`config.haltedAt` ⇒ fail `self_change_halted`(exit blocked);`state.countSince(今天 0 点)` ≥ maxPerDay ⇒ `self_change_quota`(blocked);`daemon.health()` false ⇒ `daemon_not_running`(blocked);`notice('自改 #id 开始:<需求前 80 字>')`;next `repo`。
- `repo`:`<workdir>/repo` 不存在 ⇒ `git clone <repoUrl> repo`(cwd workdir,mkdirp);存在 ⇒ `git fetch origin --prune`;`git reset --hard && git clean -fd`;`git checkout -B self/<id> origin/<branch>`;`baseSha = git rev-parse origin/<branch>`;`exec('bun', ['install','--frozen-lockfile'])`;写 brief 到 `<workdir>/briefs/<id>.md`;next `implement`。
- `implement`:`runner.run({ cwd: repo, prompt: request, systemPromptFile: brief, budgetUsd, maxTurns })`;记 sessionId/cost/turns;`!ok` ⇒ fail `implement_failed`;`git status --porcelain` 非空 ⇒ `git add -A && git commit -m "自改 #id:执行者未提交的改动"`(执行者忘了提交不算失败);`git rev-list --count origin/<branch>..HEAD` 为 0 ⇒ fail `no_changes`;next `guard`。
- `guard`:`git diff --name-only origin/<branch>...HEAD` → `forbiddenPaths` 非空 ⇒ fail `forbidden_paths`(detail 列文件);next `tests`。
- `tests`:依次 `bun run typecheck` / `bun run depcheck` / `bun run test` / `npm run test:node -- --reporter=dot`(cwd repo,`tests_timeout_ms`);第一条红 ⇒ `fixRound:'tests'`,`fixPrompt = fixPrompt('tests', 命令 + 去 ANSI 的输出尾巴 ≤ 200 行)`;全绿 ⇒ next `review`。
- `review`:`runner.run({ cwd, prompt: reviewPrompt(...), budgetUsd: reviewBudgetUsd, maxTurns: 100, readOnly: true })`;之后 `git status --porcelain` 非空或 HEAD 变了 ⇒ `git checkout -- . && git clean -fd`(HEAD 变了 ⇒ `git reset --hard <之前的 HEAD>`),verdict 强制 `changes`,加 finding `{severity:'important', summary:'评审会话改了工作树,已还原'}`;`parseReviewVerdict`;有 critical/important ⇒ `fixRound:'review'`,`fixPrompt('review', findings 列表)`;否则 next `ci`。
- `ci`:`git push -u --force origin self/<id>`;`sha = git rev-parse HEAD`;`ciTriage({ sha, branch })`;记 runId/url/verdict;`green` ⇒ next `approval`;否则 `fixRound:'ci'`,`fixPrompt('ci', formatTriage(report))`。
- 修复轮(在 `run.ts` 里统一处理):`state.implement.rounds[kind]++`;超过 `max_fix_rounds` ⇒ fail `<kind>_exhausted`;否则 `runner.run({ cwd, prompt: fixPrompt, resume: implement.sessionId, budgetUsd: implementBudgetUsd(每轮同额,简单起见), maxTurns })`,`!ok` ⇒ fail `implement_failed`;工作树脏 ⇒ 自动提交;然后 `step = 'guard'`。
- `approval`:`prompt` = 拍板卡(需求 / 分支 / `git diff --stat origin/<branch>...HEAD` 前 15 行 / 测试 4 条绿 / 评审 verdict + minor 列表 / CI url / 费用合计 / 最后一行由 daemon 的 `askUser` 追加「回 y/n」);`daemon.ask(prompt, approvalTimeoutMs)` ⇒ null 时 fail `owner_chat_unknown`(blocked);记 hash/code/askedAt;每 20 s `decision(hash)`(进程内等,总时长 approvalTimeoutMs + 30 s):`allow` ⇒ next `merge`;`deny` ⇒ result `declined`;`timeout`/`undelivered` ⇒ result `approval_timeout`;`unknown`(daemon 重启丢了)⇒ 重新 `ask` 一次,再丢 ⇒ `approval_timeout`。
- `merge`:`git fetch origin`;`git rebase origin/<branch>`(失败 ⇒ `git rebase --abort`,fail `merge_conflict`);`rebased = (HEAD ≠ ci.sha)`;`git checkout <branch>` → `git reset --hard origin/<branch>` → `git merge --ff-only self/<id>` → `git push origin <branch>` → `git push origin --delete self/<id>`(删远端失败只 log);`merge.sha`;`notice('自改 #id 已合入 dev(<sha 8 位>),开始部署')`;`noDeploy` ⇒ next `report`,否则 `deploy`。
- `deploy`:`exec('bun', ['run','build-sidecar'], { cwd: join(repo,'apps','desktop') })`;`deploy(repo)`;`!ok` ⇒ `failStreak+1` 写回 agent-config,fail `deploy_failed`;next `selftest`。
- `selftest`:`selftest()`;任一 `ok:false` ⇒ `rollback(repo)`,`failStreak+1`,fail `selftest_failed_rolled_back`(detail 里写「dev 上的提交 <sha> 需要人处理」);两个都 ok ⇒ `failStreak = 0` 写回,next `report`。
- `report`:`notice` 一条汇总(结果、sha、费用、selftest 两项、`ci_sha ≠ merge_sha` 时注明);state `done`。
- `run.ts`:循环 `steps[state.step]`,每步前后 `state.save`,`fail` ⇒ `state.result = fail`,`notice('自改 #id 失败:<fail> <detail 前 200 字>')`;`failStreak ≥ halt_after_fail_streak` ⇒ 写 `halted_at`/`halt_reason`。任何步骤抛异常 ⇒ result `crashed`,error = message,exit failed。`exitCodeFor`:`done`→0;`declined`→3;`approval_timeout`→4;`self_change_halted|self_change_quota|daemon_not_running|owner_chat_unknown`→2;其余→1。

`run.integration.test.ts`(darwin/linux 跑,win32 `skipIf`;用真 git):`makeTempDir` 里 `git init --bare remote.git`,再 clone 出一个 seed 工作树写 `AGENTS.md` + `package.json` 提交到 `dev` 并 push;`workdir` 指向另一个临时目录;`runner` 假件:第一次 run 在 cwd 写 `docs/x.md` 并 `git commit`,`resume` 调用写 `docs/y.md` 并提交,`readOnly` 调用返回评审 JSON(第一次 important、第二次 approve);`exec` 假件:`bun run test` 第一次返回 code 1(stdout 含 `FAIL src/a.test.ts`),之后 0;`ciTriage` 返回 green;`daemon` 假件记录 notices、`ask` 返回 hash、`decision` 第三次返回 allow;`deploy`/`selftest` 假件 ok。断言:远端 `dev` 的 HEAD 包含 `docs/x.md` 与 `docs/y.md`;远端没有 `self/<id>` 分支;`state.implement.rounds` 是 `{tests:1, review:1, ci:0}`;`state.result === 'done'`;notices 顺序含「开始」「已合入」「完成」;第二个用例:`decision` 返回 deny ⇒ `declined`、远端 dev 未变;第三个:`forbiddenPaths` 命中(runner 改 `src/cli/self-deploy.ts`)⇒ `forbidden_paths`,远端 dev 未变。

`steps.test.ts`:每步用假件覆盖分支(intake 三种 blocked;implement 自动提交与 no_changes;review 脏工作树还原;approval unknown 后重问;merge 冲突 abort;selftest 失败回滚 + failStreak;halt 触发)。

- [ ] Step 1 写 `steps.test.ts` / `run.test.ts` / 整合测试 → Step 2 实现 `git.ts`、`steps.ts`、`run.ts` → Step 3 typecheck + 三平台可跑(win32 skip 整合)+ 提交 `feat(self-change): 步骤与运行器`。

---

### Task 7: `wechat-cc self change` 命令 + 文档

**Files:**
- Modify: `cli.ts`(`self` 下加 `change`;`HELP_TEXT`)、`cli.test.ts`
- Create: `src/cli/self-change/index.ts`(`defaultPipelineDeps(stateDir, config)`:真 git / spawn / fetch / runCiTriage / planSelfDeploy+executeSelfDeploy / runWorkbenchSelftest+runChatSelftest)
- Create: `docs/maintainer/self-change.md`;Modify: `docs/maintainer/README.md`、`AGENTS.md`
- Test: `src/cli/self-change/index.test.ts`(只测 `defaultPipelineDeps` 的 rollback 计划把 binary 指到 `.prev`、selftest 用配置里的 executor/provider)

命令:`self change [request] --resume <id> --list --unhalt --json --from cli|wechat --budget-usd N --no-deploy`。`run`:非 darwin ⇒ 2;`--unhalt` ⇒ 清 `halted_at/halt_reason/fail_streak`,打印;`--list` ⇒ 最近 10 条 `id · step · result · startedAt`;`--resume` ⇒ load state(没有 ⇒ 1);否则需要 request 非空;`resolveSelfChangeConfig`(originUrl:源码模式 `git -C <repoRoot> remote get-url origin`,打包版 null);`acquireLock`;`runSelfChange`;`--json` 打 state,否则打人读摘要;`process.exit(exitCode)`。

`docs/maintainer/self-change.md`:一句话、命令表、五道闸门、修复轮上限、退出码、停机与 `--unhalt`、禁改清单、费用与 `--budget-usd`、`--no-deploy`、状态文件位置、微信「自改」用法、已知限制(rebase 后不重跑 CI;一次一条;darwin-only;打包版必须配 `self_change.repo_url`)。README 与 AGENTS 加一行入口。

- [ ] Step 1 cli.test 先红(`['change','deploy']`)→ Step 2 实现 → Step 3 文档 → Step 4 typecheck + 测试 + 提交 `feat(self-change): wechat-cc self change 命令 + 维护者手册`。

---

### Task 8: 微信进件口「自改」

**Files:**
- Modify: `src/daemon/admin-commands.ts`(`SELF_CHANGE_RE = /^\s*自改\s+([\s\S]+)$/`、`SELF_CHANGE_STATUS_RE = /^\s*自改\s*(状态|列表)\s*$/`;`isAdminCommandText` 认这两条)
- Create: `src/daemon/self-change-spawn.ts`
- Modify: `src/daemon/wiring/pipeline-deps.ts`(给 `makeAdminCommands` 传 `selfChange: { start, list }`)
- Test: `src/daemon/self-change-spawn.test.ts`、`src/daemon/admin-commands.test.ts`(加用例)

```ts
// self-change-spawn.ts
export function resolveSelfCli(input: { compiled: boolean; execPath: string; repoRoot: string; bunPath: string | null; exists: (p: string) => boolean }): { cmd: string; args: string[] } | { error: 'self_cli_not_found' | 'bun_not_found' }
// 源码:{ cmd: bunPath, args: [join(repoRoot,'cli.ts')] };打包:{ cmd: join(dirname(execPath),'wechat-cc-cli'), args: [] }
export function makeSelfChangeSpawner(deps: { resolve: () => ReturnType<typeof resolveSelfCli>; spawn: typeof child_process.spawn; env: NodeJS.ProcessEnv; stateDir: string; log: (l: string) => void }): { start(request: string): { ok: true; pid: number } | { ok: false; reason: string }; list(): SelfChangeState[] }
// start:spawn(cmd, [...args, 'self', 'change', '--from', 'wechat', '--json', request], { detached: true, stdio: 'ignore', windowsHide: true, env: workbenchSubprocessEnv(env) }); child.unref()
```

admin 命令:`自改 <需求>` ⇒ 非 admin 丢弃(既有守卫);`selfChange.start(text)`;ok ⇒ 回「自改开始了(pid N),进展会发到这里;说「自改 状态」看进度。」;失败 ⇒ 回「这台机器没法自改:<reason>」。`自改 状态` ⇒ `list()` 最近 5 条 `#id · <step> · <result ?? '进行中'>`,没有 ⇒ 「还没有自改记录」。

测试:`resolveSelfCli` 三种;spawner 用假 spawn 断言 args 序列与 `detached:true`、env 里没有 `WECHAT_*`;admin-commands 用例照文件里既有测试的写法(`自改 x` 调了 start;非 admin 不调;`自改 状态` 列表文案)。

- [ ] Step 1 测试 → Step 2 实现 → Step 3 typecheck + 测试 + 提交 `feat(self-change): 微信「自改 <需求>」进件口`。

---

## 收尾(由控制器做,不派发)

1. 全量 `bun run test` / `npm run test:node` / typecheck / depcheck;推 dev;`bun cli.ts ci triage --wait --rerun`。
2. 真机 dogfood:`bun cli.ts self change --json "在 docs/maintainer/ci-and-flakes.md 的已知 flake 表末尾加一行:「selftest 的 basename 假红」是 2026-09-18 发现的测试夹具问题,已修"`,拍板用 `POST /v1/permissions/resolve {hash, decision:'allow'}`;看 dev 合入、部署、selftest;再跑一条 `--no-deploy`。
3. `docs/cc-workbench.md` 不动(不是工作台);`docs/superpowers/specs/2026-09-18-self-change-pipeline-design.md` 末尾加「修订记录」。
