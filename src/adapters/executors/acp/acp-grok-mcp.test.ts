import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { grokHome, grokSubprocessEnv } from '../../../lib/grok-home'
import { removeTempDir } from '../../../lib/test-temp'
import { TIER_PROFILES } from '../../../domain/user-tier'
import { createScriptedAcpAgent } from '../../../test-support/executors/acp-scripted-agent'
import { createAcpGrokProvider } from './acp-grok'
import { createMcpHttpBridge, type McpHttpBridge } from './mcp-http-bridge'
import { wireInstructions } from '../../../daemon/bootstrap/wire-instructions'
import { SessionManager } from '../../../app/session-manager'
import { createProviderRegistry } from '../../../app/provider-registry'
import { NO_CC_MCP_INSTRUCTIONS } from '../../../domain/provider-capabilities'

const dirs: string[] = []
const bridges: McpHttpBridge[] = []
afterEach(async () => { await Promise.all(bridges.splice(0).map(b => b.close())); for (const dir of dirs.splice(0)) removeTempDir(dir) })
const fixture = fileURLToPath(new URL('../../../test-support/fixtures/stdio-mcp-bridge.ts', import.meta.url))
const spec = { command: process.execPath, args: [...(process.versions.bun ? [] : ['--experimental-strip-types']), fixture] }
const project = { alias: 'offline-grok', path: process.cwd() }
const build = wireInstructions({ ilink: { companion: { status: () => ({ enabled: false }) } } } as any, { plugins: { delegateStdioByProvider: { grok: spec }, knowledgePluginNames: [] }, defaultProviderId: 'claude', knowledge: undefined, socialWired: () => false })
const context = { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' as const, chatId: 'offline', mcpEnv: { WECHAT_SESSION_TOKEN: 'offline-session', WECHAT_SESSION_TIER: 'admin' },
  appendInstructions: build('grok', TIER_PROFILES.admin, 'offline'),
  instructionsForMcp: (available: { wechat: boolean; delegate: boolean }) => build('grok', TIER_PROFILES.admin, 'offline', undefined, available) }
function setup(caps: Record<string, boolean | undefined> = { http: true }, turns = [{ steps: [{ say: 'offline' }] }], extra: Partial<Parameters<typeof createAcpGrokProvider>[0]> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'grok-mcp-')); dirs.push(stateDir)
  grokSubprocessEnv(stateDir, {})
  writeFileSync(join(grokHome(stateDir), '.grok/auth.json'), 'offline existence sentinel')
  const fake = createScriptedAcpAgent({ initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: caps } }, turns })
  const acpSpawn = vi.fn(fake.spawn)
  const bridge = vi.fn(async (...args: Parameters<typeof createMcpHttpBridge>) => { const b = await createMcpHttpBridge(...args); bridges.push(b); return b })
  const log = vi.fn()
  const provider = createAcpGrokProvider({ bin: '/fake/grok', stateDir, spawn: acpSpawn as unknown as typeof fake.spawn, log, networkPreflight: async () => true, mcpSpecs: { wechat: spec, delegate: spec }, bridge, ...extra })
  return { fake, provider, bridge, log, acpSpawn }
}
function stallSetup({ acpSpawn, fake }: Pick<ReturnType<typeof setup>, 'acpSpawn' | 'fake'>) {
  const original = acpSpawn.getMockImplementation()!
  acpSpawn.mockImplementation(((...args: Parameters<typeof original>) => {
      const child = original(...args)
      const record = fake.children.at(-1)!
      const output = child.stdout!
      const emit = output.emit.bind(output)
      output.emit = ((event: string, ...values: unknown[]) => {
        if (event === 'data') {
          const response = JSON.parse(String(values[0]))
          const request = record.sent.find(r => r.id === response.id && r.method)
          if (request?.method === 'session/new') return true // Agent remains alive but never answers setup.
        }
        return emit(event, ...values)
      }) as typeof output.emit
      return child
    }) as typeof original)
}
async function drain(session: Awaited<ReturnType<ReturnType<typeof createAcpGrokProvider>['spawn']>>) { for await (const _ of session.dispatch('offline question')) { /* drain */ } }

describe.runIf(process.platform !== 'win32')('Grok negotiated MCP sessions', () => {
  it('injects HTTP credentials after initialize and rebuilds the real daemon prompt only on success', async () => {
    const { provider, fake, bridge } = setup()
    const reportMatterTools = vi.fn()
    const session = await provider.spawn(project, { ...context, reportMatterTools })
    try {
      expect(bridge).toHaveBeenCalledTimes(1)
      const sent = fake.children[0]!.sent
      expect(sent.findIndex(r => r.method === 'initialize')).toBeLessThan(sent.findIndex(r => r.method === 'session/new'))
      const servers = sent.find(r => r.method === 'session/new')!.params.mcpServers
      expect(servers.map((s: any) => [s.name, s.type])).toEqual([['wechat', 'http'], ['delegate', 'http']])
      expect(servers.every((s: any) => s.headers[0].name === 'Authorization' && !s.url.includes(s.headers[0].value.slice(7)))).toBe(true)
      expect(session.supportsDelegation).toBe(true)
      expect(reportMatterTools).toHaveBeenCalledWith(false)
      await drain(session)
      const prompt = fake.children[0]!.prompts[0]!
      expect(prompt).not.toContain(NO_CC_MCP_INSTRUCTIONS)
      expect(prompt).toContain('delegate_claude')
      expect(prompt).toContain('memory_read')
      expect(prompt).toContain('calendar_agenda')
    } finally { await session.close() }
    expect(bridges[0]!.active).toBe(false)
    expect(session.supportsDelegation).toBe(false)
  })
  it.each([{}, { http: false }, { sse: true }])('does not spawn MCP children for unsupported HTTP capabilities %j', async caps => {
    const { provider, fake, bridge } = setup(caps)
    const session = await provider.spawn(project, context)
    try {
      expect(bridge).not.toHaveBeenCalled()
      expect(fake.children[0]!.sent.find(r => r.method === 'session/new')!.params.mcpServers).toEqual([])
      expect(session.supportsDelegation).toBe(false)
      await drain(session)
      expect(fake.children[0]!.prompts[0]).toContain(NO_CC_MCP_INSTRUCTIONS)
      expect(fake.children[0]!.prompts[0]).not.toContain('delegate_claude')
    } finally { await session.close() }
  })
  it.each([false, true])('uses the real SessionManager instruction seam and revokes on daemon-session shutdown (failure=%s)', async failure => {
    const { provider, fake } = setup({ http: true }, undefined, failure ? { bridge: async () => { throw new Error('offline bridge failure') } } : {})
    const registry = createProviderRegistry()
    registry.register('grok', provider, { canResume: () => false })
    const manager = new SessionManager({ registry, maxConcurrent: 1, idleEvictMs: 60_000, buildInstructions: build })
    try {
      const handle = await manager.acquire({ alias: project.alias, path: project.path, providerId: 'grok', chatId: 'offline', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
      for await (const _ of handle.dispatch('offline question')) { /* real manager dispatch */ }
      expect(fake.children[0]!.prompts[0]!.includes(NO_CC_MCP_INSTRUCTIONS)).toBe(failure)
      expect(fake.children[0]!.prompts[0]!.includes('delegate_claude')).toBe(!failure)
      expect(handle.supportsDelegation).toBe(!failure)
      await manager.shutdown()
      expect(handle.supportsDelegation).toBe(false)
      if (!failure) expect(bridges[0]!.active).toBe(false)
    } finally { await manager.shutdown() }
  })
  it('revokes a bridge during pending ACP setup when the daemon session manager shuts down', async () => {
    const { provider, acpSpawn, fake } = setup()
    stallSetup({ acpSpawn, fake })
    const registry = createProviderRegistry()
    registry.register('grok', provider, { canResume: () => false })
    const invalidate = vi.fn()
    const manager = new SessionManager({ registry, maxConcurrent: 1, idleEvictMs: 60_000, buildInstructions: build, invalidateSessionToken: invalidate, mintSessionToken: () => 'offline-internal' })
    const opening = manager.acquire({ alias: project.alias, path: project.path, providerId: 'grok', chatId: 'offline', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    const result = opening.catch(error => error)
    try {
    await expect.poll(() => fake.children[0]?.sent.some(r => r.method === 'session/new')).toBe(true)
    expect(bridges[0]!.active).toBe(true)
    const stopped = manager.shutdown()
    expect(bridges[0]!.active).toBe(false)
    expect(invalidate).toHaveBeenCalledWith(`grok/${project.alias}/offline`)
    await stopped
    expect(await result).toBeInstanceOf(Error)
    expect((await result as Error).message).toContain('acp_session_closed')
    expect(manager.has({ alias: project.alias, providerId: 'grok', chatId: 'offline' })).toBe(false)
    await expect(fetch(bridges[0]!.servers[0]!.url)).rejects.toThrow()
    } finally {
      acpSpawn.mock.results[0]?.value.kill('SIGTERM') // In-memory ACP process only.
      await manager.shutdown()
      await result
    }
  })
  it.each(['shutdown', 'shutdownProtected'] as const)('%s revokes live and pending bridges before awaiting either close', async method => {
    const fixture = setup()
    const registry = createProviderRegistry()
    registry.register('grok', fixture.provider, { canResume: () => false })
    const manager = new SessionManager({ registry, maxConcurrent: 2, idleEvictMs: 60_000 })
    let opening: Promise<unknown> | undefined
    try {
      await manager.acquire({ alias: project.alias, path: project.path, providerId: 'grok', chatId: 'live', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
      stallSetup(fixture)
      opening = manager.acquire({ alias: project.alias, path: project.path, providerId: 'grok', chatId: 'pending', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' }).catch(error => error)
      await expect.poll(() => fixture.fake.children[1]?.sent.some(r => r.method === 'session/new')).toBe(true)
      const stopped = manager[method]()
      expect(bridges[0]!.active).toBe(false)
      expect(bridges[1]!.active).toBe(false)
      await stopped
      expect(await opening).toBeInstanceOf(Error)
      expect(manager.has({ alias: project.alias, providerId: 'grok', chatId: 'live' })).toBe(false)
      expect(manager.has({ alias: project.alias, providerId: 'grok', chatId: 'pending' })).toBe(false)
    } finally {
      for (const result of fixture.acpSpawn.mock.results) result.value?.kill('SIGTERM')
      await manager.shutdown()
      await opening
    }
  })
  it('preserves append text items while redacting a streamed bearer', async () => {
    let credential = ''
    const { provider } = setup({ http: true }, (() => ({ steps: [{ say: `plain${credential.slice(0, 1)}` }, { native: 'read', title: 'offline read', path: '/offline' }, { say: `echo ${credential}` }] })) as any, { workbench: true, matterMcp: () => spec })
    const session = await provider.spawn(project, context)
    try {
      credential = bridges[0]!.servers[0]!.headers[0]!.value.slice(7)
      const items = new Map<string, string>()
      for await (const event of session.dispatch('offline')) if (event.kind === 'text') items.set(event.itemId!, (items.get(event.itemId!) ?? '') + event.text)
      expect([...items.values()]).toEqual([`plain${credential.slice(0, 1)}`, 'echo [redacted]'])
    } finally { await session.close() }
  })
  it('retries explicit ACP MCP setup rejection once without tools and redacts the rejected credential', async () => {
    const { provider, fake, acpSpawn, log } = setup()
    const original = acpSpawn.getMockImplementation()!
    acpSpawn.mockImplementation(((...args: Parameters<typeof original>) => {
      const child = original(...args)
      child.stdin!.on('data', data => {
        const request = JSON.parse(String(data))
        if (request.method === 'session/new' && request.params.mcpServers.length) {
          const secret = request.params.mcpServers[0].headers[0].value
          child.stdout!.emit('data', JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `MCP connect rejected: ${secret}` } }) + '\n')
        }
      })
      return child
    }) as typeof original)
    const session = await provider.spawn(project, context)
    try {
      const requests = fake.children[0]!.sent.filter(r => r.method === 'session/new')
      expect(requests).toHaveLength(2)
      expect(requests[0]!.params.mcpServers).toHaveLength(2)
      expect(requests[1]!.params.mcpServers).toEqual([])
      expect(bridges[0]!.active).toBe(false)
      expect(session.supportsDelegation).toBe(false)
      await drain(session)
      expect(fake.children[0]!.prompts[0]).toContain(NO_CC_MCP_INSTRUCTIONS)
      const secret = requests[0]!.params.mcpServers[0].headers[0].value.slice(7)
      expect(log.mock.calls.every(row => !row.join(' ').includes(secret))).toBe(true)
    } finally { await session.close() }
  })
  it('closes an already-started bridge if negotiated prompt construction fails', async () => {
    const { provider, fake } = setup()
    const session = await provider.spawn(project, { ...context, instructionsForMcp: available => {
      if (available.wechat) throw new Error('offline prompt failure')
      return NO_CC_MCP_INSTRUCTIONS
    } })
    try {
      expect(bridges[0]!.active).toBe(false)
      expect(fake.children[0]!.sent.find(r => r.method === 'session/new')!.params.mcpServers).toEqual([])
      await drain(session)
      expect(fake.children[0]!.prompts[0]).toContain(NO_CC_MCP_INSTRUCTIONS)
    } finally { await session.close() }
  })
  it('falls back honestly when stdio spawn/listen fails, without exposing the original error', async () => {
    const bridge = vi.fn(async () => { throw new Error('private startup diagnostic') })
    const { provider, fake, log } = setup({ http: true }, undefined, { bridge })
    const reportMatterTools = vi.fn()
    const session = await provider.spawn(project, { ...context, reportMatterTools })
    try {
      await drain(session)
      expect(bridge).toHaveBeenCalledTimes(1)
      expect(session.supportsDelegation).toBe(false)
      expect(fake.children[0]!.sent.find(r => r.method === 'session/new')!.params.mcpServers).toEqual([])
      expect(fake.children[0]!.prompts[0]).toContain(NO_CC_MCP_INSTRUCTIONS)
      expect(reportMatterTools).toHaveBeenCalledWith(false)
      expect(log.mock.calls.flat().join(' ')).not.toContain('private startup diagnostic')
    } finally { await session.close() }
  })
  it('passes notebook spec authorization unchanged and reports actual notebook availability', async () => {
    const matterMcp = vi.fn((_context: unknown) => ({ ...spec, env: { MATTER_AUTH_SENTINEL: 'offline-notebook' } }))
    const { provider, fake, bridge } = setup({ http: true }, undefined, { workbench: true, matterMcp })
    const reportMatterTools = vi.fn()
    const session = await provider.spawn(project, { ...context, matterLedger: true, reportMatterTools, appendInstructions: 'notebook task' })
    try {
      expect(matterMcp.mock.calls[0]![0]).toMatchObject({ matterLedger: true, mcpEnv: context.mcpEnv })
      const specs = bridge.mock.calls[0]![0]
      expect(specs.map(({ name, command, args }) => ({ name, command, args }))).toEqual([{ name: 'wechat-cc-matter', command: spec.command, args: spec.args }])
      expect(specs[0]!.env.find(e => e.name === 'MATTER_AUTH_SENTINEL')?.value).toBe('offline-notebook')
      expect(bridge.mock.calls[0]![0][0]!.env.some(e => e.name === 'WECHAT_SESSION_TOKEN')).toBe(false)
      expect(reportMatterTools).toHaveBeenCalledWith(true)
      expect(session.supportsDelegation).toBe(false)
      await drain(session)
      expect(fake.children[0]!.prompts[0]).toContain('notebook task')
      expect(fake.children[0]!.prompts[0]).not.toContain(NO_CC_MCP_INSTRUCTIONS)
    } finally { await session.close() }
  })
  it('revokes an idle MCP session immediately when cancel is requested', async () => {
    const { provider } = setup()
    const session = await provider.spawn(project, context)
    const stopped = session.cancel!()
    expect(bridges[0]!.active).toBe(false)
    await stopped
    expect(session.supportsDelegation).toBe(false)
    expect(() => session.dispatch('after idle cancel')).toThrow('acp_session_closed')
    await session.close()
  })
  it('rotates bearer on resume, revokes on cancellation and prevents a tool-less cached redispatch', async () => {
    const { provider, fake } = setup({ http: true }, [{ steps: [{ delayMs: 300 }] }] as any)
    const first = await provider.spawn(project, context)
    const firstServer = bridges[0]!.servers[0]!
    await first.close()
    const next = await provider.spawn(project, { ...context, resumeSessionId: 'offline-resume' })
    try {
      const nextServer = bridges[1]!.servers[0]!
      expect(nextServer.headers[0]!.value === firstServer.headers[0]!.value).toBe(false)
      expect(fake.children[1]!.sent.find(r => r.method === 'session/load')!.params.mcpServers[0].headers).toEqual(nextServer.headers)
      const turn = drain(next)
      await next.cancel!()
      expect(bridges[1]!.active).toBe(false)
      await turn
      expect(() => next.dispatch('after cancel')).toThrow('acp_session_closed')
    } finally { await next.close() }
  })
  it('keeps complete reply boundaries when ordinary text ends in a bearer prefix', async () => {
    let prefix = ''
    const { provider } = setup({ http: true }, (() => ({ steps: [{ say: `result${prefix}` }, { native: 'read', title: 'offline read', path: '/offline' }, { say: 'after tool' }] })) as any)
    const session = await provider.spawn(project, context)
    try {
      prefix = bridges[0]!.servers[0]!.headers[0]!.value.slice(7, 8)
      const text: string[] = []
      for await (const event of session.dispatch('offline')) if (event.kind === 'text') text.push(event.text)
      expect(text).toEqual([`result${prefix}`, 'after tool'])
    } finally { await session.close() }
  })
  it('scrubs a bearer echoed by the agent before it reaches reply events', async () => {
    let credential = ''
    const { provider, log } = setup({ http: true }, (() => ({ steps: [{ say: `echo ${credential}` }] })) as any)
    const session = await provider.spawn(project, context)
    try {
      credential = bridges[0]!.servers[0]!.headers[0]!.value.slice(7)
      const events = []
      for await (const event of session.dispatch('offline')) events.push(event)
      expect(events).toContainEqual({ kind: 'text', text: 'echo [redacted]' })
      expect(JSON.stringify(events).includes(credential)).toBe(false)
      expect(log.mock.calls.every(row => !row.join(' ').includes(credential))).toBe(true)
    } finally { await session.close() }
  })
  it('revokes MCP immediately on ACP process exit and redacts echoed credentials from events/logs', async () => {
    let credential = ''
    const { provider, acpSpawn, log } = setup({ http: true }, [] as any)
    const session = await provider.spawn(project, context)
    try {
      credential = bridges[0]!.servers[0]!.headers[0]!.value.slice(7)
      const child = acpSpawn.mock.results[0]!.value
      child.stderr!.emit('data', `echo ${credential}`)
      child.emit('exit', 1, null)
      expect(bridges[0]!.active).toBe(false)
      expect(log.mock.calls.every(row => !row.join(' ').includes(credential))).toBe(true)
      expect(session.supportsDelegation).toBe(false)
    } finally { await session.close() }
  })
})
