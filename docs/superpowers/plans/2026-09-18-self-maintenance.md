# 自维护三件套 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wechat-cc selftest`(工作台 / 测试对话真机闭环)、`wechat-cc self deploy`(原子换 sidecar + 健康门 + 回滚)、`docs/maintainer/` 手册 + ACP spike fixture 与回放契约测试。

**Architecture:** daemon 加一条 admin 路由 `POST /v1/selftest/converse`(代 spawn 一次测试对话);CLI 加 `selftest` 与 `self` 两个命名空间,逻辑放 `src/cli/selftest.ts` / `src/cli/self-deploy.ts`(依赖注入,纯逻辑可测);文档与 fixture 独立。

**Tech Stack:** TypeScript / Bun 1.3.14 + Node 24(vitest)、citty(`cli.ts` 的 `defineCommand`)、launchctl。

**Spec:** `docs/superpowers/specs/2026-09-18-self-maintenance-design.md`

## Global Constraints

- 仓库 `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit`,分支 `dev`;不碰兄弟工作树。测试 `bun --bun vitest run <paths>`;`bun run typecheck`;`bun run depcheck`(0 errors / 7 warnings 既有);业务代码不 import `bun:*`、不用 Bun 全局(CLI 与 daemon 都算业务代码;生成 PNG 用 `node:zlib`)。
- 新路由 `POST /v1/selftest/converse` 登记:`route-tiers.ts`(admin)、`token-registry.ts` operator routeAllow + `token-registry.test.ts` 精确集合;**不**登记 `lib.rs` / `workbench-proxy.ts`(桌面不调)。
- 测试对话的会话钥匙 routeAllow 只含 `GET /v1/health`;`permissionMode:'dangerously'`、tier trusted、chatId = sessionKey(`selftest/<uuid>`)、alias `selftest`。
- `self deploy` 的 swap 必须 `copyFile` 到 `.new` 再 `rename` 覆盖(换 inode),注释里写明 2026-09-17 真机 SIGKILL 原因。只支持 darwin。
- fixture 脱敏:`WECHAT_SESSION_TOKEN` value ⇒ `<redacted>`;`/Users/<用户名>` ⇒ `/Users/owner`;`WECHAT_INTERNAL_TOKEN_FILE` value ⇒ `/Users/owner/.claude/channels/wechat/internal-token`。提交前 `rg -n "nategu|601809" src/core/acp/fixtures/` 必须为空。
- 提交信息中文,末尾两行:`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_0192qR5eDp28Cz3Xg66oEu6c`。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/daemon/selftest.ts`(新)+ test | `runSelftestConverse(deps, input)` |
| `src/daemon/internal-api/types.ts`、`routes-daemon-control.ts`、`route-tiers.ts`、`token-registry.ts`(+test)、`src/daemon/main.ts` | 路由与接线 |
| `src/cli/selftest.ts`(新)+ test | `runWorkbenchSelftest` / `runChatSelftest` / `redSquarePng` |
| `src/cli/self-deploy.ts`(新)+ test | `planSelfDeploy` / `executeSelfDeploy` / `parseLaunchAgentPlist` |
| `cli.ts` | `selftest` 与 `self` 命名空间 |
| `docs/maintainer/*.md`、`AGENTS.md`、`CLAUDE.md` | 手册 |
| `scripts/acp-fixture-from-transcript.ts`、`src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`、`src/core/acp/fixtures.test.ts` | fixture 与回放测试 |

---

### Task 1: daemon 测试对话路由

**Files:**
- Create: `src/daemon/selftest.ts`、`src/daemon/selftest.test.ts`
- Modify: `src/daemon/internal-api/types.ts`(`selftestConverse?`)、`src/daemon/internal-api/routes-daemon-control.ts`(路由)、`src/daemon/internal-api/route-tiers.ts`、`src/daemon/internal-api/token-registry.ts` + `token-registry.test.ts`、`src/daemon/main.ts`(thunk-over-bootRef 接线,照 `forgetProviderSessions` 那几行的姿势)
- Test: `src/daemon/internal-api/routes-daemon-control.test.ts`(追加)、`src/daemon/internal-api/route-tiers.test.ts`(若有精确表则追加)

**Interfaces:**
- Consumes: `ProviderRegistry.get(id)?.provider.spawn(project, ctx)`;`collectTurn`(`src/core/agent-provider.ts`);`sessionAuthEnv`、`TIER_PROFILES`(`src/core/user-tier.ts`);`InternalApi.mintSessionToken(tier, key, opts)` / `invalidateSession(key)`(main.ts 里 `internalApi` 已有这两个,见 wire-workbench 的用法)。
- Produces:
  ```ts
  export interface SelftestConverseResult { ok: boolean; providerId: string; sessionId: string | null; texts: string[]; toolCalls: string[]; error?: string; errorCode?: string; durationMs: number }
  export interface SelftestConverseDeps { registry: Pick<ProviderRegistry, 'get'>; mintSessionToken: (tier: UserTier, key: string, opts?: { routeAllow?: ReadonlySet<string> }) => string; invalidateSession: (key: string) => void; stateDir: string; log: (tag: string, line: string) => void; now?: () => number }
  export async function runSelftestConverse(deps: SelftestConverseDeps, input: { providerId: string; text: string; resumeSessionId?: string; timeoutMs?: number }): Promise<SelftestConverseResult>
  // types.ts
  selftestConverse?: (input: { providerId: string; text: string; resumeSessionId?: string }) => Promise<SelftestConverseResult>
  ```

- [ ] **Step 1: 写失败的测试**

`src/daemon/selftest.test.ts`(用 `makeFakeSession` from `src/core/test-helpers` 或手写假 provider):
- 成功:假 provider 的 `spawn` 记录 ctx;返回事件 `text('pong 42')`、`tool_call {server:'wechat', tool:'ping'}`、`result {sessionId:'s1'}` ⇒ 结果 `{ ok:true, sessionId:'s1', texts:['pong 42'], toolCalls:['wechat/ping'] }`;断言 `mintSessionToken` 被调用为 `('trusted', 匹配 /^selftest\//, { routeAllow: Set(['GET /v1/health']) })`;ctx 里 `permissionMode:'dangerously'`、`chatId === sessionKey`、`mcpEnv.WECHAT_SESSION_TOKEN === 铸出的 token`、`mcpEnv.WECHAT_SESSION_TIER === 'trusted'`、`appendInstructions` 含「自检」;`invalidateSession(sessionKey)` 与 `session.close()` 都被调;project.path 是 `<stateDir>/selftest/project` 且该目录存在。
- `resumeSessionId` 传入 ⇒ ctx 带它。
- provider 不存在 ⇒ `{ ok:false, error:'unavailable_provider' }`,不 mint。
- 事件里有 `error {message:'boom', code:'auth_failed'}` ⇒ `ok:false, error:'boom', errorCode:'auth_failed'`。
- `close()` 抛 ⇒ 结果照常返回,`log` 有一行。

`routes-daemon-control.test.ts` 追加:未接线 503 `selftest_not_wired`;`providerId` 非法 / `text` 空 / 超长 ⇒ 400;接线后 200 原样透传假结果。`token-registry.test.ts` 精确集合加 `'POST /v1/selftest/converse'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/selftest.test.ts src/daemon/internal-api/routes-daemon-control.test.ts src/daemon/internal-api/token-registry.test.ts`

- [ ] **Step 3: 实现**(按 spec §1;`selftest/project` 目录用 `mkdirSync({recursive:true})` + 不存在时写 `README.md` 一行「selftest scratch project」)

- [ ] **Step 4: 跑测试确认通过** + `bun run typecheck`

- [ ] **Step 5: 提交** `git commit -m "自检:daemon 测试对话路由 POST /v1/selftest/converse(代 spawn 一轮,钥匙只许 health)"`

---

### Task 2: CLI `selftest`

**Files:**
- Create: `src/cli/selftest.ts`、`src/cli/selftest.test.ts`
- Modify: `cli.ts`(`selftestCmd` 命名空间:`workbench` / `chat` 子命令;挂进 root 的 subCommands)

**Interfaces:**
- Consumes: Task 1 的路由(`POST /v1/selftest/converse`);工作台路由 `POST /v1/workbench/attachment { id, draftId, name, mime, base64 }`、`POST /v1/workbench/create { path, providerId, title, text, draftId?, attachmentIds? }`(202 `{task}`)、`GET /v1/workbench/task?id=&since=&wait_ms=`(`{task:{status,phase,error}, events:[{id,kind,text,activity?}], permissions:[{id,tool,description}], version}`)、`POST /v1/workbench/permission { id, requestId, decision:'allow' }`、`POST /v1/workbench/continue { id, text }`、`POST /v1/workbench/archive { id, archived:true }`;`GET /v1/health` 用 file token。
- Produces:
  ```ts
  export interface SelftestCheck { name: string; ok: boolean; detail?: string }
  export interface SelftestReport { ok: boolean; kind: 'workbench' | 'chat'; target: string; checks: SelftestCheck[]; taskId?: string; sessionId?: string; durationMs: number; scratchPath?: string }
  export interface SelftestDeps { fetch: typeof globalThis.fetch; readApiInfo: () => { baseUrl: string; token: string; operatorToken: string } | null; stateDir: string; now: () => number; sleep: (ms: number) => Promise<void>; fs: { mkdir(p: string): void; write(p: string, text: string | Uint8Array): void; read(p: string): string | null; rm(p: string): void }; git?: (args: string[], cwd: string) => boolean; log: (line: string) => void }
  export function redSquarePng(size?: number): Uint8Array
  export async function runWorkbenchSelftest(deps: SelftestDeps, opts: { executor: string; image?: boolean; resume?: boolean; timeoutMs?: number; keep?: boolean }): Promise<SelftestReport>
  export async function runChatSelftest(deps: SelftestDeps, opts: { provider: string; text?: string; resume?: boolean; timeoutMs?: number }): Promise<SelftestReport>
  export function formatSelftestReport(r: SelftestReport): string
  export const SELFTEST_EXIT = { ok: 0, failed: 1, noDaemon: 2 } as const
  ```

- [ ] **Step 1: 写失败的测试**(假 fetch:按 `${method} ${pathname}` 分发,记录 body 序列;任务详情按调用次数返回递进状态)
  - workbench 成功路径:六项全 ✓(`created`、`replied`、`text_seen`、`activity_seen`、`permission_roundtrip`、`file_written`、`no_error_event`);断言 create body 的 `providerId`/`path`、permission 被 allow、最后 archive 被调、scratch 目录被删(非 keep)。
  - `--image`:upload body 的 `base64` 解码后前 8 字节是 PNG 签名、`mime:'image/png'`;create 带 `draftId` 与 `attachmentIds`;检查项含 `answer_mentions_red`(events 里 text 含「红」⇒ ✓)。
  - `--resume`:continue 被调且 `resume_replied` ✓。
  - 任务 failed ⇒ `replied` ✗、`ok:false`。
  - `readApiInfo` 返回 null ⇒ 抛 `Error('daemon_not_running')`(cli 层映射到退出码 2)。
  - chat 成功:`POST /v1/selftest/converse` body 正确;`tool_seen` 看 `toolCalls` 含 `wechat/ping`;`--resume` 第二次 body 带 `resumeSessionId`。
  - `redSquarePng()`:长度 > 100,前 8 字节 `89 50 4E 47 0D 0A 1A 0A`,含 `IHDR`/`IDAT`/`IEND`。
  - `formatSelftestReport`:含 `✓`/`✗` 与末行 `PASS`/`FAIL`。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**(按 spec §2;`readApiInfo` 的真实现:读 `STATE_DIR/internal-api-info.json` 的 `baseUrl`、`tokenFilePath`、`operatorTokenFilePath` 并读两份 token 文件;`cli.ts` 里 `selftest workbench --executor <id> [--image] [--resume] [--json] [--timeout-ms] [--keep]` 与 `selftest chat --provider <id> [--text] [--resume] [--json]`,退出码按 `SELFTEST_EXIT`)

- [ ] **Step 4: 跑测试确认通过** + `bun run typecheck` + `bun --bun vitest run src/cli/cli-routes.test.ts`(若它枚举了根命令则加进去)

- [ ] **Step 5: 提交** `git commit -m "自检:wechat-cc selftest workbench|chat —— 真机闭环的机器可读结论(图片 / 续接 / 权限卡自动放行)"`

---

### Task 3: CLI `self deploy`

**Files:**
- Create: `src/cli/self-deploy.ts`、`src/cli/self-deploy.test.ts`
- Modify: `cli.ts`(`selfCmd` 命名空间:`deploy` 子命令)

**Interfaces:**
- Produces:
  ```ts
  export interface LaunchAgentInfo { programArguments: string[]; stderrPath: string | null }
  export function parseLaunchAgentPlist(xml: string): LaunchAgentInfo | null   // 用正则 / 简单 XML 扫描取 <key>ProgramArguments</key> 后 <array> 里的 <string>,与 <key>StandardErrorPath</key> 后的 <string>
  export interface SelfDeployPlan { platform: string; sidecarPath: string; newBinaryPath: string; prevPath: string; tmpPath: string; serviceTarget: string /* gui/<uid>/com.wechat-cc.daemon */; stderrLogPath: string | null; infoPath: string; healthTimeoutMs: number; rollback: boolean }
  export function planSelfDeploy(input: { platform: NodeJS.Platform; arch: string; homeDir: string; uid: number; repoRoot: string; stateDir: string; plistXml: string | null; binary?: string; app?: string; healthTimeoutMs?: number; rollback?: boolean }): SelfDeployPlan  // 非 darwin ⇒ throw Error('self_deploy_unsupported_platform');plist 缺失且无 --app ⇒ throw Error('launchagent_not_found')
  export interface SelfDeployDeps { spawnSync: (cmd: string, args: string[], opts?: { timeoutMs?: number }) => { status: number | null; stdout: string; stderr: string }; fs: { exists(p: string): boolean; copyFile(a: string, b: string): void; rename(a: string, b: string): void; chmod(p: string, mode: number): void; mtimeMs(p: string): number | null; readTail(p: string, lines: number): string; unlink(p: string): void }; fetch: typeof globalThis.fetch; readFileToken: (infoPath: string) => { baseUrl: string; token: string } | null; now: () => number; sleep: (ms: number) => Promise<void>; log: (line: string) => void }
  export interface SelfDeployResult { ok: boolean; exitCode: 0 | 1 | 3; steps: Array<{ name: string; ok: boolean; detail?: string }>; version?: string; rolledBack?: boolean; diagnostics?: string }
  export async function executeSelfDeploy(plan: SelfDeployPlan, deps: SelfDeployDeps): Promise<SelfDeployResult>
  ```

- [ ] **Step 1: 写失败的测试**
  - `parseLaunchAgentPlist` 解析真实形状(两种主二进制名)与 `StandardErrorPath`;坏 XML ⇒ null。
  - `planSelfDeploy`:sidecar = plist 主二进制同目录 `wechat-cc-cli`;缺省 binary = `<repoRoot>/apps/desktop/src-tauri/binaries/wechat-cc-cli-aarch64-apple-darwin`(arch arm64)/ `x86_64`(x64);`--app` 覆盖;非 darwin 抛;无 plist 无 app 抛。
  - `executeSelfDeploy` 成功:用真 tmp 目录 + 真 fs(`node:fs`)但假 spawnSync / fetch:preflight 调 `<new> --version` 拿版本;`.prev` 内容 = 旧;swap 后 sidecar 内容 = 新且 `statSync().ino` 与旧不同;kickstart 被调;health 在 info mtime 更新 + `/v1/health` 200 后通过;`exitCode 0`。
  - 健康失败 ⇒ 回滚:sidecar 内容恢复为旧、kickstart 调了两次、`rolledBack:true`、`exitCode 1`、`diagnostics` 含 `launchctl print` 的假输出与 stderr 尾巴。
  - `rollback:false` ⇒ 不回滚,`exitCode 1`。
  - preflight 失败(`--version` 非 0)⇒ 不动文件,`exitCode 1`。
  - 回滚也失败(第二次健康也超时)⇒ `exitCode 3`。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**(按 spec §3;`cli.ts`:`self deploy [--binary] [--app] [--no-rollback] [--health-timeout-ms] [--json]`,真依赖:`node:child_process` spawnSync、`node:fs`、全局 fetch;`repoRoot` = `dirname(fileURLToPath(import.meta.url))` 在源码模式,编译模式下 `--binary` 必填;版本比对:health 的 `version.cli` 与 preflight 输出不一致只记 warning 不判失败)

- [ ] **Step 4: 跑测试确认通过** + typecheck + depcheck

- [ ] **Step 5: 提交** `git commit -m "自维护:wechat-cc self deploy —— 换 inode 原子换 sidecar、kickstart、健康门、失败自动回滚并打出 launchd 退出原因"`

---

### Task 4: 手册 + fixture + 回放测试

**Files:**
- Create: `docs/maintainer/README.md`、`deploy.md`、`verify.md`、`ci-and-flakes.md`、`migrations.md`、`rules-from-real-machines.md`;`AGENTS.md`、`CLAUDE.md`;`scripts/acp-fixture-from-transcript.ts`;`src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`;`src/core/acp/fixtures.test.ts`
- 输入素材(只读):spike transcript `/private/tmp/claude-501/-Users-nategu-mac-company-Documents-tendhearth-wechat-cc/c59d552e-8954-4322-91dd-a9b506aa6f2c/scratchpad/acp-spike/transcript.jsonl`(每行 `{t, scenario, dir:'in'|'out'|'stderr'|'exit'|'in-unparsed', note?, payload}`);规矩素材:`docs/superpowers/specs/2026-09-17-acp-evaluation.md` 末节、`docs/cc-workbench.md` 修订记录、以及控制器记忆里的条目(在 dispatch 里给出)。

- [ ] **Step 1: 写失败的回放测试**(`src/core/acp/fixtures.test.ts`,按 spec §4 的断言列表;fixture 不存在时先失败)
- [ ] **Step 2: 写生成脚本并生成 fixture**(`bun scripts/acp-fixture-from-transcript.ts <transcript> src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`;只保留 `dir ∈ {in,out}` 且 scenario ∈ {c1, c2shellreject, c4both, c5, c5load};脱敏规则见 Global Constraints;输出按原顺序;二次运行 diff 为空)
- [ ] **Step 3: 跑回放测试确认通过**;`rg -n "nategu|601809" src/core/acp/fixtures/` 为空
- [ ] **Step 4: 写手册六份 + AGENTS.md + CLAUDE.md**(中文;每份 ≤ 150 行;命令都用仓库里真实存在的名字 —— `bun run test` / `npm run test:node` / `bun run typecheck` / `bun run depcheck` / `cd apps/desktop && bun run build-sidecar` / `wechat-cc self deploy` / `wechat-cc selftest …`(后两条由 Task 2/3 提供,按 spec 里的用法写)
- [ ] **Step 5: 提交** `git commit -m "维护者手册 docs/maintainer + AGENTS/CLAUDE 入口 + cursor ACP 真机报文 fixture 与回放契约测试"`

---

## Self-Review

- Spec §1 → T1;§2 → T2;§3 → T3;§4 → T4。T2 依赖 T1 的路由名与 body;T3、T4 与其它任务无文件交集,可并行。
- 类型一致:`SelftestConverseResult` 在 T1/T2 两处一致;`SelftestReport.checks` 名字与 spec §2 第 6 条一致;`planSelfDeploy` / `executeSelfDeploy` 签名一致。
