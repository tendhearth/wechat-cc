import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildBootstrap, resolveAdminChatId } from './bootstrap'
import { saveAgentConfig } from '../lib/agent-config'
import { openTestDb } from '../lib/db'
import { TIER_PROFILES } from '../core/user-tier'
import { MANIFEST_FILE } from './plugins/paths'
import type { Access } from '../lib/access'
import type { CompanionConfig } from './companion/config'
import { createInternalApi } from './internal-api'

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
// onIntent/onIntentConfirm are only wired into the a2a server — and
// bootstrap.social only constructed — when BOTH social_enabled and
// social_disclosure_policy are configured. See
// docs/superpowers/specs/2026-07-12-agent-social-m1-intent-brokering-design.md
// and src/daemon/bootstrap.a2a.test.ts for the sibling a2a-wiring pattern
// this mirrors (real a2a_listen on a fixed test port, agent.json capability
// assertions).
describe('bootstrap agent-social M1 wiring', () => {
  it('wires onIntent/onIntentConfirm + boot.social when social_enabled + social_disclosure_policy are BOTH configured', async () => {
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
      // The a2a server advertises the two social capabilities only when
      // onIntent/onIntentConfirm were actually passed to createA2AServer.
      const card = await (await fetch(`http://127.0.0.1:${port}/.well-known/agent.json`)).json() as {
        capabilities: Array<{ name: string }>
      }
      expect(card.capabilities.some(c => c.name === 'intent')).toBe(true)
      expect(card.capabilities.some(c => c.name === 'intent_confirm')).toBe(true)
      // The broker + pendingConfirms are exposed on the bootstrap return so
      // main.ts can late-bind them into internal-api (setSocial) and a
      // follow-up task (T7b-2) can wire the operator-reply resolve.
      expect(boot.social).toBeDefined()
      expect(typeof boot.social!.broker.seek).toBe('function')
      expect(typeof boot.social!.pendingConfirms.ask).toBe('function')
      expect(typeof boot.social!.pendingConfirms.resolve).toBe('function')
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
    // provider is registered. Pointing it at a loopback port nobody's
    // listening on makes the social gate's cheapEval call fail FAST
    // (ECONNREFUSED) instead of shelling out to a real `claude` subprocess
    // for a live LLM round-trip — this test only needs to prove the
    // recording wrapper persists a row around broker.seek(), not exercise
    // the real disclosure-gate judgment, and a live network call would make
    // it slow/flaky and dependent on this machine's authenticated `claude`
    // CLI (unavailable in most CI runners).
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
        openaiBaseUrl: 'http://127.0.0.1:1/v1',
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
      // so the outcome is empty — recording must STILL persist the seek row
      // (foraging → closed) even when nothing matched.
      await boot.social!.broker.seek('找个会修老相机的')
      const rows = db.query('SELECT topic, status FROM social_seek').all() as Array<{ topic: string; status: string }>
      expect(rows.some(r => r.topic.includes('相机') && r.status === 'closed')).toBe(true)
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
      if (prevKey === undefined) delete process.env.WECHAT_OPENAI_API_KEY
      else process.env.WECHAT_OPENAI_API_KEY = prevKey
    }
  })

  it('does NOT wire onIntent/onIntentConfirm and boot.social is undefined when social_enabled is absent', async () => {
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
      expect(card.capabilities.some(c => c.name === 'intent_confirm')).toBe(false)
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
})
