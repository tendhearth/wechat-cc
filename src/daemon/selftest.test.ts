import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelftestConverse, type SelftestConverseDeps } from './selftest'
import { makeFakeSession } from '../core/test-helpers'
import type { AgentEvent, AgentProject, AgentSession, SpawnContext } from '../core/agent-provider'
import type { ProviderRegistry } from '../core/provider-registry'

/** Scratch project path the runner uses (mirrors SELFTEST_PROJECT_PATH in
 *  selftest.ts). Deliberately NOT under STATE_DIR — that directory holds
 *  the daemon's tokens/account files and the selftest session runs with
 *  `permissionMode:'dangerously'`. */
const PROJECT_DIR = join(tmpdir(), 'wechat-cc-selftest', 'project')

function cleanProjectDir() {
  rmSync(join(tmpdir(), 'wechat-cc-selftest'), { recursive: true, force: true })
}

function makeRegistry(session: AgentSession, opts?: { onSpawn?: (project: AgentProject, ctx: SpawnContext) => void }) {
  const registry: Pick<ProviderRegistry, 'get'> = {
    get: (id: string) => {
      if (id !== 'claude') return null
      return {
        provider: {
          async spawn(project: AgentProject, ctx: SpawnContext) {
            opts?.onSpawn?.(project, ctx)
            return session
          },
        },
        opts: { displayName: 'Claude', canResume: () => true },
      } as never
    },
  }
  return registry
}

function makeDeps(overrides: Partial<SelftestConverseDeps> = {}): SelftestConverseDeps {
  return {
    registry: overrides.registry ?? makeRegistry(makeFakeSession({ events: [] })),
    mintSessionToken: overrides.mintSessionToken ?? vi.fn(() => 'tok-abc'),
    invalidateSession: overrides.invalidateSession ?? vi.fn(),
    log: overrides.log ?? vi.fn(),
    now: overrides.now,
  }
}

describe('runSelftestConverse', () => {
  beforeEach(cleanProjectDir)
  afterEach(cleanProjectDir)

  it('spawns a scoped session, drains one turn, tears it down, and reports texts/toolCalls', async () => {
    const events: AgentEvent[] = [
      { kind: 'text', text: 'pong 42' },
      { kind: 'tool_call', server: 'wechat', tool: 'ping' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 5 },
    ]
    let spawnedCtx: SpawnContext | undefined
    let spawnedProject: AgentProject | undefined
    const closeSpy = vi.fn(async () => {})
    const session: AgentSession = { ...makeFakeSession({ events }), close: closeSpy }
    const mintSessionToken = vi.fn((_tier: string, _key: string, _opts?: { routeAllow?: ReadonlySet<string>; ttlMs?: number }) => 'tok-abc')
    const invalidateSession = vi.fn()
    const registry = makeRegistry(session, {
      onSpawn: (project, ctx) => { spawnedProject = project; spawnedCtx = ctx },
    })

    const deps = makeDeps({ registry, mintSessionToken, invalidateSession })
    const result = await runSelftestConverse(deps, { providerId: 'claude', text: 'ping' })

    expect(result).toEqual({
      ok: true,
      providerId: 'claude',
      sessionId: 's1',
      texts: ['pong 42'],
      toolCalls: ['wechat/ping'],
      durationMs: expect.any(Number),
    })

    // mintSessionToken called with trusted tier, a THREE-part session key
    // (provider/alias/chatId — internal-api derives callerChatId as
    // `split('/').slice(2)`, so a two-part key means no chat identity at
    // all), routeAllow scoped to health only, and a bounded TTL.
    expect(mintSessionToken).toHaveBeenCalledTimes(1)
    const [tier, key, opts] = mintSessionToken.mock.calls[0]!
    expect(tier).toBe('trusted')
    expect(key.split('/')).toHaveLength(3)
    expect(key).toMatch(/^selftest\/selftest\/[0-9a-f-]{36}$/)
    expect(opts).toEqual({ routeAllow: new Set(['GET /v1/health']), ttlMs: 10 * 60_000 })

    // spawn ctx
    expect(spawnedCtx?.permissionMode).toBe('dangerously')
    expect(spawnedCtx?.chatId).toBe(key)
    expect(spawnedCtx?.mcpEnv?.WECHAT_SESSION_TOKEN).toBe('tok-abc')
    expect(spawnedCtx?.mcpEnv?.WECHAT_SESSION_TIER).toBe('trusted')
    expect(spawnedCtx?.appendInstructions).toContain('自检')
    expect(spawnedCtx?.resumeSessionId).toBeUndefined()

    // teardown
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(invalidateSession).toHaveBeenCalledWith(key)

    // scratch project lives in tmpdir, never beside the daemon's secrets
    expect(spawnedProject?.path).toBe(PROJECT_DIR)
    expect(existsSync(PROJECT_DIR)).toBe(true)
    expect(readFileSync(join(PROJECT_DIR, 'README.md'), 'utf8')).toBe('selftest scratch project\n')
  })

  it('does not clobber an existing README on a re-run', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(PROJECT_DIR, { recursive: true })
    writeFileSync(join(PROJECT_DIR, 'README.md'), 'custom content\n')

    const registry = makeRegistry(makeFakeSession({ events: [{ kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 1 }] }))
    await runSelftestConverse(makeDeps({ registry }), { providerId: 'claude', text: 'ping' })

    expect(readFileSync(join(PROJECT_DIR, 'README.md'), 'utf8')).toBe('custom content\n')
  })

  it('passes resumeSessionId through to spawn ctx when provided', async () => {
    let spawnedCtx: SpawnContext | undefined
    const registry = makeRegistry(
      makeFakeSession({ events: [{ kind: 'result', sessionId: 's2', numTurns: 1, durationMs: 1 }] }),
      { onSpawn: (_p, ctx) => { spawnedCtx = ctx } },
    )
    await runSelftestConverse(makeDeps({ registry }), { providerId: 'claude', text: 'hi', resumeSessionId: 'old-session' })

    expect(spawnedCtx?.resumeSessionId).toBe('old-session')
  })

  it('reports unavailable_provider and never mints a token when the provider is not registered', async () => {
    const mintSessionToken = vi.fn(() => 'unused')
    const registry: Pick<ProviderRegistry, 'get'> = { get: () => null }
    const result = await runSelftestConverse(makeDeps({ registry, mintSessionToken }), { providerId: 'nope', text: 'ping' })

    expect(result).toEqual({
      ok: false,
      providerId: 'nope',
      sessionId: null,
      texts: [],
      toolCalls: [],
      error: 'unavailable_provider',
      durationMs: expect.any(Number),
    })
    expect(mintSessionToken).not.toHaveBeenCalled()
  })

  it('surfaces an error event as ok:false with error/errorCode', async () => {
    const registry = makeRegistry(makeFakeSession({ events: [{ kind: 'error', message: 'boom', code: 'auth_failed' }] }))
    const result = await runSelftestConverse(makeDeps({ registry }), { providerId: 'claude', text: 'ping' })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('boom')
    expect(result.errorCode).toBe('auth_failed')
  })

  it('does not throw when session.close() rejects, and logs one SELFTEST line', async () => {
    const events: AgentEvent[] = [{ kind: 'result', sessionId: 's3', numTurns: 1, durationMs: 1 }]
    const session: AgentSession = {
      ...makeFakeSession({ events }),
      close: async () => { throw new Error('close boom') },
    }
    const registry = makeRegistry(session)
    const log = vi.fn()
    const invalidateSession = vi.fn()

    const result = await runSelftestConverse(makeDeps({ registry, log, invalidateSession }), { providerId: 'claude', text: 'ping' })

    expect(result.ok).toBe(true)
    expect(result.sessionId).toBe('s3')
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toBe('SELFTEST')
    // teardown still proceeds despite close() throwing
    expect(invalidateSession).toHaveBeenCalled()
  })

  // I4 — the route's contract is a RESULT, never an exception, and the
  // minted token must not survive a throwing spawn/turn.
  it('spawn throwing ⇒ ok:false with the message, and the session token is still invalidated', async () => {
    const registry: Pick<ProviderRegistry, 'get'> = {
      get: () => ({
        provider: { async spawn() { throw new Error('acp_auth_required') } },
        opts: { displayName: 'Cursor', canResume: () => true },
      } as never),
    }
    const invalidateSession = vi.fn()
    let mintedKey = ''
    const mintSessionToken = vi.fn((_tier: string, key: string) => { mintedKey = key; return 'tok-abc' })

    const result = await runSelftestConverse(
      makeDeps({ registry, invalidateSession, mintSessionToken }),
      { providerId: 'cursor', text: 'ping' },
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe('acp_auth_required')
    expect(result.sessionId).toBeNull()
    expect(result.texts).toEqual([])
    expect(mintedKey).toMatch(/^selftest\/selftest\//)
    expect(invalidateSession).toHaveBeenCalledWith(mintedKey)
  })

  it('a throwing turn still closes the session and invalidates the token', async () => {
    const closeSpy = vi.fn(async () => {})
    const session: AgentSession = {
      ...makeFakeSession({ events: [] }),
      dispatch: () => { throw new Error('dispatch boom') },
      close: closeSpy,
    }
    const invalidateSession = vi.fn()
    const result = await runSelftestConverse(
      makeDeps({ registry: makeRegistry(session), invalidateSession }),
      { providerId: 'claude', text: 'ping' },
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe('dispatch boom')
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(invalidateSession).toHaveBeenCalledTimes(1)
  })
})
