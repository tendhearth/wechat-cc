import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildBootstrap, resolveAdminChatId } from './bootstrap'
import { saveAgentConfig } from '../lib/agent-config'
import { openTestDb } from '../lib/db'
import { makeChannelStore } from '../core/penpal-channel-store'
import { generateKeypair, deriveSharedKey, sealLetter } from '../core/penpal-crypto'
import { TIER_PROFILES } from '../core/user-tier'
import { MANIFEST_FILE } from './plugins/paths'
import type { Access } from '../lib/access'
import type { CompanionConfig } from './companion/config'
import { createInternalApi } from './internal-api'
import { wireSelfRestart } from './bootstrap/wire-self-restart'
import { SubsystemSupervisor } from './subsystems'
import { NEW_RELATIONSHIP_MSG_COUNT } from '../lib/messages-store'

// Code review pinning (I2①, 2026-08-11): wrap the REAL wireSelfRestart with
// a spy so a couple of tests can inspect the `busy`/`lastPollSuccessAgoMs`
// closures buildBootstrap actually hands it — proving they read the SAME
// `busyRegistry`/`health` instances the rest of Bootstrap exposes, not a
// second disconnected instance (the "改错 dep 名 / 换实例" class of silent
// regression the reviewer flagged). `importOriginal` means the wrapped
// function's BEHAVIOR is unchanged (every existing self-restart test in
// this file — real git reads included — still exercises the real
// implementation); this only adds observability, and it's scoped to this
// one test file via vi.mock, not a change to any production API/type.
vi.mock('./bootstrap/wire-self-restart', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bootstrap/wire-self-restart')>()
  return { ...actual, wireSelfRestart: vi.fn(actual.wireSelfRestart) }
})

async function pollFor<T>(fn: () => T | null, tries = 50, gapMs = 10): Promise<T | null> {
  for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, gapMs)) }
  return fn()
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
        supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
    // imports; in this test env CURSOR_API_KEY is unset so it never
    // appears. agy is gated on `agyBin` in seeded agent-config OR a real
    // PATH lookup — but under a test runner the PATH fallback is disabled
    // outright (providers.ts's UNDER_TEST_RUNNER guard, fix round 1) and
    // no agent-config.json exists at this stateDir, so agy never appears
    // here regardless of whether the host machine happens to have a real
    // `agy` binary installed. Back to a strict exact-list assertion.
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
        supervisor: new SubsystemSupervisor(() => {}),
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
        supervisor: new SubsystemSupervisor(() => {}),
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
        supervisor: new SubsystemSupervisor(() => {}),
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
        supervisor: new SubsystemSupervisor(() => {}),
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
        supervisor: new SubsystemSupervisor(() => {}),
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
        supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const withUndefinedPersona = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(), stateDir: '/tmp/state', ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }), lastActiveChatId: () => null,
      log: () => {}, internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    expect(b2.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')).not.toContain('算出来的事实')
  })

  it('buildInstructions is byte-identical whether or not other bootstraps wire coreMemoryFor, when this bootstrap omits it (core-memory-injection design inert default)', async () => {
    const withoutCoreMemoryDep = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const withUndefinedCoreMemory = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
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
        supervisor: new SubsystemSupervisor(() => {}),
        db: openTestDb(),
        stateDir: base,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      const prompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
      expect(prompt).toContain('知识编排')
      // The 消息检索 bullet is deliberately NOT asserted here any more. Since
      // the Knowledge Kernel landed, wxsearch's own `search` tool is retired
      // and the bullet is gated on `knowledgeSearchAvailable` (the daemon's
      // embedder actually resolving), not on the wxsearch plugin being
      // present — see knowledgeOrchestrationSection in prompt-builder.ts.
      // Plugin presence still drives section INCLUSION, which is what this
      // test covers; the bullet's own gating is owned by
      // prompt-builder.test.ts ("renders the 关系画像 bullet but NOT a
      // `search` bullet when knowledge_search is not available" and its
      // knowledgeSearchAvailable:true counterpart).
      expect(prompt).not.toContain('消息检索')
    } finally {
      if (prevBundledDir === undefined) delete process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
      else process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = prevBundledDir
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('buildInstructions omits the knowledge-orchestration section when no knowledge plugin is loaded (stateDir has none)', async () => {
    const b = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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

  it('buildInstructions renders the sticker cold-start unlock variant when stickerTagsFor returns [] (pref on, empty library), and omits both sticker sections when it returns null (pref off) (owner-onboarding design §C2)', async () => {
    const b = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      stickerTagsFor: (chatId: string) => (chatId === 'empty-lib-chat' ? [] : chatId === 'pref-off-chat' ? null : ['happy']),
    })
    const emptyLibPrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'empty-lib-chat')
    expect(emptyLibPrompt).toContain('你还没有表情包')
    expect(emptyLibPrompt).toContain('save_sticker')
    expect(emptyLibPrompt).not.toContain('send_sticker')

    const prefOffPrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'pref-off-chat')
    expect(prefOffPrompt).not.toContain('你还没有表情包')
    expect(prefOffPrompt).not.toContain('save_sticker')
    expect(prefOffPrompt).not.toContain('send_sticker')

    const nonEmptyPrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'stocked-chat')
    expect(nonEmptyPrompt).not.toContain('你还没有表情包')
    expect(nonEmptyPrompt).toContain('send_sticker')
  })

  it('buildInstructions hides the sticker cold-start unlock variant for GUEST-tier chats even when stickerTagsFor returns [] (empty library), since guests cannot call save_sticker (memory_write denied) — mirrors the careEnabled tier gate (fix round 2)', async () => {
    const b = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      stickerTagsFor: () => [],
    })
    const guestPrompt = b.buildInstructions('claude', TIER_PROFILES.guest, 'owner-chat')
    expect(guestPrompt).not.toContain('你还没有表情包')
    expect(guestPrompt).not.toContain('save_sticker')

    const adminPrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(adminPrompt).toContain('你还没有表情包')
    expect(adminPrompt).toContain('save_sticker')
  })

  it('buildInstructions still hides the NORMAL (non-empty) sticker section for GUEST-tier chats\' behavior unchanged — no NEW tier gate on the non-empty path, pre-existing (fix round 2 only touches the empty-library variant)', async () => {
    const b = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      stickerTagsFor: () => ['happy'],
    })
    const guestPrompt = b.buildInstructions('claude', TIER_PROFILES.guest, 'owner-chat')
    expect(guestPrompt).toContain('send_sticker')
    expect(guestPrompt).toContain('happy')
  })

  it('buildInstructions defaults stickerTags to null (not []) when stickerTagsFor is unwired entirely — stays byte-identical to before the sticker feature existed', async () => {
    const withoutDep = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const prompt = withoutDep.buildInstructions('claude', TIER_PROFILES.admin, 'any-chat')
    expect(prompt).not.toContain('你还没有表情包')
    expect(prompt).not.toContain('save_sticker')
    expect(prompt).not.toContain('send_sticker')
  })

  it('buildInstructions includes the companion-offer section when companionOfferFor returns true (owner-onboarding design §C1)', async () => {
    const b = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      companionOfferFor: (chatId: string) => chatId === 'owner-chat',
    })
    const ownerPrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(ownerPrompt).toContain('聊熟了')
    expect(ownerPrompt).toContain('companion_enable')
    const otherPrompt = b.buildInstructions('claude', TIER_PROFILES.admin, 'other-chat')
    expect(otherPrompt).not.toContain('聊熟了')
  })

  it('buildInstructions includes the companion-offer section for GUEST-tier chats too — deliberately NO tier gate, since companion_enable is registered regardless of tier (owner-onboarding design §C1)', async () => {
    const b = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      companionOfferFor: () => true,
    })
    const guestPrompt = b.buildInstructions('claude', TIER_PROFILES.guest, 'owner-chat')
    expect(guestPrompt).toContain('聊熟了')
  })

  it('buildInstructions omits the companion-offer section when companionOfferFor returns false, and is byte-identical to the thunk being absent entirely', async () => {
    const bFalse = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      companionOfferFor: () => false,
    })
    const bAbsent = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const promptFalse = bFalse.buildInstructions('claude', TIER_PROFILES.admin, 'any-chat')
    const promptAbsent = bAbsent.buildInstructions('claude', TIER_PROFILES.admin, 'any-chat')
    expect(promptFalse).toBe(promptAbsent)
    expect(promptAbsent).not.toContain('聊熟了')
  })

  it('buildInstructions is mutually exclusive between newRelationshipSection and companionOfferSection at the real NEW_RELATIONSHIP_MSG_COUNT threshold boundary (owner-onboarding design §C1) — mirrors main.ts wiring: both thunks derive from the SAME per-chat inbound count, one side `< N`, the other `>= N`', async () => {
    let inboundCount = NEW_RELATIONSHIP_MSG_COUNT - 1
    const b = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
      // Mirrors main.ts's actual newRelationshipFor / companionOfferFor:
      // both read the same `inboundCount` var, thresholded on opposite sides.
      newRelationshipFor: () => inboundCount < NEW_RELATIONSHIP_MSG_COUNT,
      companionOfferFor: () => inboundCount >= NEW_RELATIONSHIP_MSG_COUNT,
    })

    const justBelow = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(justBelow).toContain('刚认识')
    expect(justBelow).not.toContain('聊熟了')

    inboundCount = NEW_RELATIONSHIP_MSG_COUNT
    const atThreshold = b.buildInstructions('claude', TIER_PROFILES.admin, 'owner-chat')
    expect(atThreshold).toContain('聊熟了')
    expect(atThreshold).not.toContain('刚认识')
  })

  it('buildInstructions includes the empty-persona nudge when personaFor returns empty content and cultivate:true (onboarding-curiosity design §2)', async () => {
    const b = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
    // Each buildBootstrap call needs its OWN supervisor instance — a shared
    // one would throw "duplicate start('knowledge')" on the second call
    // (SubsystemSupervisor rejects re-registering the same subsystem name).
    const bFalse = await buildBootstrap({ ...depsBase, supervisor: new SubsystemSupervisor(() => {}), bubbleRepliesFor: () => false })
    const bAbsent = await buildBootstrap({ ...depsBase, supervisor: new SubsystemSupervisor(() => {}) })
    const promptFalse = bFalse.buildInstructions('claude', TIER_PROFILES.admin, 'any-chat')
    const promptAbsent = bAbsent.buildInstructions('claude', TIER_PROFILES.admin, 'any-chat')
    expect(promptFalse).not.toContain('气泡式回复')
    expect(promptFalse).toBe(promptAbsent)
  })

  it('buildInstructions includes the bubble-replies section for GUEST-tier chats too — deliberately NO tier gate, since reply is guest-allowed (unlike careEnabled/newRelationship which require memory_write)', async () => {
    const b = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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
      supervisor: new SubsystemSupervisor(() => {}),
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

// ── 社交接线 ──────────────────────────────────────────────────────────────
// onLetter is only wired into the a2a server — and bootstrap.social only
// constructed — when BOTH social_enabled and social_disclosure_policy are
// configured. See docs/superpowers/specs/2026-09-04-wish-postcard/ and
// src/daemon/bootstrap.a2a.test.ts for the sibling a2a-wiring pattern this
// mirrors (real a2a_listen on a fixed test port, agent.json capability
// assertions).
describe('bootstrap 社交接线', () => {
  it('wires onLetter + boot.social {penpal, wish} when social_enabled + social_disclosure_policy are BOTH configured', async () => {
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
        supervisor: new SubsystemSupervisor(() => {}),
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      // The a2a server advertises `letter` only when onLetter was actually
      // passed to createA2AServer. 心愿改写之后信封只从这一个口进来 ——
      // intent / echo / reveal 都已退役,名片上不该再有。
      const card = await (await fetch(`http://127.0.0.1:${port}/.well-known/agent.json`)).json() as {
        capabilities: Array<{ name: string }>
      }
      expect(card.capabilities.some(c => c.name === 'letter')).toBe(true)
      expect(card.capabilities.some(c => c.name === 'intent')).toBe(false)
      expect(card.capabilities.some(c => c.name === 'echo')).toBe(false)
      expect(card.capabilities.some(c => c.name === 'reveal')).toBe(false)
      // boot.social 三块:信道(写信 / 串门)、心愿、介绍。
      expect(boot.social).toBeDefined()
      expect(Object.keys(boot.social!).sort()).toEqual(['intro', 'penpal', 'wish'])
      expect(typeof boot.social!.penpal.sendLetter).toBe('function')
      expect(typeof boot.social!.penpal.startVisit).toBe('function')
      expect(typeof boot.social!.wish.propose).toBe('function')
      expect(typeof boot.social!.wish.send).toBe('function')
      expect(typeof boot.social!.wish.cancel).toBe('function')
      expect(typeof boot.social!.wish.resolveRef).toBe('function')
      expect(typeof boot.social!.intro.request).toBe('function')
      expect(typeof boot.social!.intro.accept).toBe('function')
      expect(typeof boot.social!.intro.decline).toBe('function')
      expect(typeof boot.social!.intro.offers).toBe('function')
      // 退役的东西一件都不该还挂在上面(Task 8 会把 core 文件也删掉)。
      for (const gone of ['broker', 'seekStore', 'echoStore', 'pledgeStore', 'revealer']) {
        expect(gone in boot.social!).toBe(false)
      }
      // Task 11: the top-level boot.penpal (what the "回信" dispatch seam in
      // pipeline-deps.ts actually reads) exposes sendLetter too.
      expect(typeof boot.penpal?.sendLetter).toBe('function')
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('does NOT wire onLetter and boot.social is undefined when social_enabled is absent', async () => {
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
    // Degraded-boot guard: absence of boot.social must reflect "not
    // configured", not "social threw and was swallowed into degraded".
    const sup = new SubsystemSupervisor(() => {})
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        supervisor: sup,
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
      expect(card.capabilities.some(c => c.name === 'letter')).toBe(false)
      expect(boot.social).toBeUndefined()
      expect(sup.degraded()).toEqual([])
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
    // Degraded-boot guard (see previous test's comment).
    const sup = new SubsystemSupervisor(() => {})
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        supervisor: sup,
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(boot.social).toBeUndefined()
      expect(sup.degraded()).toEqual([])
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('claude-default daemon with knowledge_enabled wires the in-process grounded judge (SJ Task 3 — replaces the retired plugin-spawn grounded-judge.ts path)', async () => {
    // The judge no longer spawns a plugin-carrying session (grounded-judge.ts,
    // deleted) — it grounds in-process via owner-grounding.ts's makeOwnerGrounding,
    // fed from `deps.knowledge` (the same Knowledge Kernel object wired
    // whenever `knowledge_enabled` is on). No bundled plugin dir needed at all.
    const base = mkdtempSync(join(tmpdir(), 'bootstrap-inproc-judge-'))
    writeFileSync(
      join(base, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        social_enabled: true,
        social_disclosure_policy: '兴趣可说；住址不可',
        knowledge_enabled: true,
      }),
    )
    const logs: string[] = []
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        supervisor: new SubsystemSupervisor(() => {}),
        db: openTestDb(),
        stateDir: base,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: (_tag, m) => logs.push(m),
      })
      expect(logs.some(m => m.includes('social: in-process grounded judge (kernel facts + search, no spawn, provider-agnostic)'))).toBe(true)
      expect(logs.some(m => m.includes('knowledge not wired'))).toBe(false)
    } finally {
      boot?.knowledge?.store.close()
      await boot?.knowledge?.embedder?.close?.()
      await boot?.a2aServer?.stop()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('claude-default daemon with knowledge_enabled OFF logs the honest "not plugin-grounded" fallback (SJ Task 3)', async () => {
    // No knowledge kernel wired ⇒ deps.knowledge is undefined ⇒ makeOwnerGrounding
    // always resolves '' ⇒ the judge reasons from topic text alone. The boot
    // log must say so honestly rather than silently claiming grounding.
    const base = mkdtempSync(join(tmpdir(), 'bootstrap-noknowledge-judge-'))
    writeFileSync(
      join(base, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude', dangerouslySkipPermissions: false, autoStart: false, closeStopsDaemon: false,
        social_enabled: true, social_disclosure_policy: '兴趣可说；住址不可',
      }),
    )
    const logs: string[] = []
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        supervisor: new SubsystemSupervisor(() => {}),
        db: openTestDb(), stateDir: base, ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null, log: (_tag, m) => logs.push(m),
      })
      expect(logs.some(m => m.includes('social: judge reasons from topic only — knowledge not wired (kernel off?). Not plugin-grounded.'))).toBe(true)
      expect(logs.some(m => m.includes('in-process grounded judge'))).toBe(false)
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('POST /v1/social/wish returns 503 when the social wish service is not wired (deps.social absent)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'internal-api-social-503-'))
    const api = createInternalApi({ stateDir, daemonPid: 1 } as any)
    try {
      const { port } = await api.start()
      // POST /v1/social/wish is trusted-tier (route-tiers.ts, 心愿) —
      // the daemon-wide file token is already 'trusted', but an admin-tier
      // session token meets a trusted bar too (admin > trusted), so minting
      // admin here still exercises the same 503-before-authz-matters path.
      const token = api.mintSessionToken('admin', 'test-session')
      const resp = await fetch(`http://127.0.0.1:${port}/v1/social/wish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x' }),
      })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toMatchObject({ error: 'social_not_wired' })
    } finally {
      await api.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  // The inbound /a2a/letter handler only ever serves THIS daemon's own
  // channels (correspondent.receiveLetter, via channelStore.getByMyChannelId).
  // Anything else is dropped — the content-blind 2-hop relay leg retired with
  // seek/echo/reveal. Both branches are driven through the real endpoint.
  it('an inbound letter to OUR OWN open channel decrypts + notifies the owner', async () => {
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
        supervisor: new SubsystemSupervisor(() => {}),
        db,
        stateDir,
        ilink: ilink as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      boot.conversationStore.upsertIdentity('op_chat', { userId: 'op_chat' })
      const peerKey = 'peer-letter-own-key-abc123'
      boot.a2aDeps!.registry.add({
        id: 'ccb', name: '小B', url: 'http://127.0.0.1:1/a2a',
        inbound_api_key: peerKey, outbound_api_key: 'unused',
        capabilities: [], paused: false, transport: 'push', may_exec: false,
      })
      // Open a real penpal_channel on the SAME store boot.social.penpal reads
      // (both are makeChannelStore over this one db) — a mint on our side, the
      // peer's REAL keypair crossed in, status open. The peer's private key
      // then lets us encrypt a valid letter FROM the peer TO us below,
      // mirroring what the peer's own penpal-correspondent.ts would produce.
      const channelStore = makeChannelStore(db)
      const myKp = generateKeypair()
      const peerKp = generateKeypair()
      const rowId = 'ch-letter-own'
      channelStore.create({
        id: rowId, seekId: 'pair-letter-own', myPrivkey: myKp.privateKey, myPubkey: myKp.publicKey,
        myChannelId: 'my-chan-own-1', degree: 1, peerAgentId: 'ccb',
      })
      channelStore.setPeerHandle(rowId, { pubkey: peerKp.publicKey, channel_id: 'peer-chan-own-1' })
      channelStore.setStatus(rowId, 'open')
      const channel = channelStore.get(rowId)!
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

      // The owner was notified with a decrypted preview, and the sender is
      // named the way 心愿 / 明信片 name it (wire-social.ts's single peerLabel):
      // a channel whose peer_agent_id is in MY OWN registry is my friend — call
      // them by the name I gave them. 「第 N 度的某人」 is for the channels where
      // I genuinely don't know who's on the other end (no peer_agent_id). The
      // name never crosses the wire; it only ever renders into my own chat.
      const sendMessage = ilink.sendMessage as unknown as ReturnType<typeof vi.fn>
      const letterSends = sendMessage.mock.calls.filter((c: unknown[]) => String(c[1]).includes('给你写信了'))
      expect(letterSends).toHaveLength(1)
      expect(String(letterSends[0]?.[1])).toContain('下次约拍风景怎么样')
      expect(String(letterSends[0]?.[1])).toContain(channel.id)
      expect(String(letterSends[0]?.[1])).toContain('小B')
      expect(String(letterSends[0]?.[1])).not.toContain('第 1 度的某人')

      // boot.penpal.sendLetter is present and callable end to end (Task 10's
      // dispatch seam calls exactly this). Exercise it against a channel id
      // that isn't open to prove it's the real correspondent wired in, not a
      // stub — the real correspondent's own not-open guard fires.
      const badReply = await boot.penpal!.sendLetter('no-such-channel', 'hi')
      expect(badReply).toEqual({ ok: false, error: 'channel_not_open' })

      // The other branch: a letter addressed to a channel_id that is NOT one
      // of ours is DROPPED (the 2-hop relay forward retired with seek/echo/
      // reveal) — nothing decrypted, nothing stored, no owner notify.
      const beforeRows = (db.query('SELECT COUNT(*) AS n FROM penpal_letter').get() as { n: number }).n
      const strayResp = await fetch(`http://127.0.0.1:${port}/a2a/letter`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${peerKey}` },
        body: JSON.stringify({ agent_id: 'ccb', channel_id: 'not-my-channel', ...sealLetter(key, '转给别人') }),
      })
      expect(strayResp.status).toBe(200)
      expect(await strayResp.json()).toMatchObject({ ok: false, error: 'unknown_channel' })
      expect((db.query('SELECT COUNT(*) AS n FROM penpal_letter').get() as { n: number }).n).toBe(beforeRows)
      expect(sendMessage.mock.calls.filter((c: unknown[]) => String(c[1]).includes('给你写信了'))).toHaveLength(1)
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
        supervisor: new SubsystemSupervisor(() => {}),
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
    // Degraded-boot guard: boot.pairing undefined must mean "not
    // configured", not "pairing threw and was swallowed into degraded".
    const sup = new SubsystemSupervisor(() => {})
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        supervisor: sup,
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(boot.pairing).toBeUndefined()
      expect(sup.degraded()).toEqual([])
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
        supervisor: new SubsystemSupervisor(() => {}),
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
        supervisor: new SubsystemSupervisor(() => {}),
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

  // self-restart (spec 2026-08-03-daemon-self-restart-on-stale-code) —
  // wiring-level check: markInboundActivity must be present on Bootstrap
  // IFF deps.requestRestart was provided, and calling it must never throw.
  // Pure-function coverage for the decision (shouldSelfRestart) and the
  // idle-tick check itself (makeSelfRestartCheck) lives in
  // src/daemon/self-restart/*.test.ts; this proves buildBootstrap actually
  // honors the "requestRestart absent ⇒ mechanism fully inert" contract and
  // exposes a callable marker when it's wired (see bootstrap/index.ts's
  // self-restart block, which feeds the SAME activity-marker instance into
  // both this returned markInboundActivity and the check's `quietFor`).
  it('markInboundActivity is present only when requestRestart is wired (self-restart gate)', async () => {
    // Degraded-boot guard: absence must mean "requestRestart not passed",
    // not "self-restart threw and was swallowed into degraded".
    const supWithoutRestart = new SubsystemSupervisor(() => {})
    const withoutRestart = await buildBootstrap({
      supervisor: supWithoutRestart,
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(withoutRestart.markInboundActivity).toBeUndefined()
    expect(supWithoutRestart.degraded()).toEqual([])

    // Passing requestRestart makes buildBootstrap really shell out to
    // `git rev-parse` twice (HEAD + HEAD:bun.lock). Reviewed and kept
    // deliberately: both are read-only, offline, and ~10ms in a checkout,
    // and NOTHING here asserts on their output — a null result (no git, no
    // repo) leaves every assertion below unchanged. The alternatives were
    // worse: adding an injection seam to BootstrapDeps widens production
    // API for test convenience only, and vi.mock has previously caused
    // real-state-dir pollution in this repo. The 3s timeout inside
    // readGitHead bounds the worst case.
    const withRestart = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      requestRestart: () => {},
    })
    expect(typeof withRestart.markInboundActivity).toBe('function')
    // mw-messages calls this unconditionally on every inbound message
    // (before dedup/routing) — it must be safe to call from that hot path.
    expect(() => withRestart.markInboundActivity!()).not.toThrow()
  })

  // busy-registry hold (spec 2026-08-11 §1/§2, Task 6) — wiring-level check
  // that Bootstrap ALWAYS exposes holdBusy (unlike markInboundActivity, the
  // busy registry is constructed unconditionally — see bootstrap/index.ts's
  // `const busyRegistry = makeBusyRegistry()`, independent of whether
  // deps.requestRestart was provided). Bootstrap doesn't expose a busy()
  // read端 (the self-restart idle check is the only consumer wired to read
  // it — see wire-self-restart.test.ts for real-signal coverage at that
  // layer), so the observable surface here is: present regardless of
  // requestRestart, and calling it returns a safe, idempotent release.
  it('holdBusy is present on Bootstrap regardless of whether requestRestart is wired, and returns a safe idempotent release', async () => {
    for (const requestRestart of [undefined, () => {}]) {
      const boot = await buildBootstrap({
        supervisor: new SubsystemSupervisor(() => {}),
        db: openTestDb(),
        stateDir: '/tmp/state',
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
        ...(requestRestart ? { requestRestart } : {}),
      })
      expect(typeof boot.holdBusy).toBe('function')
      const release = boot.holdBusy('test-probe')
      expect(typeof release).toBe('function')
      expect(() => release()).not.toThrow()
      // Idempotent — a second release call must be a harmless no-op.
      expect(() => release()).not.toThrow()
    }
  })

  // I2① (code review, 2026-08-11) — "两个新闸门静默常闭,零生产钉子". Task 6
  // wired `lastPollSuccessAgoMs`/`busy` to read `health`/`busyRegistry`, but
  // nothing pinned that they read the SAME instances the rest of Bootstrap
  // exposes — a future edit could rename a dep or swap in a disconnected
  // second instance, tsc and every other test would stay green, and the
  // self-restart gate would silently go back to permanently-blocked. These
  // two tests drive Bootstrap's OWN public surface (`boot.health.onSuccess`,
  // `boot.holdBusy`) and observe the closures the REAL buildBootstrap call
  // handed to wireSelfRestart (captured via the module-level `vi.mock` spy
  // above — `importOriginal`, so behavior is unchanged) — no new production
  // API, no widened Bootstrap/BootstrapDeps type. wireSelfRestart is called
  // UNCONDITIONALLY by buildBootstrap (it internally no-ops on missing
  // requestRestart), so neither test needs `requestRestart` — no real git
  // spawn required.
  it('the lastPollSuccessAgoMs closure handed to wireSelfRestart reads the SAME health instance boot.health writes through', async () => {
    vi.mocked(wireSelfRestart).mockClear()
    const boot = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(wireSelfRestart).toHaveBeenCalledTimes(1)
    const passedDeps = vi.mocked(wireSelfRestart).mock.calls[0]![0]

    // Before any wechat poll has ever succeeded: null (can't prove fresh).
    expect(passedDeps.lastPollSuccessAgoMs(Date.now())).toBeNull()

    // The SAME health instance boot.health IS — writing through it must be
    // visible to the closure buildBootstrap handed to wireSelfRestart.
    boot.health.onSuccess('wechat')
    const ago = passedDeps.lastPollSuccessAgoMs(Date.now())
    expect(ago).not.toBeNull()
    expect(typeof ago).toBe('number')
    expect(ago as number).toBeGreaterThanOrEqual(0)
    expect(ago as number).toBeLessThan(1000)
  })

  it("the busy closure handed to wireSelfRestart reads the SAME busy registry boot.holdBusy writes through", async () => {
    vi.mocked(wireSelfRestart).mockClear()
    const boot = await buildBootstrap({
      supervisor: new SubsystemSupervisor(() => {}),
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(wireSelfRestart).toHaveBeenCalledTimes(1)
    const passedDeps = vi.mocked(wireSelfRestart).mock.calls[0]![0]

    expect(passedDeps.busy()).toBe(false)
    const release = boot.holdBusy('pinning-probe')
    // Same account: a hold made through boot.holdBusy must be visible to
    // the closure buildBootstrap handed to wireSelfRestart.
    expect(passedDeps.busy()).toBe(true)
    release()
    expect(passedDeps.busy()).toBe(false)
  })
})

// ── Knowledge Kernel bootstrap wiring (Phase 01, T5) ───────────────────────
// boot.knowledge (the daemon-owned KnowledgeStore + semanticSearch) is
// constructed only when `knowledge_enabled` is configured — mirrors the
// social_enabled on/off pair above. See
// docs/superpowers/plans/2026-07-12-knowledge-kernel-phase01.md Task 5.
describe('bootstrap knowledge kernel wiring (KK T5)', () => {
  it('wires boot.knowledge (store + search) and runs a boot backfill when knowledge_enabled is true', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-knowledge-on-'))
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        knowledge_enabled: true,
      }),
    )
    const logLines: Array<{ tag: string; line: string; fields?: Record<string, unknown> }> = []
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    // Agent-facing Search Task 2 — this fixture wants NO embed script to
    // resolve (asserted below), which requires no wxsearch plugin dir being
    // found. `bundledPluginsDir()` falls back to `<repo>/plugins` when this
    // env var is unset, and a dev checkout with the wechat-cc-plugins
    // monorepo symlinked in there would otherwise make wxsearch discoverable
    // for real — pointing this at an empty tmp dir isolates the assertion
    // from that ambient machine state (mirrors the pattern the
    // knowledge-orchestration tests already use for the same reason).
    const emptyBundledDir = mkdtempSync(join(tmpdir(), 'bootstrap-knowledge-nobundled-'))
    const prevBundledDir = process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
    process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = emptyBundledDir
    try {
      boot = await buildBootstrap({
        supervisor: new SubsystemSupervisor(() => {}),
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: (tag, line, fields) => { logLines.push({ tag, line, fields }) },
      })
      expect(boot.knowledge).toBeDefined()
      expect(typeof boot.knowledge!.store.putSourceMessages).toBe('function')
      expect(typeof boot.knowledge!.search).toBe('function')
      // No wxsearch plugin dir is discoverable (isolated above) and
      // knowledge_embed_script is unset, so no embed script resolves; the
      // embedder (and its query convenience wrapper) must stay undefined
      // even though the store/search half of boot.knowledge is present.
      expect(boot.knowledge!.embedder).toBeUndefined()
      expect(boot.knowledge!.embedQuery).toBeUndefined()
      // Store is actually usable — putSourceMessages/listMessages round-trip.
      const { watermark } = boot.knowledge!.store.putSourceMessages([
        { msg_key: 'm1', conversation: 'c1', sender: 's1', time: 1, type: 'text', text: 'hi', server_id: '' },
      ])
      expect(watermark).toBeGreaterThan(0)
      // Boot backfill runs fire-and-forget (setTimeout(0)) with no configured
      // knowledge_source_dir — the default decrypted dir doesn't exist, so the
      // adapter finds nothing, but it must still run and log {ingested: 0}
      // rather than silently never firing.
      // Matched via a startsWith (not a bare `.includes('knowledge')`) —
      // the tmp stateDir path itself gets logged by unrelated plugin-not-
      // ready BOOT lines (plugin data dirs live under stateDir), and this
      // test's own tmp prefix contains "knowledge", so a loose substring
      // match on the whole array would false-positive on those instead of
      // this adapter's own log line.
      // Generous poll budget (10s, not pollFor's default 500ms): this is the
      // first knowledge-kernel test in the file, so it pays the cold-start
      // cost, and on the Windows runner the boot backfill now does real work —
      // before the SQLITE_OPEN_URI fix every open failed instantly there, so
      // the whole cycle was a no-op and always logged within a few ms.
      const bootLine = await pollFor(() => logLines.find(l => l.tag === 'BOOT' && l.line.startsWith('knowledge:')) ?? null, 1000, 10)
      expect(bootLine).toBeTruthy()
      expect(bootLine!.fields).toEqual({ ingested: 0 })
    } finally {
      boot?.knowledge?.store.close()
      await boot?.knowledge?.embedder?.close?.()
      await boot?.a2aServer?.stop()
      if (prevBundledDir === undefined) delete process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
      else process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = prevBundledDir
      rmSync(emptyBundledDir, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
    // 30s, not vitest's default 5s — see the poll-budget comment above. This
    // timed out on windows-latest at 5s once the URI fix made the Windows
    // backfill actually execute instead of failing every open instantly.
  }, 30000)

  // Knowledge Graph inproc Task 4 — the graph rebuild runs as part of the
  // SAME boot backfill as the source adapter/indexer (runKnowledgeCycle,
  // see cycle.ts), writing into the SAME KnowledgeStore's graph.db.
  // `knowledge_owner` here forces a deterministic owner even though the
  // fixture's source is empty (no decrypted dir on disk) — detectOwner's
  // vote heuristic has nothing to vote on, but an explicit override still
  // wins outright, so this is a clean assertion that the config value
  // actually reaches rebuildGraphFromSource end to end.
  it('runs a graph rebuild as part of the boot backfill (KK T4), honoring knowledge_owner', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-knowledge-graph-'))
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        knowledge_enabled: true,
        knowledge_owner: 'forced_wxid_owner',
      }),
    )
    const logLines: Array<{ tag: string; line: string; fields?: Record<string, unknown> }> = []
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    const emptyBundledDir = mkdtempSync(join(tmpdir(), 'bootstrap-knowledge-graph-nobundled-'))
    const prevBundledDir = process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
    process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = emptyBundledDir
    try {
      boot = await buildBootstrap({
        supervisor: new SubsystemSupervisor(() => {}),
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: (tag, line, fields) => { logLines.push({ tag, line, fields }) },
      })
      expect(boot.knowledge).toBeDefined()

      const graphLine = await pollFor(
        () => logLines.find(l => l.tag === 'KNOWLEDGE' && l.line.startsWith('graph rebuild:')) ?? null,
      )
      expect(graphLine).toBeTruthy()

      // Source is empty (no decrypted dir on disk in this fixture), so the
      // rebuild produced an empty-but-present graph — but `knowledge_owner`
      // still reached it: the graph's owner meta is the forced value, not
      // null/undetected.
      expect(boot.knowledge!.store.getGraphMeta('owner')).toBe('forced_wxid_owner')
      expect(boot.knowledge!.store.countContacts()).toBe(0)
      expect(boot.knowledge!.store.getGraphMeta('source_watermark')).toBe('0')
    } finally {
      boot?.knowledge?.store.close()
      await boot?.knowledge?.embedder?.close?.()
      await boot?.a2aServer?.stop()
      if (prevBundledDir === undefined) delete process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
      else process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = prevBundledDir
      rmSync(emptyBundledDir, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  // Agent-facing Search Task 2 — the ONE shared embedder service is built
  // only when `knowledge_enabled` AND an embed script actually resolves
  // (`knowledge_embed_script` here, mirroring the wxsearch-plugin-dir path
  // exercised by the knowledge-orchestration test at line ~831). The
  // embedder is lazy (embedder-service.ts's docstring — no subprocess until
  // the first embed() call), and this fixture's decrypted-messages dir
  // doesn't exist, so the boot backfill's indexer pass has nothing to embed
  // — safe to assert on the wiring without ever spawning the (nonexistent)
  // script.
  it('wires boot.knowledge.embedder + embedQuery when knowledge_enabled is true and knowledge_embed_script resolves', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-knowledge-embedder-'))
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        knowledge_enabled: true,
        knowledge_embed_model: 'bge-small-zh-v1.5',
        knowledge_embed_script: join(stateDir, 'fake_embed_subprocess.py'),
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        supervisor: new SubsystemSupervisor(() => {}),
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(boot.knowledge).toBeDefined()
      expect(boot.knowledge!.embedder).toBeDefined()
      expect(boot.knowledge!.embedder!.model_id).toBe('bge-small-zh-v1.5')
      expect(typeof boot.knowledge!.embedder!.embed).toBe('function')
      expect(typeof boot.knowledge!.embedder!.close).toBe('function')
      expect(typeof boot.knowledge!.embedQuery).toBe('function')
    } finally {
      boot?.knowledge?.store.close()
      await boot?.knowledge?.embedder?.close?.()
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('boot.knowledge is undefined when knowledge_enabled is absent, and no knowledge work is ever scheduled/logged', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-knowledge-off-'))
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        // knowledge_enabled omitted entirely.
      }),
    )
    const logLines: Array<{ tag: string; line: string; fields?: Record<string, unknown> }> = []
    // Degraded-boot guard: boot.knowledge undefined must mean "not
    // configured", not "knowledge threw and was swallowed into degraded".
    const sup = new SubsystemSupervisor(() => {})
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        supervisor: sup,
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: (tag, line, fields) => { logLines.push({ tag, line, fields }) },
      })
      expect(boot.knowledge).toBeUndefined()
      expect(sup.degraded()).toEqual([])
      // Gating (T7' review Finding 2c) — when disabled, the whole
      // knowledge-cycle block (including its setTimeout(0) boot backfill)
      // never runs, so the daemon never emits a single 'KNOWLEDGE'-tagged
      // log line. Give the deferred setTimeout(0) a tick to prove this is a
      // structural "never scheduled", not a race against an async backfill
      // that just hasn't logged yet.
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(logLines.find(l => l.tag === 'KNOWLEDGE')).toBeUndefined()
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
