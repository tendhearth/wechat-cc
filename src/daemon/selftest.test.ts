import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelftestConverse, type SelftestConverseDeps } from './selftest'
import { makeFakeSession } from '../core/test-helpers'
import type { AgentEvent, AgentProject, AgentSession, SpawnContext } from '../core/agent-provider'
import type { ProviderRegistry } from '../core/provider-registry'

function makeStateDir() {
  return mkdtempSync(join(tmpdir(), 'selftest-'))
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

function makeDeps(overrides: Partial<SelftestConverseDeps> & { stateDir: string }): SelftestConverseDeps {
  return {
    registry: overrides.registry ?? makeRegistry(makeFakeSession({ events: [] })),
    mintSessionToken: overrides.mintSessionToken ?? vi.fn(() => 'tok-abc'),
    invalidateSession: overrides.invalidateSession ?? vi.fn(),
    stateDir: overrides.stateDir,
    log: overrides.log ?? vi.fn(),
    now: overrides.now,
  }
}

describe('runSelftestConverse', () => {
  it('spawns a scoped session, drains one turn, tears it down, and reports texts/toolCalls', async () => {
    const stateDir = makeStateDir()
    try {
      const events: AgentEvent[] = [
        { kind: 'text', text: 'pong 42' },
        { kind: 'tool_call', server: 'wechat', tool: 'ping' },
        { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 5 },
      ]
      let spawnedCtx: SpawnContext | undefined
      let spawnedProject: AgentProject | undefined
      const closeSpy = vi.fn(async () => {})
      const session: AgentSession = { ...makeFakeSession({ events }), close: closeSpy }
      const mintSessionToken = vi.fn((_tier: string, _key: string, _opts?: { routeAllow?: ReadonlySet<string> }) => 'tok-abc')
      const invalidateSession = vi.fn()
      const registry = makeRegistry(session, {
        onSpawn: (project, ctx) => { spawnedProject = project; spawnedCtx = ctx },
      })

      const deps = makeDeps({ stateDir, registry, mintSessionToken, invalidateSession })
      const result = await runSelftestConverse(deps, { providerId: 'claude', text: 'ping' })

      expect(result).toEqual({
        ok: true,
        providerId: 'claude',
        sessionId: 's1',
        texts: ['pong 42'],
        toolCalls: ['wechat/ping'],
        durationMs: expect.any(Number),
      })

      // mintSessionToken called with trusted tier, a selftest/-prefixed
      // session key, and routeAllow scoped to health only.
      expect(mintSessionToken).toHaveBeenCalledTimes(1)
      const [tier, key, opts] = mintSessionToken.mock.calls[0]!
      expect(tier).toBe('trusted')
      expect(key).toMatch(/^selftest\//)
      expect(opts).toEqual({ routeAllow: new Set(['GET /v1/health']) })

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

      // scratch project
      expect(spawnedProject?.path).toBe(join(stateDir, 'selftest', 'project'))
      expect(existsSync(join(stateDir, 'selftest', 'project'))).toBe(true)
      expect(readFileSync(join(stateDir, 'selftest', 'project', 'README.md'), 'utf8')).toBe('selftest scratch project\n')
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('does not clobber an existing README on a re-run', async () => {
    const stateDir = makeStateDir()
    try {
      const projectDir = join(stateDir, 'selftest', 'project')
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, 'README.md'), 'custom content\n')

      const registry = makeRegistry(makeFakeSession({ events: [{ kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 1 }] }))
      const deps = makeDeps({ stateDir, registry })
      await runSelftestConverse(deps, { providerId: 'claude', text: 'ping' })

      expect(readFileSync(join(projectDir, 'README.md'), 'utf8')).toBe('custom content\n')
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('passes resumeSessionId through to spawn ctx when provided', async () => {
    const stateDir = makeStateDir()
    try {
      let spawnedCtx: SpawnContext | undefined
      const registry = makeRegistry(
        makeFakeSession({ events: [{ kind: 'result', sessionId: 's2', numTurns: 1, durationMs: 1 }] }),
        { onSpawn: (_p, ctx) => { spawnedCtx = ctx } },
      )
      const deps = makeDeps({ stateDir, registry })
      await runSelftestConverse(deps, { providerId: 'claude', text: 'hi', resumeSessionId: 'old-session' })

      expect(spawnedCtx?.resumeSessionId).toBe('old-session')
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('reports unavailable_provider and never mints a token when the provider is not registered', async () => {
    const stateDir = makeStateDir()
    try {
      const mintSessionToken = vi.fn(() => 'unused')
      const registry: Pick<ProviderRegistry, 'get'> = { get: () => null }
      const deps = makeDeps({ stateDir, registry, mintSessionToken })

      const result = await runSelftestConverse(deps, { providerId: 'nope', text: 'ping' })

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
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('surfaces an error event as ok:false with error/errorCode', async () => {
    const stateDir = makeStateDir()
    try {
      const registry = makeRegistry(makeFakeSession({ events: [{ kind: 'error', message: 'boom', code: 'auth_failed' }] }))
      const deps = makeDeps({ stateDir, registry })

      const result = await runSelftestConverse(deps, { providerId: 'claude', text: 'ping' })

      expect(result.ok).toBe(false)
      expect(result.error).toBe('boom')
      expect(result.errorCode).toBe('auth_failed')
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('does not throw when session.close() rejects, and logs one SELFTEST line', async () => {
    const stateDir = makeStateDir()
    try {
      const events: AgentEvent[] = [{ kind: 'result', sessionId: 's3', numTurns: 1, durationMs: 1 }]
      const session: AgentSession = {
        ...makeFakeSession({ events }),
        close: async () => { throw new Error('close boom') },
      }
      const registry = makeRegistry(session)
      const log = vi.fn()
      const invalidateSession = vi.fn()
      const deps = makeDeps({ stateDir, registry, log, invalidateSession })

      const result = await runSelftestConverse(deps, { providerId: 'claude', text: 'ping' })

      expect(result.ok).toBe(true)
      expect(result.sessionId).toBe('s3')
      expect(log).toHaveBeenCalledTimes(1)
      expect(log.mock.calls[0]![0]).toBe('SELFTEST')
      // teardown still proceeds despite close() throwing
      expect(invalidateSession).toHaveBeenCalled()
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })
})
