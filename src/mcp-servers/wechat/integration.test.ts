import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createInternalApi, type InternalApi } from '../../daemon/internal-api'
import { makeMemoryFS } from '../../daemon/memory/fs-api'
import { makeEventsStore } from '../../daemon/events/store'
import { openTestDb, type Db } from '../../lib/db'
import { readFileSync } from 'node:fs'
import { wechatStdioMcpSpec } from '../../daemon/bootstrap/mcp-specs'
import { setupAgyGlobalMcp, AGY_WECHAT_MCP_NAMESPACE_ID } from '../../daemon/bootstrap/agy-mcp-config'
import { setReplyDeliveryOverrides } from '../../core/capability-matrix'
import { acpMcpServersFor } from '../../core/acp-cursor-chat'

/**
 * P1.A end-to-end: this test wires up the complete provider→stdio MCP→
 * loopback HTTP→daemon round-trip without involving Claude/Codex SDK.
 * If this passes, the architecture proven in RFC 03 §5 is operational.
 *
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │ test process                                                │
 *  │  ─ MCP Client ────────── stdio ────► wechat-mcp child       │
 *  │      ▲                                  │                   │
 *  │      │ tool result (daemon_pid)         │ HTTP fetch         │
 *  │      │                                  ▼                   │
 *  │  ─ internalApi ◄───────── 127.0.0.1:<port> ────────────────┘ │
 *  └─────────────────────────────────────────────────────────────┘
 *
 * The wechat-mcp child is spawned with WECHAT_INTERNAL_API + WECHAT_INTERNAL_TOKEN_FILE
 * env vars so its hand-off matches what bootstrap.ts wires for production.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WECHAT_MCP_MAIN = join(HERE, 'main.ts')
// We always spawn wechat-mcp under bun: the source is .ts and uses
// extensionless imports (e.g. `./client`) that node's ESM loader can't
// resolve. Bootstrap.ts in production passes process.execPath because
// the daemon itself runs under bun (`bun src/daemon/main.ts`); tests
// here run under node via vitest, so we hard-code bun. If the test
// machine doesn't have bun on PATH, this expectedly fails fast.
const RUNTIME = 'bun'

describe('wechat-mcp stdio integration', () => {
  let stateDir: string
  let api: InternalApi | null = null
  let client: Client | null = null

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'wechat-mcp-int-'))
  })
  afterEach(async () => {
    if (client) {
      try { await client.close() } catch { /* swallow */ }
      client = null
    }
    if (api) {
      try { await api.stop({ unlinkToken: true }) } catch { /* swallow */ }
      api = null
    }
    rmSync(stateDir, { recursive: true, force: true })
  })

  async function bootChain(opts: { admin?: boolean } = {}): Promise<{ client: Client }> {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    api = createInternalApi({ stateDir, daemonPid: 7777, memory })
    const { port, tokenFilePath } = await api.start()

    const baseEnv = { ...process.env as Record<string, string> }
    // The daemon-control tools register only for an admin session (tier baked
    // into WECHAT_SESSION_TIER). Ensure no inherited tier leaks in; admin runs
    // set tier=admin (+ a session token), non-admin runs set tier=trusted.
    delete baseEnv.WECHAT_SESSION_TIER
    delete baseEnv.WECHAT_SESSION_TOKEN
    const transport = new StdioClientTransport({
      command: RUNTIME,
      args: [WECHAT_MCP_MAIN],
      env: {
        ...baseEnv,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
        ...(opts.admin
          ? { WECHAT_SESSION_TIER: 'admin', WECHAT_SESSION_TOKEN: 'integration-admin-tok' }
          : { WECHAT_SESSION_TIER: 'trusted' }),
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-test', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c
    return { client: c }
  }

  const DAEMON_TOOLS = [
    'diagnostic_turns', 'diagnostic_sessions', 'diagnostic_health',
    'session_release', 'model_get', 'model_set', 'daemon_restart',
  ]

  const SOCIAL_TOOLS = [
    'social_seek', 'wish_list', 'wish_send', 'wish_cancel',
    'intro_request', 'intro_accept', 'intro_decline', 'intro_offers',
    'relationships', 'visit',
  ]

  it('lists the ping tool via tools/list', async () => {
    const { client } = await bootChain()
    const list = await client.listTools()
    expect(list.tools.map(t => t.name)).toContain('ping')
  })

  it('registers the admin daemon-control tools ONLY for an admin session (WECHAT_SESSION_TIER)', async () => {
    // The robust, provider-agnostic gate: a non-admin session's MCP child does
    // not register these tools, so they cannot be called or even discovered —
    // closing the gap that codex (no canUseTool) would otherwise leave open.
    const admin = await bootChain({ admin: true })
    const adminNames = (await admin.client.listTools()).tools.map(t => t.name)
    for (const t of DAEMON_TOOLS) expect(adminNames).toContain(t)
    for (const t of SOCIAL_TOOLS) expect(adminNames).toContain(t)
    // ping (an ungated tool) is present regardless.
    expect(adminNames).toContain('ping')
    await admin.client.close()
    if (api) { await api.stop(); api = null }

    const nonAdmin = await bootChain() // no admin flag
    const nonAdminNames = (await nonAdmin.client.listTools()).tools.map(t => t.name)
    for (const t of DAEMON_TOOLS) expect(nonAdminNames).not.toContain(t)
    for (const t of SOCIAL_TOOLS) expect(nonAdminNames).not.toContain(t)
    expect(nonAdminNames).toContain('ping') // ungated tools still present
  })

  it('ping tool round-trips the daemon_pid through the full provider → stdio → HTTP → daemon chain', async () => {
    const { client } = await bootChain()
    const result = await client.callTool({ name: 'ping', arguments: {} })
    expect(result.isError).toBeFalsy()

    // structuredContent 必须只含 outputSchema 声明的两项:严格校验的 MCP 客户端
    // (cursor-agent acp,2026-09-17 真机)对多出来的 /v1/health 字段回 -32602。
    const sc = result.structuredContent as { ok: boolean; daemon_pid: number } | undefined
    if (sc) {
      expect(sc).toEqual({ ok: true, daemon_pid: 7777 })
      expect(Object.keys(sc).sort()).toEqual(['daemon_pid', 'ok'])
      return
    }
    const content = result.content as Array<{ type: string; text?: string }>
    const textBlock = content.find(b => b.type === 'text')
    expect(textBlock).toBeDefined()
    const parsed = JSON.parse(textBlock!.text!) as { ok: boolean; daemon_pid: number }
    expect(parsed).toMatchObject({ ok: true, daemon_pid: 7777 })
  })

  it('memory_write → memory_read round-trips content through stdio + HTTP + MemoryFS', async () => {
    const { client } = await bootChain()

    const writeResult = await client.callTool({
      name: 'memory_write',
      arguments: { path: 'profile.md', content: '# 用户画像\n端到端写入测试' },
    })
    expect(writeResult.isError).toBeFalsy()
    const writeText = (writeResult.content as Array<{ type: string; text?: string }>)[0]?.text
    expect(JSON.parse(writeText!)).toEqual({ ok: true })

    const readResult = await client.callTool({
      name: 'memory_read',
      arguments: { path: 'profile.md' },
    })
    expect(readResult.isError).toBeFalsy()
    const readText = (readResult.content as Array<{ type: string; text?: string }>)[0]?.text
    expect(JSON.parse(readText!)).toEqual({
      exists: true,
      content: '# 用户画像\n端到端写入测试',
    })
  })

  it('memory_list returns files written via memory_write', async () => {
    const { client } = await bootChain()
    for (const path of ['top.md', 'sub/a.md', 'sub/b.md']) {
      await client.callTool({ name: 'memory_write', arguments: { path, content: 'x' } })
    }
    const listResult = await client.callTool({ name: 'memory_list', arguments: {} })
    expect(listResult.isError).toBeFalsy()
    const listText = (listResult.content as Array<{ type: string; text?: string }>)[0]?.text
    const parsed = JSON.parse(listText!) as { files: string[] }
    expect(parsed.files.sort()).toEqual(['sub/a.md', 'sub/b.md', 'top.md'])
  })

  it('memory_read for missing file surfaces exists:false (legacy wire shape preserved)', async () => {
    const { client } = await bootChain()
    const result = await client.callTool({
      name: 'memory_read',
      arguments: { path: 'never-existed.md' },
    })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text
    expect(JSON.parse(text!)).toEqual({ exists: false })
  })

  it('memory_write with invalid extension surfaces ok:false + error (legacy wire shape preserved)', async () => {
    const { client } = await bootChain()
    const result = await client.callTool({
      name: 'memory_write',
      arguments: { path: 'bad.txt', content: 'x' },
    })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text
    const parsed = JSON.parse(text!) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/\.md/i)
  })

  async function bootChainWithDb(): Promise<{ client: Client; db: Db }> {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    const db = openTestDb()
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, db })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME,
      args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-test', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c
    return { client: c, db }
  }

  it('memory_delete soft-deletes via the stdio MCP chain and writes an audit event', async () => {
    const { client, db } = await bootChainWithDb()
    // Seed a memory file first
    await client.callTool({
      name: 'memory_write',
      arguments: { path: 'profile.md', content: 'doomed' },
    })

    const result = await client.callTool({
      name: 'memory_delete',
      arguments: { chat_id: 'chat_int', path: 'profile.md', reason: 'user said "forget that"' },
    })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text
    const parsed = JSON.parse(text!) as { ok: boolean; existed: boolean; tombstone?: string }
    expect(parsed.ok).toBe(true)
    expect(parsed.existed).toBe(true)
    expect(parsed.tombstone).toMatch(/^profile\.md\.deleted-/)

    // Audit row landed in the per-chat events store
    const events = await makeEventsStore(db, 'chat_int').list()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'memory_deleted',
      trigger: 'mcp_tool_call',
      reasoning: 'user said "forget that"',
    })
    db.close()
  })

  // ── B3: projects + set_user_name end-to-end ─────────────────────────────

  async function bootChainWithProjects(): Promise<{ client: Client; setUserNameCalls: Array<[string, string]>; switchToCalls: string[] }> {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    const setUserNameCalls: Array<[string, string]> = []
    const switchToCalls: string[] = []
    const projects = {
      list: () => [
        { alias: 'compass', path: '/p/compass', current: true },
        { alias: 'mobile', path: '/p/mobile', current: false },
      ],
      switchTo: async (alias: string) => {
        switchToCalls.push(alias)
        return alias === 'compass' || alias === 'mobile'
          ? { ok: true as const, path: `/p/${alias}` }
          : { ok: false as const, reason: 'alias_not_found' }
      },
      add: async () => {},
      remove: async () => {},
    }
    const setUserName = async (chatId: string, name: string) => { setUserNameCalls.push([chatId, name]) }
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, projects, setUserName })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME,
      args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-projects', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c
    return { client: c, setUserNameCalls, switchToCalls }
  }

  it('list_projects round-trips through stdio + HTTP + projects.list()', async () => {
    const { client } = await bootChainWithProjects()
    const result = await client.callTool({ name: 'list_projects', arguments: {} })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text
    const arr = JSON.parse(text!) as Array<{ alias: string; current: boolean }>
    expect(arr).toHaveLength(2)
    expect(arr[0]).toMatchObject({ alias: 'compass', current: true })
  })

  it('switch_project surfaces ok:false reason from server through stdio', async () => {
    const { client, switchToCalls } = await bootChainWithProjects()
    const result = await client.callTool({ name: 'switch_project', arguments: { alias: 'ghost' } })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text
    expect(JSON.parse(text!)).toEqual({ ok: false, reason: 'alias_not_found' })
    expect(switchToCalls).toEqual(['ghost'])
  })

  it('set_user_name forwards chat_id + name through full chain', async () => {
    const { client, setUserNameCalls } = await bootChainWithProjects()
    const result = await client.callTool({
      name: 'set_user_name',
      arguments: { chat_id: 'user@bot', name: '丸子' },
    })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text
    expect(JSON.parse(text!)).toEqual({ ok: true })
    expect(setUserNameCalls).toEqual([['user@bot', '丸子']])
  })

  // ── B4: voice config tools end-to-end ───────────────────────────────────

  // ── B1: ilink-bound message family end-to-end ─────────────────────────

  it('reply / send_file / edit_message / broadcast / reply_voice round-trip through stdio + HTTP + ilink mocks', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    const calls: Array<[string, ...unknown[]]> = []
    const ilinkDep = {
      sendReply: async (chatId: string, text: string) => {
        calls.push(['sendReply', chatId, text])
        return { msgId: 'm-reply-1' }
      },
      sendFile: async (chatId: string, path: string) => {
        calls.push(['sendFile', chatId, path])
      },
      editMessage: async (chatId: string, msgId: string, text: string) => {
        calls.push(['editMessage', chatId, msgId, text])
      },
      broadcast: async (text: string, accountId?: string) => {
        calls.push(['broadcast', text, accountId])
        return { ok: 3, failed: 0 }
      },
    }
    const voice = {
      replyVoice: async (chatId: string, text: string) => {
        calls.push(['replyVoice', chatId, text])
        return { ok: true as const, msgId: 'm-voice-1' }
      },
      saveConfig: async (): Promise<{ ok: false; reason: string }> => ({ ok: false, reason: 'unused' }),
      configStatus: () => ({ configured: false as const }),
      synthesizeSpeech: async (): Promise<{ audio: Buffer; mime: string }> => { throw new Error('unused') },
    }
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, ilink: ilinkDep, voice })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME, args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-ilink', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    // reply
    const reply = await c.callTool({ name: 'reply', arguments: { chat_id: 'u@bot', text: 'hi' } })
    expect(JSON.parse(((reply.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      ok: true, msg_id: 'm-reply-1',
    })
    expect(calls[0]).toEqual(['sendReply', 'u@bot', 'hi'])

    // reply_voice
    const replyVoice = await c.callTool({ name: 'reply_voice', arguments: { chat_id: 'u@bot', text: '念这一段' } })
    expect(JSON.parse(((replyVoice.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      ok: true, msgId: 'm-voice-1',
    })
    expect(calls[1]).toEqual(['replyVoice', 'u@bot', '念这一段'])

    // send_file
    const sendFile = await c.callTool({ name: 'send_file', arguments: { chat_id: 'u@bot', path: '/abs/x.pdf' } })
    expect(JSON.parse(((sendFile.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({ ok: true })
    expect(calls[2]).toEqual(['sendFile', 'u@bot', '/abs/x.pdf'])

    // edit_message
    const edit = await c.callTool({
      name: 'edit_message',
      arguments: { chat_id: 'u@bot', msg_id: 'm-1', text: 'edited' },
    })
    expect(JSON.parse(((edit.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({ ok: true })
    expect(calls[3]).toEqual(['editMessage', 'u@bot', 'm-1', 'edited'])

    // broadcast
    const bc = await c.callTool({ name: 'broadcast', arguments: { text: 'hi all' } })
    expect(JSON.parse(((bc.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({ ok: 3, failed: 0 })
    expect(calls[4]).toEqual(['broadcast', 'hi all', undefined])
  })

  it('session token: reply passes chat_id through UNCHANGED and the daemon\'s chat_scope 403 reaches the agent (no silent rewrite)', async () => {
    // send-scope.ts (2026-10-03). The MCP side must not quietly substitute the
    // session's own chat — that would hide a cross-chat attempt instead of
    // refusing it. It forwards what the model asked for; the daemon decides.
    const sent: Array<[string, string]> = []
    const ilinkDep = {
      sendReply: async (chatId: string, text: string) => { sent.push([chatId, text]); return { msgId: 'm-1' } },
      sendFile: async () => {}, editMessage: async () => {},
      broadcast: async () => ({ ok: 0, failed: 0 }),
    }
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, ilink: ilinkDep })
    const { port, tokenFilePath } = await api.start()
    const sessionToken = api.mintSessionToken('guest', 'claude/a/guest@im.wechat')
    const baseEnv = { ...process.env as Record<string, string> }
    delete baseEnv.WECHAT_SESSION_TIER
    const transport = new StdioClientTransport({
      command: RUNTIME, args: [WECHAT_MCP_MAIN],
      env: {
        ...baseEnv,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
        WECHAT_SESSION_TIER: 'guest',
        WECHAT_SESSION_TOKEN: sessionToken,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-scope', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    const foreign = await c.callTool({ name: 'reply', arguments: { chat_id: 'owner@im.wechat', text: 'injected' } })
    const foreignText = ((foreign.content as Array<{ text?: string }>)[0]?.text)!
    expect(foreignText).toContain('403')
    expect(foreignText).toContain('chat_scope')
    expect(foreignText).toContain('nothing was sent')
    expect(sent).toEqual([])

    const own = await c.callTool({ name: 'reply', arguments: { chat_id: 'guest@im.wechat', text: 'hi' } })
    expect(JSON.parse(((own.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({ ok: true, msg_id: 'm-1' })
    expect(sent).toEqual([['guest@im.wechat', 'hi']])
  })

  it('reply_voice with text > 500 chars surfaces ok:false reason without crossing ilink (legacy cap)', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    const replyVoiceCalls: number[] = []
    const voice = {
      replyVoice: async () => { replyVoiceCalls.push(1); return { ok: true as const, msgId: 'should-not-be-called' } },
      saveConfig: async (): Promise<{ ok: false; reason: string }> => ({ ok: false, reason: 'unused' }),
      configStatus: () => ({ configured: false as const }),
      synthesizeSpeech: async (): Promise<{ audio: Buffer; mime: string }> => { throw new Error('unused') },
    }
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, voice })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME, args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-voice-cap', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    const result = await c.callTool({
      name: 'reply_voice',
      arguments: { chat_id: 'u@bot', text: 'x'.repeat(501) },
    })
    expect(JSON.parse(((result.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      ok: false, reason: 'too_long', limit: 500,
    })
    expect(replyVoiceCalls).toHaveLength(0)  // dep was NOT crossed
  })

  // ── B5: share_page / resurface_page end-to-end ────────────────────────

  it('share_page publishes then resurface_page returns the same record (legacy wire shapes preserved)', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    const published = new Map<string, { url: string; slug: string; title: string }>()
    const sharePage = async (
      title: string,
      _content: string,
      opts?: { needs_approval?: boolean; chat_id?: string; account_id?: string },
    ) => {
      const slug = `s-${published.size + 1}`
      const url = `https://share.example/${slug}${opts?.needs_approval ? '?approve=1' : ''}`
      published.set(slug, { url, slug, title })
      return { url, slug }
    }
    const resurfacePage = async (q: { slug?: string; title_fragment?: string }) => {
      if (q.slug && published.has(q.slug)) {
        const r = published.get(q.slug)!
        return { url: r.url, slug: r.slug }
      }
      if (q.title_fragment) {
        for (const r of published.values()) {
          if (r.title.includes(q.title_fragment)) return { url: r.url, slug: r.slug }
        }
      }
      return null
    }
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, sharePage, resurfacePage })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME, args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-share', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    // Publish
    const pub = await c.callTool({
      name: 'share_page',
      arguments: { title: 'My Plan', content: '# todo\n- x', needs_approval: true },
    })
    const pubBody = JSON.parse(((pub.content as Array<{ text?: string }>)[0]?.text)!) as { url: string; slug: string }
    expect(pubBody.slug).toBe('s-1')
    expect(pubBody.url).toContain('approve=1')

    // Resurface by slug
    const bySlug = await c.callTool({
      name: 'resurface_page',
      arguments: { slug: pubBody.slug },
    })
    expect(JSON.parse(((bySlug.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      url: pubBody.url, slug: pubBody.slug,
    })

    // Resurface miss → legacy {ok:false, reason:'not found'} shape
    const miss = await c.callTool({
      name: 'resurface_page',
      arguments: { slug: 'never-existed' },
    })
    expect(JSON.parse(((miss.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      ok: false, reason: 'not found',
    })
  })

  // ── B6: companion proactive-tick controls end-to-end ──────────────────

  it('companion enable → snooze → status round-trips through stdio + HTTP', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    let enabled = false
    let snoozeUntil: string | null = null
    const companion = {
      enable: async () => {
        const wasEnabled = enabled
        enabled = true
        return wasEnabled
          ? { ok: true as const, already_configured: true as const }
          : { ok: true as const, state_dir: '/state', welcome_message: '开启完成', cost_estimate_note: '~$0.02/tick' }
      },
      disable: async () => { enabled = false; return { ok: true as const, enabled: false as const } },
      status: () => ({
        enabled, timezone: 'Asia/Shanghai',
        default_chat_id: enabled ? 'c1' : null,
        snooze_until: snoozeUntil,
        import_local_history: false,
      }),
      snooze: async (minutes: number) => {
        snoozeUntil = new Date(Date.parse('2026-04-22T00:00:00Z') + minutes * 60_000).toISOString()
        return { ok: true as const, until: snoozeUntil }
      },
      setImportLocal: async (enabled: boolean) => ({ ok: true as const, import_local_history: enabled }),
    }
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, companion })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME, args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-companion', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    // First enable: welcome_message
    const enable1 = await c.callTool({ name: 'companion_enable', arguments: {} })
    const enable1Body = JSON.parse(((enable1.content as Array<{ text?: string }>)[0]?.text)!) as Record<string, unknown>
    expect(enable1Body.welcome_message).toBe('开启完成')

    // Second enable: already_configured
    const enable2 = await c.callTool({ name: 'companion_enable', arguments: {} })
    expect(JSON.parse(((enable2.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      ok: true, already_configured: true,
    })

    // Snooze 60min
    const snooze = await c.callTool({ name: 'companion_snooze', arguments: { minutes: 60 } })
    const snoozeBody = JSON.parse(((snooze.content as Array<{ text?: string }>)[0]?.text)!) as { ok: boolean; until: string }
    expect(snoozeBody.ok).toBe(true)
    expect(snoozeBody.until).toBe('2026-04-22T01:00:00.000Z')

    // Status reflects both
    const status = await c.callTool({ name: 'companion_status', arguments: {} })
    const statusBody = JSON.parse(((status.content as Array<{ text?: string }>)[0]?.text)!) as Record<string, unknown>
    expect(statusBody.enabled).toBe(true)
    expect(statusBody.snooze_until).toBe('2026-04-22T01:00:00.000Z')

    // Disable
    const disable = await c.callTool({ name: 'companion_disable', arguments: {} })
    expect(JSON.parse(((disable.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      ok: true, enabled: false,
    })
  })

  it('save_voice_config → voice_config_status round-trips through stdio + HTTP', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    let stored: { provider: 'http_tts'; default_voice: string; base_url: string; model: string; saved_at: string } | null = null
    const voice = {
      replyVoice: async (): Promise<{ ok: false; reason: string }> => ({ ok: false, reason: 'unused_in_voice_config_test' }),
      saveConfig: async (input: { provider: 'http_tts' | 'qwen'; base_url?: string; model?: string; default_voice?: string }) => {
        stored = {
          provider: 'http_tts' as const,
          default_voice: input.default_voice ?? 'default',
          base_url: input.base_url!,
          model: input.model!,
          saved_at: new Date('2026-04-22T00:00:00Z').toISOString(),
        }
        return { ok: true as const, tested_ms: 800, provider: input.provider, default_voice: stored.default_voice }
      },
      configStatus: () => stored
        ? { configured: true as const, ...stored }
        : { configured: false as const },
      synthesizeSpeech: async (): Promise<{ audio: Buffer; mime: string }> => { throw new Error('unused_in_voice_config_test') },
    }
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, voice })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME, args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-voice', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    // Initially unset
    const status1 = await c.callTool({ name: 'voice_config_status', arguments: {} })
    expect(JSON.parse(((status1.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({ configured: false })

    // Save
    const save = await c.callTool({
      name: 'save_voice_config',
      arguments: { provider: 'http_tts', base_url: 'http://mac:8000/v1/audio/speech', model: 'openbmb/VoxCPM2' },
    })
    const saveBody = JSON.parse(((save.content as Array<{ text?: string }>)[0]?.text)!) as { ok: boolean; tested_ms: number }
    expect(saveBody.ok).toBe(true)
    expect(saveBody.tested_ms).toBe(800)

    // Status now reflects saved config
    const status2 = await c.callTool({ name: 'voice_config_status', arguments: {} })
    const status2Body = JSON.parse(((status2.content as Array<{ text?: string }>)[0]?.text)!) as Record<string, unknown>
    expect(status2Body.configured).toBe(true)
    expect(status2Body.provider).toBe('http_tts')
    expect(status2Body.base_url).toBe('http://mac:8000/v1/audio/speech')
    // never leak api_key
    expect(status2Body.api_key).toBeUndefined()
  })

  it('registers locate_file ONLY for an admin session', async () => {
    const admin = await bootChain({ admin: true })
    const adminNames = (await admin.client.listTools()).tools.map(t => t.name)
    expect(adminNames).toContain('locate_file')
    await admin.client.close()
    if (api) { await api.stop(); api = null }

    const nonAdmin = await bootChain() // no admin flag → trusted
    const nonAdminNames = (await nonAdmin.client.listTools()).tools.map(t => t.name)
    expect(nonAdminNames).not.toContain('locate_file')
    await nonAdmin.client.close()
  })

  it('registers social_seek ONLY for an admin session', async () => {
    const admin = await bootChain({ admin: true })
    const adminNames = (await admin.client.listTools()).tools.map(t => t.name)
    expect(adminNames).toContain('social_seek')
    await admin.client.close()
    if (api) { await api.stop(); api = null }

    const nonAdmin = await bootChain() // no admin flag → trusted
    const nonAdminNames = (await nonAdmin.client.listTools()).tools.map(t => t.name)
    expect(nonAdminNames).not.toContain('social_seek')
    await nonAdmin.client.close()
  })

  it('social_seek hits POST /v1/social/wish and returns {ok, id, preview, hint} (心愿 repoint)', async () => {
    // Proves the tool repoint through the REAL internal-api router
    // (routes-social.ts), not just code review: only POST /v1/social/wish
    // is wired to deps.social.wish.propose — any other path either 404s (no
    // route registered) before ever reaching this stub, so the propose spy
    // firing with the right args + the tool returning this stub's exact
    // response is direct proof the stdio→HTTP chain hit exactly that
    // endpoint.
    const proposeCalls: string[] = []
    api = createInternalApi({
      stateDir, daemonPid: 7777,
      social: {
        wish: {
          propose: async (text: string) => {
            proposeCalls.push(text)
            return { ok: true as const, id: 'wish-abc123', preview: '找摄影搭子(深圳)(已脱敏)' }
          },
          send: async () => ({ ok: true as const, sentTo: 0 }),
          cancel: () => ({ ok: true as const, status: 'cancelled' as const }),
          list: () => [],
          resolveRef: () => ({ ok: false as const, reason: 'not_found' as const }),
        },
      },
    })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME, args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
        // WECHAT_SESSION_TIER='admin' registers the tool client-side
        // (main.ts's SESSION_IS_ADMIN gate). Deliberately no
        // WECHAT_SESSION_TOKEN: the client then authenticates HTTP calls
        // with the daemon-wide FILE token (trusted) — sufficient, since
        // POST /v1/social/wish is trusted-tier (route-tiers.ts, 心愿),
        // same as how the real CLI/session-token holders reach it.
        WECHAT_SESSION_TIER: 'admin',
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-social', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    const result = await c.callTool({ name: 'social_seek', arguments: { topic: '找摄影搭子', city: '深圳' } })
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text?: string }>
    const textBlock = content.find(b => b.type === 'text')
    expect(textBlock).toBeDefined()
    const body = JSON.parse(textBlock!.text!) as { ok?: boolean; id?: string; preview?: string; hint?: string }
    expect(body.ok).toBe(true)
    expect(body.id).toBe('wish-abc123')
    expect(body.preview).toBe('找摄影搭子(深圳)(已脱敏)')
    expect(body.hint).toContain('派 wish-abc123')
    expect(body.hint).toContain('wish_cancel')
    expect(proposeCalls).toEqual(['找摄影搭子(深圳)'])
  })

  it('ping tool returns isError=true when internal-api is unreachable', async () => {
    // Don't start internal-api — point the child at a port that nothing
    // is listening on. The child should still come up (no precondition
    // on api at boot) but the ping call must surface the failure cleanly
    // rather than hang or crash the child.
    const transport = new StdioClientTransport({
      command: RUNTIME,
      args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        // Point at port 1 — privileged on linux, fails fast with ECONNREFUSED.
        WECHAT_INTERNAL_API: 'http://127.0.0.1:1',
        WECHAT_INTERNAL_TOKEN_FILE: join(stateDir, 'never-exists'),
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-test-noapi', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    const result = await client.callTool({ name: 'ping', arguments: {} })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content[0]?.text).toMatch(/ping failed/)
  })

  // 回复交付第 2 步(2026-10-03):agy 只读一份**静态**全局 MCP 配置。按 agy 当前的交付模式,daemon 开机写进去的
  // 条目里带不带 WECHAT_REPLY_DELIVERY=daemon,决定 agy 的 wechat MCP 子进程注册哪套工具 —— 这里走完整条链:
  // 能力表开关 → wechatStdioMcpSpec('agy') → setupAgyGlobalMcp 写的文件 → 用文件里的 env 起子进程 → tools/list。
  describe('agy static MCP config follows agy\'s reply-delivery mode', () => {
    afterEach(() => setReplyDeliveryOverrides(undefined))
    const REPLY_FAMILY = ['reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast', 'send_sticker', 'search_online_sticker', 'send_online_sticker_candidate']

    async function toolsFromAgyEntry(geminiDir: string, port: number, tokenFilePath: string): Promise<string[]> {
      setupAgyGlobalMcp({ wechatSpec: wechatStdioMcpSpec({ baseUrl: `http://127.0.0.1:${port}`, tokenFilePath }, 'agy'), mintToken: () => 'agy-static-tok', geminiConfigDir: geminiDir, log: () => {} })
      const entry = JSON.parse(readFileSync(join(geminiDir, 'mcp_config.json'), 'utf8')).mcpServers[AGY_WECHAT_MCP_NAMESPACE_ID] as { args: string[]; env: Record<string, string> }
      const baseEnv = { ...process.env as Record<string, string> }
      delete baseEnv.WECHAT_REPLY_DELIVERY
      delete baseEnv.WECHAT_SESSION_TIER
      delete baseEnv.WECHAT_SESSION_TOKEN
      const transport = new StdioClientTransport({ command: RUNTIME, args: entry.args, env: { ...baseEnv, ...entry.env }, stderr: 'pipe' })
      const c = new Client({ name: 'agy-static-int', version: '0.0.1' }, { capabilities: {} })
      await c.connect(transport)
      try { return (await c.listTools()).tools.map(t => t.name) } finally { await c.close() }
    }

    it('daemon ⇒ the file carries WECHAT_REPLY_DELIVERY=daemon and the child hides the reply family; legacy again ⇒ rewritten, reply tools back', async () => {
      api = createInternalApi({ stateDir, daemonPid: 7777 })
      const { port, tokenFilePath } = await api.start()
      const geminiDir = join(stateDir, 'gemini-config')

      setReplyDeliveryOverrides({ agy: 'daemon' })
      const daemonTools = await toolsFromAgyEntry(geminiDir, port, tokenFilePath)
      const written = JSON.parse(readFileSync(join(geminiDir, 'mcp_config.json'), 'utf8')).mcpServers[AGY_WECHAT_MCP_NAMESPACE_ID]
      expect(written.env).toMatchObject({ WECHAT_REPLY_DELIVERY: 'daemon', WECHAT_SESSION_TIER: 'trusted', WECHAT_PARTICIPANT_TAG: 'agy' })
      for (const t of REPLY_FAMILY) expect(daemonTools).not.toContain(t)
      for (const t of ['voice', 'sticker', 'attach_file']) expect(daemonTools).toContain(t)
      expect(daemonTools).not.toContain('message') // 钉死 trusted:没有往别处发的工具
      expect(daemonTools).toContain('sticker_feedback')

      setReplyDeliveryOverrides({ agy: 'legacy' })
      const legacyTools = await toolsFromAgyEntry(geminiDir, port, tokenFilePath)
      expect(JSON.parse(readFileSync(join(geminiDir, 'mcp_config.json'), 'utf8')).mcpServers[AGY_WECHAT_MCP_NAMESPACE_ID].env.WECHAT_REPLY_DELIVERY).toBeUndefined()
      for (const t of ['reply', 'reply_voice', 'send_sticker']) expect(legacyTools).toContain(t)
      for (const t of ['voice', 'attach_file']) expect(legacyTools).not.toContain(t)
    })
  })

  // 回复交付第 3 步(2026-10-03):Cursor 的 wechat MCP 是**逐会话**注入的(session/new 的 mcpServers,带会话令牌与 tier)。
  // 完整链:能力表开关 → wechatStdioMcpSpec('cursor') → acpMcpServersFor(会话 env)→ 用那份 env 起子进程 → tools/list。
  // owner 会话是 admin ⇒ daemon 下另有往别处发的 message。
  describe('cursor per-session MCP follows cursor\'s reply-delivery mode', () => {
    afterEach(() => setReplyDeliveryOverrides(undefined))
    const REPLY_FAMILY = ['reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast', 'send_sticker', 'search_online_sticker', 'send_online_sticker_candidate']

    async function toolsForCursorSession(port: number, tokenFilePath: string): Promise<{ tools: string[]; env: Record<string, string> }> {
      const spec = wechatStdioMcpSpec({ baseUrl: `http://127.0.0.1:${port}`, tokenFilePath }, 'cursor')
      const [entry] = acpMcpServersFor({ wechat: spec, delegate: null }, { WECHAT_SESSION_TOKEN: 'cursor-session-tok', WECHAT_SESSION_TIER: 'admin' })
      const env = Object.fromEntries(entry!.env.map(e => [e.name, e.value]))
      const baseEnv = { ...process.env as Record<string, string> }
      delete baseEnv.WECHAT_REPLY_DELIVERY
      delete baseEnv.WECHAT_SESSION_TIER
      delete baseEnv.WECHAT_SESSION_TOKEN
      // command 用 RUNTIME(源码模式下 spec.command 是 process.execPath,node 跑测试时不是 bun)。
      const transport = new StdioClientTransport({ command: RUNTIME, args: entry!.args, env: { ...baseEnv, ...env }, stderr: 'pipe' })
      const c = new Client({ name: 'cursor-session-int', version: '0.0.1' }, { capabilities: {} })
      await c.connect(transport)
      try { return { tools: (await c.listTools()).tools.map(t => t.name), env } } finally { await c.close() }
    }

    it('daemon ⇒ session/new env carries WECHAT_REPLY_DELIVERY=daemon and the child hides the reply family (admin keeps message); legacy ⇒ reply tools back', async () => {
      api = createInternalApi({ stateDir, daemonPid: 7777 })
      const { port, tokenFilePath } = await api.start()

      setReplyDeliveryOverrides({ cursor: 'daemon' })
      const daemon = await toolsForCursorSession(port, tokenFilePath)
      expect(daemon.env).toMatchObject({ WECHAT_REPLY_DELIVERY: 'daemon', WECHAT_PARTICIPANT_TAG: 'cursor', WECHAT_SESSION_TIER: 'admin' })
      for (const t of REPLY_FAMILY) expect(daemon.tools).not.toContain(t)
      for (const t of ['voice', 'sticker', 'attach_file', 'message', 'sticker_feedback']) expect(daemon.tools).toContain(t)

      setReplyDeliveryOverrides({ cursor: 'legacy' })
      const legacy = await toolsForCursorSession(port, tokenFilePath)
      expect(legacy.env.WECHAT_REPLY_DELIVERY).toBeUndefined()
      for (const t of ['reply', 'reply_voice', 'send_sticker']) expect(legacy.tools).toContain(t)
      for (const t of ['voice', 'attach_file', 'message']) expect(legacy.tools).not.toContain(t)
    })
  })

  // 回复交付第 4 步(2026-10-03):Codex 的 wechat MCP 是 provider 构造时给的 spec,**每次 spawn** 把会话 env
  // (令牌 + tier)合进去,再经 SDK 的 config(mcp_servers.wechat.*)交给 codex exec。
  // 完整链:能力表开关 → wechatStdioMcpSpec('codex') → createCodexAgentProvider.spawn(会话 env)→ 交给 Codex 构造的 config
  // → 用那份 command / args / env 起子进程 → tools/list。owner 会话是 admin ⇒ daemon 下另有往别处发的 message。
  describe('codex per-spawn MCP config follows codex\'s reply-delivery mode', () => {
    afterEach(() => setReplyDeliveryOverrides(undefined))
    const REPLY_FAMILY = ['reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast', 'send_sticker', 'search_online_sticker', 'send_online_sticker_candidate']

    async function toolsForCodexSession(port: number, tokenFilePath: string): Promise<{ tools: string[]; env: Record<string, string> }> {
      const { createCodexAgentProvider } = await import('../../core/codex-agent-provider')
      const { createScriptedCodex } = await import('../../core/codex-scripted')
      const { TIER_PROFILES } = await import('../../core/user-tier')
      const scripted = createScriptedCodex({ turns: [] })
      const spec = wechatStdioMcpSpec({ baseUrl: `http://127.0.0.1:${port}`, tokenFilePath }, 'codex')
      const provider = createCodexAgentProvider({ codexFactory: scripted.factory, mcpServers: { wechat: spec } })
      await provider.spawn({ alias: 'a', path: stateDir }, {
        tierProfile: TIER_PROFILES.admin, permissionMode: 'dangerously', chatId: 'o9owner@im.wechat',
        mcpEnv: { WECHAT_SESSION_TOKEN: 'codex-session-tok', WECHAT_SESSION_TIER: 'admin' },
      })
      // 最后一次构造是 spawn 的那个 Codex(第一次是 cheapEval 的,没有 config)。
      const config = scripted.constructed[scripted.constructed.length - 1]!.config as { mcp_servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }
      const entry = config.mcp_servers.wechat!
      const baseEnv = { ...process.env as Record<string, string> }
      delete baseEnv.WECHAT_REPLY_DELIVERY
      delete baseEnv.WECHAT_SESSION_TIER
      delete baseEnv.WECHAT_SESSION_TOKEN
      // command 用 RUNTIME(源码模式下 spec.command 是 process.execPath,node 跑测试时不是 bun)。
      const transport = new StdioClientTransport({ command: RUNTIME, args: entry.args, env: { ...baseEnv, ...entry.env }, stderr: 'pipe' })
      const c = new Client({ name: 'codex-session-int', version: '0.0.1' }, { capabilities: {} })
      await c.connect(transport)
      try { return { tools: (await c.listTools()).tools.map(t => t.name), env: entry.env } } finally { await c.close() }
    }

    it('daemon ⇒ spawn 的 config 带 WECHAT_REPLY_DELIVERY=daemon + 会话令牌,子进程不注册 reply 族(admin 有 message);legacy ⇒ reply 工具回来', async () => {
      api = createInternalApi({ stateDir, daemonPid: 7777 })
      const { port, tokenFilePath } = await api.start()

      setReplyDeliveryOverrides({ codex: 'daemon' })
      const daemon = await toolsForCodexSession(port, tokenFilePath)
      expect(daemon.env).toMatchObject({ WECHAT_REPLY_DELIVERY: 'daemon', WECHAT_PARTICIPANT_TAG: 'codex', WECHAT_SESSION_TIER: 'admin', WECHAT_SESSION_TOKEN: 'codex-session-tok' })
      for (const t of REPLY_FAMILY) expect(daemon.tools).not.toContain(t)
      for (const t of ['voice', 'sticker', 'attach_file', 'message', 'sticker_feedback']) expect(daemon.tools).toContain(t)

      setReplyDeliveryOverrides({ codex: 'legacy' })
      const legacy = await toolsForCodexSession(port, tokenFilePath)
      expect(legacy.env.WECHAT_REPLY_DELIVERY).toBeUndefined()
      for (const t of ['reply', 'reply_voice', 'send_sticker']) expect(legacy.tools).toContain(t)
      for (const t of ['voice', 'attach_file', 'message']) expect(legacy.tools).not.toContain(t)
    })
  })

  // 回复交付第 5 步(2026-10-03):Claude 的 wechat MCP 是 wire-plugins 开机造的 spec(wechatStdioMcpSpec('claude')),
  // 每次 spawn 由 sdkOptionsForProject 把会话 env(令牌 + tier)合进 SDK 的 mcpServers.wechat。
  // 完整链:能力表开关 → wechatStdioMcpSpec('claude') → wireModelOptions().sdkOptionsForProject(会话 env)→
  // 用那份 command / args / env 起子进程 → tools/list。
  describe('claude per-spawn MCP options follow claude\'s reply-delivery mode', () => {
    afterEach(() => setReplyDeliveryOverrides(undefined))
    const REPLY_FAMILY = ['reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast', 'send_sticker', 'search_online_sticker', 'send_online_sticker_candidate']

    async function toolsForClaudeSession(port: number, tokenFilePath: string): Promise<{ tools: string[]; env: Record<string, string> }> {
      const { wireModelOptions } = await import('../../daemon/bootstrap/wire-model-options')
      const { TIER_PROFILES } = await import('../../core/user-tier')
      const spec = wechatStdioMcpSpec({ baseUrl: `http://127.0.0.1:${port}`, tokenFilePath }, 'claude')
      const { sdkOptionsForProject } = wireModelOptions({ stateDir }, {
        plugins: { wechatStdioForClaude: spec, delegateStdioForClaude: null, pluginMcpForClaude: {} },
        permissionMode: 'dangerously', buildCanUseTool: () => (async () => ({ behavior: 'allow' as const })), claudeBin: undefined,
      })
      const options = sdkOptionsForProject('a', stateDir, TIER_PROFILES.admin, 'o9owner@im.wechat', { WECHAT_SESSION_TOKEN: 'claude-session-tok', WECHAT_SESSION_TIER: 'admin' })
      const entry = (options.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>).wechat!
      const baseEnv = { ...process.env as Record<string, string> }
      delete baseEnv.WECHAT_REPLY_DELIVERY
      delete baseEnv.WECHAT_SESSION_TIER
      delete baseEnv.WECHAT_SESSION_TOKEN
      const transport = new StdioClientTransport({ command: RUNTIME, args: entry.args, env: { ...baseEnv, ...entry.env }, stderr: 'pipe' })
      const c = new Client({ name: 'claude-session-int', version: '0.0.1' }, { capabilities: {} })
      await c.connect(transport)
      try { return { tools: (await c.listTools()).tools.map(t => t.name), env: entry.env } } finally { await c.close() }
    }

    it('daemon(第 5 步起的默认)⇒ 会话的 mcpServers.wechat 带 WECHAT_REPLY_DELIVERY=daemon + 会话令牌,子进程不注册 reply 族(admin 有 message);legacy ⇒ reply 工具回来', async () => {
      api = createInternalApi({ stateDir, daemonPid: 7777 })
      const { port, tokenFilePath } = await api.start()

      const daemon = await toolsForClaudeSession(port, tokenFilePath)
      expect(daemon.env).toMatchObject({ WECHAT_REPLY_DELIVERY: 'daemon', WECHAT_PARTICIPANT_TAG: 'claude', WECHAT_SESSION_TIER: 'admin', WECHAT_SESSION_TOKEN: 'claude-session-tok' })
      for (const t of REPLY_FAMILY) expect(daemon.tools).not.toContain(t)
      for (const t of ['voice', 'sticker', 'attach_file', 'message', 'sticker_feedback']) expect(daemon.tools).toContain(t)

      setReplyDeliveryOverrides({ claude: 'legacy' })
      const legacy = await toolsForClaudeSession(port, tokenFilePath)
      expect(legacy.env.WECHAT_REPLY_DELIVERY).toBeUndefined()
      for (const t of ['reply', 'reply_voice', 'send_sticker']) expect(legacy.tools).toContain(t)
      for (const t of ['voice', 'attach_file', 'message']) expect(legacy.tools).not.toContain(t)
    })
  })
})
