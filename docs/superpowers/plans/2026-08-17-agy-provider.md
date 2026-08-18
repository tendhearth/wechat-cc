# agy Provider(订阅版 Gemini)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 provider id `agy`——经 Antigravity CLI(订阅 OAuth)访问 Gemini;v1 = solo 对话 + cheapEval + 真 resume + cancel;wechat MCP 按 spike 决定的档位接入。

**Architecture:** codex 式每 turn 一次 CLI 调用(`agy -p --output-format stream-json`),纯函数 NDJSON 解析层(`agy-stream.ts`)+ provider 层(`agy-agent-provider.ts`,注入 spawnFn)+ 既有 turn-emitter/auth-fail 器件;注册/命令/矩阵三处接线。genai 版 gemini 一行不动。

**Tech Stack:** bun(Bun.spawn)+ TypeScript + vitest(经 `bun --bun`);真机 agy 1.1.x。

**Spec:** `docs/superpowers/specs/2026-08-17-agy-provider-design.md`

## Global Constraints

- 测试 vitest only,`bun --bun vitest run <path>`;git add 显式路径;commit 尾行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 真机探针只在 scratchpad(`/private/tmp/claude-501/-Users-nategu-mac-company-Documents-wechat-cc/9ce5bbf8-a982-46cc-9f05-f3b8d4d0767a/scratchpad/`),不入库;**绝不登出用户的 agy、绝不覆盖 `~/.gemini` 下用户手写内容**(写配置先读后写、只动自己命名空间的条目)。
- parser 对未知 `event`/`step_type` 静默跳过(spec §6 风险①);对外文本是**step 聚合**的消息粒度,绝不逐 delta 发。
- 子系统名/命令/字段名固定:provider id `agy`、slash 词 `/agy`、配置字段 `agyModel`/`agyBin`、缺省模型 `gemini-3.7-flash-medium`、cheapEval 模型 `gemini-3.7-flash-low`。
- 本机 2 个已知 bootstrap.test.ts 环境失败(插件符号链接)忽略;其余失败必须归因。
- genai 版 gemini provider 及其测试零改动。

---

### Task 1: Spike——四个未知形状 + §3 档位决策(决策点,不产代码提交)

**Files:**
- Create(scratchpad,不入库): `agy-spike-findings.md`
- Modify: `docs/superpowers/specs/2026-08-17-agy-provider-design.md`(§0/§3 加 bracketed 结论注)

- [ ] **Step 1: 工具步事件形状**

在 scratchpad 建临时目录,放 2-3 个文件,跑:

```bash
cd <scratchpad>/agy-spike && agy -p "运行 ls 列出当前目录文件,然后告诉我有几个文件" --output-format stream-json --dangerously-skip-permissions --model gemini-3.7-flash-low --print-timeout 120s
```

记录:工具执行步的完整 JSON(`step_type` 值、工具名/参数/结果字段在哪、有无独立 tool 事件)。若一次拍不到就换更强制的措辞重试(最多 3 次)。

- [ ] **Step 2: strict(无 dangerously 旗标)下权限行为**

同目录跑 `agy -p "创建文件 test.txt 内容 hello" --output-format stream-json --model gemini-3.7-flash-low --print-timeout 90s`(不带 `--dangerously-skip-permissions`)。记录:阻塞等待/自动拒绝/直接执行/报错,以及 turn 是否能完成。若阻塞 ⇒ 再试加 `--mode plan` 的行为。结论 = spec §4 的 strict 映射选型。

- [ ] **Step 3: MCP 配置档位探测(§3 决策)**

按序:
1. `strings ~/.local/bin/agy | grep -iE "GEMINI_(CONFIG|HOME|DIR)|XDG_CONFIG|CONFIG_DIR" | sort -u | head` + 尝试 `GEMINI_CONFIG_DIR=<tmp> agy -p "hi" -p ... --print-timeout 30s`(或 strings 里发现的候选 env)是否让 agy 读 `<tmp>` 下配置(验证法:tmp 里放一个 `config/mcp_config.json` 注册假 stdio server——用 `bun -e` 写一个最小 MCP echo server 脚本——看 init 事件 tools 表/日志是否出现它);
2. 若 env 不通:在工作区目录放 `.gemini/config/mcp_config.json` 同法验证 cwd 级;
3. 都不通 ⇒ 档位 C(全局条目 + /agy 限 admin/trusted)。
记录 mcp_config.json 的确切 schema(server 条目字段名:command/args/env 的实际拼写)——从 agy 的 assets 文档(strings 提到 `docs/mcp_servers.md`)或试错得出。

- [ ] **Step 4: 杂项确认**

`--print-timeout` 接受的格式(`90s`/`5m`);`--conversation <id>` 续聊实测一次(第一轮拿 conversation_id,第二轮带上问"我上一句问了什么");非法 `--model` 的报错形状(exit code + stderr)。

- [ ] **Step 5: 写结论**

findings 文件记全部原始 JSON 样本;spec §0 的"未拍到的形状"逐项补注;§3 写明选定档位。commit 仅 spec 文件:

```bash
git add docs/superpowers/specs/2026-08-17-agy-provider-design.md
git commit -m "docs(agy): spike findings — tool-step shape, strict behavior, MCP config tier decision"
```

---

### Task 2: `src/core/agy-stream.ts`——纯 NDJSON 解析/聚合层

**Files:**
- Create: `src/core/agy-stream.ts`
- Test: `src/core/agy-stream.test.ts`

**Interfaces:**
- Produces:

```ts
/** stream-json 一行解析出的内部事件(与 CLI 解耦的窄化)。 */
export type AgyStreamEvent =
  | { kind: 'init'; conversationId: string }
  | { kind: 'text'; text: string }                    // 一个 agent_response step 聚合后的完整文本
  | { kind: 'tool_call'; tool: string; server?: string }
  | { kind: 'result'; conversationId: string; numTurns: number }
  | { kind: 'error'; message: string }                // result.status !== SUCCESS

/** 喂入原始行,吐出零或多个事件;内部维护 step 聚合状态。 */
export interface AgyStreamParser {
  feed(line: string): AgyStreamEvent[]
  /** 流终止时冲洗未 DONE 的聚合文本(有则发一条 text)。 */
  flush(): AgyStreamEvent[]
}
export function makeAgyStreamParser(): AgyStreamParser
```

- Consumes: Task 1 的工具步形状结论(tool_call 分支按 findings 写;spike 若显示工具名带 MCP server 前缀则拆出 server)。

- [ ] **Step 1: Write the failing test**

```ts
// src/core/agy-stream.test.ts
import { describe, it, expect } from 'vitest'
import { makeAgyStreamParser } from './agy-stream'

const INIT = JSON.stringify({ event: 'init', conversation_id: 'c1', init: { model: 'm', tools: [], permission_mode: 'request-review' } })
const step = (i: number, state: string, type: string, delta?: string) => JSON.stringify({
  event: 'step_update',
  step_update: { conversation_id: 'c1', step_index: i, state, step_type: type, ...(delta !== undefined ? { text_delta: delta } : {}) },
})
const RESULT = JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '2', num_turns: 1 } })

describe('makeAgyStreamParser', () => {
  it('init → init event with conversationId', () => {
    const p = makeAgyStreamParser()
    expect(p.feed(INIT)).toEqual([{ kind: 'init', conversationId: 'c1' }])
  })

  it('agent_response deltas aggregate; one text on DONE', () => {
    const p = makeAgyStreamParser()
    p.feed(INIT)
    expect(p.feed(step(2, 'ACTIVE', 'agent_response', 'he'))).toEqual([])
    expect(p.feed(step(2, 'ACTIVE', 'agent_response', 'llo'))).toEqual([])
    expect(p.feed(step(2, 'DONE', 'agent_response', '!'))).toEqual([{ kind: 'text', text: 'hello!' }])
  })

  it('non-response steps and unknown events are silently skipped', () => {
    const p = makeAgyStreamParser()
    expect(p.feed(step(0, 'DONE', 'user_input'))).toEqual([])
    expect(p.feed(step(3, 'DONE', 'checkpoint'))).toEqual([])
    expect(p.feed(JSON.stringify({ event: 'future_thing', x: 1 }))).toEqual([])
    expect(p.feed('not json at all')).toEqual([])
  })

  it('result SUCCESS → result; non-SUCCESS → error', () => {
    const p = makeAgyStreamParser()
    expect(p.feed(RESULT)).toEqual([{ kind: 'result', conversationId: 'c1', numTurns: 1 }])
    const failed = JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'FAILED', response: '', num_turns: 1 } })
    expect(p.feed(failed)).toEqual([{ kind: 'error', message: 'agy result status=FAILED' }])
  })

  it('flush emits a pending unaggregated text once', () => {
    const p = makeAgyStreamParser()
    p.feed(step(2, 'ACTIVE', 'agent_response', 'partial'))
    expect(p.flush()).toEqual([{ kind: 'text', text: 'partial' }])
    expect(p.flush()).toEqual([])
  })

  // Task 1 的工具步样本进这条(用 findings 里的真实 JSON 行):
  it('tool step maps to tool_call (shape from spike findings)', () => {
    // 实现者:把 findings 的真实工具步 JSON 贴进来断言 { kind:'tool_call', tool: '<真实工具名>' … }
    expect(true).toBe(true) // ← 占位仅在 Task 1 findings 缺失时保留并 DONE_WITH_CONCERNS 上报;正常必须替换为真实样本断言
  })
})
```

- [ ] **Step 2: Run to verify FAIL**(cannot resolve `./agy-stream`)

Run: `bun --bun vitest run src/core/agy-stream.test.ts`

- [ ] **Step 3: 实现**

按上述契约实现:`feed` 先 `try { JSON.parse } catch { return [] }`;switch on `event`;`step_update` 只认 `agent_response`(聚合 text_delta,按 step_index 键;DONE 时 emit + 清)与 Task 1 拍板的工具步 step_type(emit tool_call);其余静默;`result` 按 status 分流(非 SUCCESS 的 message 含 status 与 response 摘要,`agy result status=<S>` 前缀)。跨 step_index 切换时若旧 step 未 DONE 先 flush 它(防理论上的乱序丢文本)。文件头 doc comment 注明"1.1.x 观测、无版本契约、未知即跳过"(spec §6 风险①)。

- [ ] **Step 4: Run to verify PASS**;`bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/core/agy-stream.ts src/core/agy-stream.test.ts
git commit -m "feat(agy): stream-json parser/aggregator — message-granularity text, forward-compatible skip"
```

---

### Task 3: `src/core/agy-agent-provider.ts`——provider 本体

**Files:**
- Create: `src/core/agy-agent-provider.ts`
- Test: `src/core/agy-agent-provider.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `makeAgyStreamParser`;既有 `makeTurnEmitter`/`isAuthFailError`(src/core);`AgentProvider`/`AgentSession`/`SpawnContext`/`CheapEval` 类型(以 agent-provider.ts 现行签名为准)。
- Produces:

```ts
export const AGY_CAPABILITIES: ProviderCapabilities   // spec §2 的字段,authFailHint 含重登指引
export interface AgySpawnHandle {
  stdout: AsyncIterable<Uint8Array | string>
  exited: Promise<number>
  stderr(): Promise<string>
  kill(): void
}
export type AgySpawnFn = (args: string[], opts: { cwd: string }) => AgySpawnHandle
export interface AgyAgentProviderOptions {
  bin: string
  model: string
  /** spec §3 选定档位的产物:每 spawn 解析出的额外 CLI 参数/环境(Task 5 提供;
   *  v1 若走档位 C 则恒为 {}——全局配置已就位,无每会话参数)。 */
  sessionArgsFor?: (ctx: SpawnContext) => { args: string[]; env?: Record<string, string> }
  spawnFn?: AgySpawnFn        // 缺省 Bun.spawn 包装
  turnTimeoutMs?: number      // → --print-timeout,缺省 600_000
  log: (tag: string, line: string) => void
}
export function createAgyAgentProvider(opts: AgyAgentProviderOptions): AgentProvider
```

- [ ] **Step 1: Write the failing tests**(核心用例,实现者按现行类型微调)

```ts
// src/core/agy-agent-provider.test.ts — 全部经注入 spawnFn 的假 agy
import { describe, it, expect } from 'vitest'
import { createAgyAgentProvider } from './agy-agent-provider'
import { TIER_PROFILES } from './user-tier'

function fakeAgy(lines: string[], opts?: { exitCode?: number; stderr?: string; hang?: boolean }) {
  const calls: Array<{ args: string[]; cwd: string }> = []
  let killed = false
  const spawnFn = (args: string[], o: { cwd: string }) => {
    calls.push({ args, cwd: o.cwd })
    return {
      stdout: (async function* () { for (const l of lines) yield l + '\n'; if (opts?.hang) await new Promise(() => {}) })(),
      exited: Promise.resolve(opts?.exitCode ?? 0),
      stderr: async () => opts?.stderr ?? '',
      kill: () => { killed = true },
    }
  }
  return { spawnFn, calls, wasKilled: () => killed }
}

const INIT = JSON.stringify({ event: 'init', conversation_id: 'c1', init: { model: 'm', tools: [], permission_mode: 'request-review' } })
const TEXT_DONE = JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'hi' } })
const RESULT = JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'hi', num_turns: 1 } })

const ctx = { tierProfile: TIER_PROFILES.guest, permissionMode: 'strict' as const, chatId: 'chat1' }
const project = { alias: 'p', path: '/tmp' }

async function drain(it: AsyncIterable<{ kind: string }>) { const out = []; for await (const e of it) out.push(e); return out }

describe('createAgyAgentProvider', () => {
  it('happy turn: init+text+result; second dispatch carries --conversation', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const evs = await drain(s.dispatch('你好'))
    expect(evs.map(e => e.kind)).toEqual(['init', 'text', 'result'])
    await drain(s.dispatch('再来'))
    expect(calls[1]!.args).toContain('--conversation')
    expect(calls[1]!.args).toContain('c1')
    expect(calls[0]!.args).not.toContain('--conversation')
  })

  it('resumeSessionId seeds --conversation on the FIRST dispatch', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, { ...ctx, resumeSessionId: 'old-c' })
    await drain(s.dispatch('hi'))
    expect(calls[0]!.args).toContain('old-c')
  })

  it('dangerously permissionMode adds --dangerously-skip-permissions; strict does not', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s1 = await provider.spawn(project, { ...ctx, permissionMode: 'dangerously' })
    await drain(s1.dispatch('x'))
    expect(calls[0]!.args).toContain('--dangerously-skip-permissions')
    const s2 = await provider.spawn(project, ctx)
    await drain(s2.dispatch('x'))
    expect(calls[1]!.args).not.toContain('--dangerously-skip-permissions')
  })

  it('nonzero exit without result → error event; auth-shaped stderr classifies auth_failed', async () => {
    const { spawnFn } = fakeAgy([INIT], { exitCode: 1, stderr: 'error getting entitlement: not authenticated' })
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const evs = await drain(s.dispatch('x'))
    const err = evs.find(e => e.kind === 'error') as { code?: string; message: string }
    expect(err).toBeTruthy()
    expect(err.code).toBe('auth_failed')
  })

  it('overlapping dispatch throws; cancel kills the child', async () => {
    const { spawnFn, wasKilled } = fakeAgy([INIT], { hang: true })
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const it = s.dispatch('long')[Symbol.asyncIterator]()
    await it.next()   // init 出来,turn 在飞
    expect(() => s.dispatch('again')).toThrow()
    await s.cancel!()
    expect(wasKilled()).toBe(true)
    await it.return?.()
  })

  it('ctx.model overrides construction model in --model arg', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'default-m', spawnFn, log: () => {} })
    const s = await provider.spawn(project, { ...ctx, model: 'pinned-m' })
    await drain(s.dispatch('x'))
    const i = calls[0]!.args.indexOf('--model')
    expect(calls[0]!.args[i + 1]).toBe('pinned-m')
  })

  it('cheapEval: one-shot with flash-low model, returns response text, auth text throws', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const text = await provider.cheapEval!('prompt')
    expect(text).toBe('hi')
    expect(calls[0]!.args).toContain('gemini-3.7-flash-low')
  })
})
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: 实现**

结构(实现者以此为契约,风格随仓库):

- `AGY_CAPABILITIES` 按 spec §2;
- 缺省 `spawnFn` 用 `Bun.spawn({ cmd: [bin, ...args], cwd, stdout: 'pipe', stderr: 'pipe' })` 包装成 `AgySpawnHandle`;
- `spawn(project, ctx)` 返回 session 闭包:`conversationId = ctx.resumeSessionId ?? null`、`inFlight=false`、`currentProc=null`;
- `dispatch(text)`:`inFlight` 时同步 throw(claude 同款文案姿势);async generator 内:组参(`-p text --output-format stream-json --model (ctx.model ?? opts.model) --print-timeout <turnTimeoutMs 毫秒转 '600s'>` + conversationId 时 `--conversation id` + dangerously 旗标 + **Task 1 若判定 strict 会阻塞则加其拍板的保守旗标(如 `--mode plan`)** + `sessionArgsFor?.(ctx).args`),spawn,`em = makeTurnEmitter()`,逐行(自缓冲按 \n 切)喂 `makeAgyStreamParser`:
  - parser init → 捕获 conversationId;首个 dispatch 才 `yield em.init(conversationId)`(openai 的 firstRef 姿势);
  - text → `yield em.text(t)`;tool_call → `yield em.toolCall(tool, server)`;
  - result → sawResult=true,`yield em.finish({ sessionId: conversationId ?? '', numTurns })`;
  - parser error → `yield em.errorText(message)`;
  - 流尽后 `flush()` 余文本;`await exited` 非零且 !sawResult ⇒ `yield em.error(new Error(\`agy exited \${code}: \${(await stderr()).slice(0, 300)}\`))`(emitter 的 isAuthFailError 兜底自动判 auth——测试用例的 stderr 'not authenticated' 命中宽集);
  - finally:inFlight=false、currentProc=null;
- `cancel()`:`currentProc?.kill()`;`close()`:同 + 置 closed(closed 后 dispatch 直接 return);
- `cheapEval`/`strongEval?`:一次性 spawn(`--model gemini-3.7-flash-low`,strongEval 用 opts.model),取 result.response(或聚合 text),对文本走既有 `assertNotAuthFailed`(import 自 agent-provider);签名以 agent-provider.ts 的 `CheapEval` 为准。

- [ ] **Step 4: Run to verify PASS**;`bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/core/agy-agent-provider.ts src/core/agy-agent-provider.test.ts
git commit -m "feat(agy): provider — per-turn CLI invocation, real resume, cancel, cheapEval"
```

---

### Task 4: 配置字段 + capability 矩阵 + cheapEval 偏好

**Files:**
- Modify: `src/lib/agent-config.ts`(接口 ~:16-23、schema ~:170-173、safeParse 收集 ~:256-259、`modelForProvider`/`withModelForProvider` 的 own-field 分支)
- Modify: `src/core/capability-matrix.ts`(:27-31 imports、:109-115 `CAPABILITIES_BY_PROVIDER`)
- Modify: `src/core/provider-registry.ts`(:56 `CHEAP_EVAL_PREFERENCE`)
- Test: 各自现有套件加用例

- [ ] **Step 1: agent-config**

镜像 `geminiModel` 的四处姿势逐一加 `agyModel?: string`、`agyBin?: string`(接口 + zod optional + safeParse 收集);`modelForProvider`/`withModelForProvider` 加 `providerId === 'agy'` own-field 分支(读改 `agyModel`,与 openai/cursor 同款规则:own-field 无条件解析)。

- [ ] **Step 2: capability-matrix**

`import { AGY_CAPABILITIES } from './agy-agent-provider'`;`CAPABILITIES_BY_PROVIDER` 加 `agy: AGY_CAPABILITIES,`。矩阵套件加 agy 行断言:solo 两种 permissionMode 正常;primary_tool 的 `delegate:'unloaded'`(supportsDelegation:false ⇒ B2 合取生效)。

- [ ] **Step 3: provider-registry**

`CHEAP_EVAL_PREFERENCE` 改 `['openai', 'agy', 'claude', 'codex', 'gemini']`(spec §2:订阅额度排 openai 后、claude 前);registry 套件相应断言更新。

- [ ] **Step 4: Verify**

Run: `bun --bun vitest run src/lib/agent-config.test.ts src/core/capability-matrix.test.ts src/core/provider-registry.test.ts && bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-config.ts src/core/capability-matrix.ts src/core/provider-registry.ts $(git diff --name-only -- '*test*')
git commit -m "feat(agy): config fields, capability-matrix row, cheap-eval preference"
```

(此处 `$(git diff --name-only -- '*test*')` 仅收测试文件——若 shell 展开有疑虑改为逐个显式路径。)

---

### Task 5: MCP 会话配置机制(按 Task 1 选定档位,三档全文如下,只实现选定档)

**Files:**
- Create: `src/daemon/bootstrap/agy-mcp-config.ts`
- Test: `src/daemon/bootstrap/agy-mcp-config.test.ts`
- (档位 C 时)Modify: `src/daemon/mode-commands.ts`(`/agy` 分支 tier 门,与 Task 6 同 commit 亦可)

**Interfaces:**
- Produces: `prepareAgyMcp(opts): { sessionArgsFor(ctx): { args: string[]; env?: Record<string,string> } } | { staticSetup(): void }`(按档位;Task 6 消费)。wechat MCP spec 来源 = bootstrap 现有 `wechatStdioMcpSpec` 产物(同 gemini 的 `wechatStdioForGemini` 姿势)。

- [ ] **档位 A(env/config-dir 覆盖可用):**

`prepareAgyMcp` 返回 `sessionArgsFor(ctx)`:每 spawn 在 stateDir 下建 `agy-sessions/<random>/config/mcp_config.json`(Task 1 拍到的确切 schema),wechat 条目 env = `childEnvFor(wechatSpec, ctx.mcpEnv)`(复用 src/core/mcp-stdio-spec);返回 `{ args: [], env: { <spike 确认的 config-dir 环境变量>: <该目录> } }`——spawnFn 相应支持 env 注入(Task 3 的 `AgySpawnHandle` 加 opts.env 透传)。会话 close 时清理目录(session close 钩子)。测试:目录/文件内容/清理。

- [ ] **档位 B(工作区级配置):**

同 A,但配置写到 `<project.path>/.gemini/config/mcp_config.json`——**先读后写**:文件已存在时只 upsert `wechat-cc:wechat` 命名条目、绝不动其他键;返回 `{ args: [] }`(无 env)。测试:已有用户条目共存不丢、upsert 幂等、每会话 token 覆写。风险注:同 project 并发 agy 会话共享此文件——v1 以 serial dispatch + solo 使用为前提,注释写明。

- [ ] **档位 C(仅全局):**

`staticSetup()` 于 boot 时对 `~/.gemini/config/mcp_config.json` 读-改-写:upsert 单个 `wechat-cc:wechat` 条目,env 带 boot 期铸造的长期 trusted token——来源:`prepareAgyMcp` 的 opts 接收一个 `mintToken: () => string` 闭包,由 bootstrap 侧用既有 `mintSessionToken('trusted', 'agy-static')` 提供(该 mint 缝已在 BootstrapDeps,实现者按实际签名接)。**绝不写入每会话 token**。同时 `mode-commands.ts` 的 `/agy` 分支加 tier 门:`resolveTier(chatId) === 'guest'` ⇒ 拒绝文案「/agy 目前仅管理员/信任聊天可用(工具通道暂无法按会话隔离权限)」。测试:upsert 保留用户既有条目;guest 拒绝、admin 放行。

- [ ] **Verify + Commit**

Run: `bun --bun vitest run src/daemon/bootstrap/agy-mcp-config.test.ts && bunx tsc --noEmit`

```bash
git add src/daemon/bootstrap/agy-mcp-config.ts src/daemon/bootstrap/agy-mcp-config.test.ts
git commit -m "feat(agy): wechat MCP session config — tier <A|B|C per spike>"
```

---

### Task 6: 注册 + 命令接线

**Files:**
- Modify: `src/daemon/bootstrap/providers.ts`(gemini 块之后加 agy 注册块,lazy import + try/catch,同 cursor/gemini 姿势)
- Modify: `src/daemon/mode-commands.ts`(:74-86 `isProviderCommand` 加 `if (lower === 'agy') return 'agy'`;`/agy <model>` 的 pin 分支——把 `providerId === 'openai'` 的模型 pin 块条件改为 `providerId === 'openai' || providerId === 'agy'`,宽松 modelRe 复用,回复文案不变)
- Test: mode-commands 套件 + providers 注册可测部分

- [ ] **Step 1: providers.ts 注册块**

```ts
  // ── agy(订阅版 Gemini,经 Antigravity CLI;spec 2026-08-17-agy-provider)──
  // 门槛:agy 二进制可解析且 --version 退出 0;不满足 ⇒ 不注册,BOOT 一行。
  const agyBin = configuredAgent.agyBin ?? findOnPath('agy')
  if (agyBin && await agyVersionOk(agyBin)) {
    try {
      const { createAgyAgentProvider } = await import('../../core/agy-agent-provider')
      const mcp = prepareAgyMcp({ /* 档位对应参数;C 档在此调 staticSetup() */ })
      registry.register('agy', createAgyAgentProvider({
        bin: agyBin,
        model: configuredAgent.agyModel ?? 'gemini-3.7-flash-medium',
        ...(mcp.sessionArgsFor ? { sessionArgsFor: mcp.sessionArgsFor } : {}),
        turnTimeoutMs,
        log: deps.log,
      }), { displayName: 'Gemini (agy)', canResume: () => true })
      deps.log('BOOT', 'agy: binary present — provider registered')
    } catch (err) { deps.log('BOOT', `agy: registration failed — ${err instanceof Error ? err.message : String(err)}`) }
  } else {
    deps.log('BOOT', 'agy: binary not found (PATH or agyBin) — provider not registered')
  }
```

(`findOnPath` 已存在于该文件的 gemini/python 探测邻域——grep 确认后复用;`agyVersionOk` = spawn `--version` 看退出码,放本文件或 agy-mcp-config 同层小助手;`turnTimeoutMs` 用 bootstrap 已解析的同名值。)

- [ ] **Step 2: mode-commands**

上述两处;测试:`/agy` 切 solo+agy(registry.has 假注册)、`/agy gemini-3.7-flash-high` pin 成功、未注册时"未注册"文案;档位 C 时 guest 拒绝用例并入。

- [ ] **Step 3: Verify**

Run: `bun --bun vitest run src/daemon/mode-commands.test.ts src/daemon/bootstrap/ && bunx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/daemon/bootstrap/providers.ts src/daemon/mode-commands.ts src/daemon/mode-commands.test.ts
git commit -m "feat(agy): registration + /agy command with model pin"
```

---

### Task 7: 真机验收 + 全量回归 + 文档

**Files:**
- Create(scratchpad,不入库): 验收探针
- Modify: `docs/architecture.md`(D4 行括注里的 "gemini→agy deferred" 更新为 v1 done + spec 指针)

- [ ] **Step 1: 真机验收探针**(scratchpad,注入真 spawnFn=缺省)

直接实例化 `createAgyAgentProvider({ bin: <真实路径>, model: 'gemini-3.7-flash-low', log: console })`:① 一轮对话(断言 init/text/result);② 第二次 dispatch 续聊(问"我上一句问了什么",断言回答引用第一句 → 真 resume);③ 一次真实工具调用(prompt 要求 ls,断言 tool_call 事件出现);④ cheapEval 单发。全部结果贴报告。**不测登出态**。若 Task 5 走 A/B 档:再加 ⑤ wechat MCP 真连(需运行中 daemon 的 internal-api——若 daemon 未跑,记为"待部署验证"不阻塞)。

- [ ] **Step 2: 全量回归**

`bunx tsc --noEmit && bun --bun vitest run`(仅容忍 2 个已知环境失败)+ `bun --bun vitest run --config vitest.e2e.config.ts`(全绿)。

- [ ] **Step 3: 文档 + Commit**

architecture.md 更新一句;commit:

```bash
git add docs/architecture.md
git commit -m "docs: agy provider v1 landed — subscription Gemini via Antigravity CLI"
```
