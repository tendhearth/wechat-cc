# Provider 运行时去重(D4)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消灭 provider 层的五份 McpStdioSpec、三份 auth-fail 正则与 ~250 行循环样板,同时修复三组 live bug(gemini tier 鉴权缺口、delegation 静默降级、三家不识别 auth 失败)。

**Architecture:** 四个新共享模块(`mcp-stdio-spec` / `auth-fail` / `async-queue` / `turn-emitter`)落在 src/core;五个 provider 循环保留各自结构、逐个换器件;mode-commands + validateMode + capability-matrix 三处救活 `supportsDelegation`。

**Tech Stack:** bun + TypeScript,vitest(经 `bun --bun`),现有注入端口与 vi.mock 缝不动。

**Spec:** `docs/superpowers/specs/2026-08-17-provider-runtime-dedup-design.md`

## Global Constraints

- 测试一律 `import from 'vitest'`,绝不 `bun:test`;运行统一 `bun --bun vitest run <path>`(裸 `bunx` 走 Node,bun:sqlite/Bun.serve 会挂)。
- 三个 vi.mock 路径(`@anthropic-ai/claude-agent-sdk`、`@openai/codex-sdk`、`@cursor/sdk`)与 `src/daemon/__e2e__/fake-sdk.ts` **一行不改**。
- 导出纯函数 `mapCursorMessage` / `mapCursorToolName` / `mapDeltaToEvent` / `runDispatchLoop` 的签名与行为不变(现有单测为准绳)。
- claude 的 queue-pump 结构、`[STREAM_DROP]`、cancel/close、"每 dispatch 推一条消息等 result"契约不变;**claude 不接 turn-emitter**(实施期裁决,理由见 spec §2 与本 plan Task 3)。
- 刻意行为变化仅限 spec §5 清单四条,各自写进对应 commit message。
- 本机已知 2 个 bootstrap.test.ts 环境性失败(plugins/ 开发符号链接),忽略之;其余任何失败必须归因。
- 每个 task 一个 commit,尾行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: `src/core/mcp-stdio-spec.ts`

**Files:**
- Create: `src/core/mcp-stdio-spec.ts`
- Test: `src/core/mcp-stdio-spec.test.ts`

**Interfaces:**
- Produces: `McpStdioSpec { command: string; args?: string[]; env?: Record<string,string> }`、`childEnvFor(spec, mcpEnv?): Record<string,string>`。Task 5-8/10 依赖这两个确切名字。

- [ ] **Step 1: Write the failing test**

```ts
// src/core/mcp-stdio-spec.test.ts
import { describe, it, expect } from 'vitest'
import { childEnvFor, type McpStdioSpec } from './mcp-stdio-spec'

describe('childEnvFor', () => {
  const spec: McpStdioSpec = { command: 'bun', args: ['x'], env: { FROM_SPEC: 's', SHARED: 'spec' } }

  it('inherits process.env, then spec.env, then mcpEnv — later wins', () => {
    process.env.MCP_SPEC_TEST_VAR = 'host'
    try {
      const env = childEnvFor(spec, { SHARED: 'mcp', WECHAT_SESSION_TOKEN: 'tok' })
      expect(env.MCP_SPEC_TEST_VAR).toBe('host')      // 宿主继承(PATH/HOME 同理)
      expect(env.FROM_SPEC).toBe('s')
      expect(env.SHARED).toBe('mcp')                  // mcpEnv > spec.env
      expect(env.WECHAT_SESSION_TOKEN).toBe('tok')
      expect(env.PATH).toBeDefined()
    } finally { delete process.env.MCP_SPEC_TEST_VAR }
  })

  it('omits non-string process.env entries and tolerates absent optionals', () => {
    const env = childEnvFor({ command: 'x' })
    for (const v of Object.values(env)) expect(typeof v).toBe('string')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/core/mcp-stdio-spec.test.ts`
Expected: FAIL — cannot resolve `./mcp-stdio-spec`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/mcp-stdio-spec.ts
/**
 * 唯一的 stdio MCP 子进程 spec(spec 2026-08-17-provider-runtime-dedup §1a)。
 * 此前五份结构等同的定义(bootstrap/mcp-specs、openai-mcp-bridge、cursor、
 * gemini、codex)收敛于此;全部是结构赋值互通,调用点零改动。
 */
export interface McpStdioSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

/**
 * 子进程 env 合并的唯一出口:继承宿主 env(PATH/HOME —— gemini 曾因缺这层
 * 而拿不到 PATH),叠加 spec 自带 env,最后叠加会话级 mcpEnv
 * (WECHAT_SESSION_TOKEN/_TIER —— gemini 曾因缺这层而绕过 tier 鉴权)。
 * 合并顺序即优先级:mcpEnv > spec.env > process.env。
 */
export function childEnvFor(spec: McpStdioSpec, mcpEnv?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') base[k] = v
  }
  return { ...base, ...(spec.env ?? {}), ...(mcpEnv ?? {}) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/core/mcp-stdio-spec.test.ts`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add src/core/mcp-stdio-spec.ts src/core/mcp-stdio-spec.test.ts
git commit -m "feat(core): single McpStdioSpec + childEnvFor merge helper (D4)"
```

---

### Task 2: `src/core/auth-fail.ts` + agent-provider 迁移

**Files:**
- Create: `src/core/auth-fail.ts`
- Test: `src/core/auth-fail.test.ts`
- Modify: `src/core/agent-provider.ts`(`AUTH_FAIL_RE` 常量与 `assertNotAuthFailed`,~:255-275)

**Interfaces:**
- Produces: `AUTH_FAIL_ASSISTANT_TEXT`、`AUTH_FAIL_SDK_ERROR`、`type AuthFailChannel = 'assistant-text' | 'sdk-error'`、`isAuthFail(channel, text): boolean`。Task 3-8 依赖。

- [ ] **Step 1: Write the failing test**

```ts
// src/core/auth-fail.test.ts
import { describe, it, expect } from 'vitest'
import { isAuthFail } from './auth-fail'

describe('isAuthFail — two channel profiles', () => {
  it('assistant-text (narrow): error-shape phrases hit, bare env-var name does NOT', () => {
    expect(isAuthFail('assistant-text', 'Please run /login')).toBe(true)
    expect(isAuthFail('assistant-text', 'Not logged in · run /login')).toBe(true)
    expect(isAuthFail('assistant-text', '401 unauthorized')).toBe(true)
    expect(isAuthFail('assistant-text', 'OPENAI_API_KEY not set')).toBe(true)
    // 合法模型输出里引用变量名 —— 决不能命中(agent-provider.ts 原注释的用例)
    expect(isAuthFail('assistant-text', 'what does OPENAI_API_KEY do?')).toBe(false)
    expect(isAuthFail('assistant-text', 'remember: put OPENAI_API_KEY in .env')).toBe(false)
  })

  it('sdk-error (wide): bare OPENAI_API_KEY and auth…expired hit', () => {
    expect(isAuthFail('sdk-error', 'Missing OPENAI_API_KEY environment variable')).toBe(true)
    expect(isAuthFail('sdk-error', 'auth token expired, run codex login')).toBe(true)
    expect(isAuthFail('sdk-error', 'Please run /login')).toBe(true)
    expect(isAuthFail('sdk-error', 'Not logged in')).toBe(true)
    expect(isAuthFail('sdk-error', 'connection reset by peer')).toBe(false)
    expect(isAuthFail('sdk-error', 'expired certificate')).toBe(false)   // 无 auth 前缀不命中
  })
})
```

- [ ] **Step 2: Run to verify FAIL**(cannot resolve `./auth-fail`)

- [ ] **Step 3: Write the implementation**

```ts
// src/core/auth-fail.ts
/**
 * auth-fail 判别的唯一来源(spec §1b)。双 profile 而非单一常量 —— 分歧有
 * 真实原因:窄集跑在【合法模型输出】上(裸 OPENAI_API_KEY 会误伤引用它的
 * 正常回答);宽集跑在【SDK 错误通道】上(错误消息里出现裸 OPENAI_API_KEY
 * 就是认证问题)。新增候选词必须注明归属通道及原因。
 */

/** 窄集:原 agent-provider.ts 的超集正则原样迁移(error-shape phrases only)。 */
export const AUTH_FAIL_ASSISTANT_TEXT =
  /(Please run \/login|Not logged in|not authenticated|401 unauthorized|please run `?codex login|OPENAI_API_KEY (?:not|is not|missing|required)|auth(?:entication)?\s+(?:expired|failed))/i

/** 宽集:原 codex 私有正则,吸收 claude 的两个 sentinel 词。 */
export const AUTH_FAIL_SDK_ERROR =
  /(Please run \/login|Not logged in|OPENAI_API_KEY|not authenticated|401 unauthorized|codex login|auth.*expired)/i

export type AuthFailChannel = 'assistant-text' | 'sdk-error'

export function isAuthFail(channel: AuthFailChannel, text: string): boolean {
  return (channel === 'assistant-text' ? AUTH_FAIL_ASSISTANT_TEXT : AUTH_FAIL_SDK_ERROR).test(text)
}
```

- [ ] **Step 4: agent-provider.ts 迁移**

删除本地 `const AUTH_FAIL_RE = /(Please run \/login|…)/i`(~:268)及其上方 5 行"Regex is INTENTIONALLY narrow"注释段(理由已随正则搬进 auth-fail.ts),`assertNotAuthFailed` 体改为:

```ts
export function assertNotAuthFailed(text: string, log: (tag: string, line: string) => void, source: string): void {
  if (isAuthFail('assistant-text', text)) {
    log('AUTH_FAILED', `${source} credentials stale: ${text.slice(0, 160)}`)
    throw new Error(`auth_failed: ${text.slice(0, 120)}`)
  }
}
```

顶部加 `import { isAuthFail } from './auth-fail'`。函数上方原有 doc comment 保留,末尾补一句指向 auth-fail.ts。

- [ ] **Step 5: Run to verify PASS**

Run: `bun --bun vitest run src/core/auth-fail.test.ts src/core/agent-provider.test.ts && bunx tsc --noEmit`
Expected: 全绿(assertNotAuthFailed 行为不变,现有 203 行套件是回归证据)

- [ ] **Step 6: Commit**

```bash
git add src/core/auth-fail.ts src/core/auth-fail.test.ts src/core/agent-provider.ts
git commit -m "feat(core): single auth-fail source with two channel profiles (D4)"
```

---

### Task 3: `src/core/async-queue.ts` + claude 接入

**Files:**
- Create: `src/core/async-queue.ts`
- Test: `src/core/async-queue.test.ts`
- Modify: `src/core/claude-agent-provider.ts`(AsyncQueue 类 :417-449 删除;AUTH_FAIL_RE :162 删除;两处改 import)

**Interfaces:**
- Produces: `export class AsyncQueue<T>`(语义与原私有类逐字一致)。

- [ ] **Step 1: Write the failing test**

```ts
// src/core/async-queue.test.ts
import { describe, it, expect } from 'vitest'
import { AsyncQueue } from './async-queue'

describe('AsyncQueue — contract snapshot (collectTurn watchdog depends on it)', () => {
  it('push before consume buffers; end() drains parked consumers with done', async () => {
    const q = new AsyncQueue<number>()
    q.push(1); q.push(2)
    const it = q.iterable()[Symbol.asyncIterator]()
    expect((await it.next()).value).toBe(1)
    expect((await it.next()).value).toBe(2)
    const pending = it.next()
    q.end()
    expect((await pending).done).toBe(true)
  })

  it('buffered items remain drainable after end(); push after end() is a silent no-op', async () => {
    const q = new AsyncQueue<number>()
    q.push(1); q.end(); q.push(99)
    const it = q.iterable()[Symbol.asyncIterator]()
    expect((await it.next())).toEqual({ value: 1, done: false })
    expect((await it.next()).done).toBe(true)
  })

  it('return() resolves synchronously-shaped (same-tick) and closes the queue', async () => {
    const q = new AsyncQueue<number>()
    const it = q.iterable()[Symbol.asyncIterator]()
    const r = await it.return!()
    expect(r.done).toBe(true)
    expect((await it.next()).done).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify FAIL**(cannot resolve `./async-queue`)

- [ ] **Step 3: 搬移实现**

把 claude-agent-provider.ts:417-449 的 `class AsyncQueue<T> { … }` **一字不动**搬到 `src/core/async-queue.ts`,加 `export` 与 doc comment:

```ts
/**
 * 单消费者异步队列(spec §1c;原 claude-agent-provider 私有类原样提升)。
 * 契约(collectTurn watchdog 依赖,agent-provider.ts:378-381):
 *   - iterator.return() 同步 resolve 并关闭队列;
 *   - end() 后 buf 仍可排空(next 先查 buf 再查 closed);
 *   - push 于 closed 后静默丢弃;无背压(buf 无界);单消费者约定。
 * 不做任何"顺手改进"。
 */
export class AsyncQueue<T> { /* 原 :417-449 逐字 */ }
```

claude-agent-provider.ts:删除私有类,顶部加 `import { AsyncQueue } from './async-queue'`。

- [ ] **Step 4: claude 的 auth 正则切换**

删除 :162 的 `const AUTH_FAIL_RE = /(Please run \/login|Not logged in)/i`(其上方 10 行注释保留、末行改为指向 auth-fail.ts 的窄集与"两个 sentinel 因 SDK 分片必须双词"一句);:309 的 `AUTH_FAIL_RE.test(text)` 改 `isAuthFail('assistant-text', text)`,顶部加 import。
**刻意行为变化(spec §5-清单,写进 commit message):** claude 流内检测由 2 词加宽到完整 assistant-text 集。

- [ ] **Step 5: Run to verify PASS**

Run: `bun --bun vitest run src/core/async-queue.test.ts src/core/claude-agent-provider.test.ts && bunx tsc --noEmit`
Expected: 全绿(claude 的 566 行套件是 queue-pump 契约未变的证据)

- [ ] **Step 6: Commit**

```bash
git add src/core/async-queue.ts src/core/async-queue.test.ts src/core/claude-agent-provider.ts
git commit -m "refactor(core): lift AsyncQueue to shared module; claude uses shared narrow auth profile

Behavior change (deliberate, spec §5): claude in-stream auth detection widens
from 2 sentinel phrases to the full assistant-text profile (same channel)."
```

---

### Task 4: `src/core/turn-emitter.ts`

**Files:**
- Create: `src/core/turn-emitter.ts`
- Test: `src/core/turn-emitter.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TurnEmitter {
  init(sessionId: string): AgentEvent
  text(t: string): AgentEvent
  toolCall(tool: string, server?: string): AgentEvent          // 内部 toolCall 计数++
  /** catch 到的异常 → error 事件;message 走 err instanceof Error 语气词;
   *  自动 isAuthFail('sdk-error') ⇒ code:'auth_failed'(opts.code 显式给定则优先)。 */
  error(err: unknown, opts?: { code?: string }): AgentEvent
  /** SDK 事件里已是字符串的错误消息 → 同上判别。 */
  errorText(message: string, opts?: { code?: string }): AgentEvent
  /** result 合成:durationMs 缺省 = now - 构造时刻;numTurns 缺省 = toolCall 计数
   *  (实践中五家都带自己的 numTurns —— overrides 整体覆盖,合成绝不克扣)。 */
  finish(overrides: { sessionId: string; numTurns?: number; durationMs?: number }): AgentEvent
}
export function makeTurnEmitter(): TurnEmitter   // 每个 dispatch/turn 构造一个
```

- [ ] **Step 1: Write the failing test**

```ts
// src/core/turn-emitter.test.ts
import { describe, it, expect } from 'vitest'
import { makeTurnEmitter } from './turn-emitter'

describe('makeTurnEmitter', () => {
  it('event constructors produce exact AgentEvent shapes', () => {
    const em = makeTurnEmitter()
    expect(em.init('s1')).toEqual({ kind: 'init', sessionId: 's1' })
    expect(em.text('hi')).toEqual({ kind: 'text', text: 'hi' })
    expect(em.toolCall('reply', 'wechat')).toEqual({ kind: 'tool_call', server: 'wechat', tool: 'reply' })
    expect(em.toolCall('bash')).toEqual({ kind: 'tool_call', tool: 'bash' })   // server 缺省不出现
  })

  it('error(): Error→message, non-Error→String, sdk-error profile stamps auth_failed', () => {
    const em = makeTurnEmitter()
    expect(em.error(new Error('boom'))).toEqual({ kind: 'error', message: 'boom' })
    expect(em.error('raw')).toEqual({ kind: 'error', message: 'raw' })
    expect(em.error(new Error('Missing OPENAI_API_KEY'))).toEqual(
      { kind: 'error', code: 'auth_failed', message: 'Missing OPENAI_API_KEY' })
    expect(em.errorText('401 unauthorized')).toEqual(
      { kind: 'error', code: 'auth_failed', message: '401 unauthorized' })
    expect(em.error(new Error('x'), { code: 'step_budget' })).toEqual(
      { kind: 'error', code: 'step_budget', message: 'x' })
  })

  it('finish(): overrides win wholesale; defaults fill only the omitted', () => {
    const em = makeTurnEmitter()
    em.toolCall('a'); em.toolCall('b')
    const r1 = em.finish({ sessionId: 's', numTurns: 7, durationMs: 123 })
    expect(r1).toEqual({ kind: 'result', sessionId: 's', numTurns: 7, durationMs: 123 })  // 权威值不被克扣
    const r2 = em.finish({ sessionId: 's' })
    expect(r2.kind).toBe('result')
    if (r2.kind === 'result') {
      expect(r2.numTurns).toBe(2)              // 缺省 = toolCall 计数
      expect(r2.durationMs).toBeGreaterThanOrEqual(0)
    }
  })
})
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Write the implementation**

```ts
// src/core/turn-emitter.ts
import type { AgentEvent } from './agent-provider'
import { isAuthFail } from './auth-fail'

/**
 * 每 turn 的事件制造 + 记账(spec §1d)。只制造事件对象,不接管循环、不接管
 * 工具执行、不碰迭代器 —— 因此 queue-pump / per-turn generator / 自持工具
 * 循环三种形状都能用。B3(三家不识别 auth 失败)由 error()/errorText()
 * 内建的 sdk-error 判别达成。
 */
export interface TurnEmitter { /* 如上 Interfaces 块,逐字 */ }

export function makeTurnEmitter(): TurnEmitter {
  const startedAt = Date.now()
  let toolCalls = 0
  const mkError = (message: string, code?: string): AgentEvent => ({
    kind: 'error',
    message,
    ...(code ?? (isAuthFail('sdk-error', message) ? 'auth_failed' : undefined)
      ? { code: code ?? 'auth_failed' }
      : {}),
  })
  return {
    init: (sessionId) => ({ kind: 'init', sessionId }),
    text: (text) => ({ kind: 'text', text }),
    toolCall: (tool, server) => {
      toolCalls++
      return { kind: 'tool_call', tool, ...(server !== undefined ? { server } : {}) }
    },
    error: (err, opts) => mkError(err instanceof Error ? err.message : String(err), opts?.code),
    errorText: (message, opts) => mkError(message, opts?.code),
    finish: (o) => ({
      kind: 'result',
      sessionId: o.sessionId,
      numTurns: o.numTurns ?? toolCalls,
      durationMs: o.durationMs ?? Date.now() - startedAt,
    }),
  }
}
```

(实现细节可调,`mkError` 的三元若嫌绕可展开为 if/else;测试断言的输出形状是契约。)

- [ ] **Step 4: Run to verify PASS**;`bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/core/turn-emitter.ts src/core/turn-emitter.test.ts
git commit -m "feat(core): TurnEmitter — shared per-turn event bookkeeping with auth classification (D4)"
```

---

### Task 5: codex 接入

**Files:**
- Modify: `src/core/codex-agent-provider.ts`(:97 正则、:103 类型、dispatch 内 :280-320 区段)
- Modify(如 grep 命中): `CodexMcpStdioServer` 的外部消费点

- [ ] **Step 1: 类型与正则替换**

- 删除 `const AUTH_FAIL_RE = …`(:97 及其上 5 行注释,末行留一句指向 auth-fail.ts 宽集);
- 删除 `export interface CodexMcpStdioServer { … }`(:103-107),顶部加 `import type { McpStdioSpec } from './mcp-stdio-spec'`;文件内引用改名。Run `grep -rn "CodexMcpStdioServer" --include="*.ts" src` — 每个外部消费点改 import `McpStdioSpec`。
- 顶部加 `import { makeTurnEmitter } from './turn-emitter'`。

- [ ] **Step 2: dispatch 循环换器件**

generator 开头(`const turnStarted = Date.now()` 一行)替换为 `const em = makeTurnEmitter()`(turnStarted 删除)。四处事件替换:

```ts
} else if (ev.type === 'turn.completed') {
  yield em.finish({ sessionId: thread.id ?? '', numTurns: ++turnCount })
} else if (ev.type === 'turn.failed') {
  const m = ev.error.message
  console.error(`wechat channel: [SESSION_RESULT] alias=${project.alias} provider=codex turn.failed=${m.slice(0, 400)}`)
  yield em.errorText(m)
} else if (ev.type === 'error') {
  const m = (ev as { type: 'error'; message: string }).message
  console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} provider=codex stream-error=${m.slice(0, 400)}`)
  yield em.errorText(m)
}
```

(init/text/tool_call 三个事件字面量**保持不动**——emitter 只在有增益处使用;errorText 的宽集与原 AUTH_FAIL_RE 判别语义一致。)

- [ ] **Step 3: Verify**

Run: `bun --bun vitest run src/core/codex-agent-provider.test.ts && bunx tsc --noEmit`
Expected: 623 行套件全绿(auth 判别集合未变,只是来源统一)

- [ ] **Step 4: Commit**

```bash
git add src/core/codex-agent-provider.ts $(git diff --name-only)
git commit -m "refactor(codex): shared McpStdioSpec + auth profile + TurnEmitter (D4)"
```

---

### Task 6: cursor 接入

**Files:**
- Modify: `src/core/cursor-agent-provider.ts`(:215 类型、dispatch 循环 :310-366)

- [ ] **Step 1: 类型替换**

删除 `export interface CursorMcpStdioSpec`(:215-219,其上注释并入新 import 行注释),改 `import type { McpStdioSpec } from './mcp-stdio-spec'`;`CursorAgentProviderOptions.mcpServers` 类型改 `Record<string, McpStdioSpec>`。Run `grep -rn "CursorMcpStdioSpec" --include="*.ts" src` 更新外部消费点。

- [ ] **Step 2: dispatch 循环换器件(mapper 纯函数不动)**

`dispatchGenerator` 内:`const startMs = Date.now()` 替换为 `const em = makeTurnEmitter()`;两处 catch 的 `yield { kind: 'error', message: err instanceof Error … }` 改 `yield em.error(err)`;两处 result 字面量改 `yield em.finish({ sessionId: agent.agentId, numTurns: myTurns })`;mapper 产出的事件加分类包装——把

```ts
            for (const ev of mapCursorMessage(raw, mcpServerNames, agent.agentId)) {
              yield ev
            }
```

改为(**mapper 本身零改动**,status:ERROR 的无 code error 事件在消费侧补判别——这是 B3 的 cursor 半边):

```ts
            for (const ev of mapCursorMessage(raw, mcpServerNames, agent.agentId)) {
              // B3:mapper 保持纯函数,auth 判别在消费侧补 —— status:ERROR 的
              // 消息命中 sdk-error 宽集时升级为结构化 auth_failed。
              yield ev.kind === 'error' && ev.code === undefined ? em.errorText(ev.message) : ev
            }
```

- [ ] **Step 3: Verify**

Run: `bun --bun vitest run src/core/cursor-agent-provider.test.ts && bunx tsc --noEmit`
Expected: 405 行套件全绿(mapper 行为未变);新增一条用例:构造 `msg = { type:'status', status:'ERROR', error:{ message:'401 unauthorized' } }` 走 dispatch 流(用该套件现有的注入 fake agent 模式),断言产出事件含 `code:'auth_failed'`。

- [ ] **Step 4: Commit**

```bash
git add src/core/cursor-agent-provider.ts src/core/cursor-agent-provider.test.ts $(git diff --name-only)
git commit -m "refactor(cursor): shared McpStdioSpec + TurnEmitter; auth-classify SDK errors (D4/B3)

Behavior change (deliberate, spec §5): cursor auth-shaped SDK errors now carry
code:'auth_failed' → throttled notice instead of raw text via FALLBACK_REPLY."
```

---

### Task 7: openai 接入

**Files:**
- Modify: `src/core/openai-mcp-bridge.ts`(:5-9 类型、:34-42 connectStdio)
- Modify: `src/core/openai-agent-provider.ts`(dispatch 的 `run` generator :83-131)

- [ ] **Step 1: bridge 换共享件**

删除本地 `export interface McpStdioSpec`(:5-9),改 `export type { McpStdioSpec } from '../core/mcp-stdio-spec'` 姿势——**注意**:bridge 在 src/core 内,即 `from './mcp-stdio-spec'`;保留 re-export 以免外部 import 路径断裂(grep `from './openai-mcp-bridge'` 的 McpStdioSpec 消费点确认)。`connectStdio` 的 env 行:

```ts
      env: { ...process.env, ...(spec.env ?? {}) } as Record<string, string>,
```

改为:

```ts
      env: childEnvFor(spec),
```

(语义等价 + 过滤了非字符串项;`spec.args` 现为可选,传参处补 `spec.args ?? []`。)

- [ ] **Step 2: dispatch 循环补 catch(B3 的 openai 半边)**

`run` generator 目前无 try/catch——`streamTurn`/`finished` 抛错会直接穿透迭代器。将 generator 体(自 `let steps = 0` 起至 `yield { kind: 'result', … }` 止)包进 try/catch:

```ts
        const em = makeTurnEmitter()
        try {
          /* …原体不动,仅两处替换:
             - `yield { kind: 'error', message: \`step budget …\`, code: 'step_budget' }`
               → `yield em.errorText(\`step budget ${maxSteps} exhausted\`, { code: 'step_budget' })`
             - 末尾 result 字面量 → `yield em.finish({ sessionId, numTurns: steps })` */
        } catch (err) {
          yield em.error(err)
        }
      })()
```

(`startedAt` 改由 emitter 持有,原 `const startedAt = Date.now()` 删除。)

- [ ] **Step 3: Verify**

Run: `bun --bun vitest run src/core/openai-agent-provider.test.ts src/core/openai-integration.test.ts && bunx tsc --noEmit`
新增用例:注入的 fake chatModel 的 `streamTurn` 抛 `new Error('401 unauthorized')`,断言 dispatch 事件流以 `{ kind:'error', code:'auth_failed' }` 结束而非向外抛。

- [ ] **Step 4: Commit**

```bash
git add src/core/openai-mcp-bridge.ts src/core/openai-agent-provider.ts src/core/openai-agent-provider.test.ts
git commit -m "refactor(openai): shared spec/env + TurnEmitter; dispatch errors become classified events (D4/B3)

Behavior change (deliberate, spec §5): a thrown streamTurn error now surfaces as
an error event (auth-classified) instead of propagating out of the iterator."
```

---

### Task 8: gemini 接入(B1 修复)

**Files:**
- Modify: `src/core/gemini-agent-provider.ts`(:292 类型、`connectWechatMcp` :302-320、`GeminiAgentProviderOptions.mcpConnect`、spawn 调用、`runDispatchLoop` catch)
- Modify: `src/daemon/bootstrap/providers.ts`(gemini 注册块 :430-433 附近)

- [ ] **Step 1: 类型 + env(B1 本体)**

- 删除 `export interface GeminiMcpStdioSpec`(:292-296),改 import 共享 `McpStdioSpec`;
- `connectWechatMcp(spec: GeminiMcpStdioSpec)` 改签名 `connectWechatMcp(spec: McpStdioSpec, mcpEnv?: Record<string, string>)`,transport 构造:

```ts
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args ?? [], env: childEnvFor(spec, mcpEnv) })
```

- `GeminiAgentProviderOptions.mcpConnect` 类型改 `(mcpEnv?: Record<string, string>) => Promise<McpConnection>`,doc comment 写明这是 tier 鉴权的载体;
- spawn 内 `const conn = await opts.mcpConnect()` 改 `await opts.mcpConnect(ctx.mcpEnv)`。

- [ ] **Step 2: providers.ts 穿线**

gemini 注册块的:

```ts
          mcpConnect: () => {
            if (!wechatStdioForGemini) throw new Error('gemini: internalApi unavailable — cannot connect wechat MCP')
            return connectWechatMcp(wechatStdioForGemini)
          },
```

改为:

```ts
          mcpConnect: (mcpEnv) => {
            if (!wechatStdioForGemini) throw new Error('gemini: internalApi unavailable — cannot connect wechat MCP')
            // B1(spec §3):childEnvFor 继承宿主 env + 合并会话 mcpEnv,
            // gemini 的 wechat MCP 子进程从此带 WECHAT_SESSION_TOKEN/_TIER。
            return connectWechatMcp(wechatStdioForGemini, mcpEnv)
          },
```

- [ ] **Step 3: runDispatchLoop 的 catch 换器件(B3 的 gemini 半边)**

`runDispatchLoop` 签名不变。开头 `const startMs = Date.now()` 改 `const em = makeTurnEmitter()`;两处 result 字面量改 `yield em.finish({ sessionId: args.sessionId, numTurns: rounds })`;catch 末行:

```ts
    yield { kind: 'error', message: err instanceof Error ? err.message : String(err) }
```

改 `yield em.error(err)`。(`server:'wechat'` 硬编码的 tool_call 字面量**不动**——修它属于粒度/命名问题,non-goal。)

- [ ] **Step 4: Verify(B1 断言)**

Run: `bun --bun vitest run src/core/gemini-agent-provider.test.ts && bunx tsc --noEmit`
新增用例(该套件现有的 mcpConnect 注入模式):spawn 时传 `ctx.mcpEnv = { WECHAT_SESSION_TOKEN: 't', WECHAT_SESSION_TIER: 'guest' }`,断言注入的 `mcpConnect` 收到该对象;另一条:`connectWechatMcp` 不直接单测(需真 stdio),但 `childEnvFor` 的合并已在 Task 1 锁死——在报告里说明该判断。
新增用例(B3):注入 genai 的 `generateContent` 抛 `new Error('401 unauthorized')`,断言事件流含 `code:'auth_failed'`。

- [ ] **Step 5: Commit**

```bash
git add src/core/gemini-agent-provider.ts src/core/gemini-agent-provider.test.ts src/daemon/bootstrap/providers.ts
git commit -m "fix(gemini): MCP child inherits host env + session mcpEnv — closes the tier-authz gap (D4/B1)

Behavior change (deliberate, spec §5): gemini's wechat MCP child env goes from
bare spec.env to full inherit+merge; its sessions now carry WECHAT_SESSION_TOKEN/_TIER."
```

---

### Task 9: delegation 能力校验(B2)

**Files:**
- Modify: `src/core/capability-matrix.ts`(:162-167)
- Modify: `src/daemon/mode-commands.ts`(peer 解析块,`peerProviderId === providerId` 检查之后)
- Modify: `src/core/conversation-coordinator.ts`(`validateMode` 的 primary_tool 分支)
- Test: 各自现有套件加用例

- [ ] **Step 1: capability-matrix 恢复合取**

:162-167 的注释与赋值:

```ts
  // delegate-mcp is loaded for every primary_tool session regardless of
  // whether the host provider itself can be a delegate target — the host
  // delegates OUT to others. supportsDelegation controls whether THIS
  // provider can be registered as a peer (consumed by ProviderRegistry,
  // not by the matrix).
  const delegate = mode === 'primary_tool' ? 'loaded' : 'unloaded'
```

改为:

```ts
  // RFC-05 §2.4 的合取(spec 2026-08-17-provider-runtime-dedup §4):主提供方
  // 自己必须 supportsDelegation 才装载 delegate-mcp —— gemini/cursor 的注册
  // 根本没有 delegate stdio 通道,'loaded' 是谎报。mode-commands 与
  // validateMode 是另外两道防线(拒绝进入该组合)。
  const delegate = mode === 'primary_tool' && cap.supportsDelegation ? 'loaded' : 'unloaded'
```

- [ ] **Step 2: mode-commands 第四检查**

`if (peerProviderId === providerId) { … }` 块之后、`const wiredPeer = …` 之前插入:

```ts
          // B2(spec §4):主提供方必须能委派出去,否则确认消息许诺的
          // delegate 工具在其会话里根本不存在(gemini 硬编码
          // delegateAvailable:false,cursor 无 delegate stdio 通道)。
          // Surface, don't paper over(RFC-05 §5)。
          if (!capabilitiesFor(providerId).supportsDelegation) {
            await reply(msg.chatId, `❌ ${slashWord} 不支持主从模式(该 provider 的会话无法调用 delegate 工具),对话保持原模式。`)
            return true
          }
```

(`capabilitiesFor` 已在 :30 import,无新增。)

- [ ] **Step 3: validateMode 同一防线**

primary_tool 分支的 `if (!deps.registry.has(mode.primary)) { … }` 之后插入:

```ts
      // B2(spec §4):持久化状态里翻出的旧非法组合也要拦 —— 与 registry
      // 未注册同姿势,抛错由 setMode 调用方转成用户可见的失败。
      if (!capabilitiesFor(mode.primary).supportsDelegation) {
        throw new Error(`provider '${mode.primary}' cannot delegate (supportsDelegation=false) — primary_tool mode unavailable`)
      }
```

coordinator 顶部补 `import { capabilitiesFor } from './capability-matrix'`(确认无循环依赖:capability-matrix 不 import coordinator)。

- [ ] **Step 4: 测试**

- `capability-matrix` 套件:cursor/gemini × primary_tool × 两种 permissionMode 的 `delegate` 断言改 `'unloaded'`;claude/codex/openai 仍 `'loaded'`。`assertMatrixComplete` 用例不变。
- `mode-commands` 套件(现有模式):`/gemini + cc` ⇒ 回复含"不支持主从模式"且 setMode 未被调用;`/cc + codex` 照常成功。
- coordinator 套件:`setMode(chat, { kind:'primary_tool', primary:'gemini' })` 抛错含 `cannot delegate`。

Run: `bun --bun vitest run src/core/capability-matrix.test.ts src/daemon/mode-commands.test.ts src/core/conversation-coordinator.test.ts && bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/core/capability-matrix.ts src/daemon/mode-commands.ts src/core/conversation-coordinator.ts $(git diff --name-only | grep test)
git commit -m "fix(mode): supportsDelegation enforced at parser+validateMode+matrix — /gemini+cc no longer fake-succeeds (D4/B2)

Behavior change (deliberate, spec §5): non-delegating primaries (gemini/cursor)
are rejected with a clear reason instead of a false '✅ delegate_*' confirmation;
their primary_tool matrix rows now say delegate:'unloaded' (matching reality)."
```

---

### Task 10: bootstrap 类型收敛 + 全量回归 + 文档

**Files:**
- Modify: `src/daemon/bootstrap/mcp-specs.ts`(:24 本地类型)
- Modify: `docs/architecture.md`(D4 行)

- [ ] **Step 1: mcp-specs.ts 收敛**

删除本地 `export interface McpStdioSpec`(:24 附近),改为:

```ts
export type { McpStdioSpec } from '../../core/mcp-stdio-spec'
```

(保留 re-export,bootstrap 侧现有 import 路径全部不断裂。)Run `grep -rn "interface .*McpStdioSpec\|interface CodexMcpStdioServer\|interface GeminiMcpStdioSpec\|interface CursorMcpStdioSpec" --include="*.ts" src` — Expected: **0 命中**(五份定义只剩共享一份)。

- [ ] **Step 2: 全量回归**

Run: `bunx tsc --noEmit && bun --bun vitest run`(允许仅那 2 个已知环境失败)
Run: `bun --bun vitest run --config vitest.e2e.config.ts`
Expected: 全绿

- [ ] **Step 3: 文档**

`docs/architecture.md` D4 行按该文档状态标注惯例(粗体状态词 + 日期)标 **RESOLVED 2026-08-17**,正文一句:shared `mcp-stdio-spec`/`auth-fail`/`async-queue`/`turn-emitter` in src/core;B1/B2/B3 修复;指针 `docs/superpowers/specs/2026-08-17-provider-runtime-dedup-design.md`;注明 out-of-scope 残留(cancel() 三家、文本粒度、gemini 假 resume)留在正文括号里。

- [ ] **Step 4: Commit**

```bash
git add src/daemon/bootstrap/mcp-specs.ts docs/architecture.md
git commit -m "docs: mark D4 resolved — one McpStdioSpec, one auth-fail source, shared turn plumbing"
```
