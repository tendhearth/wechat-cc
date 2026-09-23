# 社交工具面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给伙伴九个新的 MCP 工具(心愿、介绍、关系、串门),加一段系统提示,让主人用自然语言驱动社交层;精确命令快车道一字不改。

**Architecture:** 工具全部加在现有 `wechat` MCP server(`src/mcp-servers/wechat/tools-social.ts`),内部打 internal API 的 trusted 路由,只返回路由 JSON,不返回文案。权限三层:admin 会话才注册、`user-tier.ts` 新 kind `social_act` admin-only、路由层拒非 admin token。`prompt-builder.ts` 新增 `socialAvailable` 段,与 `fileLocateAvailable` 同一契约(缺省逐字节不变)。入口顺序(`commandRouter.tryHandle` → `coordinator.dispatch`)不动。

**Tech Stack:** TypeScript on Bun;Vitest(`bun --bun vitest run <file>`);`@modelcontextprotocol/sdk`(`McpServer`、`InMemoryTransport`、`Client`);zod。

**Spec:** `docs/superpowers/specs/2026-09-05-social-tools-design.md`

## Global Constraints

- 九个新工具名(小写下划线,逐字):`wish_list`、`wish_send`、`wish_cancel`、`intro_request`、`intro_accept`、`intro_decline`、`intro_offers`、`relationships`、`visit`;`social_seek` 保留原名原行为。
- 工具**只返回路由 JSON 原样**(`JSON.stringify(resp)` 进一个 text block),不拼中文文案;传输 / 非 2xx 走 `passthroughErrorResult(err, toolName)`。唯一例外:`social_seek` 现有的 `hint` 字段保留。
- `ref` / `reply_ref` 参数是 `z.string().min(2)`;`wish_send` / `wish_cancel` body 键是 `{ id }`,intro 三个 body 键是 `{ reply_id }`,`visit` body 是 `{ target }` 或 `{}`。
- 新 ToolKind 名 `social_act`,加入 `ALL_KINDS` 与 `ADMIN_ONLY`;`classifyToolUse('mcp__wechat__<九个名字>')` → `'social_act'`;`social_seek` 映射不变。
- `prompt-builder` 新字段 `socialAvailable?: boolean`;缺省 / false 时 `buildSystemPrompt` 输出与之前**逐字节相同**;true 时渲染 `socialToolsSection()`,标题为 `## 替主人交朋友(管理员)`,正文含全部十个工具名(九个新 + `social_seek`)。
- `bootstrap/index.ts` 用一个 `let socialToolsWired = false`(在 `buildInstructions` 之前声明,在 `socialWiring` 赋值之后置为 `!!socialWiring.social`)计算 `socialAvailable: socialToolsWired && tierProfile.allow.has('social_act')`。**不要**在 `buildInstructions` 闭包里直接引用 `socialWiring`(它在闭包之后才 `const` 声明,有 TDZ 风险)。
- `command-router.ts`、六个 `parse*Command`、桌面、路由、`wire-*` 全部不改;它们的既有测试一条不动。
- 每个提交全量测试绿(`bun --bun vitest run`)、`bun run typecheck` 干净;报告前 `git status --short` 必须为空。
- 提交信息用仓库风格的一行中文;trailer:`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` 与 `Claude-Session: https://claude.ai/code/session_01UyRSmFJFdAc7VP1TzUUdS7`。

---

### Task 1: `user-tier.ts` 新 kind `social_act`

**Files:**
- Modify: `src/core/user-tier.ts`(ToolKind 联合、`ALL_KINDS`、`ADMIN_ONLY`、`classifyToolUse`)
- Test: `src/core/user-tier.test.ts`(追加 describe)

**Interfaces:**
- Produces: `ToolKind` 多一个字面量 `'social_act'`;`TIER_PROFILES.admin.allow.has('social_act') === true`,trusted / guest `deny.has('social_act') === true`;`classifyToolUse('mcp__wechat__wish_list', {})` 等九个 → `'social_act'`。Task 4 用 `tierProfile.allow.has('social_act')`。

- [ ] **Step 1: 写失败测试**

在 `src/core/user-tier.test.ts` 的 `describe('social_seek tier kind (M1 T6)', …)` 之后追加:

```ts
describe('social_act tier kind (social-tools 2026-09-05)', () => {
  const NAMES = ['wish_list', 'wish_send', 'wish_cancel', 'intro_request', 'intro_accept', 'intro_decline', 'intro_offers', 'relationships', 'visit'] as const
  it('classifies the nine mcp__wechat__ social tools as ToolKind social_act', () => {
    for (const n of NAMES) expect(classifyToolUse(`mcp__wechat__${n}`, {})).toBe('social_act')
  })
  it('leaves social_seek on its own kind', () => {
    expect(classifyToolUse('mcp__wechat__social_seek', { topic: 'x' })).toBe('social_seek')
  })
  it('admin allows social_act; trusted and guest deny it, no relay path', () => {
    // 认识 / 同意 / 不了 / 串门 / 查心愿都是替主人对外动作或读主人的社交状态,
    // 和 social_seek 同一信任档:只有主人能调,不走中继。
    expect(TIER_PROFILES.admin.allow.has('social_act')).toBe(true)
    expect(TIER_PROFILES.admin.relay.has('social_act')).toBe(false)
    expect(TIER_PROFILES.trusted.deny.has('social_act')).toBe(true)
    expect(TIER_PROFILES.trusted.allow.has('social_act')).toBe(false)
    expect(TIER_PROFILES.guest.deny.has('social_act')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('social_act')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/user-tier.test.ts`
Expected: FAIL —— 九个名字被归到 `'subgent'` 缺省桶(`toBe('social_act')` 不成立),`allow.has('social_act')` 为 false。

- [ ] **Step 3: 实现**

`src/core/user-tier.ts` 三处改动:

1. `ToolKind` 联合体里,`| 'social_seek'` 那一行之后加:

```ts
  | 'social_act'         // admin-only: act on the owner's social layer via the wechat MCP tools (wish_list/wish_send/wish_cancel/intro_request/intro_accept/intro_decline/intro_offers/relationships/visit, social-tools 2026-09-05) — same trust class as social_seek: reads the owner's social state or reaches out on their behalf.
```

2. `ALL_KINDS` 里 `'social_seek', 'knowledge_search', …` 那一行改为:

```ts
  'social_seek', 'social_act', 'knowledge_search', 'federated_query', 'graph_query', 'facts_query', 'person_query',
```

3. `ADMIN_ONLY` 里 `'social_seek'` 之后插入 `'social_act'`:

```ts
const ADMIN_ONLY = new Set<ToolKind>(['daemon_introspect', 'daemon_remediate', 'file_locate', 'plugin_tool', 'social_seek', 'social_act', 'knowledge_search', 'federated_query', 'graph_query', 'facts_query', 'person_query', 'config_admin'])
```

4. `classifyToolUse` 里 `if (sub === 'social_seek') return 'social_seek'` 之后加:

```ts
    // social-tools (2026-09-05): the nine tools that read or act on the
    // owner's social layer — admin-only, same posture as social_seek.
    if (sub === 'wish_list' || sub === 'wish_send' || sub === 'wish_cancel'
      || sub === 'intro_request' || sub === 'intro_accept' || sub === 'intro_decline' || sub === 'intro_offers'
      || sub === 'relationships' || sub === 'visit') return 'social_act'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/core/user-tier.test.ts && bun run typecheck`
Expected: PASS(既有 social_seek / knowledge_search 各条不受影响)。

- [ ] **Step 5: 提交**

```bash
git add src/core/user-tier.ts src/core/user-tier.test.ts
git commit -m "user-tier:social_act —— 九个社交工具只给主人,和 social_seek 同一档"
```

---

### Task 2: `tools-social.ts` 九个工具 + 单元测试

**Files:**
- Modify: `src/mcp-servers/wechat/tools-social.ts`(保留 `registerSocialSeekTool`,新增九个工具与 `registerSocialTools`)
- Test: `src/mcp-servers/wechat/tools-social.test.ts`(新)

**Interfaces:**
- Consumes: `InternalApiClient.request<T>(method, path, body?)`(`./client`);`passthroughErrorResult(err, tool)`(`./tool-helpers`);`InternalApiError(message, status, path, body)`(`./client`,测试造 503 用)。
- Produces: `export function registerSocialTools(server: McpServer, client: InternalApiClient): void` —— 注册十个工具(`social_seek` + 九个新的)。Task 3 在 `main.ts` 调它。

- [ ] **Step 1: 写失败测试**

新建 `src/mcp-servers/wechat/tools-social.test.ts`:

```ts
/**
 * 社交工具面(spec 2026-09-05-social-tools §1):十个工具只是 internal API
 * 的薄壳 —— 这里断言的是「打对路由 + body 形状 + 路由 JSON 原样回给模型」,
 * 不断言任何中文文案(文案是模型的活)。走 InMemoryTransport 起真的
 * McpServer,和 federated-source.test.ts 同一套。
 */
import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerSocialTools } from './tools-social'
import { InternalApiError, type InternalApiClient } from './client'

type Call = { method: string; path: string; body?: unknown }

function fakeClient(routes: Record<string, unknown>): { client: InternalApiClient; calls: Call[] } {
  const calls: Call[] = []
  const client: InternalApiClient = {
    async request(method, path, body) {
      calls.push({ method, path, body })
      const r = routes[`${method} ${path}`]
      if (r instanceof Error) throw r
      if (r === undefined) throw new InternalApiError(`no fixture for ${method} ${path}`, 404, path, { error: 'not_found' })
      return r as never
    },
  }
  return { client, calls }
}

async function harness(routes: Record<string, unknown>) {
  const server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } })
  const { client: api, calls } = fakeClient(routes)
  registerSocialTools(server, api)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 't', version: '0' }, { capabilities: {} })
  await Promise.all([server.connect(serverT), mcp.connect(clientT)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await mcp.callTool({ name, arguments: args }) as { content: Array<{ type: string; text: string }> }
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>
  }
  return { mcp, calls, call }
}

const TEN = ['social_seek', 'wish_list', 'wish_send', 'wish_cancel', 'intro_request', 'intro_accept', 'intro_decline', 'intro_offers', 'relationships', 'visit']

describe('registerSocialTools', () => {
  it('registers exactly the ten social tools', async () => {
    const { mcp } = await harness({})
    const names = (await mcp.listTools()).tools.map(t => t.name).sort()
    expect(names).toEqual([...TEN].sort())
  })

  it('wish_list → GET /v1/social/wishes, route JSON returned verbatim', async () => {
    const fixture = { wishes: [{ id: 'w1', text: '找搭子', status: 'open', postcards: [{ reply_id: 'ab12cd34', via_label: '阿A', preview: '我朋友常去', at: 't', requested: false }] }] }
    const { calls, call } = await harness({ 'GET /v1/social/wishes': fixture })
    expect(await call('wish_list')).toEqual(fixture)
    expect(calls).toEqual([{ method: 'GET', path: '/v1/social/wishes', body: undefined }])
  })

  it('wish_send / wish_cancel post { id } from ref', async () => {
    const { calls, call } = await harness({
      'POST /v1/social/wish/send': { ok: true, sent_to: 2 },
      'POST /v1/social/wish/cancel': { ok: true, status: 'cancelled' },
    })
    expect(await call('wish_send', { ref: 'w1' })).toEqual({ ok: true, sent_to: 2 })
    expect(await call('wish_cancel', { ref: 'w1' })).toEqual({ ok: true, status: 'cancelled' })
    expect(calls.map(c => [c.path, c.body])).toEqual([
      ['/v1/social/wish/send', { id: 'w1' }],
      ['/v1/social/wish/cancel', { id: 'w1' }],
    ])
  })

  it('intro_request / intro_accept / intro_decline post { reply_id } from reply_ref', async () => {
    const { calls, call } = await harness({
      'POST /v1/social/intro/request': { ok: true, reply_id: 'ab12cd34' },
      'POST /v1/social/intro/accept': { ok: true, reply_id: 'ab12cd34' },
      'POST /v1/social/intro/decline': { ok: false, reason: 'not_found' },
    })
    expect(await call('intro_request', { reply_ref: 'ab' })).toEqual({ ok: true, reply_id: 'ab12cd34' })
    expect(await call('intro_accept', { reply_ref: 'ab12' })).toEqual({ ok: true, reply_id: 'ab12cd34' })
    expect(await call('intro_decline', { reply_ref: 'zz' })).toEqual({ ok: false, reason: 'not_found' })
    expect(calls.map(c => [c.path, c.body])).toEqual([
      ['/v1/social/intro/request', { reply_id: 'ab' }],
      ['/v1/social/intro/accept', { reply_id: 'ab12' }],
      ['/v1/social/intro/decline', { reply_id: 'zz' }],
    ])
  })

  it('intro_offers / relationships are plain GETs returned verbatim', async () => {
    const offers = { offers: [{ reply_id: 'ab12cd34', hint: '找搭子', via_label: '阿A', at: 't' }] }
    const rels = [{ id: 'peer:cc-1', kind: 'peer', label: '阿A', origin: '配对' }]
    const { calls, call } = await harness({ 'GET /v1/social/intro/offers': offers, 'GET /v1/social/relationships': rels })
    expect(await call('intro_offers')).toEqual(offers)
    expect(await call('relationships')).toEqual(rels)
    expect(calls.map(c => c.path)).toEqual(['/v1/social/intro/offers', '/v1/social/relationships'])
  })

  it('visit posts {} without target and { target } with one', async () => {
    const { calls, call } = await harness({ 'POST /v1/social/visit': { ok: true, started: true } })
    await call('visit')
    await call('visit', { target: '阿A' })
    expect(calls.map(c => c.body)).toEqual([{}, { target: '阿A' }])
  })

  it('a 503 from the route becomes a structured error text, never an MCP exception', async () => {
    const { call } = await harness({
      'POST /v1/social/intro/request': new InternalApiError('503', 503, '/v1/social/intro/request', { error: 'social_not_wired' }),
    })
    const r = await call('intro_request', { reply_ref: 'ab' })
    expect(String(r.error)).toContain('503')
    expect(String(r.error)).toContain('social_not_wired')
  })

  it('social_seek is unchanged: proposes via POST /v1/social/wish and adds the hint', async () => {
    const { calls, call } = await harness({ 'POST /v1/social/wish': { ok: true, id: 'w9', preview: '想找周末爬山的朋友' } })
    const r = await call('social_seek', { topic: '周末爬山搭子', city: '北京' })
    expect(r).toMatchObject({ ok: true, id: 'w9', preview: '想找周末爬山的朋友' })
    expect(String(r.hint)).toContain('派 w9')
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/social/wish', body: { text: '周末爬山搭子(北京)' } })
  })

  it('rejects a one-character ref at the schema layer (server prefix match needs ≥2)', async () => {
    const { mcp, calls } = await harness({})
    // SDK 版本不同,参数校验失败可能是 isError 结果也可能是 JSON-RPC 错误;两种都算拒绝。
    let rejected = false
    try {
      const res = await mcp.callTool({ name: 'intro_request', arguments: { reply_ref: 'a' } }) as { isError?: boolean }
      rejected = res.isError === true
    } catch { rejected = true }
    expect(rejected).toBe(true)
    expect(calls).toEqual([])   // 没打到 internal API
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/mcp-servers/wechat/tools-social.test.ts`
Expected: FAIL —— `registerSocialTools` 不是导出(import 报错)。

- [ ] **Step 3: 实现**

`src/mcp-servers/wechat/tools-social.ts` 整文件替换为:

```ts
/**
 * 社交工具面(spec 2026-09-05-social-tools):伙伴替主人用社交层的十个
 * MCP 工具。全是 internal API 的薄壳 —— 打 trusted 路由,把路由 JSON 原样
 * 交给模型,**不拼任何中文文案**;回话怎么说是模型的活(spec §1 规则)。
 * 权限:main.ts 只在 admin 会话注册;user-tier.ts 把它们归到 `social_act`
 * (admin-only);路由层再拒一次非 admin token。
 *
 * `social_seek` 是老工具(agent-social M1 → 心愿 §4 repoint),名字与行为
 * 都不动:只出脱敏预览存草稿,主人点头后模型再调 `wish_send`。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

type TextResult = { content: Array<{ type: 'text'; text: string }> }
const asText = (v: unknown): TextResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }] })

/** 心愿 id / 明信片 replyId 的前缀:服务端做前缀匹配,至少给两位。 */
const REF = z.string().min(2)

interface WishProposeResponse {
  ok: boolean
  id?: string
  preview?: string
  error?: string
  violations?: string[]
}

export function registerSocialSeekTool(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'social_seek',
    {
      title: 'Propose a social wish via people the owner knows',
      description: '替主人向认识的人打听——本工具只生成脱敏预览并暂存草稿,不会立即发出。返回 { ok, id, preview } 或 { ok:false, error, violations }。把 preview 原样念给主人;主人点头(任何肯定的说法)再调 wish_send,「算了」调 wish_cancel;若 ok:false,原样告诉主人哪些话不能说出去。仅管理员可用。',
      inputSchema: {
        topic: z.string().describe('要寻找同好/资源的话题,例如"周末爬山搭子"'),
        city: z.string().optional().describe('可选,限定城市范围'),
      },
    },
    async ({ topic, city }) => {
      try {
        const resp = await client.request<WishProposeResponse>('POST', '/v1/social/wish', { text: topic + (city ? `(${city})` : '') })
        if (!resp.ok) return asText(resp)
        const hint = `已生成脱敏预览并暂存;把 preview 念给主人,主人点头后调 wish_send('${resp.id ?? '<id>'}'),「算了」调 wish_cancel。(主人也可以直接回「派 ${resp.id ?? '<id>'}」)`
        return asText({ ...resp, hint })
      } catch (err) {
        return passthroughErrorResult(err, 'social_seek')
      }
    },
  )
}

/** 一个 GET 工具:没有参数,路由 JSON 原样返回。 */
function registerGet(server: McpServer, client: InternalApiClient, name: string, title: string, description: string, path: string): void {
  server.registerTool(name, { title, description, inputSchema: {} }, async () => {
    try { return asText(await client.request('GET', path)) }
    catch (err) { return passthroughErrorResult(err, name) }
  })
}

/** 一个「按引用动作」的 POST 工具:一个字符串参数,映射成 body 里的一个键。 */
function registerRefPost(
  server: McpServer, client: InternalApiClient,
  name: string, title: string, description: string,
  path: string, argName: 'ref' | 'reply_ref', bodyKey: 'id' | 'reply_id', argDescription: string,
): void {
  server.registerTool(name, { title, description, inputSchema: { [argName]: REF.describe(argDescription) } }, async (args) => {
    try { return asText(await client.request('POST', path, { [bodyKey]: (args as Record<string, string>)[argName] })) }
    catch (err) { return passthroughErrorResult(err, name) }
  })
}

export function registerSocialTools(server: McpServer, client: InternalApiClient): void {
  registerSocialSeekTool(server, client)

  registerGet(server, client, 'wish_list',
    'List the owner\'s open wishes and the postcards that came back',
    '主人开着的心愿,以及每条收到的回音(postcards:reply_id、via_label=哪位朋友转来的、preview、requested=是否已在问)。主人问「谁回了心愿」「那个 X 的回音」先调这个;要「认识」某个回音的人,在 postcards 的 preview 里对上,拿 reply_id 调 intro_request。返回路由 JSON 原样。仅管理员可用。',
    '/v1/social/wishes')

  registerRefPost(server, client, 'wish_send',
    'Send a proposed wish (owner has confirmed the preview)',
    '主人对 social_seek 的预览点头之后才调:把草稿真正派出去。ref 是心愿 id 或前缀。返回 { ok, sent_to } 或 { ok:false, reason }(no_channels=还没有认识的人,too_many_open=开着的太多)。仅管理员可用。',
    '/v1/social/wish/send', 'ref', 'id', '心愿 id 或前缀(至少 2 位)')

  registerRefPost(server, client, 'wish_cancel',
    'Cancel a wish (draft or open)',
    '主人说「算了」「收了」:作废草稿或关掉开着的心愿(之后的回音仍会进包袱)。ref 是心愿 id 或前缀。返回路由 JSON 原样。仅管理员可用。',
    '/v1/social/wish/cancel', 'ref', 'id', '心愿 id 或前缀(至少 2 位)')

  registerRefPost(server, client, 'intro_request',
    'Ask to be introduced to the friend-of-a-friend behind a postcard',
    '主人说「把那个 X 认识一下」:对 wish_list 里某张 postcard 的 reply_id 发起介绍,由转来的那位朋友去问对方;对方点头后双方自动成为朋友。主人这句话本身就是指令,直接调,不必再确认。返回 { ok:true, reply_id } 或 { ok:false, reason }(not_found / ambiguous=前缀对到多张,列出来让主人选 / already_requested=已经在问了 / send_failed)。仅管理员可用。',
    '/v1/social/intro/request', 'reply_ref', 'reply_id', 'postcard 的 reply_id 或前缀(至少 2 位)')

  registerRefPost(server, client, 'intro_accept',
    'Accept an introduction offer (someone wants to meet the owner)',
    '主人对 intro_offers 里某条邀约点头:「同意」「可以认识」。直接调,不必再确认。返回 { ok:true, reply_id } 或 { ok:false, reason }(not_found=没有这条或过期了 / ambiguous / send_failed=没送出去,邀约还在,可重试)。仅管理员可用。',
    '/v1/social/intro/accept', 'reply_ref', 'reply_id', '邀约的 reply_id 或前缀(至少 2 位)')

  registerRefPost(server, client, 'intro_decline',
    'Decline an introduction offer',
    '主人对 intro_offers 里某条邀约摇头:「不了」「算了」。直接调,不必再确认。返回 { ok:true, reply_id } 或 { ok:false, reason }。仅管理员可用。',
    '/v1/social/intro/decline', 'reply_ref', 'reply_id', '邀约的 reply_id 或前缀(至少 2 位)')

  registerGet(server, client, 'intro_offers',
    'List introduction offers waiting for the owner\'s nod',
    '等主人点头的邀约:{ offers:[{ reply_id, hint=对方当初问的话题, via_label=哪位朋友转来的, at }] }。主人问「有人想认识我吗」先调这个;点头调 intro_accept,摇头调 intro_decline。仅管理员可用。',
    '/v1/social/intro/offers')

  registerGet(server, client, 'relationships',
    'List who the owner\'s companion knows',
    '伙伴认识的人(关系视图):每条有 label、kind、origin(配对 / 经朋友介绍 / 来找我聊过 …)、familiarity。主人问「我都认识谁」「和谁熟」先调这个。返回路由 JSON 原样。仅管理员可用。',
    '/v1/social/relationships')

  server.registerTool(
    'visit',
    {
      title: 'Send the companion to visit a friend\'s companion',
      description: '主人说「去串个门」「去 X 家看看」:让伙伴去朋友的伙伴那里串门(后台进行,结果之后进包袱)。target 可选,是朋友的名字或信道 id;不给就由伙伴自己挑。直接调,不必再确认。返回 { ok:true, started:true } 或 { ok:false, reason }(unknown_channel=没有这个朋友)。仅管理员可用。',
      inputSchema: { target: z.string().min(1).optional().describe('可选:朋友的名字或信道 id') },
    },
    async ({ target }) => {
      try { return asText(await client.request('POST', '/v1/social/visit', target === undefined ? {} : { target })) }
      catch (err) { return passthroughErrorResult(err, 'visit') }
    },
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/mcp-servers/wechat/ && bun run typecheck`
Expected: PASS(含 `integration.test.ts` —— 它此时仍走 `registerSocialSeekTool`,不受影响)。

- [ ] **Step 5: 提交**

```bash
git add src/mcp-servers/wechat/tools-social.ts src/mcp-servers/wechat/tools-social.test.ts
git commit -m "wechat MCP:九个社交工具 —— 查心愿 / 派 / 收 / 认识 / 同意 / 不了 / 邀约 / 认识的人 / 串门,只回路由 JSON"
```

---

### Task 3: `main.ts` 注册 + integration 测试的 admin-only 断言

**Files:**
- Modify: `src/mcp-servers/wechat/main.ts`(import 与 admin 分支)
- Test: `src/mcp-servers/wechat/integration.test.ts`(扩展现有 admin-only 那条)

**Interfaces:**
- Consumes: Task 2 `registerSocialTools(server, client)`。

- [ ] **Step 1: 写失败测试**

`src/mcp-servers/wechat/integration.test.ts`:在 `const DAEMON_TOOLS = [ … ]` 之后加:

```ts
  const SOCIAL_TOOLS = [
    'social_seek', 'wish_list', 'wish_send', 'wish_cancel',
    'intro_request', 'intro_accept', 'intro_decline', 'intro_offers',
    'relationships', 'visit',
  ]
```

并把 `it('registers the admin daemon-control tools ONLY for an admin session (WECHAT_SESSION_TIER)', …)` 里的两个 for 循环各加一行:

```ts
    for (const t of DAEMON_TOOLS) expect(adminNames).toContain(t)
    for (const t of SOCIAL_TOOLS) expect(adminNames).toContain(t)
```

```ts
    for (const t of DAEMON_TOOLS) expect(nonAdminNames).not.toContain(t)
    for (const t of SOCIAL_TOOLS) expect(nonAdminNames).not.toContain(t)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/mcp-servers/wechat/integration.test.ts -t "ONLY for an admin session"`
Expected: FAIL —— admin 会话的 `tools/list` 里没有 `wish_list`。

- [ ] **Step 3: 实现**

`src/mcp-servers/wechat/main.ts`:

1. import 行 `import { registerSocialSeekTool } from './tools-social'` 改为 `import { registerSocialTools } from './tools-social'`。
2. admin 分支里 `registerSocialSeekTool(server, client)` 及其上方那段注释改为:

```ts
  // 社交工具面(spec 2026-09-05-social-tools):social_seek + 九个读 / 动
  // 主人社交层的工具。admin-only(user-tier.ts 的 social_seek / social_act
  // 都在 ADMIN_ONLY);非 admin 会话根本看不到,路由层再拒一次。
  registerSocialTools(server, client)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun --bun vitest run src/mcp-servers/wechat/ && bun run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/mcp-servers/wechat/main.ts src/mcp-servers/wechat/integration.test.ts
git commit -m "wechat MCP:admin 会话注册整组社交工具;非 admin 一个都看不到"
```

---

### Task 4: 系统提示 `socialAvailable` + bootstrap 接线 + 全量

**Files:**
- Modify: `src/core/prompt-builder.ts`(`BuildSystemPromptArgs.socialAvailable`、`socialToolsSection()`、sections 数组)
- Modify: `src/daemon/bootstrap/index.ts`(`let socialToolsWired`、`buildInstructions` 传 `socialAvailable`、`socialWiring` 之后置位)
- Test: `src/core/prompt-builder.test.ts`(追加 describe)
- Full: `bun run typecheck && bun --bun vitest run`

**Interfaces:**
- Consumes: Task 1 `tierProfile.allow.has('social_act')`。
- Produces: `BuildSystemPromptArgs.socialAvailable?: boolean`;`export function socialToolsSection(): string`。

- [ ] **Step 1: 写失败测试**

`src/core/prompt-builder.test.ts` 末尾追加(`buildSystemPrompt` 已在文件顶部 import;把 `socialToolsSection` 加进那行 import):

```ts
describe('socialAvailable (social-tools 2026-09-05)', () => {
  const base = { providerId: 'claude' as const, peerProviderId: 'codex' as const, companionEnabled: false, delegateAvailable: false }
  const TOOLS = ['social_seek', 'wish_list', 'wish_send', 'wish_cancel', 'intro_request', 'intro_accept', 'intro_decline', 'intro_offers', 'relationships', 'visit']

  it('buildSystemPrompt is byte-identical whether socialAvailable is absent or explicitly false', () => {
    const withoutKey = buildSystemPrompt({ ...base })
    const withFalse = buildSystemPrompt({ ...base, socialAvailable: false })
    expect(withFalse).toBe(withoutKey)
    expect(withoutKey).not.toContain('替主人交朋友')
    for (const t of TOOLS.filter(t => t !== 'social_seek')) expect(withoutKey).not.toContain(t)
  })

  it('renders the 替主人交朋友 section with all ten tool names when socialAvailable is true', () => {
    const p = buildSystemPrompt({ ...base, socialAvailable: true })
    expect(p).toContain('## 替主人交朋友(管理员)')
    for (const t of TOOLS) expect(p).toContain(`\`${t}\``)
  })

  it('socialToolsSection() says: query before answering, act on say-so, wish keeps the preview nod', () => {
    const s = socialToolsSection()
    expect(s).toContain('先查再答')
    expect(s).toContain('直接做')
    expect(s).toContain('preview')
    expect(s).toContain('social_not_wired')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun --bun vitest run src/core/prompt-builder.test.ts`
Expected: FAIL —— `socialToolsSection` 不是导出;`socialAvailable` 不是已知字段(typecheck 也会报)。

- [ ] **Step 3: 实现 prompt-builder**

1. `BuildSystemPromptArgs` 里 `fileLocateAvailable?: boolean` 之后加:

```ts
  /**
   * When true, this session is admin-tier AND the daemon's social layer is
   * wired, so the wechat-mcp social tools (social_seek / wish_* / intro_* /
   * relationships / visit, spec 2026-09-05-social-tools) are registered and
   * functional. Adds the 替主人交朋友 section so the agent queries before
   * answering and acts on the owner's say-so instead of asking the owner
   * to type `认识 ab12`. Caller passes
   * `socialToolsWired && tierProfile.allow.has('social_act')`. Absent or
   * false ⇒ output is byte-identical to before this field existed
   * (mirrors `fileLocateAvailable`'s contract).
   */
  socialAvailable?: boolean
```

2. `buildSystemPrompt` 的 sections 数组里,`args.fileLocateAvailable ? fileLocateSection() : '',` 之后加一行:

```ts
    args.socialAvailable === true ? socialToolsSection() : '',
```

3. `fileLocateSection` 函数之后加:

```ts
export function socialToolsSection(): string {
  return `## 替主人交朋友(管理员)

伙伴的社交层开着,你手里有一组工具。主人问「谁回了心愿」「有人想认识我吗」「我都认识谁」——先查再答,别凭记忆:
- \`wish_list\`:开着的心愿和每条的回音(reply_id、哪位朋友转来的、预览、是否已在问)。
- \`intro_offers\`:等主人点头的邀约。\`relationships\`:认识的人。
主人说「把 X 认识一下」「同意 / 不了」「去串门」——这句话本身就是指令,直接做,做完把结果说清楚,不要再问一遍「你确定吗」:
- 「认识」:先 \`wish_list\`,在 postcards 的 preview 里对上那个人,拿 reply_id 调 \`intro_request\`;\`requested:true\` 的说「已经在问了」,别再点。对不上或对上多张,把候选列出来让主人挑。
- 「同意 / 不了」:用 \`intro_offers\` 对上 reply_id,再 \`intro_accept\` / \`intro_decline\`。
- 「去串门」:\`visit\`,可带对方名字。
派心愿是唯一的例外:\`social_seek\` 只出脱敏预览并存草稿,把 preview 原样念给主人;主人点头(任何肯定的说法)再 \`wish_send\`,「算了」就 \`wish_cancel\`。
工具回 \`ok:false\` 时把 reason 用人话说;\`error\` 里是 \`social_not_wired\` 表示社交层没开,连不上 daemon 是另一回事,两句别混。主人也可以直接回「派 w1」「认识 ab12」这类精确命令,那不经过你。`
}
```

- [ ] **Step 4: 实现 bootstrap 接线**

`src/daemon/bootstrap/index.ts`:

1. 紧挨着 `const buildInstructions = (providerId: ProviderId, tierProfile: TierProfile, chatId: string): string => {` 的**上一行**加:

```ts
  // social-tools (2026-09-05): flipped to true right after `socialWiring`
  // below resolves. A `let` read lazily by buildInstructions — NOT a direct
  // reference to `socialWiring` from inside the closure, which is declared
  // later with `const` and would be a TDZ hazard if any session's prompt
  // were built before social wiring completes.
  let socialToolsWired = false
```

2. `buildSystemPrompt({ … })` 参数里,`fileLocateAvailable: tierProfile.allow.has('file_locate'),` 之后加:

```ts
      // Tracks tool registration exactly, same posture as fileLocateAvailable:
      // `social_act` is ADMIN_ONLY (user-tier.ts), matching wechat-mcp/main.ts's
      // SESSION_IS_ADMIN gate on registerSocialTools; `socialToolsWired` says
      // the daemon's social layer actually came up (otherwise every tool 503s).
      socialAvailable: socialToolsWired && tierProfile.allow.has('social_act'),
```

3. `const socialWiring = (await sup.start('social', async () => { … }))` 这个表达式结束(分号)之后的下一行加:

```ts
  socialToolsWired = !!socialWiring.social
```

(`socialWiring.social` 在社交层降级 / 没开时为 undefined,与 `bootstrap/types.ts` 的 `social?` 一致。)

- [ ] **Step 5: 跑测试确认通过 + 全量**

Run: `bun --bun vitest run src/core/prompt-builder.test.ts src/daemon/bootstrap.test.ts && bun run typecheck`
Expected: PASS。

然后全量:`bun run typecheck && bun --bun vitest run`
Expected: 全绿;`bootstrap.test.ts` 若有 prompt 快照或字段断言需随之更新,只允许**追加** `socialAvailable` 相关期望,不得放松其它断言。

- [ ] **Step 6: 提交**

```bash
git add src/core/prompt-builder.ts src/core/prompt-builder.test.ts src/daemon/bootstrap/index.ts
git commit -m "系统提示:社交层开着且是主人会话时,告诉伙伴怎么用这组工具 —— 先查再答、说了就做、派心愿留预览"
```

---

## 完成后(真机)

两台配对好之后,在微信里对伙伴说:
1. 「帮我看看有谁回了心愿」→ 伙伴调 `wish_list` 后列出回音(没有就说没有)。
2. 有 hop 2 回音时:「把那个 X 的认识一下」→ 对端主人收到「想认识你」。
3. 对端直接说「同意」(不带编号)→ 伙伴调 `intro_offers` + `intro_accept` → 双方互见为 peer。
4. 「去串个门」→ `visit` 启动,包袱里出现串门记录。
5. 反例:社交层关着时问同样的话 → 伙伴说「社交没开」而不是「daemon 没起」。

memory:新建 `social-tools-shipped`;第 2 项「伙伴日程判断」在这轮合入后单独 brainstorm。
