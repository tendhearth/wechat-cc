# 对话侧 Cursor 走 ACP、退休 print 模式 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对话侧(微信 / 桌面 / App)的 Cursor 由同一个 ACP 客户端驱动:每会话一个常驻 `cursor-agent acp`,wechat / delegate MCP 按会话注入并带逐会话 token ⇒ `adminMcpTools:true`;删掉 print 模式 provider 与全局 `~/.cursor/mcp.json` 写入;一次性评估仍走 print;工作台行为一行不变。

**Architecture:** `acp/events.ts` 加 messages 模式与 MCP 身份;`acp-workbench-provider.ts` 的实现搬到 `acp-agent-provider.ts` 成通用 `createAcpProvider(options)`(permissions / text / mcpServers / model / resume / notice 五个新选项),工作台版变薄封装;新 `acp-cursor-chat.ts`(对话侧工厂 + 能力)与 `cursor-eval.ts`(一次性评估);bootstrap 切换并把全局 MCP 写入改成 boot 时清理。

**Tech Stack:** TypeScript / Bun 1.3.14 + Node 24(vitest)、`node:child_process`。

**Spec:** `docs/superpowers/specs/2026-09-18-acp-cursor-chat-design.md`

## Global Constraints

- 仓库 `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit`,分支 `dev`;不碰兄弟工作树 `…/wechat-cc`。
- 测试 `bun --bun vitest run <paths>`;全量 `bun run test`;Node `npm run test:node`;`bun run typecheck`;`bun run depcheck`(0 errors;7 warnings 既有)。业务代码不 import `bun:*`、不用 Bun 全局。
- **工作台不变**:`src/core/acp-workbench-provider.test.ts` 与 `src/daemon/bootstrap/wire-workbench.test.ts` 原样通过(一个断言都不改)。
- 隐私规矩:活动行 `detail` 只放路径与工具身份;MCP 身份只读 `rawInput.providerIdentifier` / `rawInput.toolName` 两个字段,**不读 args**。权限只回 `allow_once` / `reject_once`。
- 对话侧 solo 协调器给每条 `text` 事件发一条微信 ⇒ messages 模式每条助理消息**只能**有一条 text 事件。
- `server` 名经 `normalizeWechatMcpServer` 折回规范名 `wechat`;`isReplyToolCall` 必须认得 ACP 路发出的 `{server:'wechat', tool:'reply'}`。
- 提交信息中文,末尾两行:`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_0192qR5eDp28Cz3Xg66oEu6c`。每任务:相关测试绿 → typecheck 干净 → 提交。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/core/acp/events.ts` | + messages 模式(`endTurn`)、MCP 身份 server/tool |
| `src/core/acp-agent-provider.ts`(新) | 通用 `createAcpProvider(options)`(从 workbench 版搬来 + 五个选项) |
| `src/core/acp-workbench-provider.ts` | 只剩 `acpNotice` + `createAcpWorkbenchProvider` 薄封装 + 类型 re-export |
| `src/core/cursor-eval.ts`(新) | print 一次性评估(从 cursor-cli-provider 搬) |
| `src/core/acp-cursor-chat.ts`(新) | `DEFAULT_CURSOR_MODEL`、`ACP_CURSOR_CAPABILITIES`、`acpMcpServersFor`、`createAcpCursorChatProvider` |
| `src/core/cursor-cli-provider.ts` + test | 删除 |
| `src/core/agent-provider.ts` | 删 `CURSOR_WECHAT_MCP_NAMESPACE_ID` 与其别名 |
| `src/core/capability-matrix.ts` | `cursor: ACP_CURSOR_CAPABILITIES` |
| `src/core/external-cli-contract.live.test.ts` | import 改到 cursor-eval |
| `src/daemon/bootstrap/cursor-mcp-config.ts` + test | 只剩 `removeCursorGlobalMcp`(常量私有) |
| `src/daemon/bootstrap/providers.ts`、`bootstrap/index.ts`、`src/daemon/main.ts` | 切换到 ACP 对话 provider;boot 清理旧全局条目;关机钩子删 |

---

### Task 1: events.ts —— messages 模式 + MCP 身份

**Files:**
- Modify: `src/core/acp/events.ts`
- Test: `src/core/acp/events.test.ts`(追加)

**Interfaces:**
- Produces:
  ```ts
  export interface AcpTranslatorOptions { text?: 'append' | 'messages' }
  export interface AcpTranslator { update(update: unknown): AgentEvent[]; beginTurn(): void; endTurn(): AgentEvent[] }
  export function createAcpTranslator(options?: AcpTranslatorOptions): AcpTranslator
  ```
  `tool_call` 事件在 `rawInput.providerIdentifier` / `rawInput.toolName` 都是字符串时带 `server`(经 `normalizeWechatMcpServer`)与 `tool = toolName`。

- [ ] **Step 1: 写失败的测试**(追加到 `events.test.ts`;顶部 import 已有 `createAcpTranslator`)

```ts
describe('messages mode (chat side)', () => {
  it('buffers chunks and emits one text per assistant message: before a tool_call and at endTurn', () => {
    const t = createAcpTranslator({ text: 'messages' }); t.beginTurn()
    expect(t.update(chunk('这'))).toEqual([])
    expect(t.update(chunk('边'))).toEqual([])
    const events = t.update(call({ toolCallId: 'c1', kind: 'read', locations: [{ path: '/p/a' }] }))
    expect(events).toEqual([
      { kind: 'text', text: '这边' },
      { kind: 'tool_call', tool: 'read', activity: { id: 'c1', type: 'read', status: 'running', label: '读取文件', detail: '/p/a' } },
    ])
    expect(t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })).toHaveLength(1)
    t.update(chunk('好')); t.update(chunk('的'))
    expect(t.endTurn()).toEqual([{ kind: 'text', text: '好的' }])
    expect(t.endTurn()).toEqual([])
  })
  it('does not emit whitespace-only buffers and append mode endTurn is always empty', () => {
    const t = createAcpTranslator({ text: 'messages' }); t.beginTurn()
    t.update(chunk(' \n'))
    expect(t.endTurn()).toEqual([])
    const a = createAcpTranslator(); a.beginTurn(); a.update(chunk('x'))
    expect(a.endTurn()).toEqual([])
  })
  it('beginTurn drops a stale buffer from a previous turn', () => {
    const t = createAcpTranslator({ text: 'messages' }); t.beginTurn(); t.update(chunk('old')); t.beginTurn()
    expect(t.endTurn()).toEqual([])
  })
})

describe('MCP identity on tool calls', () => {
  it('reads providerIdentifier/toolName as server/tool, normalizes the wechat server name, never reads args', () => {
    const t = createAcpTranslator(); t.beginTurn()
    const first = t.update({ sessionUpdate: 'tool_call', toolCallId: 'm1', title: 'MCP: tool', kind: 'other', status: 'pending', rawInput: {} })
    expect(first[0]).toMatchObject({ kind: 'tool_call', tool: 'other' }); expect(first[0]).not.toHaveProperty('server')
    const [ev] = t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'm1', title: 'wechat: reply', rawInput: { providerIdentifier: 'wechat', toolName: 'reply', args: { text: 'SECRET' } } })
    expect(ev).toMatchObject({ kind: 'tool_call', server: 'wechat', tool: 'reply', activity: { id: 'm1', type: 'tool', label: '调用工具', detail: 'wechat: reply' } })
    expect(JSON.stringify(ev)).not.toContain('SECRET')
    const [done] = t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'm1', status: 'completed', rawOutput: { success: true } })
    expect(done).toMatchObject({ server: 'wechat', tool: 'reply', activity: { status: 'completed' } })
    const [legacy] = t.update({ sessionUpdate: 'tool_call', toolCallId: 'm2', kind: 'other', rawInput: { providerIdentifier: 'wechat-cc-wechat', toolName: 'ping' } })
    expect(legacy).toMatchObject({ server: 'wechat', tool: 'ping' })
  })
  it('isReplyToolCall recognizes an ACP wechat reply', () => {
    const t = createAcpTranslator({ text: 'messages' }); t.beginTurn()
    const [ev] = t.update({ sessionUpdate: 'tool_call', toolCallId: 'r', kind: 'other', rawInput: { providerIdentifier: 'wechat', toolName: 'reply' } })
    expect(isReplyToolCall(ev!)).toBe(true)
  })
})
```

在文件顶部 import 加 `import { isReplyToolCall } from '../agent-provider'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/acp/events.test.ts`
Expected: FAIL(`endTurn` 不存在 / server 缺失)

- [ ] **Step 3: 实现**

`events.ts` 改动:

```ts
import type { AgentActivity, AgentEvent } from '../agent-provider'
import { normalizeWechatMcpServer } from '../agent-provider'

export interface AcpTranslatorOptions {
  /** 'append'(缺省):token 级 chunk 带 itemId(工作台逐字流);'messages':每条助理消息一条 text 事件 ——
   *  对话侧的 solo 协调器给每条 text 事件发一条微信,token 级会发成几十条。 */
  text?: 'append' | 'messages'
}
export interface AcpTranslator {
  update(update: unknown): AgentEvent[]
  beginTurn(): void
  /** messages 模式:把攒着的助理文本吐成一条 text 事件(空白不吐);append 模式恒空。 */
  endTurn(): AgentEvent[]
}

interface Remembered { kind: string; title: string; name: string; status: AgentActivity['status']; paths: string[]; server?: string; tool?: string }

export function createAcpTranslator(options: AcpTranslatorOptions = {}): AcpTranslator {
  const messages = options.text === 'messages'
  let turn = 0, message = 0, textSeen = false, buffer = ''
  const calls = new Map<string, Remembered>()
  const flushBuffer = (): AgentEvent[] => {
    const text = buffer; buffer = ''
    return text.trim() ? [{ kind: 'text', text }] : []
  }
  const activityEvent = (id: string, call: Remembered): AgentEvent | null => {
    if (call.kind === 'think') return null
    const spec = Object.hasOwn(KINDS, call.kind) ? KINDS[call.kind] : undefined
    const includeIdentity = IDENTITY_KINDS.has(call.kind)
    const resolved = spec ?? OTHER
    const activity: AgentActivity = { id, type: resolved.type, status: call.status, label: resolved.label }
    const detail = includeIdentity ? [...call.paths, display(call.title, 120)].filter(Boolean).join('\n') : call.paths.join('\n')
    if (detail) activity.detail = detail.slice(0, 2000)
    // MCP 身份(providerIdentifier / toolName)是身份不是参数:reply 判定与 TURN 日志靠它。args 永远不看。
    if (call.server !== undefined && call.tool !== undefined) return { kind: 'tool_call', server: call.server, tool: call.tool, activity }
    return { kind: 'tool_call', tool: call.name || call.kind || 'tool', activity }
  }
  return {
    beginTurn() { turn++; message = 0; textSeen = false; buffer = ''; calls.clear() },
    endTurn() { return messages ? flushBuffer() : [] },
    update(update) {
      if (!object(update) || typeof update.sessionUpdate !== 'string') return []
      if (update.sessionUpdate === 'agent_message_chunk') {
        if (!object(update.content) || update.content.type !== 'text' || typeof update.content.text !== 'string') return []
        textSeen = true
        if (messages) { buffer += update.content.text; return [] }
        const itemId = typeof update.messageId === 'string' && update.messageId ? `acp:msg:${acpActivityId(update.messageId)}` : `acp:turn:${turn}:${message}`
        return [{ kind: 'text', text: update.content.text, itemId, textMode: 'append' }]
      }
      if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return []
      if (typeof update.toolCallId !== 'string' || !update.toolCallId) return []
      const id = acpActivityId(update.toolCallId)
      const flushed = update.sessionUpdate === 'tool_call' && messages ? flushBuffer() : []
      if (update.sessionUpdate === 'tool_call' && textSeen) { message++; textSeen = false }
      const previous = calls.get(id) ?? { kind: '', title: '', name: '', status: 'running' as const, paths: [] }
      const raw = object(update.rawInput) ? update.rawInput : undefined
      const identity = raw && typeof raw.providerIdentifier === 'string' && typeof raw.toolName === 'string'
        ? { server: normalizeWechatMcpServer(display(raw.providerIdentifier, 120)), tool: display(raw.toolName, 120) } : undefined
      const call: Remembered = {
        kind: typeof update.kind === 'string' ? update.kind : previous.kind,
        title: typeof update.title === 'string' ? update.title : previous.title,
        name: typeof update.name === 'string' ? display(update.name, 120) : previous.name,
        status: status(update.status, previous.status),
        paths: update.locations === undefined ? previous.paths : paths(update.locations),
        server: identity?.server ?? previous.server, tool: identity?.tool ?? previous.tool,
      }
      calls.set(id, call)
      const event = activityEvent(id, call)
      return event ? [...flushed, event] : flushed
    },
  }
}
```

(`KINDS` / `OTHER` / `IDENTITY_KINDS` / `status` / `display` / `paths` / `acpActivityId` / 两个 permission 函数原样保留。)注意 `normalizeWechatMcpServer` 目前还认 `CURSOR_WECHAT_MCP_NAMESPACE_ID`,Task 3 会删掉那条别名 —— 上面 `legacy` 测试用的是 agy 的别名 `wechat-cc-wechat`,两边都不受影响。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/acp src/core/acp-workbench-provider.test.ts && bun run typecheck`
Expected: 全绿(工作台 provider 测试不受影响);typecheck 0

- [ ] **Step 5: 提交**

```bash
git add src/core/acp/events.ts src/core/acp/events.test.ts
git commit -m "ACP 事件翻译:messages 模式(每条助理消息一条 text)+ 工具调用带 MCP 身份(server/tool,只读身份不读参数)"
```

---

### Task 2: 通用 `createAcpProvider` + 工作台薄封装

**Files:**
- Create: `src/core/acp-agent-provider.ts`(内容 = 现 `acp-workbench-provider.ts` 搬入并改造)
- Modify: `src/core/acp-workbench-provider.ts`(只剩封装)
- Test: `src/core/acp-agent-provider.test.ts`(新;复用 `acp-workbench-provider.test.ts` 的 FakeProcess 脚手架 —— 把 `FakeProcess`、`mocks`、`context`、`prompted`、`permission` 这几个 helper **复制**过来,别改原测试文件)

**Interfaces:**
- Consumes: Task 1 `createAcpTranslator({text})` / `endTurn()`。
- Produces:
  ```ts
  export interface AcpMcpServer { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  export interface AcpProviderOptions extends AcpWorkbenchProviderOptions {
    permissions: 'bridge' | 'mode'; text: 'append' | 'messages'
    mcpServers?: (context: SpawnContext) => AcpMcpServer[]
    model?: (context: SpawnContext) => string | undefined
    resume?: 'strict' | 'fallback'
    notice?: string | null
  }
  export function createAcpProvider(options: AcpProviderOptions): AgentProvider
  // acp-workbench-provider.ts:
  export interface AcpWorkbenchProviderOptions { …原样… }
  export const acpNotice = (displayName: string) => …原样…
  export function createAcpWorkbenchProvider(o: AcpWorkbenchProviderOptions): AgentProvider   // = createAcpProvider({ ...o, permissions:'bridge', text:'append' })
  ```

- [ ] **Step 1: 写失败的测试**(`src/core/acp-agent-provider.test.ts`;脚手架同工作台测试,`start()` 改成接受 `AcpProviderOptions` 的部分覆盖:`start(extra, setup, providerOptions)`,缺省 `{ permissions:'mode', text:'messages' }`)

```ts
describe('ACP provider — chat-side options', () => {
  it('passes mcpServers to session/new and session/load, sets the model only when offered, skips the notice', async () => {
    const reportNotice = vi.fn()
    const servers = [{ name: 'wechat', command: '/cli', args: ['mcp-server', 'wechat'], env: [{ name: 'WECHAT_SESSION_TOKEN', value: 't' }] }]
    const { child } = await start({ reportNotice, model: 'gpt-5' }, c => { c.newResult = { sessionId: 'sess-1', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'auto', options: [{ value: 'auto', name: 'Auto' }, { value: 'gpt-5', name: 'GPT-5' }] }] } }, { mcpServers: () => servers, model: ctx => ctx.model, notice: null })
    expect(child.sent.find(m => m.method === 'session/new')!.params).toEqual({ cwd: '/project', mcpServers: servers })
    await expect.poll(() => child.sent.some(m => m.method === 'session/set_config_option')).toBe(true)
    expect(child.sent.find(m => m.method === 'session/set_config_option')!.params).toEqual({ sessionId: 'sess-1', configId: 'model', value: 'gpt-5' })
    expect(reportNotice).not.toHaveBeenCalled()
    const log = vi.fn()
    const second = await start({ model: 'nope' }, c => { c.newResult = { sessionId: 'sess-2', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'auto', options: [{ value: 'auto', name: 'Auto' }] }] } }, { model: ctx => ctx.model, log })
    await new Promise(r => setTimeout(r, 20))
    expect(second.child.sent.some(m => m.method === 'session/set_config_option')).toBe(false)
    expect(log).toHaveBeenCalledWith('ACP', expect.stringContaining('nope'))
    const resumed = await start({ resumeSessionId: 'sess-old', model: 'gpt-5' }, undefined, { mcpServers: () => servers, model: ctx => ctx.model })
    expect(resumed.child.sent.find(m => m.method === 'session/load')!.params).toEqual({ sessionId: 'sess-old', cwd: '/project', mcpServers: servers })
    expect(resumed.child.sent.some(m => m.method === 'session/set_config_option')).toBe(false)
  })
  it('mode permissions: dangerously ⇒ allow-once, strict ⇒ reject-once, never calls the bridge, unverifiable ⇒ cancelled without stopping', async () => {
    const requestPermission = vi.fn(async () => true)
    const { session, child } = await start({ permissionMode: 'dangerously', requestPermission })
    const { done } = collect(session); await prompted(child)
    permission(child, 'p1')
    await expect.poll(() => child.sent.some(m => m.id === 'p1')).toBe(true)
    expect(child.sent.find(m => m.id === 'p1')!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    permission(child, 'p2', { toolCall: { toolCallId: 'c9', kind: 'execute', rawInput: { command: 'x'.repeat(20_001) } } })
    await expect.poll(() => child.sent.some(m => m.id === 'p2')).toBe(true)
    expect(child.sent.find(m => m.id === 'p2')!.result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(requestPermission).not.toHaveBeenCalled()
    child.finishPrompt(); await done
    expect(session).toBeTruthy()
    const strict = await start({ permissionMode: 'strict' })
    const s = collect(strict.session); await prompted(strict.child)
    permission(strict.child, 'p3')
    await expect.poll(() => strict.child.sent.some(m => m.id === 'p3')).toBe(true)
    expect(strict.child.sent.find(m => m.id === 'p3')!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    strict.child.finishPrompt(); await s.done
    expect(s.events.at(-1)).toMatchObject({ kind: 'result' })
  })
  it('messages text: one text event per assistant message, flushed before tool calls and before the result', async () => {
    const { session, child } = await start()
    const { events, done } = collect(session); await prompted(child)
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先' } })
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '看' } })
    child.update({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'other', status: 'pending', rawInput: { providerIdentifier: 'wechat', toolName: 'reply' } })
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好了' } })
    child.finishPrompt(); await done
    expect(events.map(e => e.kind)).toEqual(['init', 'text', 'tool_call', 'text', 'result'])
    expect(events[1]).toEqual({ kind: 'text', text: '先看' }); expect(events[3]).toEqual({ kind: 'text', text: '好了' })
    expect(events[2]).toMatchObject({ server: 'wechat', tool: 'reply' })
  })
  it('resume fallback: a failed session/load logs once and opens a new session whose id is reported', async () => {
    const log = vi.fn()
    const { session, child } = await start({ resumeSessionId: 'gone' }, c => { c.loadResult = { error: { code: -32602, message: 'unknown session' } }; c.newResult = { sessionId: 'sess-fresh' } }, { resume: 'fallback', log })
    expect(child.sent.some(m => m.method === 'session/load')).toBe(true)
    expect(child.sent.some(m => m.method === 'session/new')).toBe(true)
    expect(log).toHaveBeenCalledWith('ACP', expect.stringContaining('gone'))
    const { events, done } = collect(session); await prompted(child); child.finishPrompt(); await done
    expect(events[0]).toEqual({ kind: 'init', sessionId: 'sess-fresh' })
    expect(events.at(-1)).toMatchObject({ kind: 'result', sessionId: 'sess-fresh' })
    const noLoad = await start({ resumeSessionId: 'x' }, c => { c.initializeResult = { protocolVersion: 1, agentCapabilities: {} }; c.newResult = { sessionId: 'sess-n' } }, { resume: 'fallback' })
    expect(noLoad.child.sent.some(m => m.method === 'session/new')).toBe(true)
  })
  it('strict resume (default) still rejects on load failure', async () => {
    const provider = createAcpProvider({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', rpcTimeoutMs: 200, closeTimeoutMs: 250, permissions: 'bridge', text: 'append' })
    const p = provider.spawn({ alias: 'a', path: '/project' }, context({ resumeSessionId: 'gone' }))
    await expect.poll(() => children.length).toBe(1); children[0]!.loadResult = { error: { code: -32602, message: 'unknown session' } }
    await expect(p).rejects.toThrow('acp_session_failed: unknown session')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/acp-agent-provider.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

把 `acp-workbench-provider.ts` 全文移到 `acp-agent-provider.ts`,函数改名 `createAcpProvider(options: AcpProviderOptions)`,并做以下改动(其余一字不动):

```ts
export interface AcpMcpServer { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
export interface AcpProviderOptions extends AcpWorkbenchProviderOptions {
  permissions: 'bridge' | 'mode'
  text: 'append' | 'messages'
  mcpServers?: (context: SpawnContext) => AcpMcpServer[]
  model?: (context: SpawnContext) => string | undefined
  resume?: 'strict' | 'fallback'
  notice?: string | null
}
```

1. `const translator = createAcpTranslator({ text: options.text })`。
2. setup 段:
   ```ts
   const mcpServers = options.mcpServers?.(context) ?? []
   const openNew = async () => {
     const created = await connection.request('session/new', { cwd: project.path, mcpServers })
     if (!object(created) || !sessionIdOk(created.sessionId)) throw new Error('acp_missing_session_id')
     sessionId = created.sessionId
     return created
   }
   let created: Record<string, unknown> | undefined
   if (context.resumeSessionId) {
     try {
       if (!loadSession) throw new Error('acp_resume_unsupported')
       sessionId = context.resumeSessionId
       const loaded = await connection.request('session/load', { sessionId, cwd: project.path, mcpServers })
       if (object(loaded) && loaded.sessionId !== undefined && loaded.sessionId !== sessionId) throw new Error('acp_resume_session_mismatch')
     } catch (error) {
       if (options.resume !== 'fallback') throw error
       logOnce('resume', `session/load ${forLog(context.resumeSessionId)} failed (${error instanceof Error ? error.message.replace(CONTROL_CHARS, ' ').slice(0, 120) : String(error)}); opening a new session`)
       sessionId = ''
       created = await openNew()
     }
   } else created = await openNew()
   // 只在新会话上钉模型:session/load 沿用会话原状。失败只记日志,模型选错不该让整段对话起不来。
   const wanted = created ? options.model?.(context) : undefined
   if (wanted && wanted !== 'auto') {
     const option = Array.isArray(created!.configOptions) ? created!.configOptions.find((item: unknown) => object(item) && (item.id === 'model' || item.category === 'model')) : undefined
     const offered = object(option) && Array.isArray(option.options) && option.options.some((item: unknown) => object(item) && item.value === wanted)
     if (offered) await connection.request('session/set_config_option', { sessionId, configId: String((option as Record<string, unknown>).id), value: wanted }, 60_000).catch((error: unknown) => logOnce('model', `session/set_config_option ${forLog(wanted)} failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`))
     else logOnce('model', `model ${forLog(wanted)} not offered by ${options.displayName}; using its default`)
   }
   ```
   (`loading = false` 之后:`if (options.notice !== null) context.reportNotice?.(options.notice ?? acpNotice(options.displayName))`。)
3. `onRequest` 的权限分支:在 `permissions.size >= permissionLimit` 检查之后:
   ```ts
   const description = acpPermissionDescription(params)
   if (description === null) {
     if (options.permissions === 'mode') { logOnce('permission-shape', 'session/request_permission cancelled: undisplayable request'); return { outcome: { outcome: 'cancelled' } } }
     queueMicrotask(() => fatal(`无法核实或完整显示本次 ${options.displayName} 权限请求，工作台已停止任务。`)); return { outcome: { outcome: 'cancelled' } }
   }
   if (options.permissions === 'mode') {
     const optionId = acpPermissionOption(params.options, context.permissionMode === 'dangerously')
     return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } }
   }
   ```
   (bridge 分支照旧。)
4. `dispatch` 的 prompt 结果处理:三处 `finish(turn, …)` 之前先 `for (const event of translator.endTurn()) turn.queue.push(event)` —— 写成一个 `const settle = (event: AgentEvent) => { if (active !== turn) return; for (const e of translator.endTurn()) turn.queue.push(e); finish(turn, event) }`,三处改调 `settle`。取消 / fatal 路径不吐缓冲(半截话不发)。
5. 文件头注释改成通用描述(工作台 + 对话侧两种用法)。

`acp-workbench-provider.ts` 改为:

```ts
/** 工作台专用封装:逐工具权限桥 + 逐字流。通用实现见 acp-agent-provider.ts。 */
import type { AgentProvider } from './agent-provider'
import { createAcpProvider, type AcpProviderOptions } from './acp-agent-provider'

export type AcpWorkbenchProviderOptions = Omit<AcpProviderOptions, 'permissions' | 'text' | 'mcpServers' | 'model' | 'resume' | 'notice'>
export const acpNotice = (displayName: string): string =>
  `${displayName} 通过 ACP 执行：命令会逐次请求批准；工作区内的文件编辑由 ${displayName} 直接执行，不经过权限卡。`
export function createAcpWorkbenchProvider(options: AcpWorkbenchProviderOptions): AgentProvider {
  return createAcpProvider({ ...options, permissions: 'bridge', text: 'append' })
}
```

`acp-agent-provider.ts` 里 `AcpWorkbenchProviderOptions` 的字段定义(command/args/displayName/rpcTimeoutMs/closeTimeoutMs/permissionLimit/spawn/log)改名为 `AcpProviderBaseOptions` 并让 `AcpProviderOptions extends AcpProviderBaseOptions`;`acpNotice` 在 provider 内部用时从 `./acp-workbench-provider` import 会形成循环 —— 改成 provider 内部自带一份 `defaultNotice(displayName)`,`acp-workbench-provider.ts` 的 `acpNotice` 从 provider 文件 re-export(`export { acpNotice } from './acp-agent-provider'`)。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/acp-agent-provider.test.ts src/core/acp-workbench-provider.test.ts src/daemon/bootstrap/wire-workbench.test.ts src/core/acp && bun run typecheck && bun run depcheck`
Expected: 全绿(工作台测试一个断言没改);typecheck 0;depcheck 0 errors / 7 warnings

- [ ] **Step 5: 提交**

```bash
git add src/core/acp-agent-provider.ts src/core/acp-agent-provider.test.ts src/core/acp-workbench-provider.ts
git commit -m "ACP provider 通用化:permissions/text/mcpServers/model/resume/notice 五个选项,工作台版变薄封装"
```

---

### Task 3: 对话侧 Cursor(`acp-cursor-chat.ts` + `cursor-eval.ts`),删 print provider

**Files:**
- Create: `src/core/cursor-eval.ts`、`src/core/acp-cursor-chat.ts`
- Delete: `src/core/cursor-cli-provider.ts`、`src/core/cursor-cli-provider.test.ts`
- Modify: `src/core/agent-provider.ts`(删 `CURSOR_WECHAT_MCP_NAMESPACE_ID` 及别名集里的那一项)、`src/core/capability-matrix.ts`(cursor 行)、`src/core/external-cli-contract.live.test.ts`(import)
- Test: `src/core/acp-cursor-chat.test.ts`(新)、`src/core/cursor-eval.test.ts`(新)

**Interfaces:**
- Consumes: Task 2 `createAcpProvider`、`AcpMcpServer`;`McpStdioSpec`(`src/core/mcp-stdio-spec.ts`);`CORE_MCP_SERVER_NAMES`、`assertNotAuthFailed`、`ProviderCapabilities`(`agent-provider.ts`);`drainCappedStderr`(`agy-agent-provider.ts`);`makeCursorStreamParser`(`cursor-cli-stream.ts`);`spawn`(`src/lib/runtime/process`)。
- Produces:
  ```ts
  // cursor-eval.ts
  export interface CursorSpawnHandle { stdout: AsyncIterable<Uint8Array | string>; exited: Promise<number>; stderr(): Promise<string>; kill(): void }
  export type CursorSpawnFn = (args: string[], opts: { cwd: string }) => CursorSpawnHandle
  export function cursorBaseArgs(prompt: string, model: string): string[]
  export function defaultCursorSpawnFn(bin: string): CursorSpawnFn
  export async function cursorOneShotEval(spawnFn: CursorSpawnFn, model: string, prompt: string): Promise<string>
  // acp-cursor-chat.ts
  export const DEFAULT_CURSOR_MODEL = 'auto'
  export const ACP_CURSOR_CAPABILITIES: ProviderCapabilities
  export interface AcpCursorChatOptions { bin: string; model: string; log: (tag: string, line: string) => void; mcpSpecs: { wechat: McpStdioSpec | null; delegate: McpStdioSpec | null }; evalSpawn?: CursorSpawnFn; spawn?: typeof import('node:child_process').spawn }
  export function acpMcpServersFor(specs: AcpCursorChatOptions['mcpSpecs'], mcpEnv?: Record<string, string>): AcpMcpServer[]
  export function createAcpCursorChatProvider(options: AcpCursorChatOptions): AgentProvider
  ```

- [ ] **Step 1: 写失败的测试**

`src/core/cursor-eval.test.ts`(从被删的 `cursor-cli-provider.test.ts` 里搬 `fakeCursor` 脚手架与一次性评估相关的用例;至少):

```ts
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { cursorBaseArgs, cursorOneShotEval, type CursorSpawnFn } from './cursor-eval'

function fakeCursor(lines: string[], opts?: { exitCode?: number; stderr?: string }) {
  const calls: Array<{ args: string[]; cwd: string }> = []
  const spawnFn: CursorSpawnFn = (args, o) => { calls.push({ args, cwd: o.cwd }); return { stdout: (async function* () { for (const l of lines) yield l + '\n' })(), exited: Promise.resolve(opts?.exitCode ?? 0), stderr: async () => opts?.stderr ?? '', kill: () => {} } }
  return { spawnFn, calls }
}
const TEXT = '{"type":"assistant","message":{"content":[{"type":"text","text":"收到"}]},"session_id":"s1"}'
const RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"收到","session_id":"s1"}'

describe('cursor one-shot eval (print mode)', () => {
  it('runs -p in the temp dir with --trust and the model, and joins the assistant text', async () => {
    const f = fakeCursor([TEXT, RESULT])
    await expect(cursorOneShotEval(f.spawnFn, 'auto', 'hi')).resolves.toBe('收到')
    expect(f.calls[0]!.args).toEqual(cursorBaseArgs('hi', 'auto')); expect(f.calls[0]!.cwd).toBe(tmpdir())
    expect(cursorBaseArgs('hi', 'auto')).toEqual(['-p', 'hi', '--output-format', 'stream-json', '--model', 'auto', '--trust'])
  })
  it('surfaces a non-zero exit with stderr and a result error', async () => {
    await expect(cursorOneShotEval(fakeCursor([], { exitCode: 2, stderr: 'boom' }).spawnFn, 'auto', 'x')).rejects.toThrow('cursor-agent exited 2: boom')
    await expect(cursorOneShotEval(fakeCursor(['{"type":"result","subtype":"error","is_error":true,"result":"bad"}']).spawnFn, 'auto', 'x')).rejects.toThrow('cursor-agent result error: bad')
  })
})
```

`src/core/acp-cursor-chat.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { ACP_CURSOR_CAPABILITIES, acpMcpServersFor, createAcpCursorChatProvider, DEFAULT_CURSOR_MODEL } from './acp-cursor-chat'

describe('ACP cursor chat provider', () => {
  it('builds per-session MCP entries: CORE names get mcpEnv, PATH/HOME are carried, null specs are skipped', () => {
    const prevPath = process.env.PATH, prevHome = process.env.HOME
    process.env.PATH = '/usr/bin'; process.env.HOME = '/Users/me'
    try {
      const servers = acpMcpServersFor({ wechat: { command: '/cli', args: ['mcp-server', 'wechat'], env: { WECHAT_INTERNAL_API: 'http://127.0.0.1:1' } }, delegate: null }, { WECHAT_SESSION_TOKEN: 'tok', WECHAT_SESSION_TIER: 'admin' })
      expect(servers).toEqual([{ name: 'wechat', command: '/cli', args: ['mcp-server', 'wechat'], env: [
        { name: 'PATH', value: '/usr/bin' }, { name: 'HOME', value: '/Users/me' }, { name: 'WECHAT_INTERNAL_API', value: 'http://127.0.0.1:1' }, { name: 'WECHAT_SESSION_TOKEN', value: 'tok' }, { name: 'WECHAT_SESSION_TIER', value: 'admin' },
      ] }])
      const both = acpMcpServersFor({ wechat: { command: '/cli', args: ['a'] }, delegate: { command: '/cli', args: ['d'] } }, { WECHAT_SESSION_TOKEN: 'tok' })
      expect(both.map(s => s.name)).toEqual(['wechat', 'delegate'])
      expect(both[1]!.env.some(e => e.name === 'WECHAT_SESSION_TOKEN')).toBe(true)
      expect(acpMcpServersFor({ wechat: null, delegate: null })).toEqual([])
    } finally { process.env.PATH = prevPath; process.env.HOME = prevHome }
  })
  it('declares admin MCP tools, resume, no per-tool callback, claude as default peer', () => {
    expect(ACP_CURSOR_CAPABILITIES).toMatchObject({ perToolCallback: false, adminMcpTools: true, supportsDelegation: false, supportsResume: true, defaultPeer: 'claude' })
    expect(ACP_CURSOR_CAPABILITIES.authFailHint).toContain('cursor-agent login')
    expect(DEFAULT_CURSOR_MODEL).toBe('auto')
  })
  it('cheapEval/strongEval run the print one-shot and turn a login sentinel into auth_failed', async () => {
    const lines = ['{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in"}]}}', '{"type":"result","subtype":"success","is_error":false,"result":"x","session_id":"s"}']
    const evalSpawn = vi.fn(() => ({ stdout: (async function* () { for (const l of lines) yield l + '\n' })(), exited: Promise.resolve(0), stderr: async () => '', kill: () => {} }))
    const provider = createAcpCursorChatProvider({ bin: '/cursor-agent', model: 'auto', log: () => {}, mcpSpecs: { wechat: null, delegate: null }, evalSpawn })
    await expect(provider.cheapEval!('q')).rejects.toThrow('auth_failed')
    expect(provider.cheapEvalBudgetMs).toBe(20_000)
    expect(typeof provider.strongEval).toBe('function')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/cursor-eval.test.ts src/core/acp-cursor-chat.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

`src/core/cursor-eval.ts`:把 `cursor-cli-provider.ts` 里的 `CursorSpawnHandle`、`CursorSpawnFn`、`STDERR_CAP_BYTES`、`defaultSpawnFn`(改名 `defaultCursorSpawnFn`,导出)、`readLines`、`LineRaceResult`、`cursorBaseArgs`、`oneShotEval`(改名 `cursorOneShotEval`,导出)原样搬来;文件头注释:「Cursor 的一次性评估(cheapEval / strongEval)仍走 print 模式:无工具、无会话、一进程一答,比起 ACP 的 initialize/session/prompt 三步更省。对话与工作台都走 ACP(acp-cursor-chat.ts / acp-workbench-provider.ts)。」

`src/core/acp-cursor-chat.ts`:

```ts
/**
 * 对话侧的 Cursor:同一个 ACP 客户端(acp-agent-provider.ts),每会话一个常驻 cursor-agent acp,
 * wechat / delegate MCP 按会话注入并带逐会话 token 与 tier —— 于是主人聊天拿得到 admin 工具
 * (adminMcpTools:true),不再需要往 ~/.cursor/mcp.json 塞一把静态钥匙。
 * 一次性评估仍走 print(cursor-eval.ts)。
 */
import type { AgentProvider, ProviderCapabilities, SpawnContext } from './agent-provider'
import { assertNotAuthFailed, CORE_MCP_SERVER_NAMES } from './agent-provider'
import type { McpStdioSpec } from './mcp-stdio-spec'
import { createAcpProvider, type AcpMcpServer } from './acp-agent-provider'
import { cursorOneShotEval, defaultCursorSpawnFn, type CursorSpawnFn } from './cursor-eval'

/** cursorModel 没设时的兜底('auto' = 让 Cursor 自己挑)。 */
export const DEFAULT_CURSOR_MODEL = 'auto'

export const ACP_CURSOR_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: false,
  // session/new.mcpServers[].env 逐会话带 WECHAT_SESSION_TOKEN/_TIER(spike 2026-09-17 第 4 条实证到模型手里),
  // 所以 owner/admin 聊天真的拿到 admin tier —— 与 claude/codex 同档。
  adminMcpTools: true,
  sandboxLevels: new Set(),
  supportsDelegation: false,
  supportsResume: true,
  defaultPeer: 'claude',
  authFailHint: 'cursor 登录态失效,请在电脑上跑一次 `cursor-agent login` 重新登录后再发消息。',
}

export interface AcpCursorChatOptions {
  bin: string
  model: string
  log: (tag: string, line: string) => void
  /** boot 给的 MCP spec,键就是规范名;null ⇒ 不注入。 */
  mcpSpecs: { wechat: McpStdioSpec | null; delegate: McpStdioSpec | null }
  evalSpawn?: CursorSpawnFn
  spawn?: typeof import('node:child_process').spawn
}

/** MCP 子进程 env:PATH/HOME(gemini 曾因缺这层拿不到 PATH)+ spec.env + 会话 env(只给 CORE 名字,与 mergeEnvIntoMcpServers 同一条规矩)。 */
export function acpMcpServersFor(specs: AcpCursorChatOptions['mcpSpecs'], mcpEnv?: Record<string, string>): AcpMcpServer[] {
  const servers: AcpMcpServer[] = []
  for (const name of ['wechat', 'delegate'] as const) {
    const spec = specs[name]
    if (!spec) continue
    const env: Record<string, string> = {}
    for (const key of ['PATH', 'HOME']) { const value = process.env[key]; if (typeof value === 'string') env[key] = value }
    Object.assign(env, spec.env ?? {}, CORE_MCP_SERVER_NAMES.has(name) ? mcpEnv ?? {} : {})
    servers.push({ name, command: spec.command, args: spec.args ?? [], env: Object.entries(env).map(([k, v]) => ({ name: k, value: v })) })
  }
  return servers
}

export function createAcpCursorChatProvider(options: AcpCursorChatOptions): AgentProvider {
  const evalSpawn = options.evalSpawn ?? defaultCursorSpawnFn(options.bin)
  const base = createAcpProvider({
    command: options.bin, args: ['acp'], displayName: 'Cursor', log: options.log, spawn: options.spawn,
    permissions: 'mode', text: 'messages', resume: 'fallback', notice: null,
    mcpServers: (context: SpawnContext) => acpMcpServersFor(options.mcpSpecs, context.mcpEnv),
    model: (context: SpawnContext) => context.model ?? options.model,
  })
  return {
    spawn: base.spawn,
    /** CLI 子进程一档,与 codex 同量级。 */
    cheapEvalBudgetMs: 20_000,
    async cheapEval(prompt: string): Promise<string> {
      const text = await cursorOneShotEval(evalSpawn, options.model, prompt)
      assertNotAuthFailed(text, options.log, 'cursor cheapEval')
      return text
    },
    async strongEval(prompt: string): Promise<string> {
      const text = await cursorOneShotEval(evalSpawn, options.model, prompt)
      assertNotAuthFailed(text, options.log, 'cursor strongEval')
      return text
    },
  }
}
```

`agent-provider.ts`:删除 `CURSOR_WECHAT_MCP_NAMESPACE_ID` 常量与别名集里的那一项;注释里「cursor-mcp-config」相关句子改成只说 agy。`capability-matrix.ts`:`import { ACP_CURSOR_CAPABILITIES } from './acp-cursor-chat'`,`cursor: ACP_CURSOR_CAPABILITIES`(原 `CURSOR_CAPABILITIES` import 若无他用则删)。`external-cli-contract.live.test.ts`:`import { cursorBaseArgs } from './cursor-eval'` + `import { DEFAULT_CURSOR_MODEL } from './acp-cursor-chat'`。删 `cursor-cli-provider.ts` 与其测试。`rg -n "cursor-cli-provider|CURSOR_CLI_CAPABILITIES|CURSOR_WECHAT_MCP_NAMESPACE_ID" src apps` 除 bootstrap(Task 4)外必须为空。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/cursor-eval.test.ts src/core/acp-cursor-chat.test.ts src/core/acp src/core/agent-provider.test.ts src/core/capability-matrix.test.ts src/core/cursor-cli-stream.test.ts && bun run typecheck`
Expected: 全绿;typecheck 会在 bootstrap 处报 `cursor-cli-provider` 找不到 —— 那是 Task 4 的活,此任务结束时 typecheck 允许**只剩** `src/daemon/bootstrap/providers.ts`、`src/daemon/bootstrap/index.ts`、`src/daemon/bootstrap/cursor-mcp-config.ts` 三处错误(在报告里列出)。

- [ ] **Step 5: 提交**

```bash
git add -A src/core
git commit -m "对话侧 Cursor 走 ACP:acp-cursor-chat(逐会话 MCP 注入、adminMcpTools)+ cursor-eval(一次性评估留 print);删 print provider 与命名空间别名"
```

---

### Task 4: bootstrap 切换、旧全局条目清理、文档

**Files:**
- Modify: `src/daemon/bootstrap/providers.ts:396-425`、`src/daemon/bootstrap/index.ts:55,586,768-780`、`src/daemon/main.ts:70,218`
- Modify: `src/daemon/bootstrap/cursor-mcp-config.ts`(删 setup;常量私有)、`src/daemon/bootstrap/cursor-mcp-config.test.ts`(删 setup 的 describe)
- Modify: `docs/superpowers/specs/2026-09-18-acp-cursor-chat-design.md`(修订记录)、`docs/cc-workbench.md`(修订记录一条,说明对话侧也走 ACP、不再写 `~/.cursor/mcp.json`)
- Test: `src/daemon/bootstrap.test.ts`(若有 cursor CLI 分支用例则改期望;没有则加一个:`cursorAgentBin` 指向一个假脚本时注册的 provider 有 `cheapEvalBudgetMs === 20_000`,且日志有 `cursor: cursor-agent CLI present … (ACP)`)

**Interfaces:**
- Consumes: Task 3 `createAcpCursorChatProvider`、`DEFAULT_CURSOR_MODEL`;`removeCursorGlobalMcp`。

- [ ] **Step 1: 改测试**

`cursor-mcp-config.test.ts`:删掉 `describe('setupCursorGlobalMcp …')` 整块;remove 的用例里凡是用 `setupCursorGlobalMcp` 造夹具的,改成直接写一个含 `wechat-cc:wechat` 条目的 mcp.json 文件。`bootstrap.test.ts`:如上。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/daemon/bootstrap/cursor-mcp-config.test.ts src/daemon/bootstrap.test.ts`
Expected: FAIL / typecheck 报错

- [ ] **Step 3: 实现**

`providers.ts` cursor 分支:

```ts
  const cursorAgentBin = configuredAgent.cursorAgentBin ?? (UNDER_TEST_RUNNER ? null : findOnPath('cursor-agent'))
  let cursorCliRegistered = false
  if (cursorAgentBin && probeBinaryVersion(cursorAgentBin) !== null) {
    try {
      const { createAcpCursorChatProvider, DEFAULT_CURSOR_MODEL } = await import('../../core/acp-cursor-chat')
      // 上一版往 ~/.cursor/mcp.json 塞过一把静态 trusted 钥匙(tier C);对话侧走 ACP 后 MCP 按会话注入,
      // 那条目只剩风险 —— boot 时清掉(测试 runner 下 remove 自己会跳过)。
      const { removeCursorGlobalMcp } = await import('./cursor-mcp-config')
      removeCursorGlobalMcp({ log: deps.log })
      registry.register(
        'cursor',
        createAcpCursorChatProvider({
          bin: cursorAgentBin,
          model: configuredAgent.cursorModel ?? DEFAULT_CURSOR_MODEL,
          mcpSpecs: { wechat: wechatStdioForCursor, delegate: delegateStdioForCursor },
          log: deps.log,
        }),
        { displayName: 'Cursor', canResume: () => true },
      )
      cursorCliRegistered = true
      deps.log('BOOT', 'cursor: cursor-agent CLI present (subscription auth) — provider registered (ACP, per-session MCP)')
    } catch (err) {
      deps.log('BOOT', `cursor: CLI registration failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
```

(`setupCursorGlobalMcp` 与 `mintSessionToken` 那段删掉;`import { setupCursorGlobalMcp } from './cursor-mcp-config'` 与 `DEFAULT_CURSOR_MODEL` 的旧 import 删掉;`wechatStdioForCursor` / `delegateStdioForCursor` 仍从参数来。)`index.ts:55` 改 `import { DEFAULT_CURSOR_MODEL } from '../../core/acp-cursor-chat'`;`index.ts:768-780` 注释里去掉 cursor。`main.ts`:删 `removeCursorGlobalMcp` import 与第 218 行那条关机钩子。`cursor-mcp-config.ts`:删 `setupCursorGlobalMcp`、`PrepareCursorMcpOpts`,`const CURSOR_WECHAT_MCP_NAMESPACE_ID = 'wechat-cc:wechat'` 改成文件内私有常量(不再从 agent-provider import,也不再 re-export),文件头注释改为「只剩 boot 时清理上一版留下的条目」。

`docs/cc-workbench.md` 修订记录追加:`- **2026-09-18**：对话侧的 Cursor 也改走 ACP（每会话一个常驻 cursor-agent acp，wechat / delegate MCP 按会话注入并带逐会话 token 与 tier，主人聊天拿得到 admin 工具）；不再往 ~/.cursor/mcp.json 写静态钥匙，boot 时清掉上一版留下的条目；一次性评估（cheapEval）仍走 print 模式。设计：docs/superpowers/specs/2026-09-18-acp-cursor-chat-design.md。` spec 修订记录追加 `- 2026-09-18:按计划落地(任务 1–4)。`

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/daemon && bun run typecheck && bun run depcheck && bun run test && npm run test:node`
Expected: 全绿;typecheck 0;depcheck 0 errors / 7 warnings;`rg -n "cursor-cli-provider|CURSOR_CLI_CAPABILITIES|CURSOR_WECHAT_MCP_NAMESPACE_ID|setupCursorGlobalMcp" src apps` 为空。

- [ ] **Step 5: 提交**

```bash
git add -A src/daemon docs/cc-workbench.md docs/superpowers/specs/2026-09-18-acp-cursor-chat-design.md
git commit -m "bootstrap:cursor 对话 provider 切到 ACP,boot 清掉旧的 ~/.cursor/mcp.json 静态钥匙,关机钩子删;文档"
```

---

## Self-Review

- **Spec coverage**:§1 → Task 1;§2 → Task 2;§3 + §4 + §5(删 provider、别名、matrix、live test)→ Task 3;§5(bootstrap、cursor-mcp-config、main.ts、docs)→ Task 4;真机 harness 由控制器在部署前跑(不在计划内)。
- **Placeholder scan**:无。
- **Type consistency**:`createAcpProvider(options: AcpProviderOptions)`、`AcpMcpServer`、`createAcpTranslator({text})`/`endTurn()`、`acpMcpServersFor(specs, mcpEnv)`、`createAcpCursorChatProvider({bin, model, log, mcpSpecs, evalSpawn?, spawn?})`、`cursorOneShotEval(spawnFn, model, prompt)`、`defaultCursorSpawnFn(bin)` 各任务一致。
