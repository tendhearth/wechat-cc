# ACP 客户端(Cursor 进工作台)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作台里的 Cursor 执行者改由 `cursor-agent acp`(Agent Client Protocol v1,stdio JSON-RPC)驱动:命令逐次进权限卡、时间线有逐条活动行、逐字流照旧;不再标「免审」、不再要一次性确认;agy 与对话侧的 Cursor 一行不动。

**Architecture:** 四个新文件:`src/core/acp/rpc.ts`(换行分隔 JSON-RPC over stdio)、`src/core/acp/events.ts`(`session/update` → `AgentEvent` 纯翻译)、`src/core/acp/agents.ts`(启动描述与二进制解析)、`src/core/acp-workbench-provider.ts`(`AgentProvider`:spawn / dispatch / cancel / close,进程组确认退出)。能力层加 `ACP_CAPABILITIES`(`permissions:'task'`);`wire-workbench` 新增 `registerAcpExecutors`,`registerUnattendedExecutors` 只剩 agy。`service.ts` 不改。

**Tech Stack:** TypeScript / Bun 1.3.14 + Node 24(vitest,`bun --bun vitest run`),`node:child_process`(与 codex 适配器同,测试用 `vi.mock`),`AsyncQueue`(`src/core/async-queue.ts`),`makeTurnEmitter`(`src/core/turn-emitter.ts`)。

**Spec:** `docs/superpowers/specs/2026-09-17-acp-cursor-executor-design.md`(前提:`docs/superpowers/specs/2026-09-17-acp-evaluation.md` 末节的真机 spike)

## Global Constraints

- 仓库 `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit`,分支 `dev`;不碰兄弟工作树 `…/wechat-cc`。
- 测试 `bun --bun vitest run <paths>`;全量 `bun run test`;Node `npm run test:node`;`bun run typecheck`;`bun run depcheck`(0 errors;7 warnings 既有)。业务代码不 import `bun:*`、不用 Bun 全局(`no-bun-globals` 守卫)。
- **"不按品牌准入"不变式保留**:`src/core/workbench/service-capabilities.test.ts` 的 `does not admit a provider by brand` 原样通过;准入只看能力对象。
- **隐私规矩(与 `codex-activity.ts` 同)**:活动行 `detail` 只放路径与工具身份,**永不**复制 `rawInput` / `rawOutput` / `content` / 命令字符串;权限卡的 `description` 可以含命令(那是给主人审的)。
- **权限只回 `allow_once` / `reject_once`**,绝不选 `allow_always` / `reject_always`。
- 客户端能力 `{ fs: { readTextFile: false, writeTextFile: false }, terminal: false }`,不声明 `elicitation`;任何未知 agent→client 请求回 `-32601`。
- `close()` 必须确认进程组退出(`process.kill(-pid, 0)` 抛 ESRCH),否则抛 `acp_process_not_exited`。win32 在 spawn 时直接拒绝。
- 提示文案原文:「Cursor 通过 ACP 执行：命令会逐次请求批准；工作区内的文件编辑由 Cursor 直接执行，不经过权限卡。」
- 提交信息中文,末尾两行:`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_0192qR5eDp28Cz3Xg66oEu6c`。每任务:相关测试绿 → typecheck 干净 → 提交。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/core/acp/rpc.ts`(新) | 换行分隔 JSON-RPC:请求配对、超时、agent→client 请求回复、fatal |
| `src/core/acp/events.ts`(新) | `session/update` → `AgentEvent`;itemId 合成;活动映射;权限描述与选项 |
| `src/core/acp/agents.ts`(新) | `resolveAcpAgent('cursor', config, findOnPath)` |
| `src/core/acp-workbench-provider.ts`(新) | `createAcpWorkbenchProvider`:进程、initialize/session、dispatch、cancel、close |
| `src/core/workbench/executor-capabilities.ts` | `ACP_CAPABILITIES` |
| `src/daemon/bootstrap/wire-workbench.ts` | `registerAcpExecutors`;`registerUnattendedExecutors` 只剩 agy |
| `src/core/workbench/execution-settings.ts`、`apps/desktop/src/modules/workbench-execution.js` | `acp_*` 错误文案 |
| `src/core/workbench/wechat-control.ts`、`apps/desktop/src/modules/workbench-unattended.js` | 免审文案去掉 Cursor |
| `docs/cc-workbench.md` | 执行者覆盖表 + 修订记录 |

---

### Task 1: JSON-RPC 连接层 `src/core/acp/rpc.ts`

**Files:**
- Create: `src/core/acp/rpc.ts`
- Test: `src/core/acp/rpc.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AcpRpcError { code: number; message: string; data?: unknown }
  export interface AcpConnectionOptions { rpcTimeoutMs: number; onRequest(method: string, params: unknown, id: string | number): Promise<unknown>; onNotification(method: string, params: unknown): void; onFatal(error: Error): void }
  export interface AcpConnection { request(method: string, params: unknown, timeoutMs?: number): Promise<any>; notify(method: string, params: unknown): void; dispose(reason: Error): void }
  export class AcpRequestError extends Error { code: number; data?: unknown }
  export function createAcpConnection(stdin: NodeJS.WritableStream, stdout: NodeJS.ReadableStream, options: AcpConnectionOptions): AcpConnection
  ```

- [ ] **Step 1: 写失败的测试**

```ts
// src/core/acp/rpc.test.ts
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AcpRequestError, createAcpConnection } from './rpc'

function harness(overrides: Partial<Parameters<typeof createAcpConnection>[2]> = {}) {
  const stdin = new PassThrough(), stdout = new PassThrough()
  const written: any[] = []
  let pending = ''
  stdin.on('data', chunk => { pending += String(chunk); let i; while ((i = pending.indexOf('\n')) >= 0) { written.push(JSON.parse(pending.slice(0, i))); pending = pending.slice(i + 1) } })
  const onRequest = vi.fn(async () => ({ ok: true })), onNotification = vi.fn(), onFatal = vi.fn()
  const conn = createAcpConnection(stdin, stdout, { rpcTimeoutMs: 50, onRequest, onNotification, onFatal, ...overrides })
  const agent = (msg: unknown) => stdout.write(JSON.stringify(msg) + '\n')
  const flushed = () => new Promise(resolve => setTimeout(resolve, 0))
  return { conn, written, agent, onRequest, onNotification, onFatal, flushed, stdout }
}

describe('ACP JSON-RPC over stdio', () => {
  it('pairs responses by id and rejects error responses with code and data', async () => {
    const h = harness()
    const p1 = h.conn.request('initialize', { a: 1 }), p2 = h.conn.request('session/new', {})
    await h.flushed()
    expect(h.written).toEqual([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } }, { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} }])
    h.agent({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } })
    h.agent({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'auth', data: { x: 1 } } })
    await expect(p2).resolves.toEqual({ sessionId: 's' })
    const err = await p1.catch(e => e)
    expect(err).toBeInstanceOf(AcpRequestError); expect(err.code).toBe(-32000); expect(err.message).toBe('auth'); expect(err.data).toEqual({ x: 1 })
  })
  it('times out with the method name, and 0 means no timeout', async () => {
    const h = harness()
    await expect(h.conn.request('slow', {})).rejects.toThrow('acp_rpc_timeout: slow')
    const p = h.conn.request('session/prompt', {}, 0)
    await new Promise(resolve => setTimeout(resolve, 80))
    h.agent({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } })
    await expect(p).resolves.toEqual({ stopReason: 'end_turn' })
  })
  it('answers agent requests with result or error and routes notifications', async () => {
    const h = harness({ onRequest: vi.fn(async (method: string) => { if (method === 'fs/read_text_file') throw Object.assign(new Error('client capability not declared: fs/read_text_file'), { code: -32601 }); return { outcome: 'x' } }) })
    h.agent({ jsonrpc: '2.0', id: 'r1', method: 'session/request_permission', params: { p: 1 } })
    h.agent({ jsonrpc: '2.0', id: 'r2', method: 'fs/read_text_file', params: {} })
    h.agent({ jsonrpc: '2.0', method: 'session/update', params: { u: 1 } })
    await h.flushed(); await h.flushed()
    expect(h.written).toContainEqual({ jsonrpc: '2.0', id: 'r1', result: { outcome: 'x' } })
    expect(h.written).toContainEqual({ jsonrpc: '2.0', id: 'r2', error: { code: -32601, message: 'client capability not declared: fs/read_text_file' } })
    expect(h.onNotification).toHaveBeenCalledWith('session/update', { u: 1 })
  })
  it('reports fatal once on invalid JSON and on oversized lines', async () => {
    const h = harness()
    h.stdout.write('{not json\n'); h.stdout.write('{"also":"bad"\n')
    await h.flushed()
    expect(h.onFatal).toHaveBeenCalledTimes(1); expect(h.onFatal.mock.calls[0][0].message).toBe('acp_invalid_protocol_message')
    const big = harness()
    big.stdout.write('x'.repeat(4 * 1024 * 1024 + 1))
    await big.flushed()
    expect(big.onFatal.mock.calls[0][0].message).toBe('acp_line_too_long')
  })
  it('dispose rejects pending and later requests, and late agent requests get -32603', async () => {
    const h = harness()
    const p = h.conn.request('x', {}, 0)
    h.conn.dispose(new Error('acp_session_closed'))
    await expect(p).rejects.toThrow('acp_session_closed')
    await expect(h.conn.request('y', {})).rejects.toThrow('acp_session_closed')
    h.agent({ jsonrpc: '2.0', id: 'late', method: 'session/request_permission', params: {} })
    await h.flushed()
    expect(h.written.at(-1)).toEqual({ jsonrpc: '2.0', id: 'late', error: { code: -32603, message: 'acp_session_closed' } })
    expect(h.onRequest).not.toHaveBeenCalled()
  })
  it('reports write failure as fatal instead of throwing', () => {
    const h = harness()
    h.conn['__stdinForTest']?.()
    const closed = new PassThrough(); closed.end()
    const conn2 = createAcpConnection(closed, new PassThrough(), { rpcTimeoutMs: 10, onRequest: async () => null, onNotification: () => {}, onFatal: h.onFatal })
    conn2.notify('session/cancel', {})
    expect(h.onFatal).toHaveBeenCalledWith(expect.objectContaining({ message: 'acp_protocol_write_failed' }))
  })
})
```

去掉最后一个测试里 `h.conn['__stdinForTest']?.()` 这一行(不存在这样的钩子;写进去只是提醒不要加测试专用后门)。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/acp/rpc.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
// src/core/acp/rpc.ts
/**
 * ACP(Agent Client Protocol v1)的传输层:stdio 上换行分隔的 JSON-RPC 2.0。
 * 真机(cursor-agent acp,2026-09-17 spike)一行一条,没有 Content-Length 头。
 * 只管配对与回复,不认识任何方法名。
 */
export interface AcpRpcError { code: number; message: string; data?: unknown }
export interface AcpConnectionOptions {
  rpcTimeoutMs: number
  /** agent → client 请求:返回值作为 result;抛错 ⇒ error 回复(code 取 err.code 数字,否则 -32603)。 */
  onRequest(method: string, params: unknown, id: string | number): Promise<unknown>
  onNotification(method: string, params: unknown): void
  /** 协议层无法继续(解析失败、行超长、写失败)。只触发一次。 */
  onFatal(error: Error): void
}
export interface AcpConnection {
  /** timeoutMs 缺省 rpcTimeoutMs;0 ⇒ 不限时(session/prompt 由服务层 watchdog 兜底)。 */
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>
  notify(method: string, params: unknown): void
  /** 拒绝所有挂起请求;之后 request 直接 reject,晚到的 agent 请求回 -32603。 */
  dispose(reason: Error): void
}
export class AcpRequestError extends Error {
  code: number; data?: unknown
  constructor(error: AcpRpcError) { super(error.message); this.name = 'AcpRequestError'; this.code = error.code; this.data = error.data }
}

const MAX_LINE = 4 * 1024 * 1024
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function createAcpConnection(stdin: NodeJS.WritableStream, stdout: NodeJS.ReadableStream, options: AcpConnectionOptions): AcpConnection {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>()
  let sequence = 0, buffer = '', disposed: Error | undefined, fatal = false
  const fail = (message: string) => { if (fatal) return; fatal = true; options.onFatal(new Error(message)) }
  const write = (message: Record<string, unknown>) => {
    try { stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n', error => { if (error) fail('acp_protocol_write_failed') }) }
    catch { fail('acp_protocol_write_failed') }
  }
  const respond = (id: string | number, outcome: { result: unknown } | { error: AcpRpcError }) => write({ id, ...outcome })
  const handle = (message: Record<string, unknown>) => {
    const id = message.id
    const hasId = typeof id === 'string' || typeof id === 'number'
    if (hasId && typeof message.method !== 'string') {
      // 响应
      const entry = typeof id === 'number' ? pending.get(id) : undefined
      if (!entry) return
      pending.delete(id as number); if (entry.timer) clearTimeout(entry.timer)
      if (object(message.error) && typeof message.error.code === 'number' && typeof message.error.message === 'string') entry.reject(new AcpRequestError(message.error as AcpRpcError))
      else entry.resolve(message.result)
      return
    }
    if (typeof message.method !== 'string') return
    if (!hasId) { options.onNotification(message.method, message.params); return }
    if (disposed) { respond(id as string | number, { error: { code: -32603, message: disposed.message } }); return }
    void options.onRequest(message.method, message.params, id as string | number).then(
      result => respond(id as string | number, { result: result === undefined ? null : result }),
      (error: unknown) => {
        const code = object(error) && typeof error.code === 'number' ? error.code : -32603
        respond(id as string | number, { error: { code, message: error instanceof Error ? error.message : String(error) } })
      },
    )
  }
  stdout.on('data', chunk => {
    if (fatal) return
    buffer += String(chunk)
    if (buffer.length > MAX_LINE && !buffer.includes('\n')) { buffer = ''; fail('acp_line_too_long'); return }
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1)
      if (!line) continue
      if (line.length > MAX_LINE) { fail('acp_line_too_long'); return }
      let message: unknown
      try { message = JSON.parse(line) } catch { fail('acp_invalid_protocol_message'); return }
      if (!object(message)) { fail('acp_invalid_protocol_message'); return }
      handle(message)
    }
  })
  return {
    request(method, params, timeoutMs = options.rpcTimeoutMs) {
      if (disposed) return Promise.reject(disposed)
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const entry: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject }
        if (timeoutMs > 0) entry.timer = setTimeout(() => { pending.delete(id); reject(new Error(`acp_rpc_timeout: ${method}`)) }, timeoutMs)
        pending.set(id, entry)
        write({ id, method, params })
      })
    },
    notify(method, params) { if (!disposed) write({ method, params }) },
    dispose(reason) {
      if (disposed) return
      disposed = reason
      for (const [id, entry] of pending) { pending.delete(id); if (entry.timer) clearTimeout(entry.timer); entry.reject(reason) }
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/acp/rpc.test.ts && bun run typecheck`
Expected: 6 passed;typecheck 0 errors

- [ ] **Step 5: 提交**

```bash
git add src/core/acp/rpc.ts src/core/acp/rpc.test.ts
git commit -m "ACP 客户端①:stdio 上换行分隔的 JSON-RPC 连接层(配对 / 超时 / 反向请求回复 / fatal)"
```

---

### Task 2: 事件翻译 `src/core/acp/events.ts`

**Files:**
- Create: `src/core/acp/events.ts`
- Test: `src/core/acp/events.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`、`AgentActivity`(`src/core/agent-provider.ts`)。
- Produces:
  ```ts
  export interface AcpTranslator { update(update: unknown): AgentEvent[]; beginTurn(): void }
  export function createAcpTranslator(): AcpTranslator
  export function acpActivityId(toolCallId: string): string
  export function acpPermissionDescription(params: unknown): string | null
  export function acpPermissionOption(options: unknown, allow: boolean): string | null
  ```

- [ ] **Step 1: 写失败的测试**

```ts
// src/core/acp/events.test.ts
import { describe, expect, it } from 'vitest'
import { acpActivityId, acpPermissionDescription, acpPermissionOption, createAcpTranslator } from './events'

const chunk = (text: string, messageId?: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(messageId ? { messageId } : {}) })
const call = (extra: Record<string, unknown> = {}) => ({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Edit File', kind: 'edit', status: 'pending', rawInput: { path: 'secret.txt', content: 'SECRET' }, locations: [{ path: '/p/a.ts' }], ...extra })

describe('ACP session/update → AgentEvent', () => {
  it('synthesizes an itemId per assistant message when messageId is absent and rolls it over across tool calls', () => {
    const t = createAcpTranslator(); t.beginTurn()
    expect(t.update(chunk('这'))).toEqual([{ kind: 'text', text: '这', itemId: 'acp:turn:1:0', textMode: 'append' }])
    expect(t.update(chunk('边'))).toEqual([{ kind: 'text', text: '边', itemId: 'acp:turn:1:0', textMode: 'append' }])
    t.update(call())
    expect(t.update(chunk('好'))[0]).toMatchObject({ itemId: 'acp:turn:1:1' })
    t.beginTurn()
    expect(t.update(chunk('新'))[0]).toMatchObject({ itemId: 'acp:turn:2:0' })
  })
  it('uses messageId when present and ignores non-text and thought chunks', () => {
    const t = createAcpTranslator(); t.beginTurn()
    expect(t.update(chunk('a', 'm-9'))[0]).toMatchObject({ itemId: 'acp:msg:m-9' })
    expect(t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } })).toEqual([])
    expect(t.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private' } })).toEqual([])
    for (const kind of ['user_message_chunk', 'plan', 'available_commands_update', 'current_mode_update', 'config_option_update', 'usage_update']) expect(t.update({ sessionUpdate: kind })).toEqual([])
  })
  it('maps tool_call kinds to public activities without copying raw input or output', () => {
    const t = createAcpTranslator(); t.beginTurn()
    const [ev] = t.update(call())
    expect(ev).toEqual({ kind: 'tool_call', tool: 'edit', activity: { id: 'call-1', type: 'edit', status: 'running', label: '修改文件', detail: '/p/a.ts' } })
    expect(JSON.stringify(ev)).not.toContain('SECRET')
    const cases: Array<[string, string, string]> = [['read', 'read', '读取文件'], ['delete', 'edit', '删除文件'], ['move', 'edit', '移动文件'], ['search', 'search', '检索文件'], ['execute', 'command', '运行命令'], ['fetch', 'search', '获取网页'], ['switch_mode', 'tool', '调用工具'], ['other', 'tool', '调用工具']]
    for (const [kind, type, label] of cases) expect(t.update(call({ toolCallId: `c-${kind}`, kind, locations: [] }))[0]).toMatchObject({ activity: { type, label } })
    expect(t.update(call({ toolCallId: 'think-1', kind: 'think' }))).toEqual([])
  })
  it('merges tool_call_update into the remembered call and keeps title only as tool identity for other kinds', () => {
    const t = createAcpTranslator(); t.beginTurn()
    t.update(call({ kind: 'other', title: 'MCP: tool', locations: undefined }))
    const [ev] = t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'spike-wechat: ping', rawInput: { providerIdentifier: 'spike-wechat', args: { secret: 'S' } } })
    expect(ev).toMatchObject({ activity: { id: 'call-1', type: 'tool', status: 'running', label: '调用工具', detail: 'spike-wechat: ping' } })
    const [done] = t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: { success: true, secret: 'S2' } })
    expect(done).toMatchObject({ activity: { status: 'completed', detail: 'spike-wechat: ping' } })
    expect(JSON.stringify(done)).not.toContain('S2')
    expect(t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'unknown', status: 'failed' })[0]).toMatchObject({ activity: { id: 'unknown', type: 'tool', status: 'failed' } })
    expect(t.update(call({ toolCallId: 'exec', kind: 'execute', title: '`rm -rf /`', status: 'failed' }))[0]).toMatchObject({ activity: { status: 'failed' } })
    expect(JSON.stringify(t.update(call({ toolCallId: 'exec2', kind: 'execute', title: '`uname -a`' })))).not.toContain('uname')
  })
  it('sanitizes tool call ids with control characters and bounds length', () => {
    expect(acpActivityId('call-bf73-0\nfc_2190_0')).toBe('call-bf73-0_fc_2190_0')
    expect(acpActivityId('x'.repeat(500))).toHaveLength(200)
  })
  it('describes permission requests for review and picks only the once options', () => {
    const params = { sessionId: 's', toolCall: { toolCallId: 'c', title: '`uname -a`', kind: 'execute', status: 'pending', rawInput: { command: 'uname -a' }, content: [{ type: 'content', content: { type: 'text', text: 'Not in allowlist: uname' } }], locations: [{ path: '/p' }] }, options: [{ optionId: 'allow-always', name: 'Always', kind: 'allow_always' }, { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] }
    expect(acpPermissionDescription(params)).toBe('uname -a\nNot in allowlist: uname\n/p')
    expect(acpPermissionDescription({ ...params, toolCall: { ...params.toolCall, kind: 'edit', rawInput: {} } })).toBe('`uname -a`\nNot in allowlist: uname\n/p')
    expect(acpPermissionDescription({ ...params, toolCall: undefined })).toBeNull()
    expect(acpPermissionDescription({ ...params, options: 'no' })).toBeNull()
    expect(acpPermissionDescription({ ...params, toolCall: { ...params.toolCall, rawInput: { command: 'x'.repeat(20_001) } } })).toBeNull()
    expect(acpPermissionOption(params.options, true)).toBe('allow-once')
    expect(acpPermissionOption(params.options, false)).toBe('reject-once')
    expect(acpPermissionOption([{ optionId: 'a', kind: 'allow_always' }], true)).toBeNull()
    expect(acpPermissionOption('nope', false)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/acp/events.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
// src/core/acp/events.ts
import type { AgentActivity, AgentEvent } from '../agent-provider'

/**
 * ACP `session/update` → `AgentEvent` 的纯翻译。不碰进程、不碰 RPC。
 *
 * 真机(cursor-agent acp,2026-09-17 spike)三条规矩来源:
 *  - `agent_message_chunk` 没有 `messageId`,同一轮里工具调用前后是两条助理消息 ⇒ 自己合成 itemId,
 *    遇到 tool_call 之后再来的文本翻新一条;
 *  - `toolCallId` 里嵌着字面换行 ⇒ 当活动 id(event_key / DOM id)前先清洗;
 *  - `rawOutput` 只有 `{success:true}`,真正载荷不在协议里 ⇒ 活动行只放路径与工具身份(与 codex-activity 同一条隐私规矩)。
 */
export interface AcpTranslator { update(update: unknown): AgentEvent[]; beginTurn(): void }

type Obj = Record<string, unknown>
const object = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value)
const display = (value: unknown, limit = 300): string => typeof value === 'string' ? value.replace(/[ -]/g, ' ').trim().slice(0, limit) : ''
const paths = (locations: unknown): string[] => Array.isArray(locations) ? [...new Set(locations.slice(0, 12).map(loc => object(loc) ? display(loc.path) : '').filter(Boolean))] : []

export function acpActivityId(toolCallId: string): string { return toolCallId.replace(/[ -]/g, '_').slice(0, 200) }

const KINDS: Record<string, { type: AgentActivity['type']; label: string }> = {
  read: { type: 'read', label: '读取文件' }, edit: { type: 'edit', label: '修改文件' }, delete: { type: 'edit', label: '删除文件' }, move: { type: 'edit', label: '移动文件' },
  search: { type: 'search', label: '检索文件' }, execute: { type: 'command', label: '运行命令' }, fetch: { type: 'search', label: '获取网页' },
}
const OTHER = { type: 'tool' as const, label: '调用工具' }
const status = (value: unknown): AgentActivity['status'] => value === 'completed' ? 'completed' : value === 'failed' ? 'failed' : 'running'

interface Remembered { kind: string; title: string; name: string; status: AgentActivity['status']; paths: string[] }

export function createAcpTranslator(): AcpTranslator {
  let turn = 0, message = 0, textSeen = false
  const calls = new Map<string, Remembered>()
  const activityEvent = (id: string, call: Remembered): AgentEvent | null => {
    if (call.kind === 'think') return null
    const spec = KINDS[call.kind] ?? OTHER
    const activity: AgentActivity = { id, type: spec.type, status: call.status, label: spec.label }
    const detail = spec === OTHER ? [...call.paths, display(call.title, 120)].filter(Boolean).join('\n') : call.paths.join('\n')
    if (detail) activity.detail = detail.slice(0, 2000)
    return { kind: 'tool_call', tool: call.name || call.kind || 'tool', activity }
  }
  return {
    beginTurn() { turn++; message = 0; textSeen = false; calls.clear() },
    update(update) {
      if (!object(update) || typeof update.sessionUpdate !== 'string') return []
      if (update.sessionUpdate === 'agent_message_chunk') {
        if (!object(update.content) || update.content.type !== 'text' || typeof update.content.text !== 'string') return []
        textSeen = true
        const itemId = typeof update.messageId === 'string' && update.messageId ? `acp:msg:${acpActivityId(update.messageId)}` : `acp:turn:${turn}:${message}`
        return [{ kind: 'text', text: update.content.text, itemId, textMode: 'append' }]
      }
      if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return []
      if (typeof update.toolCallId !== 'string' || !update.toolCallId) return []
      const id = acpActivityId(update.toolCallId)
      if (update.sessionUpdate === 'tool_call' && textSeen) { message++; textSeen = false }
      const previous = calls.get(id) ?? { kind: '', title: '', name: '', status: 'running' as const, paths: [] }
      const call: Remembered = {
        kind: typeof update.kind === 'string' ? update.kind : previous.kind,
        title: typeof update.title === 'string' ? update.title : previous.title,
        name: typeof update.name === 'string' ? display(update.name, 120) : previous.name,
        status: update.status === undefined ? previous.status : status(update.status),
        paths: update.locations === undefined ? previous.paths : paths(update.locations),
      }
      calls.set(id, call)
      const event = activityEvent(id, call)
      return event ? [event] : []
    },
  }
}

/** 权限卡正文:命令(execute 的 rawInput.command)/ 标题、agent 附带的说明文本、涉及路径。超过 20_000 字或形状不对 ⇒ null(不可完整显示就不放行)。 */
export function acpPermissionDescription(params: unknown): string | null {
  if (!object(params) || !object(params.toolCall) || !Array.isArray(params.options)) return null
  const call = params.toolCall
  const command = call.kind === 'execute' && object(call.rawInput) && typeof call.rawInput.command === 'string' ? call.rawInput.command : null
  const notes = Array.isArray(call.content) ? call.content.map(item => object(item) && item.type === 'content' && object(item.content) && item.content.type === 'text' && typeof item.content.text === 'string' ? item.content.text : '').filter(Boolean) : []
  const parts = [command ?? (typeof call.title === 'string' ? call.title : ''), ...notes, ...paths(call.locations)].filter(Boolean)
  const description = parts.join('\n')
  return description && description.length <= 20_000 ? description : null
}

/** 只认 once 档:daemon 的权限桥是逐次布尔,永远不替主人做长期授权。找不到 ⇒ null(调用方回 cancelled)。 */
export function acpPermissionOption(options: unknown, allow: boolean): string | null {
  if (!Array.isArray(options)) return null
  const wanted = allow ? 'allow_once' : 'reject_once'
  const option = options.find(item => object(item) && item.kind === wanted && typeof item.optionId === 'string' && item.optionId)
  return option ? String((option as Obj).optionId) : null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/acp/events.test.ts && bun run typecheck`
Expected: 6 passed;typecheck 0 errors

- [ ] **Step 5: 提交**

```bash
git add src/core/acp/events.ts src/core/acp/events.test.ts
git commit -m "ACP 客户端②:session/update 到 AgentEvent 的翻译(合成 itemId、活动映射、权限描述与选项)"
```

---

### Task 3: 启动描述 + 能力常量

**Files:**
- Create: `src/core/acp/agents.ts`
- Modify: `src/core/workbench/executor-capabilities.ts`(追加 `ACP_CAPABILITIES`)
- Test: `src/core/acp/agents.test.ts`、`src/core/workbench/executor-capabilities.test.ts`(追加)

**Interfaces:**
- Consumes: `AgentConfig.cursorAgentBin?: string`(`src/lib/agent-config.ts`);`findOnPath(cmd): string | null`(`src/lib/util.ts`)。
- Produces:
  ```ts
  export interface AcpAgentLaunch { id: 'cursor'; displayName: string; command: string; args: string[] }
  export function resolveAcpAgent(id: 'cursor', config: { cursorAgentBin?: string }, findOnPath: (cmd: string) => string | null): AcpAgentLaunch | null
  export const ACP_CAPABILITIES: WorkbenchExecutorCapabilities
  ```

- [ ] **Step 1: 写失败的测试**

```ts
// src/core/acp/agents.test.ts
import { describe, expect, it } from 'vitest'
import { resolveAcpAgent } from './agents'

describe('ACP agent launch resolution', () => {
  it('prefers the configured cursor-agent path, then PATH, and never probes', () => {
    expect(resolveAcpAgent('cursor', { cursorAgentBin: '/opt/cursor-agent' }, () => '/usr/bin/cursor-agent')).toEqual({ id: 'cursor', displayName: 'Cursor', command: '/opt/cursor-agent', args: ['acp'] })
    expect(resolveAcpAgent('cursor', {}, cmd => cmd === 'cursor-agent' ? '/usr/bin/cursor-agent' : null)).toEqual({ id: 'cursor', displayName: 'Cursor', command: '/usr/bin/cursor-agent', args: ['acp'] })
    expect(resolveAcpAgent('cursor', {}, () => null)).toBeNull()
  })
})
```

在 `src/core/workbench/executor-capabilities.test.ts` 顶部 import 加 `ACP_CAPABILITIES`,文件末尾追加:

```ts
describe('ACP executor capabilities', () => {
  it('is a task-permission executor without attachments, execution settings or model catalog, resumable natively', () => {
    expect(isWorkbenchExecutorCapabilities(ACP_CAPABILITIES)).toBe(true)
    expect(isUnattendedExecutor(ACP_CAPABILITIES)).toBe(false)
    expect(canResumeWorkbenchExecutor(ACP_CAPABILITIES)).toBe(true)
    expect(() => requireWorkbenchInput(ACP_CAPABILITIES, { ...input, attachments: [{}] })).toThrow('workbench_attachments_unsupported')
    expect(() => requireWorkbenchInput(ACP_CAPABILITIES, { attachments: [], execution: { defaults: 'native', model: null, reasoningEffort: null } })).toThrow('workbench_execution_unsupported')
    expect(() => requireWorkbenchInput(ACP_CAPABILITIES, { ...input, resume: true })).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/acp/agents.test.ts src/core/workbench/executor-capabilities.test.ts`
Expected: FAIL(`resolveAcpAgent` / `ACP_CAPABILITIES` 不存在)

- [ ] **Step 3: 实现**

```ts
// src/core/acp/agents.ts
/**
 * 走 ACP 的执行者启动描述。只认 cursor(`cursor-agent acp` 在用户已装的 CLI 里,零额外安装);
 * agy 的 ACP 面是 dl.google.com 上的独立二进制,按 2026-09-17 评估备忘推迟。
 * 不探测 --version、不起进程:能不能用由第一次 initialize 真跑说了算(codex-version-coupling 定案)。
 */
export interface AcpAgentLaunch { id: 'cursor'; displayName: string; command: string; args: string[] }

export function resolveAcpAgent(id: 'cursor', config: { cursorAgentBin?: string }, findOnPath: (cmd: string) => string | null): AcpAgentLaunch | null {
  if (id !== 'cursor') return null
  const command = config.cursorAgentBin ?? findOnPath('cursor-agent')
  return command ? { id: 'cursor', displayName: 'Cursor', command, args: ['acp'] } : null
}
```

`executor-capabilities.ts` 在 `UNATTENDED_CAPABILITIES` 之后追加:

```ts
/** 走 ACP 的执行者(cursor-agent acp):命令逐次进权限卡,但工作区内的文件编辑由 CLI 直接执行(spike 2026-09-17);
 *  按 session/load 恢复;不收附件、不认执行设置、无模型目录。 */
export const ACP_CAPABILITIES: WorkbenchExecutorCapabilities = Object.freeze({
  version:1,permissions:'task',configuration:'task-policy',completion:'native',stop:'confirmed',background:'disabled',
  features:Object.freeze({nativeResume:true,attachments:false,executionSettings:false,modelCatalog:false}),
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/acp/agents.test.ts src/core/workbench/executor-capabilities.test.ts src/core/workbench/service-capabilities.test.ts && bun run typecheck`
Expected: 全绿;typecheck 0 errors

- [ ] **Step 5: 提交**

```bash
git add src/core/acp/agents.ts src/core/acp/agents.test.ts src/core/workbench/executor-capabilities.ts src/core/workbench/executor-capabilities.test.ts
git commit -m "ACP 客户端③:cursor 的启动描述解析 + ACP_CAPABILITIES(task 权限、原生恢复、无附件/执行设置)"
```

---

### Task 4: 执行者 `src/core/acp-workbench-provider.ts`

**Files:**
- Create: `src/core/acp-workbench-provider.ts`
- Test: `src/core/acp-workbench-provider.test.ts`

**Interfaces:**
- Consumes: Task 1 `createAcpConnection` / `AcpRequestError`;Task 2 `createAcpTranslator` / `acpPermissionDescription` / `acpPermissionOption`;`AsyncQueue`(`src/core/async-queue.ts`:`push/end/iterable()`);`makeTurnEmitter`(`src/core/turn-emitter.ts`);`isAuthFail`(`src/core/auth-fail.ts`);`AgentProvider` / `AgentSession` / `SpawnContext`(`src/core/agent-provider.ts`)。
- Produces:
  ```ts
  export interface AcpWorkbenchProviderOptions { command: string; args: string[]; displayName: string; rpcTimeoutMs?: number; closeTimeoutMs?: number; spawn?: typeof spawn }
  export function createAcpWorkbenchProvider(options: AcpWorkbenchProviderOptions): AgentProvider
  export const ACP_NOTICE = 'Cursor 通过 ACP 执行：命令会逐次请求批准；工作区内的文件编辑由 Cursor 直接执行，不经过权限卡。'
  ```

- [ ] **Step 1: 写失败的测试**

```ts
// src/core/acp-workbench-provider.test.ts
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSession, SpawnContext } from './agent-provider'
import { TIER_PROFILES } from './user-tier'
import { ACP_NOTICE, createAcpWorkbenchProvider } from './acp-workbench-provider'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

type Rpc = { id?: string | number; method?: string; params?: any; result?: any; error?: any }
class FakeProcess extends EventEmitter {
  pid = 4242
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough()
  exitCode: number | null = null
  sent: Rpc[] = []
  initializeResult: Record<string, unknown> = { protocolVersion: 1, agentCapabilities: { loadSession: true } }
  newResult: Record<string, unknown> | { error: Rpc['error'] } = { sessionId: 'sess-1' }
  loadResult: Record<string, unknown> | { error: Rpc['error'] } = {}
  promptAuto = true
  groupAlive = true
  constructor() {
    super()
    let lines = ''
    this.stdin.on('data', chunk => {
      lines += String(chunk)
      while (lines.includes('\n')) {
        const end = lines.indexOf('\n'), line = lines.slice(0, end); lines = lines.slice(end + 1)
        const message = JSON.parse(line) as Rpc
        this.sent.push(message)
        if (message.method === 'initialize') queueMicrotask(() => this.send({ id: message.id, result: this.initializeResult }))
        if (message.method === 'session/new') queueMicrotask(() => this.send('error' in this.newResult ? { id: message.id, error: this.newResult.error } : { id: message.id, result: this.newResult }))
        if (message.method === 'session/load') queueMicrotask(() => { this.notify('session/update', { sessionId: message.params.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' } } }); this.notify('session/update', { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } } }); this.send('error' in this.loadResult ? { id: message.id, error: this.loadResult.error } : { id: message.id, result: this.loadResult }) })
        if (message.method === 'session/cancel') queueMicrotask(() => { const prompt = this.sent.findLast(m => m.method === 'session/prompt'); if (prompt) this.send({ id: prompt.id, result: { stopReason: 'cancelled' } }) })
      }
    })
  }
  send(message: Rpc) { this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n') }
  notify(method: string, params: unknown) { this.send({ method, params }) }
  update(update: unknown, sessionId = 'sess-1') { this.notify('session/update', { sessionId, update }) }
  finishPrompt(stopReason = 'end_turn') { const prompt = this.sent.findLast(m => m.method === 'session/prompt')!; this.send({ id: prompt.id, result: { stopReason } }) }
  exit(code: number | null = 0, signal: string | null = null) { if (this.exitCode !== null) return; this.exitCode = code; this.groupAlive = false; this.stdout.end(); this.emit('exit', code, signal) }
}
let children: FakeProcess[], sessions: AgentSession[], platform: PropertyDescriptor
const context = (extra: Partial<SpawnContext> = {}): SpawnContext => ({ tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', chatId: 'workbench:task', appendInstructions: 'task instructions', workbenchTimeline: true, ...extra })
async function start(extra: Partial<SpawnContext> = {}, setup?: (child: FakeProcess) => void) {
  const spawnedBefore = children.length
  const spawning = createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 200, closeTimeoutMs: 250 }).spawn({ alias: 'workbench:task', path: '/project' }, context(extra))
  await expect.poll(() => children.length).toBe(spawnedBefore + 1)
  setup?.(children.at(-1)!)
  const session = await spawning
  sessions.push(session)
  return { session, child: children.at(-1)! }
}
function collect(session: AgentSession, text = 'do the thing') {
  const events: AgentEvent[] = []
  const done = (async () => { for await (const event of session.dispatch(text)) events.push(event) })()
  return { events, done }
}
async function prompted(child: FakeProcess, n = 1) { await expect.poll(() => child.sent.filter(m => m.method === 'session/prompt').length).toBe(n) }
function permission(child: FakeProcess, id: string | number = 'perm-1', extra: Record<string, unknown> = {}) {
  child.send({ id, method: 'session/request_permission', params: { sessionId: 'sess-1', toolCall: { toolCallId: 'c1', title: '`uname -a`', kind: 'execute', status: 'pending', rawInput: { command: 'uname -a' } }, options: [{ optionId: 'allow-always', name: 'Always', kind: 'allow_always' }, { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }], ...extra } })
}
beforeEach(() => {
  children = []; sessions = []
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  mocks.spawn.mockReset().mockImplementation(() => { const child = new FakeProcess(); children.push(child); return child })
  mocks.kill.mockReset().mockImplementation((pid: number, signal?: string | number) => {
    const child = children.find(c => -c.pid === pid || c.pid === pid)
    if (!child || (!child.groupAlive && child.exitCode !== null)) { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) }
    if (signal === 'SIGTERM' || signal === 'SIGKILL') queueMicrotask(() => child.exit(null, String(signal)))
    return true
  })
  vi.spyOn(process, 'kill').mockImplementation(mocks.kill as never)
})
afterEach(async () => { for (const session of sessions) await session.close().catch(() => {}); Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks() })

describe('ACP workbench provider', () => {
  it('initializes without fs/terminal capabilities, opens a session and reports the edit-unattended notice', async () => {
    const reportNotice = vi.fn()
    const { child } = await start({ reportNotice })
    expect(mocks.spawn).toHaveBeenCalledWith('/cursor-agent', ['acp'], expect.objectContaining({ cwd: '/project', detached: true, stdio: ['pipe', 'pipe', 'pipe'] }))
    const init = child.sent.find(m => m.method === 'initialize')!
    expect(init.params).toEqual({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'cc_workbench', title: 'CC Workbench', version: '0.6.4' } })
    expect(child.sent.find(m => m.method === 'session/new')!.params).toEqual({ cwd: '/project', mcpServers: [] })
    expect(reportNotice).toHaveBeenCalledWith(ACP_NOTICE)
  })
  it('rejects unsupported protocol versions and missing session ids, closing the process', async () => {
    const bad = createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 200, closeTimeoutMs: 250 })
    const p1 = bad.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(1); children[0].initializeResult = { protocolVersion: 2 }
    await expect(p1).rejects.toThrow('acp_protocol_version_unsupported')
    await expect.poll(() => children[0].exitCode !== null).toBe(true)
    const p2 = bad.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(2); children[1].newResult = { sessionId: 'bad\nid' }
    await expect(p2).rejects.toThrow('acp_missing_session_id')
  })
  it('maps -32000 on session setup to acp_auth_required and other errors to acp_session_failed', async () => {
    const provider = createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 200, closeTimeoutMs: 250 })
    const p1 = provider.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(1); children[0].newResult = { error: { code: -32000, message: 'Authentication required' } }
    await expect(p1).rejects.toThrow('acp_auth_required')
    const p2 = provider.spawn({ alias: 'a', path: '/project' }, context())
    await expect.poll(() => children.length).toBe(2); children[1].newResult = { error: { code: -32602, message: 'bad cwd' } }
    await expect(p2).rejects.toThrow('acp_session_failed: bad cwd')
  })
  it('resumes through session/load, discards the replayed history, and refuses when loadSession is absent', async () => {
    const { session, child } = await start({ resumeSessionId: 'sess-old' })
    expect(child.sent.find(m => m.method === 'session/load')!.params).toEqual({ sessionId: 'sess-old', cwd: '/project', mcpServers: [] })
    expect(child.sent.some(m => m.method === 'session/new')).toBe(false)
    const { events, done } = collect(session)
    await prompted(child)
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live' } }, 'sess-old'); child.finishPrompt()
    await done
    expect(events.filter(e => e.kind === 'text').map(e => (e as any).text)).toEqual(['live'])
    expect(events[0]).toEqual({ kind: 'init', sessionId: 'sess-old' })
    const provider = createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 200, closeTimeoutMs: 250 })
    const p = provider.spawn({ alias: 'a', path: '/project' }, context({ resumeSessionId: 'sess-old' }))
    await expect.poll(() => children.length).toBe(2); children[1].initializeResult = { protocolVersion: 1, agentCapabilities: {} }
    await expect(p).rejects.toThrow('acp_resume_unsupported')
  })
  it('prefixes instructions on the first prompt only and streams init, text, activities and result', async () => {
    const { session, child } = await start()
    const first = collect(session, 'first ask')
    await prompted(child)
    expect(child.sent.findLast(m => m.method === 'session/prompt')!.params).toEqual({ sessionId: 'sess-1', prompt: [{ type: 'text', text: 'task instructions\n\n---\n\nfirst ask' }] })
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '这' } })
    child.update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Edit File', kind: 'edit', status: 'pending', locations: [{ path: '/project/a.ts' }] })
    child.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } })
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ignored' } }, 'other-session')
    child.finishPrompt()
    await first.done
    expect(first.events).toEqual([
      { kind: 'init', sessionId: 'sess-1' },
      { kind: 'text', text: '这', itemId: 'acp:turn:1:0', textMode: 'append' },
      { kind: 'tool_call', tool: 'edit', activity: { id: 'c1', type: 'edit', status: 'running', label: '修改文件', detail: '/project/a.ts' } },
      { kind: 'tool_call', tool: 'edit', activity: { id: 'c1', type: 'edit', status: 'completed', label: '修改文件', detail: '/project/a.ts' } },
      { kind: 'text', text: '好', itemId: 'acp:turn:1:1', textMode: 'append' },
      expect.objectContaining({ kind: 'result', sessionId: 'sess-1', numTurns: 1 }),
    ])
    const second = collect(session, 'second ask')
    await prompted(child, 2)
    expect(child.sent.findLast(m => m.method === 'session/prompt')!.params.prompt).toEqual([{ type: 'text', text: 'second ask' }])
    child.finishPrompt(); await second.done
  })
  it('turns permission requests into the task bridge and answers only with once options', async () => {
    const requestPermission = vi.fn(async (request: { tool: string; description: string }) => request.description.includes('rm') ? false : true)
    const { session, child } = await start({ requestPermission })
    const { done } = collect(session)
    await prompted(child)
    permission(child, 'perm-1')
    await expect.poll(() => child.sent.some(m => m.id === 'perm-1')).toBe(true)
    expect(requestPermission).toHaveBeenCalledWith({ tool: 'execute', description: 'uname -a' }, expect.any(AbortSignal))
    expect(child.sent.find(m => m.id === 'perm-1')).toEqual({ jsonrpc: '2.0', id: 'perm-1', result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
    permission(child, 'perm-2', { toolCall: { toolCallId: 'c2', title: '`rm x`', kind: 'execute', status: 'pending', rawInput: { command: 'rm x' } } })
    await expect.poll(() => child.sent.some(m => m.id === 'perm-2')).toBe(true)
    expect(child.sent.find(m => m.id === 'perm-2')!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    permission(child, 'perm-3', { options: [{ optionId: 'a', kind: 'allow_always' }] })
    await expect.poll(() => child.sent.some(m => m.id === 'perm-3')).toBe(true)
    expect(child.sent.find(m => m.id === 'perm-3')!.result).toEqual({ outcome: { outcome: 'cancelled' } })
    child.finishPrompt(); await done
  })
  it('rejects when no bridge is bound, cancels unverifiable requests and stops the task, and answers unknown methods with -32601', async () => {
    const { session, child } = await start()
    const { events, done } = collect(session)
    await prompted(child)
    permission(child, 'perm-1')
    await expect.poll(() => child.sent.some(m => m.id === 'perm-1')).toBe(true)
    expect(child.sent.find(m => m.id === 'perm-1')!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    child.send({ id: 'fs-1', method: 'fs/read_text_file', params: { path: '/etc/passwd' } })
    await expect.poll(() => child.sent.some(m => m.id === 'fs-1')).toBe(true)
    expect(child.sent.find(m => m.id === 'fs-1')!.error).toEqual({ code: -32601, message: 'client capability not declared: fs/read_text_file' })
    permission(child, 'perm-2', { toolCall: { toolCallId: 'c9', kind: 'execute', rawInput: { command: 'x'.repeat(20_001) } } })
    await expect.poll(() => child.sent.some(m => m.id === 'perm-2')).toBe(true)
    expect(child.sent.find(m => m.id === 'perm-2')!.result).toEqual({ outcome: { outcome: 'cancelled' } })
    await done
    expect(events.at(-1)).toEqual({ kind: 'error', message: '无法核实或完整显示本次 Cursor 权限请求，工作台已停止任务。' })
    await expect(async () => { for await (const _ of session.dispatch('again')) { /* noop */ } }).rejects.toThrow('acp_session_closed')
  })
  it('cancel sends session/cancel, aborts pending permissions and ends the turn with an error event', async () => {
    const requestPermission = vi.fn((_request: unknown, signal?: AbortSignal) => new Promise<boolean>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))))
    const { session, child } = await start({ requestPermission })
    const { events, done } = collect(session)
    await prompted(child)
    permission(child, 'perm-1')
    await expect.poll(() => requestPermission.mock.calls.length).toBe(1)
    await session.cancel!()
    expect(child.sent.some(m => m.method === 'session/cancel' && m.params.sessionId === 'sess-1')).toBe(true)
    await done
    expect(child.sent.find(m => m.id === 'perm-1')!.result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'acp_turn_cancelled' })
  })
  it('maps stop reasons: agent-side cancelled counts as end, max_tokens and refusal are errors', async () => {
    const { session, child } = await start()
    const a = collect(session); await prompted(child, 1); child.finishPrompt('cancelled'); await a.done
    expect(a.events.at(-1)).toMatchObject({ kind: 'result' })
    const b = collect(session); await prompted(child, 2); child.finishPrompt('max_tokens'); await b.done
    expect(b.events.at(-1)).toEqual({ kind: 'error', message: 'acp_stop_max_tokens' })
    const c = collect(session); await prompted(child, 3); child.finishPrompt('refusal'); await c.done
    expect(c.events.at(-1)).toEqual({ kind: 'error', message: 'acp_stop_refusal' })
  })
  it('surfaces an unexpected process exit as an error event and refuses further dispatch', async () => {
    const { session, child } = await start()
    const { events, done } = collect(session)
    await prompted(child)
    child.exit(1)
    await done
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'acp_process_exited: 1' })
    await expect(async () => { for await (const _ of session.dispatch('again')) { /* noop */ } }).rejects.toThrow('acp_session_closed')
  })
  it('close ends stdin, signals the process group and waits for exit; a stubborn group fails with acp_process_not_exited', async () => {
    const { session, child } = await start()
    await session.close()
    expect(child.stdin.writableEnded).toBe(true)
    expect(mocks.kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(child.exitCode).not.toBeNull()
    const stubborn = await start()
    mocks.kill.mockImplementation((pid: number, signal?: string | number) => { if (signal === 0) return true; return true })
    await expect(stubborn.session.close()).rejects.toThrow('acp_process_not_exited')
    expect(mocks.kill).toHaveBeenCalledWith(-stubborn.child.pid, 'SIGKILL')
    stubborn.child.exit(0)
  })
  it('refuses attachments, overlapping turns and win32', async () => {
    const { session, child } = await start()
    await expect(async () => { for await (const _ of session.dispatch('x', [{ name: 'a', mime: 'text/plain', path: '/a', sha256: 'f' }])) { /* noop */ } }).rejects.toThrow('acp_attachments_unsupported')
    const first = collect(session); await prompted(child)
    await expect(async () => { for await (const _ of session.dispatch('overlap')) { /* noop */ } }).rejects.toThrow('acp_turn_already_running')
    child.finishPrompt(); await first.done
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    await expect(createAcpWorkbenchProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor' }).spawn({ alias: 'a', path: '/project' }, context())).rejects.toThrow('Windows')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/acp-workbench-provider.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
// src/core/acp-workbench-provider.ts
/**
 * 工作台专用的 ACP(Agent Client Protocol v1)执行者:起 `<command> <args>`(cursor:`cursor-agent acp`),
 * stdio 上换行分隔 JSON-RPC。每个 spawn 一个进程、一个 session;dispatch = 一次 session/prompt。
 *
 * 真机边界(2026-09-17 spike,见 docs/superpowers/specs/2026-09-17-acp-evaluation.md 末节):
 *  - 命令(kind execute)逐次 session/request_permission;工作区内文件编辑不弹卡 ⇒ spawn 时报 ACP_NOTICE;
 *  - 关 stdin 不会让 cursor-agent 退出 ⇒ close() 必须 SIGTERM/SIGKILL 进程组并确认退出;
 *  - 不注入 MCP(工作台任务本来就不给执行者 wechat MCP);不声明 fs/terminal,agent 自己落盘。
 * 对话侧的 Cursor(print 模式,cursor-cli-provider.ts)与本文件无关。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import type { AgentEvent, AgentProvider, AgentSession, SpawnContext } from './agent-provider'
import { AsyncQueue } from './async-queue'
import { makeTurnEmitter } from './turn-emitter'
import { isAuthFail } from './auth-fail'
import { AcpRequestError, createAcpConnection, type AcpConnection } from './acp/rpc'
import { acpPermissionDescription, acpPermissionOption, createAcpTranslator } from './acp/events'

export interface AcpWorkbenchProviderOptions {
  command: string; args: string[]; displayName: string
  /** initialize / session/new / session/load 的上限;缺省 60s。 */
  rpcTimeoutMs?: number
  /** close() 确认进程组退出的上限;缺省 3s。 */
  closeTimeoutMs?: number
  spawn?: typeof nodeSpawn
}

export const ACP_NOTICE = 'Cursor 通过 ACP 执行：命令会逐次请求批准；工作区内的文件编辑由 Cursor 直接执行，不经过权限卡。'
const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
const CLIENT_INFO = { name: 'cc_workbench', title: 'CC Workbench', version: '0.6.4' }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const sessionIdOk = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[ -]/.test(value)

interface Turn { queue: AsyncQueue<AgentEvent>; cancelled: boolean; startedAt: number }
interface PendingPermission { controller: AbortController; respond: (outcome: unknown) => void }

export function createAcpWorkbenchProvider(options: AcpWorkbenchProviderOptions): AgentProvider {
  const spawn = options.spawn ?? nodeSpawn
  const rpcTimeoutMs = options.rpcTimeoutMs ?? 60_000, closeTimeoutMs = options.closeTimeoutMs ?? 3_000
  return {
    async spawn(project, context: SpawnContext): Promise<AgentSession> {
      if (process.platform === 'win32') throw new Error('Cursor 工作台暂不支持 Windows：尚未验证任务进程树清理。')
      const child = spawn(options.command, options.args, { cwd: project.path, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true })
      const permissions = new Map<string | number, PendingPermission>()
      const translator = createAcpTranslator()
      let sessionId = '', active: Turn | undefined, loading = true
      let closing = false, exited = false, broken: Error | undefined, closePromise: Promise<void> | undefined
      let resolveExit!: () => void
      const exit = new Promise<void>(resolve => { resolveExit = resolve })
      let instructionsInjected = false

      const settlePermissions = (outcome: unknown) => {
        for (const [id, entry] of permissions) { permissions.delete(id); entry.controller.abort(); entry.respond(outcome) }
      }
      const finish = (turn: Turn, event: AgentEvent) => {
        if (active !== turn) return
        active = undefined
        settlePermissions({ outcome: { outcome: 'cancelled' } })
        turn.queue.push(event); turn.queue.end()
      }
      const fatal = (message: string) => {
        if (broken || closing) return
        broken = new Error(message)
        connection.dispose(new Error('acp_session_closed'))
        if (active) finish(active, { kind: 'error', message })
      }
      const connection: AcpConnection = createAcpConnection(child.stdin!, child.stdout!, {
        rpcTimeoutMs,
        onNotification(method, params) {
          if (method !== 'session/update' || loading || !object(params) || params.sessionId !== sessionId) return
          const turn = active
          if (!turn || turn.cancelled) return
          for (const event of translator.update(params.update)) turn.queue.push(event)
        },
        async onRequest(method, params) {
          if (method !== 'session/request_permission') throw Object.assign(new Error(`client capability not declared: ${method}`), { code: -32601 })
          const turn = active
          if (!turn || turn.cancelled || closing || !object(params) || params.sessionId !== sessionId) return { outcome: { outcome: 'cancelled' } }
          const description = acpPermissionDescription(params)
          if (description === null) { queueMicrotask(() => fatal('无法核实或完整显示本次 Cursor 权限请求，工作台已停止任务。')); return { outcome: { outcome: 'cancelled' } } }
          const toolCall = params.toolCall as Record<string, unknown>
          const tool = typeof toolCall.kind === 'string' && toolCall.kind ? toolCall.kind : 'tool'
          return new Promise<unknown>(resolve => {
            const controller = new AbortController()
            const key = `${Date.now()}:${Math.random()}`
            const entry: PendingPermission = { controller, respond: resolve }
            permissions.set(key, entry)
            void Promise.resolve().then(() => context.requestPermission ? context.requestPermission({ tool, description }, controller.signal) : false)
              .catch(() => false)
              .then(allow => {
                if (permissions.get(key) !== entry) return
                permissions.delete(key)
                if (controller.signal.aborted || active !== turn) { resolve({ outcome: { outcome: 'cancelled' } }); return }
                const optionId = acpPermissionOption(params.options, allow === true)
                resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } })
              })
          })
        },
        onFatal(error) { fatal(error.message) },
      })
      child.stderr?.resume()
      child.on('error', () => { exited = true; resolveExit(); fatal('acp_process_start_failed') })
      child.on('exit', (code, signal) => { exited = true; resolveExit(); if (!closing) fatal(`acp_process_exited: ${signal ?? code ?? 'unknown'}`) })

      const signalGroup = (signal: NodeJS.Signals) => {
        try { if (child.pid) process.kill(-child.pid, signal); else child.kill(signal) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      const groupAlive = () => {
        if (!child.pid) return !exited
        try { process.kill(-child.pid, 0); return true }
        catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
      }
      const close = () => {
        if (closePromise) return closePromise
        closing = true
        closePromise = (async () => {
          const deadline = Date.now() + closeTimeoutMs
          settlePermissions({ outcome: { outcome: 'cancelled' } })
          if (active && sessionId) { active.cancelled = true; connection.notify('session/cancel', { sessionId }) }
          if (active) finish(active, { kind: 'error', message: 'acp_session_closed' })
          connection.dispose(new Error('acp_session_closed'))
          try { child.stdin?.end() } catch { /* already closed */ }
          signalGroup('SIGTERM')
          let killed = false
          while (!exited || groupAlive()) {
            if (Date.now() >= deadline) { signalGroup('SIGKILL'); throw new Error('acp_process_not_exited') }
            if (!killed && Date.now() >= deadline - Math.max(50, closeTimeoutMs / 4)) { signalGroup('SIGKILL'); killed = true }
            const pause = new Promise<void>(resolve => setTimeout(resolve, 15))
            await (exited ? pause : Promise.race([exit, pause]))
          }
        })()
        return closePromise
      }
      const setupError = (error: unknown): Error => {
        if (error instanceof AcpRequestError && (error.code === -32000 || isAuthFail('sdk-error', error.message))) return new Error('acp_auth_required')
        if (error instanceof AcpRequestError) return new Error(`acp_session_failed: ${error.message}`)
        return error instanceof Error ? error : new Error(String(error))
      }
      try {
        const initialized = await connection.request('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: CLIENT_INFO })
        if (!object(initialized) || initialized.protocolVersion !== 1) throw new Error('acp_protocol_version_unsupported')
        const loadSession = object(initialized.agentCapabilities) && initialized.agentCapabilities.loadSession === true
        if (context.resumeSessionId) {
          if (!loadSession) throw new Error('acp_resume_unsupported')
          sessionId = context.resumeSessionId
          const loaded = await connection.request('session/load', { sessionId, cwd: project.path, mcpServers: [] })
          if (object(loaded) && loaded.sessionId !== undefined && loaded.sessionId !== sessionId) throw new Error('acp_resume_session_mismatch')
        } else {
          const created = await connection.request('session/new', { cwd: project.path, mcpServers: [] })
          if (!object(created) || !sessionIdOk(created.sessionId)) throw new Error('acp_missing_session_id')
          sessionId = created.sessionId
        }
      } catch (error) {
        const mapped = setupError(error)
        await close().catch(() => {})
        throw mapped
      }
      loading = false
      context.reportNotice?.(ACP_NOTICE)

      return {
        dispatch(text, attachments) {
          if (attachments?.length) throw new Error('acp_attachments_unsupported')
          if (closing || broken || exited) throw broken ?? new Error('acp_session_closed')
          if (active) throw new Error('acp_turn_already_running')
          const em = makeTurnEmitter()
          const turn: Turn = { queue: new AsyncQueue<AgentEvent>(), cancelled: false, startedAt: Date.now() }
          active = turn
          translator.beginTurn()
          turn.queue.push(em.init(sessionId))
          let prompt = text
          if (!instructionsInjected && context.appendInstructions) { prompt = `${context.appendInstructions}\n\n---\n\n${text}`; instructionsInjected = true }
          void connection.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, 0).then(
            result => {
              const reason = object(result) && typeof result.stopReason === 'string' ? result.stopReason : 'end_turn'
              if (reason === 'cancelled' && turn.cancelled) finish(turn, { kind: 'error', message: 'acp_turn_cancelled' })
              else if (reason === 'end_turn' || reason === 'cancelled') finish(turn, em.finish({ sessionId, numTurns: 1, durationMs: Date.now() - turn.startedAt }))
              else finish(turn, { kind: 'error', message: `acp_stop_${reason}` })
            },
            (error: unknown) => { if (active === turn) finish(turn, em.errorText(error instanceof Error ? error.message : String(error))) },
          )
          const iterable = turn.queue.iterable()
          return {
            [Symbol.asyncIterator]() {
              const inner = iterable[Symbol.asyncIterator]()
              return {
                next: () => inner.next(),
                return: async (value?: AgentEvent) => {
                  if (active === turn && !turn.cancelled) { turn.cancelled = true; settlePermissions({ outcome: { outcome: 'cancelled' } }); connection.notify('session/cancel', { sessionId }) }
                  return inner.return!(value)
                },
              }
            },
          }
        },
        async cancel() {
          const turn = active
          if (!turn || turn.cancelled || closing) return
          turn.cancelled = true
          settlePermissions({ outcome: { outcome: 'cancelled' } })
          connection.notify('session/cancel', { sessionId })
        },
        close,
      }
    },
  }
}
```

实现要点(评审会盯的):
- `onNotification` 在 `loading` 期间(session/load 结果返回前)丢弃一切更新 —— 那是历史重放。
- `finish` 只在 `active === turn` 时生效,防止晚到的 prompt 结果覆盖新一轮。
- `fatal` 先 `dispose` 连接(挂起的 prompt 请求 reject ⇒ `finish` 走 `errorText`),再把在飞回合收掉;顺序颠倒会重复 push。测试「无法核实」那条期望最后一个事件是那句中文 —— 所以 `fatal` 里要先 `finish(active, {error: message})` 再 `dispose`?**不行**:`finish` 之后 `active` 已清空,`dispose` 触发的 reject 走 `if (active === turn)` 判断被跳过 —— 两种顺序都只会 push 一次,但要让中文那句胜出,必须 **先 finish 再 dispose**。把 `fatal` 改成:`broken = …; if (active) finish(active, {kind:'error', message}); connection.dispose(…)`。
- 迭代器的 `return()` 触发取消(服务层 `collectWorkbenchTurn` 的 finally 一定会调),但 close 路径已经取消过的不再重复。
- `close()` 里先 `finish` 在飞回合再 `dispose`,与 `fatal` 同序。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/acp-workbench-provider.test.ts src/core/acp && bun run typecheck && bun run depcheck`
Expected: 全绿;typecheck 0 errors;depcheck 0 errors / 7 warnings

- [ ] **Step 5: 提交**

```bash
git add src/core/acp-workbench-provider.ts src/core/acp-workbench-provider.test.ts
git commit -m "ACP 客户端④:工作台执行者(initialize / session new·load / prompt / 权限桥 / cancel / 进程组确认退出)"
```

---

### Task 5: 注册、文案、文档

**Files:**
- Modify: `src/daemon/bootstrap/wire-workbench.ts`(`registerUnattendedExecutors` 只剩 agy;新 `registerAcpExecutors`;`wireWorkbench` 接线)
- Modify: `src/daemon/bootstrap/wire-workbench.test.ts`
- Modify: `src/core/workbench/execution-settings.ts:8-`(`executionFailureMessage` 加 `acp_*`)
- Modify: `apps/desktop/src/modules/workbench-execution.js:20-`(`executionErrorMessage` 加 `acp_*`)
- Modify: `src/core/workbench/wechat-control.ts:149`(文案去 Cursor)
- Modify: `apps/desktop/src/modules/workbench-unattended.js:2`(注释去 Cursor)
- Modify: `docs/cc-workbench.md`(执行者覆盖表 + 修订记录);`docs/superpowers/specs/2026-09-17-acp-cursor-executor-design.md` 修订记录
- Test: `src/core/workbench/execution-settings.test.ts`(追加,若不存在则新建)

**Interfaces:**
- Consumes: Task 3 `resolveAcpAgent`、`ACP_CAPABILITIES`;Task 4 `createAcpWorkbenchProvider`;`findOnPath`(`src/lib/util.ts`);`loadAgentConfig`。
- Produces:
  ```ts
  export function registerAcpExecutors(target: ProviderRegistry, source: Pick<ProviderRegistry, 'get'>, config: { cursorAgentBin?: string }, deps?: { findOnPath?: (cmd: string) => string | null; create?: typeof createAcpWorkbenchProvider; log?: (tag: string, line: string) => void }): string[]
  ```

- [ ] **Step 1: 改测试**

`wire-workbench.test.ts`:import 加 `registerAcpExecutors`、`ACP_CAPABILITIES`;把「registers boot-discovered agy/cursor …」改成只断言 agy,并新增:

```ts
it('registers only agy as unattended; cursor is no longer an unattended executor', () => {
  const source = createProviderRegistry(), target = createProviderRegistry()
  const agy = fakeProvider(), cursor = fakeProvider()
  source.register('agy', agy, { displayName: 'Gemini (agy)', canResume: () => true })
  source.register('cursor', cursor, { displayName: 'Cursor', canResume: () => false })
  const registered = registerUnattendedExecutors(target, source)
  expect(registered).toEqual(['agy'])
  expect(target.get('agy')!.provider).toBe(agy)
  expect(target.get('agy')!.opts.workbench).toBe(UNATTENDED_CAPABILITIES)
  expect(target.has('cursor')).toBe(false)
})

it('registers cursor through the ACP provider with ACP capabilities when the binary resolves', () => {
  const source = createProviderRegistry(), target = createProviderRegistry()
  source.register('cursor', fakeProvider(), { displayName: 'Cursor', canResume: () => true })
  const acp = fakeProvider(), create = vi.fn(() => acp)
  const registered = registerAcpExecutors(target, source, { cursorAgentBin: '/opt/cursor-agent' }, { create, findOnPath: () => null })
  expect(registered).toEqual(['cursor'])
  expect(create).toHaveBeenCalledWith({ command: '/opt/cursor-agent', args: ['acp'], displayName: 'Cursor' })
  expect(target.get('cursor')!.provider).toBe(acp)
  expect(target.get('cursor')!.opts.displayName).toBe('Cursor')
  expect(target.get('cursor')!.opts.workbench).toBe(ACP_CAPABILITIES)
})

it('registers nothing for ACP when boot lacks cursor or the binary cannot be resolved', () => {
  const source = createProviderRegistry(), target = createProviderRegistry()
  expect(registerAcpExecutors(target, source, {}, { findOnPath: () => '/usr/bin/cursor-agent', create: vi.fn() })).toEqual([])
  source.register('cursor', fakeProvider(), { displayName: 'Cursor', canResume: () => true })
  const log = vi.fn()
  expect(registerAcpExecutors(target, source, {}, { findOnPath: () => null, create: vi.fn(), log })).toEqual([])
  expect(target.has('cursor')).toBe(false)
  expect(log).toHaveBeenCalledWith('WORKBENCH', expect.stringContaining('cursor'))
})
```

`execution-settings.test.ts`(存在则追加;不存在则新建,含 `import { describe, expect, it } from 'vitest'` 与 `import { executionFailureMessage } from './execution-settings'`):

```ts
describe('ACP failure copy', () => {
  it('maps acp codes, including prefixed session failures', () => {
    expect(executionFailureMessage('acp_auth_required')).toContain('cursor-agent login')
    expect(executionFailureMessage('acp_session_failed: bad cwd')).toContain('acp')
    expect(executionFailureMessage('acp_process_exited: 1')).toContain('acp')
    expect(executionFailureMessage('acp_resume_unsupported')).toContain('重新开始')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/bootstrap/wire-workbench.test.ts src/core/workbench/execution-settings.test.ts`
Expected: FAIL(`registerAcpExecutors` 不存在;旧断言 `['agy','cursor']` 已删)

- [ ] **Step 3: 实现**

`wire-workbench.ts`:

```ts
import { ACP_CAPABILITIES, MANAGED_NATIVE_CAPABILITIES, UNATTENDED_CAPABILITIES } from '../../core/workbench/executor-capabilities'
import { createAcpWorkbenchProvider } from '../../core/acp-workbench-provider'
import { resolveAcpAgent } from '../../core/acp/agents'
import { findOnPath } from '../../lib/util'

/** 免审执行者:只剩 agy(cursor 自 2026-09-17 起走 ACP,见 registerAcpExecutors)。 */
export function registerUnattendedExecutors(target: ProviderRegistry, source: Pick<ProviderRegistry, 'get'>): string[] {
  const registered: string[] = []
  for (const id of ['agy'] as const) {
    const entry = source.get(id)
    if (entry) {
      target.register(id, entry.provider, { ...entry.opts, workbench: UNATTENDED_CAPABILITIES })
      registered.push(id)
    }
  }
  return registered
}

/**
 * 走 ACP 的执行者:boot registry 有 cursor(对话侧的 print 模式 provider,证明用户装了 cursor-agent)
 * 且二进制能解析 ⇒ 工作台登记一个**新的** ACP provider(不是同一个实例;对话侧那个不动),
 * displayName/canResume 沿用 boot 的登记项。解析不到 ⇒ 不登记、不退回免审,记一行日志。
 */
export function registerAcpExecutors(target: ProviderRegistry, source: Pick<ProviderRegistry, 'get'>, config: { cursorAgentBin?: string },
  deps: { findOnPath?: (cmd: string) => string | null; create?: typeof createAcpWorkbenchProvider; log?: (tag: string, line: string) => void } = {}): string[] {
  const entry = source.get('cursor')
  if (!entry) return []
  const launch = resolveAcpAgent('cursor', config, deps.findOnPath ?? findOnPath)
  if (!launch) { deps.log?.('WORKBENCH', 'cursor: cursor-agent binary not resolvable — ACP executor not registered'); return [] }
  const provider = (deps.create ?? createAcpWorkbenchProvider)({ command: launch.command, args: launch.args, displayName: launch.displayName })
  target.register('cursor', provider, { ...entry.opts, workbench: ACP_CAPABILITIES })
  return ['cursor']
}
```

`wireWorkbench` 里把 `registerUnattendedExecutors(registry,opts.boot.registry)` 改成:

```ts
  registerAcpExecutors(registry,opts.boot.registry,agentConfig,{log:opts.log})
  registerUnattendedExecutors(registry,opts.boot.registry)
```

(`opts.log` 是 `PermissionRelayDeps['log']`,签名 `(tag, line)`;若类型不合,包一层 `(tag,line)=>opts.log(tag,line)`。)

`execution-settings.ts` 的 `executionFailureMessage`:在 `messages` 表后、返回前加前缀匹配。现有函数最后是 `return messages[code] ?? …`,改成:

```ts
  const ACP_SESSION = 'Cursor 的 ACP 会话无法建立或中断，请确认 cursor-agent 是支持 acp 子命令的版本后重试。'
  const acp: Array<[string, string]> = [
    ['acp_auth_required', 'Cursor 登录态失效，请在电脑上跑一次 cursor-agent login 后再试。'],
    ['acp_resume_unsupported', '这个版本的 Cursor 不支持接着原会话，请带记录重新开始。'],
    ['acp_protocol_version_unsupported', ACP_SESSION], ['acp_session_failed', ACP_SESSION], ['acp_process_exited', ACP_SESSION],
    ['acp_process_start_failed', ACP_SESSION], ['acp_invalid_protocol_message', ACP_SESSION], ['acp_line_too_long', ACP_SESSION], ['acp_protocol_write_failed', ACP_SESSION],
  ]
  for (const [prefix, text] of acp) if (code === prefix || code.startsWith(`${prefix}:`)) return text
```

桌面 `workbench-execution.js` `executionErrorMessage` 同样加这一段(JS 语法,放在查表之前)。

`wechat-control.ts:149`:`'agy / Cursor 是免审执行者：…'` ⇒ `'agy 是免审执行者：…'`(其余原文不动)。`workbench-unattended.js:2` 注释 `免审执行者(agy / Cursor)` ⇒ `免审执行者(agy)`。

`docs/cc-workbench.md` 执行者覆盖表:把 `| Cursor / agy | …` 一行拆成两行:

```
| Cursor（ACP） | `cursor-agent acp` 会话、命令逐次进权限卡（桌面 / 微信 y/n）、逐条活动行与逐字流、按 `session/load` 接着原会话、成果 / diff 快照 / 停止与其它执行者一致 | **工作区内的文件编辑由 Cursor 直接执行，不经过权限卡**（Cursor 自己的 allowlist 模式，ACP 面上没有开关）；附件、模型 / 思考强度选择、提问（elicitation）；Cursor 全局 MCP 配置里的服务器在任务里仍可见（任务提示词禁止调用，未按任务隔离） |
| agy | 原有陪伴聊天接入继续保留；工作台按「免审」接入（见 2026-09-17 修订记录） | 逐步权限、提问、附件与模型选择 |
```

修订记录追加:

```
- **2026-09-17**：Cursor 改由 ACP（Agent Client Protocol v1，`cursor-agent acp`，stdio JSON-RPC）进工作台，不再是免审执行者：命令逐次进权限卡，时间线有逐条活动行（读 / 改 / 检索 / 命令 / 工具），逐字流照旧；按 `session/load` 接着原会话；`close()` 确认进程组退出。每个任务开跑时记一条提示：工作区内的文件编辑由 Cursor 直接执行，不经过权限卡（真机 spike 所见，ACP 面上没有开关）。不注入 MCP、不声明 fs / terminal 客户端能力、不做 elicitation 与附件；权限只回 allow-once / reject-once。agy 与对话侧的 Cursor 不变。设计：`docs/superpowers/specs/2026-09-17-acp-cursor-executor-design.md`；评估与 spike：`docs/superpowers/specs/2026-09-17-acp-evaluation.md`。
```

spec 修订记录追加一行:`- 2026-09-17:按计划落地(任务 1–5)。`

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/daemon/bootstrap src/core/workbench/execution-settings.test.ts src/core/workbench/service-capabilities.test.ts src/core/workbench/wechat-control.test.ts && bun run typecheck && bun run depcheck && bun run test && npm run test:node`
Expected: 全绿;typecheck 0;depcheck 0 errors / 7 warnings

- [ ] **Step 5: 提交**

```bash
git add src/daemon/bootstrap/wire-workbench.ts src/daemon/bootstrap/wire-workbench.test.ts src/core/workbench/execution-settings.ts src/core/workbench/execution-settings.test.ts apps/desktop/src/modules/workbench-execution.js src/core/workbench/wechat-control.ts apps/desktop/src/modules/workbench-unattended.js docs/cc-workbench.md docs/superpowers/specs/2026-09-17-acp-cursor-executor-design.md
git commit -m "ACP 客户端⑤:cursor 以 ACP 能力登记进工作台、免审只剩 agy、acp_* 错误文案、文档"
```

---

## Self-Review

- **Spec coverage**:§1 rpc → Task 1;§2 events → Task 2;§3 agents + §5 能力 → Task 3;§4 provider(win32、initialize、new/load、通知丢弃、prompt、stopReason、权限、未知请求 -32601、cancel、close 确认退出、fatal)→ Task 4;§5 注册 + §6 文案 + 文档 → Task 5。`service.ts` 不改(spec 明说)。
- **Placeholder scan**:无 TBD;每步有代码。
- **Type consistency**:`createAcpConnection(stdin, stdout, options)`、`AcpRequestError.code`、`createAcpTranslator().update/beginTurn`、`acpPermissionDescription/acpPermissionOption`、`resolveAcpAgent('cursor', config, findOnPath)`、`ACP_CAPABILITIES`、`createAcpWorkbenchProvider({command,args,displayName,rpcTimeoutMs,closeTimeoutMs,spawn})`、`ACP_NOTICE`、`registerAcpExecutors(target, source, config, deps)` 在各任务一致。
