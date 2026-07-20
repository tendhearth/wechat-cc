import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildBootstrap, resolveAdminChatId } from './bootstrap'
import { saveAgentConfig } from '../lib/agent-config'
import { openTestDb } from '../lib/db'
import { makeSeekStore } from '../core/social-seek-store'
import { makeEchoStore } from '../core/social-echo-store'
import { makeChannelStore } from '../core/penpal-channel-store'
import { makeRelayStore } from '../core/social-relay-store'
import { generateKeypair, deriveSharedKey, sealLetter } from '../core/penpal-crypto'
import { TIER_PROFILES } from '../core/user-tier'
import { MANIFEST_FILE } from './plugins/paths'
import type { Access } from '../lib/access'
import type { CompanionConfig } from './companion/config'
import { createInternalApi } from './internal-api'

async function pollFor<T>(fn: () => T | null, tries = 50, gapMs = 10): Promise<T | null> {
  for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, gapMs)) }
  return fn()
}

// Minimal OpenAI-compatible /v1/chat/completions SSE mock. The social disclosure
// gate (a2a-disclosure.ts) calls the registry's cheapEval — the openai provider —
// BEFORE the broker sows a seek row, so a live (non-refused) endpoint returning a
// non-violation verdict is what lets the sync `foraging` row appear.
function serveMockOpenai(content: string): ReturnType<typeof Bun.serve> {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const body = chunk({ role: 'assistant', content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n'
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  })
}

function makeIlinkStub() {
  return {
    sendMessage: vi.fn(),
    sendFile: vi.fn(),
    editMessage: vi.fn(),
    broadcast: vi.fn(),
    sharePage: vi.fn(),
    resurfacePage: vi.fn(),
    setUserName: vi.fn(),
    projects: { list: () => [], switchTo: vi.fn(), add: vi.fn(), remove: vi.fn() },
    companion: {
      enable: vi.fn(),
      disable: vi.fn(),
      status: () => ({
        enabled: false,
        timezone: 'Asia/Shanghai',
        per_project_persona: {},
        personas_available: [],
        triggers: [],
        snooze_until: null,
        pushes_last_24h: 0,
        runs_last_24h: 0,
      }),
      snooze: vi.fn(),
      personaSwitch: vi.fn(),
      triggerAdd: vi.fn(),
      triggerRemove: vi.fn(),
      triggerPause: vi.fn(),
    },
    askUser: vi.fn(),
  }
}

describe('bootstrap', () => {
  it('sdkOptionsForProject returns cwd, wechat stdio mcpServer, canUseTool, systemPrompt', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      // After RFC 03 P1.B B1, wechat MCP is exclusively the stdio server
      // wired via internalApi. Without internalApi the daemon would never
      // expose any wechat tools — that's not a real production code path.
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, '_test')
    expect(opts.cwd).toBe('/p')
    expect(opts.mcpServers).toBeDefined()
    const wechatCfg = opts.mcpServers!['wechat']
    expect(wechatCfg).toBeDefined()
    // Stdio MCP server (renamed from wechat_ipc back to wechat in B1
    // when the legacy in-process server was deleted).
    expect(wechatCfg!.type).toBe('stdio')
    expect(typeof opts.canUseTool).toBe('function')
    // systemPrompt is now the preset+append form (we switched from raw string
    // to avoid SDK ToolSearch deferring MCP tools). Accept string OR preset object.
    const sp = opts.systemPrompt
    const ok = typeof sp === 'string'
      || Array.isArray(sp)
      || (typeof sp === 'object' && sp !== null && (sp as { type?: string }).type === 'preset')
    expect(ok).toBe(true)
    // 15s timeout (vs the 5s default): this is the first buildBootstrap call in
    // the file, so it bears one-time cold-import cost (SDK + MCP spec assembly)
    // that intermittently exceeds 5s on slow Windows CI runners. See the
    // 2026-06-03 windows-latest flake.
  }, 15_000)

  it('resolve uses projects.current', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(b.resolve('anyone')).toEqual({ alias: 'P', path: '/p' })
  })

  // Task 13: sdkOptionsForProject body migrated from
  // `if (dangerouslySkipPermissions) bypassPermissions; else default+canUseTool`
  // to tier-driven via tierProfileToClaudeSdkOpts(tierProfile). The
  // dangerouslySkipPermissions flag now influences which tier is resolved
  // (via the makeCanUseTool closure), not the SDK options shape directly.
  // canUseTool is now always wired — under bypassPermissions the SDK simply
  // never fires it.
  it('admin tier produces bypassPermissions (matches the legacy --dangerously path)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      dangerouslySkipPermissions: true,
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, '_test')
    expect(opts.permissionMode).toBe('bypassPermissions')
    // Task 13 — canUseTool wired even at admin tier; SDK won't fire it under
    // bypassPermissions, but production code paths should not rely on that.
    expect(typeof opts.canUseTool).toBe('function')
  })

  it('trusted tier produces permissionMode=default + canUseTool (no disallowedTools — relays via canUseTool)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      dangerouslySkipPermissions: false,
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.trusted, '_test')
    expect(opts.permissionMode).toBe('default')
    expect(typeof opts.canUseTool).toBe('function')
    // Trusted's relay set is shell_destructive/memory_delete — both gated
    // by canUseTool input inspection, not via disallowedTools.
    expect(opts.disallowedTools).toBeUndefined()
  })

  it('guest tier produces permissionMode=default + disallowedTools + canUseTool', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      dangerouslySkipPermissions: false,
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.guest, '_test')
    expect(opts.permissionMode).toBe('default')
    expect(typeof opts.canUseTool).toBe('function')
    // Guest denies fs_write / shell / network / subagent — the SDK sees the
    // built-in names in disallowedTools (mcp__wechat__* gates inside canUseTool).
    expect(Array.isArray(opts.disallowedTools)).toBe(true)
    expect(opts.disallowedTools).toContain('Bash')
    expect(opts.disallowedTools).toContain('Write')
    expect(opts.disallowedTools).toContain('Edit')
  })

  it('defaults dangerouslySkipPermissions to false when omitted (strict mode → default+canUseTool)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    // RFC 05: when daemon was NOT launched --dangerously, sdkOptionsForProject
    // returns `default + canUseTool` regardless of tier — destructive ops
    // get gated via the relay inside canUseTool, not by SDK-level bypass.
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, '_test')
    expect(opts.permissionMode).toBe('default')
    expect(typeof opts.canUseTool).toBe('function')
  })

  it('defaults to the Claude agent provider', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(b.agentProviderKind).toBe('claude')
  })

  it('can select the Codex agent provider explicitly', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      agentProviderKind: 'codex',
    })
    expect(b.agentProviderKind).toBe('codex')
  })

  it('reads provider selection from agent-config.json', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wechat-bootstrap-'))
    try {
      saveAgentConfig(stateDir, { provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false })
      const b = await buildBootstrap({
      db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(b.agentProviderKind).toBe('codex')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  // ── RFC 03 review #12 — registry / coordinator wiring coverage ────────

  it('registers BOTH claude and codex providers regardless of default (RFC 03 P2)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      agentProviderKind: 'claude',
    })
    // P2 design: even when default is claude, codex is also registered
    // so /codex slash command works without daemon restart.
    // Cursor only registers when CURSOR_API_KEY is set + @cursor/sdk
    // imports; in this test env CURSOR_API_KEY is unset so the list
    // remains ['claude', 'codex'].
    expect(b.registry.list().sort()).toEqual(['claude', 'codex'])
    expect(b.registry.has('claude')).toBe(true)
    expect(b.registry.has('codex')).toBe(true)
  })

  // Cursor registration is gated on CURSOR_API_KEY + the @cursor/sdk
  // dynamic import succeeding. Both must hold; either missing → silent
  // skip with [BOOT] log entry. See bootstrap/index.ts cursor block.
  it('registers cursor provider when CURSOR_API_KEY is set + cursorModel configured + @cursor/sdk available', async () => {
    const prevKey = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'test-cursor-key'
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-cursor-'))
    saveAgentConfig(stateDir, {
      provider: 'cursor',
      cursorModel: 'composer-2',
      dangerouslySkipPermissions: false,
      autoStart: false,
      closeStopsDaemon: false,
    })
    try {
      const b = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(b.registry.list()).toContain('cursor')
      expect(b.registry.has('cursor')).toBe(true)
    } finally {
      if (prevKey === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = prevKey
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('does NOT register cursor when CURSOR_API_KEY is set but cursorModel is missing — Cursor SDK requires model for local agents', async () => {
    const prevKey = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'test-cursor-key'
    const logEntries: Array<{ tag: string; line: string }> = []
    try {
      const b = await buildBootstrap({
        db: openTestDb(),
        stateDir: '/tmp/state',  // no agent-config.json → cursorModel undefined
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: (tag, line) => { logEntries.push({ tag, line }) },
      })
      expect(b.registry.list()).not.toContain('cursor')
      const boot = logEntries.filter(e => e.tag === 'BOOT' && e.line.includes('cursor'))
      expect(boot.some(e => e.line.includes('cursorModel is not configured'))).toBe(true)
    } finally {
      if (prevKey === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = prevKey
    }
  })

  it('skips cursor registration when CURSOR_API_KEY is unset', async () => {
    const prevKey = process.env.CURSOR_API_KEY
    delete process.env.CURSOR_API_KEY
    try {
      const b = await buildBootstrap({
        db: openTestDb(),
        stateDir: '/tmp/state',
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(b.registry.list()).not.toContain('cursor')
    } finally {
      if (prevKey !== undefined) process.env.CURSOR_API_KEY = prevKey
    }
  })

  // openai-compatible registration is gated on WECHAT_OPENAI_API_KEY +
  // openaiBaseUrl + openaiModel all being present. See bootstrap/index.ts
  // openai block.
  it('registers openai provider when WECHAT_OPENAI_API_KEY + openaiBaseUrl + openaiModel are all set', async () => {
    const prevKey = process.env.WECHAT_OPENAI_API_KEY
    process.env.WECHAT_OPENAI_API_KEY = 'test-openai-key'
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-openai-'))
    saveAgentConfig(stateDir, {
      provider: 'openai',
      openaiBaseUrl: 'https://api.deepseek.com/v1',
      openaiModel: 'deepseek-chat',
      dangerouslySkipPermissions: false,
      autoStart: false,
      closeStopsDaemon: false,
    })
    try {
      const b = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(b.registry.list()).toContain('openai')
      expect(b.registry.has('openai')).toBe(true)
    } finally {
      if (prevKey === undefined) delete process.env.WECHAT_OPENAI_API_KEY
      else process.env.WECHAT_OPENAI_API_KEY = prevKey
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('does NOT register openai when WECHAT_OPENAI_API_KEY is set but openaiBaseUrl/openaiModel are missing', async () => {
    const prevKey = process.env.WECHAT_OPENAI_API_KEY
    process.env.WECHAT_OPENAI_API_KEY = 'test-openai-key'
    const logEntries: Array<{ tag: string; line: string }> = []
    try {
      const b = await buildBootstrap({
        db: openTestDb(),
        stateDir: '/tmp/state',  // no agent-config.json → openaiBaseUrl/openaiModel undefined
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: (tag, line) => { logEntries.push({ tag, line }) },
      })
      expect(b.registry.list()).not.toContain('openai')
      const boot = logEntries.filter(e => e.tag === 'BOOT' && e.line.includes('openai'))
      expect(boot.some(e => e.line.includes('not configured'))).toBe(true)
    } finally {
      if (prevKey === undefined) delete process.env.WECHAT_OPENAI_API_KEY
      else process.env.WECHAT_OPENAI_API_KEY = prevKey
    }
  })

  it('skips openai registration when WECHAT_OPENAI_API_KEY is unset', async () => {
    const prevKey = process.env.WECHAT_OPENAI_API_KEY
    delete process.env.WECHAT_OPENAI_API_KEY
    try {
      const b = await buildBootstrap({
        db: openTestDb(),
        stateDir: '/tmp/state',
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(b.registry.list()).not.toContain('openai')
    } finally {
      if (prevKey !== undefined) process.env.WECHAT_OPENAI_API_KEY = prevKey
    }
  })

  it('exposes the conversation coordinator and dispatchDelegate', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(b.coordinator).toBeDefined()
    expect(typeof b.coordinator.dispatch).toBe('function')
    expect(typeof b.coordinator.getMode).toBe('function')
    expect(typeof b.coordinator.setMode).toBe('function')
    expect(typeof b.coordinator.cancel).toBe('function')
    // P4 — dispatchDelegate function present + accepts (peer, prompt, cwd?)
    expect(typeof b.dispatchDelegate).toBe('function')
    expect(b.dispatchDelegate.length).toBeGreaterThanOrEqual(2)
  })

  it('default mode for any chat is solo + agentProviderKind', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      agentProviderKind: 'codex',
    })
    expect(b.coordinator.getMode('any-new-chat')).toEqual({ kind: 'solo', provider: 'codex' })
  })

  it('sdkOptionsForProject wires BOTH wechat AND delegate stdio servers (RFC 03 P4)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, '_test')
    expect(opts.mcpServers!['wechat']).toBeDefined()
    expect(opts.mcpServers!['delegate']).toBeDefined()
    // Delegate child env declares peer=codex (since this is the claude session config).
    const delegate = opts.mcpServers!['delegate'] as { type: string; env?: Record<string, string> }
    expect(delegate.env?.WECHAT_DELEGATE_PEER).toBe('codex')
    expect(delegate.env?.WECHAT_INTERNAL_API).toBe('http://127.0.0.1:0')
    expect(delegate.env?.WECHAT_INTERNAL_TOKEN_FILE).toBe('/tmp/token')
  })

  it('omits stdio mcpServers entirely when internalApi is not wired (no leaks)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      // No internalApi
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, '_test')
    expect(opts.mcpServers).toEqual({})  // Both wechat and delegate skipped.
  })

  // ── Task 13 — resolveAdminChatId + tier-driven relay wiring ───────────

  describe('resolveAdminChatId', () => {
    it('returns companion default_chat_id if it is admin', () => {
      expect(resolveAdminChatId(
        { dmPolicy: 'allowlist', allowFrom: ['x', 'y'], admins: ['x', 'y'] } as Access,
        { default_chat_id: 'x' } as CompanionConfig,
      )).toBe('x')
    })

    it('falls back to admins[0] if default_chat_id is not admin', () => {
      expect(resolveAdminChatId(
        { dmPolicy: 'allowlist', allowFrom: ['x', 'y'], admins: ['y'] } as Access,
        { default_chat_id: 'x' } as CompanionConfig,
      )).toBe('y')
    })

    it('returns null when admins empty', () => {
      expect(resolveAdminChatId(
        { dmPolicy: 'allowlist', allowFrom: ['x'], admins: [] } as Access,
        { default_chat_id: null } as CompanionConfig,
      )).toBeNull()
    })

    it('returns null when admins undefined', () => {
      expect(resolveAdminChatId(
        { dmPolicy: 'allowlist', allowFrom: ['x'] } as Access,
        { default_chat_id: null } as CompanionConfig,
      )).toBeNull()
    })

    it('falls back to admins[0] when companion default_chat_id is null', () => {
      expect(resolveAdminChatId(
        { dmPolicy: 'allowlist', allowFrom: ['a', 'b'], admins: ['a', 'b'] } as Access,
        { default_chat_id: null } as CompanionConfig,
      )).toBe('a')
    })

    it('prefers the initiating chat when it is itself an admin (multi-admin)', () => {
      // Multi-admin install: prompt goes to whichever admin triggered the
      // tool call. Closes the "admins[1+] never see prompts" gap without
      // reintroducing the guest self-approval hole (only admins are
      // allowed to self-approve).
      const access = {
        dmPolicy: 'allowlist',
        allowFrom: ['admin-a', 'admin-b', 'admin-c'],
        admins: ['admin-a', 'admin-b', 'admin-c'],
      } as Access
      const companion = { default_chat_id: null } as CompanionConfig
      expect(resolveAdminChatId(access, companion, 'admin-b')).toBe('admin-b')
      expect(resolveAdminChatId(access, companion, 'admin-c')).toBe('admin-c')
    })

    it('routes non-admin initiator to default_chat_id / admins[0]', () => {
      // Guest/trusted initiating chat MUST NOT self-approve. Falls
      // through to companion.default_chat_id (if admin) or admins[0].
      const access = {
        dmPolicy: 'allowlist',
        allowFrom: ['guest-x', 'admin-a', 'admin-b'],
        admins: ['admin-a', 'admin-b'],
      } as Access
      expect(resolveAdminChatId(
        access,
        { default_chat_id: 'admin-b' } as CompanionConfig,
        'guest-x',
      )).toBe('admin-b')
      expect(resolveAdminChatId(
        access,
        { default_chat_id: null } as CompanionConfig,
        'guest-x',
      )).toBe('admin-a')
    })
  })

  it('buildInstructions is the prompt-builder output (mentions delegate_codex for claude sessions)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    // Prompt assembly now lives in the single provider-agnostic buildInstructions
    // thunk (SessionManager calls it per spawn). The big things the v0.x prompt
    // missed — verify they're now in.
    const prompt = b.buildInstructions('claude', TIER_PROFILES.admin, '_test')
    expect(prompt).toContain('delegate_codex')
    expect(prompt).toContain('share_page')
    expect(prompt).toContain('broadcast')
    expect(prompt).toContain('chatroom_round')
    // Admin tier → the self-heal section is present; the codex peer gets a
    // claude-peer prompt without the delegate_codex tool name.
    expect(prompt).toContain('自我诊断')
    // No careLevelFor wired in this bootstrap → care section never included,
    // regardless of chatId (proactive-care design §7 opt-in-only invariant).
    expect(prompt).not.toContain('set_chat_pref')
    const codexPrompt = b.buildInstructions('codex', TIER_PROFILES.admin, '_test')
    expect(codexPrompt).not.toContain('delegate_codex')
    expect(codexPrompt).toContain('delegate_claude')
    // cursor's session IS wired with a delegate-claude child (bootstrap builds
    // delegateStdioForCursor), so its prompt must advertise delegate_claude —
    // peer + availability now both derive from ProviderCapabilities.defaultPeer,
    // not the old 2-provider ternary that wrongly left cursor delegate-silent.
    expect(b.buildInstructions('cursor', TIER_PROFILES.admin, '_test')).toContain('delegate_claude')

    // sdkOptionsForProject just forwards whatever appendInstructions it's given
    // into the SDK preset+append slot — no assembly of its own.
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, '_test', undefined, 'SEAM-PROMPT')
    const sp = opts.systemPrompt as { type: 'preset'; preset: string; append?: string } | string
    if (typeof sp === 'string') throw new Error('expected preset+append form')
    expect(sp.type).toBe('preset')
    expect(sp.append).toBe('SEAM-PROMPT')
  })

  it('buildInstructions includes the care section only for chats whose careLevelFor is not off (proactive-care design §7)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      careLevelFor: (chatId: string) => (chatId === 'owner-chat' ? 'low' : 'off'),
    })
    const carePrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(carePrompt).toContain('agenda.md')
    expect(carePrompt).toContain('set_chat_pref')
    const noCarePrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'guest-chat')
    expect(noCarePrompt).not.toContain('set_chat_pref')
  })

  it('buildInstructions hides the care section for GUEST-tier chats even when careLevelFor is on, since guests cannot author agenda.md/set_chat_pref (memory_write denied) (proactive-care M1)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      careLevelFor: () => 'high',
    })
    const guestPrompt = b.buildInstructions('claude', TIER_PROFILES.guest, 'owner-chat')
    expect(guestPrompt).not.toContain('set_chat_pref')
    expect(guestPrompt).not.toContain('主动关心（agenda.md）')
    const trustedPrompt = b.buildInstructions('claude', TIER_PROFILES.trusted, 'owner-chat')
    expect(trustedPrompt).toContain('set_chat_pref')
    const adminPrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(adminPrompt).toContain('set_chat_pref')
  })

  it('buildInstructions includes the sticker section only for chats whose stickerTagsFor returns tags (image-stickers design §5)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      stickerTagsFor: (chatId: string) => (chatId === 'owner-chat' ? ['happy', 'sad'] : []),
    })
    const stickerPrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(stickerPrompt).toContain('send_sticker')
    expect(stickerPrompt).toContain('happy')
    const noStickerPrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'guest-chat')
    expect(noStickerPrompt).not.toContain('send_sticker')
  })

  it('buildInstructions includes the persona section (but not cultivation) when personaFor returns content with cultivate:false (persona design §2)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      personaFor: () => ({ content: '毒舌但温柔', cultivate: false }),
    })
    const prompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(prompt).toContain('毒舌但温柔')
    expect(prompt).not.toContain('人设养成(persona.md)')
  })

  it('buildInstructions includes BOTH the persona section and the persona-cultivation section when personaFor returns cultivate:true (persona design §2)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      personaFor: () => ({ content: '毒舌但温柔', cultivate: true }),
    })
    const prompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(prompt).toContain('毒舌但温柔')
    expect(prompt).toContain('人设养成(persona.md)')
  })

  it('buildInstructions for a GUEST-tier chat still includes the persona section but never the cultivation section (persona is identity, not a capability; cultivation is memory_write-gated like careEnabled)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      personaFor: () => ({ content: '毒舌但温柔', cultivate: true }),
    })
    const guestPrompt = b.buildInstructions('claude', TIER_PROFILES.guest, 'owner-chat')
    // Persona is the agent's identity — every tier speaks in character.
    expect(guestPrompt).toContain('毒舌但温柔')
    // But cultivation instructs memory_write calls, which guest denies —
    // so the heading must be absent even though personaFor said cultivate:true.
    expect(guestPrompt).not.toContain('人设养成(persona.md)')
  })

  it('buildInstructions is byte-identical whether or not other bootstraps wire personaFor, when this bootstrap omits it (persona design §2 inert default)', async () => {
    const withoutPersonaDep = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const withUndefinedPersona = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      personaFor: () => ({}),
    })
    const promptA = withoutPersonaDep.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    const promptB = withUndefinedPersona.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(promptA).toBe(promptB)
    expect(promptA).not.toContain('你的人设(persona)')
    expect(promptA).not.toContain('人设养成(persona.md)')
  })

  it('buildInstructions includes the core-memory section when coreMemoryFor returns content (core-memory-injection design)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      coreMemoryFor: () => '张三是产品经理，在做一个陪伴 app',
    })
    const prompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(prompt).toContain('张三是产品经理，在做一个陪伴 app')
    expect(prompt).toContain('核心记忆')
  })

  it('buildInstructions includes the knowledge-memory section when knowledgeMemoryFor returns content (knowledge-distillation design D1)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      knowledgeMemoryFor: () => '## 你的社交状态（算出来的，非主观）\n\n**未了义务**\n- 帮张三改简历',
    })
    const prompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(prompt).toContain('算出来的事实')
    expect(prompt).toContain('帮张三改简历')
    // absent thunk ⇒ section omitted
    const b2 = await buildBootstrap({
      db: openTestDb(), stateDir: '/tmp/state', ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }), lastActiveChatId: () => null,
      log: () => {}, internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    expect(b2.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')).not.toContain('算出来的事实')
  })

  it('buildInstructions is byte-identical whether or not other bootstraps wire coreMemoryFor, when this bootstrap omits it (core-memory-injection design inert default)', async () => {
    const withoutCoreMemoryDep = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const withUndefinedCoreMemory = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      coreMemoryFor: () => '',
    })
    const promptA = withoutCoreMemoryDep.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    const promptB = withUndefinedCoreMemory.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(promptA).toBe(promptB)
    expect(promptA).not.toContain('核心记忆')
  })

  it('buildInstructions includes the knowledge-orchestration section when a KNOWN_KNOWLEDGE_PLUGINS entry (wxsearch) is loaded+enabled from bundledPluginsDir (knowledge-orchestration design Task 2)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bootstrap-knowledge-'))
    const bundledDir = join(base, 'bundled')
    const pluginDir = join(bundledDir, 'wxsearch')
    mkdirSync(pluginDir, { recursive: true })
    // process.execPath is absolute + always present on every platform, so the
    // plugin resolves ready (mirrors registry.test.ts's `good()` fixture, and
    // is cross-platform — Windows has no /bin/sh) — bundled defaults enabled.
    writeFileSync(join(pluginDir, MANIFEST_FILE), JSON.stringify({
      name: 'wxsearch',
      kind: 'mcp',
      spawn: { command: process.execPath, args: [] },
    }))
    const prevBundledDir = process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
    process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = bundledDir
    try {
      const b = await buildBootstrap({
        db: openTestDb(),
        stateDir: base,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      const prompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
      expect(prompt).toContain('知识编排')
      expect(prompt).toContain('消息检索')
    } finally {
      if (prevBundledDir === undefined) delete process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
      else process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = prevBundledDir
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('buildInstructions omits the knowledge-orchestration section when no knowledge plugin is loaded (stateDir has none)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    const prompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(prompt).not.toContain('知识编排')
  })

  it('buildInstructions includes the new-relationship section for a fresh chat at trusted+ tier when newRelationshipFor returns true (onboarding-curiosity design §2)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      newRelationshipFor: (chatId: string) => chatId === 'fresh-chat',
    })
    const trustedPrompt = b.buildInstructions('claude', TIER_PROFILES.trusted, 'fresh-chat')
    expect(trustedPrompt).toContain('刚认识')
    const adminPrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'fresh-chat')
    expect(adminPrompt).toContain('刚认识')
  })

  it('buildInstructions hides the new-relationship section for GUEST-tier chats even when newRelationshipFor is true, since guests cannot write memory (onboarding-curiosity design §2, mirrors proactive-care M1)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      newRelationshipFor: () => true,
    })
    const guestPrompt = b.buildInstructions('claude', TIER_PROFILES.guest, 'fresh-chat')
    expect(guestPrompt).not.toContain('刚认识')
  })

  it('buildInstructions omits the new-relationship section when newRelationshipFor returns false (old chat past the message-count threshold)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      newRelationshipFor: () => false,
    })
    const prompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'old-chat')
    expect(prompt).not.toContain('刚认识')
  })

  it('buildInstructions includes the empty-persona nudge when personaFor returns empty content and cultivate:true (onboarding-curiosity design §2)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      personaFor: () => ({ content: '', cultivate: true }),
    })
    const prompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(prompt).toContain('人设养成(persona.md)')
    expect(prompt).toContain('现在还是空的')
  })

  it('buildInstructions omits the empty-persona nudge when personaFor returns non-empty content, even with cultivate:true', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      personaFor: () => ({ content: '毒舌但温柔', cultivate: true }),
    })
    const prompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(prompt).toContain('人设养成(persona.md)')
    expect(prompt).not.toContain('现在还是空的')
  })

  it('buildInstructions includes the bubble-replies section when bubbleRepliesFor returns true (bubble-replies design)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      bubbleRepliesFor: (chatId: string) => chatId === 'split-on-chat',
    })
    const prompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'split-on-chat')
    expect(prompt).toContain('气泡式回复')
    const otherPrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'other-chat')
    expect(otherPrompt).not.toContain('气泡式回复')
  })

  it('buildInstructions omits the bubble-replies section when bubbleRepliesFor returns false, and is byte-identical to the thunk being absent entirely', async () => {
    const depsBase = {
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    }
    const bFalse = await buildBootstrap({ ...depsBase, bubbleRepliesFor: () => false })
    const bAbsent = await buildBootstrap({ ...depsBase })
    const promptFalse = bFalse.buildInstructions('claude', TIER_PROFILES.admin, 'any-chat')
    const promptAbsent = bAbsent.buildInstructions('claude', TIER_PROFILES.admin, 'any-chat')
    expect(promptFalse).not.toContain('气泡式回复')
    expect(promptFalse).toBe(promptAbsent)
  })

  it('buildInstructions includes the bubble-replies section for GUEST-tier chats too — deliberately NO tier gate, since reply is guest-allowed (unlike careEnabled/newRelationship which require memory_write)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      bubbleRepliesFor: () => true,
    })
    const guestPrompt = b.buildInstructions('claude', TIER_PROFILES.guest, 'guest-chat')
    expect(guestPrompt).toContain('气泡式回复')
  })

  // ── Per-session canUseTool (concurrent-dispatch tier hazard) ─────────
  //
  // Before this fix, the canUseTool closure was built ONCE at bootstrap
  // and read `deps.lastActiveChatId()` per call — a process-wide ref
  // updated by mw-capture-ctx on every inbound. Under concurrent
  // dispatch (chat A mid-turn while chat B sends an inbound), the
  // lastActiveChatId could flip to B's id between when A initiated a
  // tool call and when canUseTool fired — cross-resolving A's tier as
  // B's. The fix threads chatId through sdkOptionsForProject so each
  // spawn builds its own canUseTool with chatId baked in.
  //
  // We can't easily exercise the SDK's canUseTool callback without a
  // full Options-execution harness, so the test verifies closure
  // identity + invokes the canUseTool functions directly.
  it('per-session canUseTool: each chatId gets its own closure (no shared identity)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => null,
      log: () => {},
      dangerouslySkipPermissions: false,
    })

    const optsA = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, 'chatA')
    const optsB = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.guest, 'chatB')

    // Each spawn gets its OWN canUseTool — not the same instance. Pre-fix
    // it was a single bootstrap-time closure shared across all sessions;
    // post-fix sdkOptionsForProject builds one per call so the chatId
    // bound into resolveTier/mode is per-session.
    expect(optsA.canUseTool).toBeDefined()
    expect(optsB.canUseTool).toBeDefined()
    expect(optsA.canUseTool).not.toBe(optsB.canUseTool)
  })

  it('per-session canUseTool: guest chatId resolves guest tier even when lastActiveChatId flips to admin', async () => {
    // The hazard scenario, demonstrated:
    //   1. Daemon spawns canUseTool for chatB (guest)
    //   2. Process-wide lastActiveChatId flips to chatA (admin) — happens
    //      whenever any inbound arrives on chatA mid-turn
    //   3. chatB's canUseTool fires; pre-fix it would read
    //      lastActiveChatId → chatA → resolve as admin → would have
    //      auto-allowed a destructive tool the guest matrix forbids
    //
    // Post-fix the chatId is baked in at spawn time, so step 3 still
    // sees chatB and resolves guest tier (Bash → deny per TIER_PROFILES.guest.deny).
    let lastActive: string | null = 'chatB'
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => lastActive,
      log: () => {},
      dangerouslySkipPermissions: false,
    })

    const optsB = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.guest, 'chatB')

    // Simulate the race: chatA's inbound flips lastActiveChatId mid-turn.
    lastActive = 'chatA'

    const ctl = new AbortController()
    const result = await optsB.canUseTool!('Bash', { command: 'rm -rf /' }, {
      signal: ctl.signal,
      suggestions: [],
      toolUseID: 't1',
    } as any)

    // The only way result.behavior could be 'allow' here is if chatB's
    // closure read lastActiveChatId (= chatA) and resolved admin instead
    // of being bound to its own chatId. The deny proves the binding holds.
    expect(result.behavior).toBe('deny')
  })
})

// ── Agent-social M1 wiring (T7b-core) ─────────────────────────────────────
// onIntent/onReveal are only wired into the a2a server — and
// bootstrap.social only constructed — when BOTH social_enabled and
// social_disclosure_policy are configured. See
// docs/superpowers/specs/2026-07-12-agent-social-m1-intent-brokering-design.md
// and src/daemon/bootstrap.a2a.test.ts for the sibling a2a-wiring pattern
// this mirrors (real a2a_listen on a fixed test port, agent.json capability
// assertions).
describe('bootstrap agent-social M1 wiring', () => {
  it('wires onIntent/onReveal + boot.social when social_enabled + social_disclosure_policy are BOTH configured', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-on-'))
    const port = 19901
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      // The a2a server advertises the social capabilities only when
      // onIntent/onReveal were actually passed to createA2AServer.
      const card = await (await fetch(`http://127.0.0.1:${port}/.well-known/agent.json`)).json() as {
        capabilities: Array<{ name: string }>
      }
      expect(card.capabilities.some(c => c.name === 'intent')).toBe(true)
      // The broker + revealer + pledgeStore are exposed on the bootstrap
      // return so main.ts can late-bind them into internal-api (setSocial).
      expect(boot.social).toBeDefined()
      expect(typeof boot.social!.broker.seek).toBe('function')
      expect(typeof boot.social!.revealer.revealEcho).toBe('function')
      expect(typeof boot.social!.pledgeStore.list).toBe('function')
      expect(card.capabilities.some(c => c.name === 'reveal')).toBe(true)
      // Task 11: correspondent + letter relay wired — boot.social.penpal AND
      // the top-level boot.penpal (what the "回信" dispatch seam in
      // pipeline-deps.ts actually reads) both expose sendLetter.
      expect(typeof boot.social!.penpal.sendLetter).toBe('function')
      expect(typeof boot.penpal?.sendLetter).toBe('function')
      expect(card.capabilities.some(c => c.name === 'letter')).toBe(true)
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('exposes seekStore + echoStore on boot.social', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-stores-'))
    const port = 19905
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(typeof boot.social!.seekStore.list).toBe('function')
      expect(typeof boot.social!.echoStore.listAll).toBe('function')
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  // spec #2 forwarding-hop — the forwarder + relay reconciler are wired into
  // the daemon. Scoped to the intermediary surface (the full S→W→Q path is the
  // Task 8 e2e): (a) /a2a/reveal accepts a relay leg (relay_token in body)
  // without 400/500 — proves socialOnReveal tries the reconciler first, then
  // falls through; (b) an inbound card at the hop ceiling (hop:2) is TERMINAL —
  // the MatchReceipt carries no `forwarded`, even though a downstream peer is
  // registered (the cap, not empty targets, is what stops the forward). Judge
  // routed through a local openai SSE mock so the answer path is deterministic.
  it('wires the forwarder + relay reconciler: hop:2 is terminal (no forwarded) + /a2a/reveal accepts a relay leg', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-fwd-'))
    const port = 19908
    const openaiMock = serveMockOpenai('{"match":"no"}')
    const prevKey = process.env.WECHAT_OPENAI_API_KEY
    process.env.WECHAT_OPENAI_API_KEY = 'test-openai-key'
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'openai',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
        openaiBaseUrl: `http://127.0.0.1:${openaiMock.port}/v1`,
        openaiModel: 'test-model',
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      const senderKey = 'sender-inbound-key-abc123'   // ≥16 chars (registry rule)
      // The sender S (as W sees it) — authenticates the inbound /a2a/intent.
      boot.a2aDeps.registry.add({
        id: 'ccs', name: '小S', url: 'http://127.0.0.1:1/a2a',
        inbound_api_key: senderKey, outbound_api_key: 'unused',
        capabilities: [], paused: false, transport: 'push',
      })
      // A downstream peer W COULD forward to — present so the terminal assertion
      // isolates the hop cap (not merely an empty target list). Unreachable url;
      // it must NOT be contacted at hop:2.
      boot.a2aDeps.registry.add({
        id: 'ccq', name: '小Q', url: 'http://127.0.0.1:1/a2a',
        inbound_api_key: 'downstream-inbound-key-xyz', outbound_api_key: 'unused-q',
        capabilities: [], paused: false, transport: 'push',
      })

      // (b) hop:2 card → terminal: the receipt has no `forwarded`.
      const intentRes = await fetch(`http://127.0.0.1:${port}/a2a/intent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${senderKey}` },
        body: JSON.stringify({
          agent_id: 'ccs',
          card: {
            intent_id: 'fwd-terminal-1', kind: 'seek', topic: '找摄影搭子', hop: 2,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          },
        }),
      })
      expect(intentRes.status).toBe(200)
      const receipt = await intentRes.json() as { match: string; forwarded?: unknown }
      expect(receipt.match).toBe('no')
      expect(receipt.forwarded).toBeUndefined()

      // (a) a relay leg (relay_token present) → 200, no 400/500. No relay row
      // exists for this token, so the reconciler returns null and the endpoint
      // revealer answers { mutual:false } — the point is the wiring accepts it.
      const revealRes = await fetch(`http://127.0.0.1:${port}/a2a/reveal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${senderKey}` },
        body: JSON.stringify({ agent_id: 'ccs', intent_id: 'fwd-terminal-1', relay_token: 'no-such-token' }),
      })
      expect(revealRes.status).toBe(200)
      expect(await revealRes.json()).toMatchObject({ mutual: false })
    } finally {
      openaiMock.stop()
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
      if (prevKey === undefined) delete process.env.WECHAT_OPENAI_API_KEY
      else process.env.WECHAT_OPENAI_API_KEY = prevKey
    }
  })

  // I1 regression — when the SEEKER reveals FIRST, mutual completes via the
  // inbound /a2a/reveal (onInboundReveal's echo branch), which only holds the
  // peer's agent_id. Reveal crosses a PenpalHandle (pubkey + channel id), NEVER
  // real identity — the masked placeholder is permanent; only the penpal_channel
  // row learns the crossed handle. Driven full-stack through the real
  // a2a-server /a2a/reveal endpoint (the peer has no real handle to present
  // here, so this exercises the "peer presented nothing" path — the channel
  // still opens via the mutual-instant openLocal, non-null on OUR side).
  it('first-revealer echo stays masked and opens a penpal_channel on inbound-completed mutual', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-i1-'))
    const port = 19907
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    const db = openTestDb()
    const ilink = makeIlinkStub()
    ;(ilink.sendMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ msgId: 'm1' })
    try {
      boot = await buildBootstrap({
        db,
        stateDir,
        ilink: ilink as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      // Bind an operator chat so the 'connected' notify beat actually fires,
      // so we can assert its text is content-free (no peer name).
      boot.conversationStore.upsertIdentity('op_chat', { userId: 'op_chat' })
      const peerKey = 'peer-inbound-key-abc123'   // ≥16 chars (registry rule)
      boot.a2aDeps.registry.add({
        id: 'ccb', name: '小B', url: 'http://127.0.0.1:1/a2a',
        inbound_api_key: peerKey, outbound_api_key: 'unused',
        capabilities: [], paused: false, transport: 'push',
      })
      // Seed the seeker-side state: a seek + an echo whose owner ALREADY
      // revealed (self_revealed), still masked, holding the peer's agent_id.
      const intentId = 'seek-i1'
      boot.social!.seekStore.create({ id: intentId, kind: 'seek', topic: '找摄影搭子' })
      boot.social!.echoStore.create({
        id: `${intentId}:ccb`, seekId: intentId, peerMasked: '第 1 度的某人',
        degree: 1, content: '南京摄影爱好者', peerAgentId: 'ccb',
      })
      boot.social!.echoStore.setSelfRevealed(`${intentId}:ccb`, new Date().toISOString())

      // The peer now reveals back over the wire, presenting ITS PenpalHandle
      // (pubkey + channel id) — the reveal transport's ONLY crossing material.
      // No name, ever.
      const peerHandle = { pubkey: generateKeypair().publicKey, channel_id: 'peer-chan-1' }
      const resp = await fetch(`http://127.0.0.1:${port}/a2a/reveal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${peerKey}` },
        body: JSON.stringify({ agent_id: 'ccb', intent_id: intentId, peer_handle: peerHandle }),
      })
      expect(resp.status).toBe(200)
      const respBody = await resp.json() as { mutual: boolean; handle?: { pubkey: string; channel_id: string } }
      expect(respBody.mutual).toBe(true)
      // Content-free: no name, ever — only a pubkey handle may ride along.
      expect(respBody).not.toHaveProperty('peer_name')
      expect(respBody).not.toHaveProperty('identity')

      // The masked placeholder NEVER lifts — reveal crosses pubkeys, not names.
      const echo = boot.social!.echoStore.get(`${intentId}:ccb`)!
      expect(echo.peer_masked).toBe('第 1 度的某人')
      expect(echo.peer_revealed_at).not.toBeNull()
      expect(boot.social!.seekStore.get(intentId)!.status).toBe('connected')

      // A penpal_channel row opened for this echo: OUR minted handle plus the
      // peer's presented handle, crossed and open.
      const channelStore = makeChannelStore(db)
      const channel = channelStore.get(`${intentId}:ccb`)
      expect(channel).not.toBeNull()
      expect(channel!.status).toBe('open')
      expect(channel!.peer_pubkey).toBe(peerHandle.pubkey)
      expect(channel!.peer_channel_id).toBe(peerHandle.channel_id)

      // The 'connected' beat fired to the operator, and it is content-free —
      // no peer name anywhere in the text (小B never appears).
      const sendMessage = ilink.sendMessage as unknown as ReturnType<typeof vi.fn>
      const connectedSends = sendMessage.mock.calls.filter((c: unknown[]) => String(c[1]).includes('接上头'))
      expect(connectedSends).toHaveLength(1)
      expect(String(connectedSends[0]?.[1])).not.toContain('小B')
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('a wired social seek persists a social_seek row', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-record-'))
    const port = 19904
    // registry.getCheapEval() prefers 'openai' over 'claude' (see
    // provider-registry.ts CHEAP_EVAL_PREFERENCE) once an openai-compatible
    // provider is registered — so we point it at a local SSE mock instead of
    // shelling out to a real `claude` subprocess (slow/flaky/CI-unavailable).
    // The broker now GATES the outbound topic via cheapEval *before* sowing
    // the seek row, so the mock must return a non-violation verdict for the
    // `foraging` row to appear (a refused port would fail the gate closed →
    // no sow). discover() returns no peers here, so the background forage
    // settles the row to `closed`.
    const openaiMock = serveMockOpenai('{"violation": false, "redacted": "找个会修老相机的"}')
    const prevKey = process.env.WECHAT_OPENAI_API_KEY
    process.env.WECHAT_OPENAI_API_KEY = 'test-openai-key'
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
        openaiBaseUrl: `http://127.0.0.1:${openaiMock.port}/v1`,
        openaiModel: 'test-model',
      }),
    )
    const db = openTestDb()
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db,
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      // discover() returns no peers in this fixture (no paired a2a agents),
      // so the outcome is empty — sow must STILL persist the seek row
      // (foraging → closed) even when nothing matched.
      await boot.social!.broker.seek('找个会修老相机的')
      // Non-blocking: the sync leg sows `foraging`; the background forage
      // (0 peers here) settles it to `closed`. Poll briefly for the terminal row.
      const seen = await pollFor(() => {
        const rows = db.query('SELECT topic, status FROM social_seek').all() as Array<{ topic: string; status: string }>
        return rows.find(r => r.topic.includes('相机') && (r.status === 'closed' || r.status === 'foraging')) ?? null
      })
      expect(seen).not.toBeNull()
    } finally {
      openaiMock.stop()
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
      if (prevKey === undefined) delete process.env.WECHAT_OPENAI_API_KEY
      else process.env.WECHAT_OPENAI_API_KEY = prevKey
    }
  })

  it('a social seek recording failure does not surface as a rejected/broken seek (throw-safety)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-record-throw-'))
    const port = 19905
    // Gate must PASS (mock returns a non-violation verdict) so the broker
    // reaches its sow leg — the point of this test is that a persistence
    // failure inside sow/finishSeek is swallowed, not that the gate blocks.
    const openaiMock = serveMockOpenai('{"violation": false, "redacted": "找个会修老相机的"}')
    const prevKey = process.env.WECHAT_OPENAI_API_KEY
    process.env.WECHAT_OPENAI_API_KEY = 'test-openai-key'
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
        openaiBaseUrl: `http://127.0.0.1:${openaiMock.port}/v1`,
        openaiModel: 'test-model',
      }),
    )
    const db = openTestDb()
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db,
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      // Drop the table the sow leg writes to AFTER bootstrap has already
      // prepared its statements, so the INSERT inside the broker's sow()
      // throws ("no such table: social_seek") — this simulates a persistence
      // error (locked db / disk full / duplicate PK) without faking those
      // conditions directly. sow/recordEcho/finishSeek each guard their own
      // writes, so a store failure must never turn seek() into a rejection.
      db.exec('DROP TABLE social_seek')
      const out = await boot.social!.broker.seek('找个会修老相机的')
      expect(typeof out.intent_id).toBe('string')   // never rejects; background write failures are swallowed
      expect(out.intent_id.length).toBeGreaterThan(0)
    } finally {
      openaiMock.stop()
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
      if (prevKey === undefined) delete process.env.WECHAT_OPENAI_API_KEY
      else process.env.WECHAT_OPENAI_API_KEY = prevKey
    }
  })

  // M2 — restart-mid-forage must not re-fire the "有回声了" (first_echo) beat.
  // Boot-time resume-scan (bootstrap/index.ts, just after the a2a server
  // starts) re-runs forage() for any social_seek row still `foraging` — a
  // seek whose background leg never reached finishSeek before the process
  // died. The broker's own `e.first` flag is a per-forage-run in-memory
  // counter, so a resumed run that echoes the SAME peer again recomputes
  // `first: true` even though that echo row already exists from before the
  // crash (the recordEcho wiring's dup-PK insert just gets caught and
  // swallowed) — re-notifying the operator about an echo they already saw.
  // seekResume below reproduces exactly that: pre-seeded `foraging` +
  // pre-existing echo row, so its resume forage must NOT fire first_echo.
  // seekFresh is the control: pre-seeded `foraging` with NO echo yet, so its
  // resume forage is a genuine first echo and MUST fire the beat.
  it('resume forage after a restart does not re-fire first_echo for a seek that already has an echo, but does for one that does not', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-resume-'))
    const port = 19909
    const openaiMock = serveMockOpenai('{"violation": false, "redacted": "找搭子"}')
    // Stand-in peer — always answers "yes" to whatever intent it's asked
    // about, echoing the caller's intent_id back so the MatchReceipt parses.
    const peerMock = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        const body = await req.json() as { card: { intent_id: string } }
        return Response.json({ intent_id: body.card.intent_id, match: 'yes', blurb: '摄影爱好者' })
      },
    })
    const prevKey = process.env.WECHAT_OPENAI_API_KEY
    process.env.WECHAT_OPENAI_API_KEY = 'test-openai-key'
    const seekResume = 'seek-resume-dup'    // already has an echo — the restart-duplicate case
    const seekFresh = 'seek-resume-fresh'   // no echo yet — resume's genuine first echo
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
        openaiBaseUrl: `http://127.0.0.1:${openaiMock.port}/v1`,
        openaiModel: 'test-model',
        a2a_agents: [{
          id: 'ccb', name: '小B', url: `http://127.0.0.1:${peerMock.port}/a2a`,
          inbound_api_key: 'peer-inbound-key-abc123', outbound_api_key: 'peer-outbound-key-xyz',
          capabilities: [], paused: false, transport: 'push',
        }],
      }),
    )
    const db = openTestDb()
    // Seed the "crash mid-forage" state directly (bypassing broker.seek's
    // real gate/discover round trip, since we only need the terminal DB
    // state a crashed prior run would have left behind).
    const seekStore = makeSeekStore(db)
    const echoStore = makeEchoStore(db)
    seekStore.create({ id: seekResume, kind: 'seek', topic: '找摄影搭子（续）' })
    echoStore.create({ id: `${seekResume}:ccb`, seekId: seekResume, peerMasked: '第 1 度的某人', degree: 1, content: '之前的回声', peerAgentId: 'ccb' })
    seekStore.create({ id: seekFresh, kind: 'seek', topic: '找摄影搭子（新）' })

    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    const ilink = makeIlinkStub()
    ;(ilink.sendMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ msgId: 'm1' })
    try {
      boot = await buildBootstrap({
        db,
        stateDir,
        ilink: ilink as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      // Bind an operator chat so notify()'s sendAssistantText call actually
      // fires (resolveOperatorChatId reads the earliest `conversations` row).
      boot.conversationStore.upsertIdentity('op_chat', { userId: 'op_chat' })

      // Both resume forages were already scheduled fire-and-forget inside
      // buildBootstrap; wait for both to settle.
      await pollFor(() => (echoStore.listForSeek(seekFresh).length > 0 ? true : null))
      await pollFor(() => (seekStore.get(seekResume)?.status !== 'foraging' ? true : null))
      await pollFor(() => (seekStore.get(seekFresh)?.status !== 'foraging' ? true : null))

      // seekResume's echo count stays at 1 — the resumed recordEcho's insert
      // for the same peer hit the dup-PK guard and was swallowed, as before.
      expect(echoStore.listForSeek(seekResume).length).toBe(1)
      expect(echoStore.listForSeek(seekFresh).length).toBe(1)

      const sendMessage = ilink.sendMessage as unknown as ReturnType<typeof vi.fn>
      const firstEchoSends = sendMessage.mock.calls.filter((c: unknown[]) => String(c[1]).includes('有回声了'))
      // Exactly ONE first_echo beat total: seekFresh's genuine first echo.
      // seekResume's resumed (duplicate) echo must NOT have re-fired it.
      expect(firstEchoSends).toHaveLength(1)
      expect(firstEchoSends[0]?.[0]).toBe('op_chat')
    } finally {
      openaiMock.stop()
      peerMock.stop()
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
      if (prevKey === undefined) delete process.env.WECHAT_OPENAI_API_KEY
      else process.env.WECHAT_OPENAI_API_KEY = prevKey
    }
  })

  it('does NOT wire onIntent/onReveal and boot.social is undefined when social_enabled is absent', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-off-'))
    const port = 19902
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        // social_enabled omitted entirely.
        social_disclosure_policy: '兴趣可说；住址不可',
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      const card = await (await fetch(`http://127.0.0.1:${port}/.well-known/agent.json`)).json() as {
        capabilities: Array<{ name: string }>
      }
      expect(card.capabilities.some(c => c.name === 'intent')).toBe(false)
      expect(card.capabilities.some(c => c.name === 'reveal')).toBe(false)
      expect(boot.social).toBeUndefined()
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('does NOT wire social when social_enabled is true but social_disclosure_policy is absent', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-nopolicy-'))
    const port = 19903
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        // social_disclosure_policy omitted.
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(boot.social).toBeUndefined()
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('claude-default daemon with a plugin selects the grounded judge path (not cheapEval) (grounded-judge Task 2)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bootstrap-grounded-judge-'))
    const bundledDir = join(base, 'bundled')
    const pluginDir = join(bundledDir, 'wxsearch')
    mkdirSync(pluginDir, { recursive: true })
    // Mirrors the knowledge-orchestration fixture (line ~766): process.execPath
    // is absolute + always present, so the plugin resolves ready — bundled
    // defaults enabled — and ends up in bootstrap's `pluginMcp`, which is what
    // the grounded judge needs threaded through as `deps.pluginMcp`.
    writeFileSync(join(pluginDir, MANIFEST_FILE), JSON.stringify({
      name: 'wxsearch',
      kind: 'mcp',
      spawn: { command: process.execPath, args: [] },
    }))
    writeFileSync(
      join(base, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
      }),
    )
    const prevBundledDir = process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
    process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = bundledDir
    const logs: string[] = []
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir: base,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: (_tag, m) => logs.push(m),
      })
      expect(logs.some(m => m.includes('plugin-grounded judge via claude'))).toBe(true)
      expect(logs.some(m => m.includes('falls back to cheapEval'))).toBe(false)
    } finally {
      await boot?.a2aServer?.stop()
      if (prevBundledDir === undefined) delete process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
      else process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = prevBundledDir
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('POST /v1/social/seek returns 503 when the social broker is not wired (deps.social absent)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'internal-api-social-503-'))
    const api = createInternalApi({ stateDir, daemonPid: 1 } as any)
    try {
      const { port } = await api.start()
      // social_seek is admin-tier (route-tiers.ts) — the daemon-wide file
      // token is only 'trusted', so mint an admin-tier session token
      // (mirrors how a real admin-tier MCP child would authenticate).
      const token = api.mintSessionToken('admin', 'test-session')
      const resp = await fetch(`http://127.0.0.1:${port}/v1/social/seek`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ topic: '找摄影搭子' }),
      })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toMatchObject({ error: 'social_not_wired' })
    } finally {
      await api.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  // Task 11 — cross-task dispatch order (flagged in Task 9 review): the
  // inbound /a2a/letter handler MUST try THIS daemon's own channel first
  // (correspondent.receiveLetter, via channelStore.getByMyChannelId) and
  // only fall through to the content-blind relay when that channel_id is
  // NOT one of our own. Each test below drives ONE branch through the real
  // /a2a/letter endpoint and asserts the OTHER branch's effects did not fire.
  it('an inbound letter to OUR OWN open channel decrypts + notifies the owner (not routed)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-letter-own-'))
    const port = 19910
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
      }),
    )
    const db = openTestDb()
    const ilink = makeIlinkStub()
    ;(ilink.sendMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ msgId: 'm1' })
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db,
        stateDir,
        ilink: ilink as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      boot.conversationStore.upsertIdentity('op_chat', { userId: 'op_chat' })
      const peerKey = 'peer-letter-own-key-abc123'
      boot.a2aDeps.registry.add({
        id: 'ccb', name: '小B', url: 'http://127.0.0.1:1/a2a',
        inbound_api_key: peerKey, outbound_api_key: 'unused',
        capabilities: [], paused: false, transport: 'push',
      })
      // Open a real penpal_channel the same way the I1 reveal test does: seed
      // a self-revealed echo, then have the peer reveal back over the wire
      // with a REAL keypair (its private key lets us encrypt a valid letter
      // FROM the peer TO us below, mirroring what the peer's own
      // penpal-correspondent.ts would produce).
      const intentId = 'seek-letter-own'
      boot.social!.seekStore.create({ id: intentId, kind: 'seek', topic: '找摄影搭子' })
      boot.social!.echoStore.create({
        id: `${intentId}:ccb`, seekId: intentId, peerMasked: '第 1 度的某人',
        degree: 1, content: '南京摄影爱好者', peerAgentId: 'ccb',
      })
      boot.social!.echoStore.setSelfRevealed(`${intentId}:ccb`, new Date().toISOString())
      const peerKp = generateKeypair()
      const peerHandle = { pubkey: peerKp.publicKey, channel_id: 'peer-chan-own-1' }
      const revealResp = await fetch(`http://127.0.0.1:${port}/a2a/reveal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${peerKey}` },
        body: JSON.stringify({ agent_id: 'ccb', intent_id: intentId, peer_handle: peerHandle }),
      })
      expect(revealResp.status).toBe(200)
      expect((await revealResp.json() as { mutual: boolean }).mutual).toBe(true)

      const channelStore = makeChannelStore(db)
      const channel = channelStore.get(`${intentId}:ccb`)!
      expect(channel.status).toBe('open')

      // Encrypt a letter AS THE PEER (its private key + our channel's public
      // key — deriveSharedKey is symmetric), addressed to OUR OWN inbound
      // channel_id, exactly as penpal-correspondent.ts's sendLetter would
      // from the peer's side.
      const key = deriveSharedKey(peerKp.privateKey, channel.my_pubkey)
      const sealed = sealLetter(key, '下次约拍风景怎么样?')
      const letterResp = await fetch(`http://127.0.0.1:${port}/a2a/letter`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${peerKey}` },
        body: JSON.stringify({ agent_id: 'ccb', channel_id: channel.my_channel_id, ...sealed }),
      })
      expect(letterResp.status).toBe(200)
      expect(await letterResp.json()).toEqual({ ok: true })

      // Decrypted + persisted locally — the OWN-endpoint path, not relayed.
      const letterRow = db.query('SELECT direction, plaintext FROM penpal_letter WHERE channel_id = ?')
        .get(channel.id) as { direction: string; plaintext: string } | null
      expect(letterRow).not.toBeNull()
      expect(letterRow!.direction).toBe('in')
      expect(letterRow!.plaintext).toBe('下次约拍风景怎么样?')

      // The owner was notified with a decrypted preview; content-free of the
      // peer's real identity — only the masked degree placeholder rides along.
      const sendMessage = ilink.sendMessage as unknown as ReturnType<typeof vi.fn>
      const letterSends = sendMessage.mock.calls.filter((c: unknown[]) => String(c[1]).includes('给你写信了'))
      expect(letterSends).toHaveLength(1)
      expect(String(letterSends[0]?.[1])).toContain('下次约拍风景怎么样')
      expect(String(letterSends[0]?.[1])).toContain(channel.id)
      expect(String(letterSends[0]?.[1])).not.toContain('小B')

      // boot.penpal.sendLetter is present and callable end to end (Task 10's
      // dispatch seam calls exactly this). Exercise it against a channel id
      // that isn't open to prove it's the real correspondent wired in, not a
      // stub — the real correspondent's own not-open guard fires.
      const badReply = await boot.penpal!.sendLetter('no-such-channel', 'hi')
      expect(badReply).toEqual({ ok: false, error: 'channel_not_open' })
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('an inbound letter to a NON-own (relay leg) channel forwards unopened via the content-blind relay (not decrypted, not stored, no owner notify)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-letter-relay-'))
    const port = 19911
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
      }),
    )
    const db = openTestDb()
    const ilink = makeIlinkStub()
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    // Stand-in far endpoint (Q) — captures whatever we (W, the introducer)
    // forward, unopened.
    let forwardedBody: unknown = null
    const peerMock = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        forwardedBody = await req.json()
        return Response.json({ ok: true })
      },
    })
    try {
      boot = await buildBootstrap({
        db,
        stateDir,
        ilink: ilink as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      const senderKey = 'sender-letter-relay-key-abc1'
      // S — the sender, authenticates the inbound POST. Its own url is never
      // contacted in this flow (W only forwards TOWARD the far endpoint).
      boot.a2aDeps.registry.add({
        id: 'ccs', name: '小S', url: 'http://127.0.0.1:1/a2a',
        inbound_api_key: senderKey, outbound_api_key: 'unused-s',
        capabilities: [], paused: false, transport: 'push',
      })
      // Q — the far endpoint W forwards to, registered with the stub's real url.
      boot.a2aDeps.registry.add({
        id: 'ccq', name: '小Q', url: `http://127.0.0.1:${peerMock.port}/a2a`,
        inbound_api_key: 'unused-q-inbound-key123', outbound_api_key: 'w-to-q-outbound-key',
        capabilities: [], paused: false, transport: 'push',
      })
      // A relay leg W (this daemon) brokered earlier (Task 9): S's own inbox
      // is chan-s-relay, Q's own inbox is chan-q-relay. A letter is always
      // addressed by the RECIPIENT's own channel_id (see
      // penpal-correspondent.ts sendLetter), so S writing to Q addresses it
      // to chan-q-relay.
      const relayStore = makeRelayStore(db)
      relayStore.create({ id: 'i1:tok1', intentId: 'i1', relayToken: 'tok1', upstreamAgentId: 'ccs', downstreamAgentId: 'ccq' })
      relayStore.setUpstreamHandle('i1:tok1', { pubkey: 'Spub', channel_id: 'chan-s-relay' })
      relayStore.setDownstreamHandle('i1:tok1', { pubkey: 'Qpub', channel_id: 'chan-q-relay' })

      // Deliberately opaque/garbage ciphertext — W must NEVER attempt to
      // open it (it holds no key for this channel; this proves the relay
      // path, not the correspondent path, handled it).
      const sealed = { nonce: 'NONCE1', ct: 'OPAQUE_CIPHERTEXT_NEVER_DECRYPTED', tag: 'TAG1' }
      const resp = await fetch(`http://127.0.0.1:${port}/a2a/letter`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${senderKey}` },
        body: JSON.stringify({ agent_id: 'ccs', channel_id: 'chan-q-relay', ...sealed }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: true })

      // Forwarded byte-identical + unopened to Q's real endpoint.
      expect(forwardedBody).toMatchObject({ channel_id: 'chan-q-relay', ...sealed })

      // Never touched the correspondent's own-channel path: no penpal_letter
      // row was ever created for this channel_id (content-blind — W never
      // decrypts, and this channel_id isn't one of W's own channels).
      const letterRow = db.query('SELECT id FROM penpal_letter WHERE channel_id = ?').get('chan-q-relay')
      expect(letterRow).toBeNull()

      // No owner notify fired either — notifyInbound (the own-endpoint path)
      // was never entered.
      const sendMessage = ilink.sendMessage as unknown as ReturnType<typeof vi.fn>
      expect(sendMessage.mock.calls.some((c: unknown[]) => String(c[1]).includes('给你写信了'))).toBe(false)
    } finally {
      peerMock.stop()
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

// ── url-less mailbox peer guard (pairing-code Task 3, review IMPORTANT-2) ──
// Making A2AAgentRecord.url optional for transport:'mailbox' lets a url-less
// mailbox peer sit in the registry — that's the whole point of the pairing
// feature (a pure-NAT peer has no public url). But intentUrl/revealUrl both
// open with `agentUrl.replace(...)`, which throws on undefined, and three
// wire-social.ts sites read hand.url unconditionally: broker.discover,
// forwardTargets, and postPeerReveal. Each test below drives ONE of those
// three sites with only a url-less mailbox peer registered and proves the
// peer is cleanly skipped (seek/reveal-over-mailbox deferred, spec §10) —
// not merely that some outer try/catch happened to swallow a throw.
describe('bootstrap agent-social M1 wiring — url-less mailbox peer guard (IMPORTANT-2)', () => {
  const mailboxPeer = {
    id: 'cc-aaaa1111', name: 'Alice', inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o',
    capabilities: [], paused: false, transport: 'mailbox' as const,
    mailbox_addr: 'A', mailbox_enc_pub: 'E', relays: ['https://brain.example/mailbox'],
  }

  it('discover: broker.seek with ONLY a url-less mailbox peer registered never reaches intentUrl(undefined) — peer skipped, seek closes with 0 peers asked', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-guard-discover-'))
    const port = 19912
    const openaiMock = serveMockOpenai(JSON.stringify({ violation: false, redacted: '找摄影搭子' }))
    const prevKey = process.env.WECHAT_OPENAI_API_KEY
    process.env.WECHAT_OPENAI_API_KEY = 'test-openai-key'
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'openai',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
        openaiBaseUrl: `http://127.0.0.1:${openaiMock.port}/v1`,
        openaiModel: 'test-model',
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      boot.a2aDeps.registry.add(mailboxPeer)

      const { intent_id } = await boot.social!.broker.seek('找摄影搭子')
      const row = await pollFor(() => {
        const r = boot!.social!.seekStore.get(intent_id)
        return r && r.status !== 'foraging' ? r : null
      })
      expect(row).not.toBeNull()
      // Closed (no yes echo) with 0 peers asked — proves discover filtered
      // the url-less mailbox peer OUT before any send was attempted, not
      // merely that a throw somewhere was swallowed.
      expect(row!.status).toBe('closed')
      expect(row!.peers_asked).toBe(0)
    } finally {
      openaiMock.stop()
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
      if (prevKey === undefined) delete process.env.WECHAT_OPENAI_API_KEY
      else process.env.WECHAT_OPENAI_API_KEY = prevKey
    }
  })

  it('forwardTargets: an inbound /a2a/intent with ONLY a url-less mailbox peer as a forward target never reaches intentUrl(undefined) — 200, no forward', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-guard-forward-'))
    const port = 19913
    const openaiMock = serveMockOpenai('{"match":"no"}')
    const prevKey = process.env.WECHAT_OPENAI_API_KEY
    process.env.WECHAT_OPENAI_API_KEY = 'test-openai-key'
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'openai',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
        openaiBaseUrl: `http://127.0.0.1:${openaiMock.port}/v1`,
        openaiModel: 'test-model',
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      const senderKey = 'sender-inbound-key-guard1'
      boot.a2aDeps.registry.add({
        id: 'ccs', name: '小S', url: 'http://127.0.0.1:1/a2a',
        inbound_api_key: senderKey, outbound_api_key: 'unused',
        capabilities: [], paused: false, transport: 'push',
      })
      // The ONLY possible forward target is the url-less mailbox peer.
      boot.a2aDeps.registry.add(mailboxPeer)

      const resp = await fetch(`http://127.0.0.1:${port}/a2a/intent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${senderKey}` },
        body: JSON.stringify({
          agent_id: 'ccs',
          card: {
            intent_id: 'guard-fwd-1', kind: 'seek', topic: '找摄影搭子', hop: 1,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          },
        }),
      })
      // No throw (a TypeError deep in forwardTargets/forwardSend would have
      // surfaced as a 500 here).
      expect(resp.status).toBe(200)
      const receipt = await resp.json() as { match: string; forwarded?: unknown }
      // No forward happened — the mailbox peer was filtered out of forwardTargets.
      expect(receipt.forwarded).toBeUndefined()
    } finally {
      openaiMock.stop()
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
      if (prevKey === undefined) delete process.env.WECHAT_OPENAI_API_KEY
      else process.env.WECHAT_OPENAI_API_KEY = prevKey
    }
  })

  it('postPeerReveal: revealEcho against a url-less mailbox peer never reaches revealUrl(undefined) — short-circuits to peer_unreachable, no throw', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-social-guard-reveal-'))
    const port = 19914
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      boot.a2aDeps.registry.add(mailboxPeer)

      // Seed an echo whose peer is the url-less mailbox peer — revealEcho's
      // postPeerReveal call is the site under test.
      const intentId = 'guard-reveal-1'
      const echoId = `${intentId}:${mailboxPeer.id}`
      boot.social!.seekStore.create({ id: intentId, kind: 'seek', topic: '找摄影搭子' })
      boot.social!.echoStore.create({
        id: echoId, seekId: intentId, peerMasked: '第 1 度的某人',
        degree: 1, content: '南京摄影爱好者', peerAgentId: mailboxPeer.id,
      })

      const outcome = await boot.social!.revealer.revealEcho(echoId)
      expect(outcome).toEqual({ state: 'peer_unreachable' })
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

// ── Pairing-code (spec §7) — boot.pairing wiring ──────────────────────────
// Gated ONLY on mailbox_relays?.length (the rendezvous relay), independent
// of social_enabled — a daemon that hasn't turned social on can still pair.
// See src/daemon/bootstrap/wire-pairing.ts + docs/superpowers/specs/
// 2026-07-20-pairing-code-design.md §7.
describe('bootstrap pairing-code wiring', () => {
  it('wires boot.pairing when mailbox_relays is configured', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-pairing-on-'))
    writeFileSync(join(stateDir, 'agent-config.json'),
      JSON.stringify({ provider: 'claude', mailbox_relays: ['https://brain.example/mailbox'] }))
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(boot.pairing).toBeDefined()
      expect(typeof boot.pairing!.start).toBe('function')
      expect(typeof boot.pairing!.accept).toBe('function')
      expect(typeof boot.pairing!.stop).toBe('function')
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('leaves boot.pairing undefined with no mailbox_relays', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-pairing-off-'))
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(boot.pairing).toBeUndefined()
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  // T2/T6 identity split (carried review item 1) — boot.selfId is what every
  // outbound wiring seam (wireSocial, wirePairing, pipeline-deps' delegate
  // path) shares. Asserted directly here so a future regression that
  // reintroduces a second, independently-resolved selfId somewhere is caught
  // at the bootstrap layer, not just by re-deriving the expected value.
  it('exposes boot.selfId — the single resolveSelfAgentId result shared by every wiring seam', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-selfid-'))
    writeFileSync(join(stateDir, 'agent-config.json'),
      JSON.stringify({ provider: 'claude', mailbox_relays: ['https://brain.example/mailbox'] }))
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(typeof boot.selfId).toBe('string')
      expect(boot.selfId.length).toBeGreaterThan(0)
      // Persisted to disk by resolveSelfAgentId's fresh-daemon mint branch —
      // proves this is the SAME resolution wire-pairing/wire-social read,
      // not a second independent one.
      const disk = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
      expect(disk.self_agent_id).toBe(boot.selfId)
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  // Double-notify fix (T7 review) — start()/accept() are SYNC calls the
  // caller (WeChat 配对 dispatch seam / internal-api / CLI) is waiting on
  // and renders every outcome for; boot.pairing's wired `notify` (→
  // resolveOperatorChatId + sendMessage) is reserved for the initiator's
  // ASYNC poller only (see pairing.ts's notify doc comment). Previously
  // start()'s relay_drop_failed branch ALSO fired notify synchronously,
  // which — since resolveOperatorChatId resolves to the same chat as the
  // one that typed "配对" in a solo-owner install — meant the owner got the
  // honest failure copy twice (once from here, once from the pipeline
  // dispatch seam). Locking in: the real wired engine must NOT send
  // anything on a sync relay-drop failure; the caller alone renders it
  // (covered end-to-end for the WeChat seam in
  // pipeline-deps-pairing-dispatch.test.ts).
  it('a failed relay drop on start() does NOT notify via the wired notify path (sync outcome — caller renders it)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-pairing-notify-'))
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({
      provider: 'claude',
      // Port 1 is never a live relay in this test env — drop() will fail
      // (fetch throws / non-2xx), driving the honest relay_drop_failed path.
      mailbox_relays: ['http://127.0.0.1:1/mailbox'],
    }))
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      const sent: Array<{ chatId: string; text: string }> = []
      const db = openTestDb()
      const ilink = makeIlinkStub()
      ilink.sendMessage = (async (chatId: string, text: string) => { sent.push({ chatId, text }); return { msgId: 'm1' } }) as any
      boot = await buildBootstrap({
        db,
        stateDir,
        ilink: ilink as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      // Seed a conversation row so resolveOperatorChatId() (earliest-updated
      // conversation) resolves to a real chat instead of null — proves the
      // silence below isn't just "no operator chat to notify".
      boot.conversationStore.set('op_chat', { kind: 'solo', provider: 'claude' })
      expect(boot.pairing).toBeDefined()
      const res = await boot.pairing!.start()
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.reason).toBe('relay_drop_failed')
      expect(sent.length).toBe(0)
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
