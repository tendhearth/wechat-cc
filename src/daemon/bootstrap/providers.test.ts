import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { writeWarmExecFixture } from '../../lib/test-temp'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { registerProviders, type ProviderDeps } from './providers'
import { openTestDb } from '../../lib/db'
import { makeConversationStore } from '../../adapters/store/conversation-store'
import type { AgentConfig } from '../../lib/agent-config'
import {saveAgentConfig} from '../../lib/agent-config'
import type { McpStdioSpec } from '../../adapters/executors/mcp-stdio-spec'
import { AGY_WECHAT_MCP_NAMESPACE_ID } from './agy-mcp-config'
import { TIER_PROFILES } from '../../domain/user-tier'
import { classifyCall, type CallTarget } from '../../lib/call-classifier'
import { APP_VERSION, BUILD_SHA } from '../../lib/app-version'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { authFailNotice, turnErrorNotice } from '../../app/coordinator/failures'
import { collectTurn } from '../../ports/agent-provider'
import { probeEndpointKey } from '../../app/first-use-probe'

const fakeProbe = vi.hoisted(() => ({
  error: null as string | null,
  codexError: null as string | null,
  codexEmpty: false,
  codexReroute: false,
  codexTurns: [] as string[],
  claudeOneShots: [] as string[],
  claudeInputs: [] as string[],
  claudeSettings: {} as Record<string, unknown>,
  claudeCalls: [] as Array<{ cwd?: string; sources?: Options['settingSources']; maxTurns?: number }>,
  codexStartupFailure: null as 'config' | 'thread' | null,
  codexResumeModel: null as string | null,
  claudeResult: null as { result: string; api_error_status: number; sdkError?: string } | null,
  models: {} as Record<string, unknown>,
  codexConfig: new Map<string, Record<string, unknown>>(),
  codexThreads: [] as Array<{ cwd: unknown; cheap: boolean }>,
  codexGateway: {} as Record<string, unknown>,
}))

const probeGateway = 'https://gateway.example/v1'
function gatewayConfig(baseUrl = probeGateway, model?: string) {
  return {
    ...(model ? { model } : {}),
    model_provider: 'gateway',
    model_providers: { gateway: { base_url: baseUrl, wire_api: 'responses' } },
  }
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query(request: { prompt: string | AsyncIterable<{ message: { content: unknown } }>; options?: Options }) {
    const { prompt, options } = request
    fakeProbe.claudeCalls.push({ cwd: options?.cwd, sources: options?.settingSources, maxTurns: options?.maxTurns })
    const turn = async function* () {
      if (fakeProbe.error) throw new Error(fakeProbe.error)
      if (fakeProbe.claudeResult?.sdkError) {
        yield { type: 'assistant', error: fakeProbe.claudeResult.sdkError, message: { content: [{ type: 'text', text: fakeProbe.claudeResult.result }] } }
      }
      yield fakeProbe.claudeResult
        ? { type: 'result', subtype: 'success', is_error: true, ...fakeProbe.claudeResult }
        : { type: 'result', subtype: 'success', result: 'Claude real reply' }
    }
    return Object.assign((async function* () {
      if (typeof prompt === 'string') {
        fakeProbe.claudeOneShots.push(prompt)
        yield* turn()
        return
      }
      for await (const { message } of prompt) {
        const input = (message.content as Array<{ text?: string }>).map(block => block.text ?? '').join('')
        fakeProbe.claudeInputs.push(input)
        yield { type: 'system', subtype: 'init', model: 'claude-reported', session_id: 'claude-session' }
        yield* turn()
      }
    })(), { getSettings: async () => ({ effective: fakeProbe.claudeSettings, sources: [] }) })
  },

}))

vi.mock('../../adapters/executors/codex/codex-app-server-process', async () => {
  const { createScriptedCodex } = await import('../../test-support/executors/codex-scripted')
  const scripted = createScriptedCodex({
    turns: input => {
      fakeProbe.codexTurns.push(input)
      return { steps: fakeProbe.codexError || fakeProbe.codexEmpty ? [] : [
        ...(fakeProbe.codexReroute ? [
          { notify: { method: 'model/rerouted', params: { turnId: 'stale-turn', toModel: 'stale-model' } } },
          { notify: { method: 'model/rerouted', params: { toModel: 'rerouted-model' } } },
        ] : []),
        { say: 'native reply' },
      ], fail: fakeProbe.codexError ?? undefined }
    },
    cheapAnswer: () => 'evaluation answer',
    rewrite: message => {
      if (fakeProbe.codexStartupFailure === 'config' && message.result?.config ||
          fakeProbe.codexStartupFailure === 'thread' && message.result?.thread) {
        return { id: message.id, error: { code: -32601, message: 'Method not found' } }
      }
      if (message.result?.thread?.id === 'resumed-thread' && fakeProbe.codexResumeModel) {
        return { ...message, result: { ...message.result, model: fakeProbe.codexResumeModel } }
      }
      return message
    },
    configForCwd: cwd => fakeProbe.codexConfig.get(cwd) ?? fakeProbe.codexGateway,
    onThreadStart: (_method, params, cheap) => {
      fakeProbe.codexThreads.push({ cwd: params.cwd, cheap })
      if (cheap) fakeProbe.models.codex = params.model
    },
  })
  return { spawnCodexAppServerProcess: scripted.spawn }
})

/**
 * A tiny real executable that exits 0 on `--version` — stands in for the
 * `agy` CLI so these tests never depend on (or spawn) the real Antigravity
 * binary, and pass identically whether or not the host machine happens to
 * have one installed. `agyVersionOk` (agy-version-check.ts) just spawns
 * `[bin, '--version']` and checks the exit code, so a one-line shell script
 * satisfies it exactly like a real CLI would.
 *
 * 用 writeWarmExecFixture 而不是自己 writeFileSync + chmodSync:刚写出来的可执行
 * 文件第一次 exec 要付一笔一次性校验开销,满载套件里能涨到 4886ms,把
 * `agyVersionOk` 缺省的 5s 探测窗口吃穿 ⇒ 下面三条 opt-in 用例随机红成
 * `expected false to be true`。完整的量和推理在 test-temp.ts 那个函数的注释里。
 */
function makeFakeAgyBin(dir: string): string {
  const path = join(dir, 'fake-agy')
  writeWarmExecFixture(path, '#!/bin/sh\necho "1.0.0-fake"\nexit 0\n')
  return path
}

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: 'claude',
    dangerouslySkipPermissions: false,
    autoStart: false,
    closeStopsDaemon: false,
    ...overrides,
  }
}

function baseDeps(overrides: Partial<ProviderDeps> = {}): ProviderDeps {
  const db = openTestDb()
  return {
    // No-op default — callers that want to observe log lines go through
    // baseDepsWithLogs below, which overrides this via `overrides.log`.
    log: () => {},
    stateDir: mkdtempSync(join(tmpdir(), 'providers-test-state-')),
    ilink: { askUser: vi.fn(), companion: { status: () => ({ enabled: false }) } } as unknown as ProviderDeps['ilink'],
    configuredAgent: baseConfig(),
    permissionMode: 'strict',
    conversationStore: makeConversationStore(db),
    sdkOptionsForProject: (() => ({})) as unknown as ProviderDeps['sdkOptionsForProject'],
    claudeBin: undefined,
    currentClaudeModel: () => 'claude-x',
    resolveAdminChatId: () => null,
    pluginMcp: {},
    wechatStdioForCodex: null,
    delegateStdioForCodex: null,
    wechatStdioForCursor: null,
    delegateStdioForCursor: null,
    wechatStdioForOpenai: null,
    delegateStdioForOpenai: null,
    wechatStdioForGemini: null,
    wechatStdioForAgy: null,
    turnTimeoutMs: 60_000,
    ...overrides,
  } as ProviderDeps
}

// Expose the logs array captured above via a small wrapper so tests can
// assert on BOOT lines without threading a second out-param through
// baseDeps's return type.
function baseDepsWithLogs(overrides: Partial<ProviderDeps> = {}): { deps: ProviderDeps; logs: Array<[string, string]> } {
  const logs: Array<[string, string]> = []
  const deps = baseDeps({ log: (tag, line) => logs.push([tag, line]), ...overrides })
  return { deps, logs }
}

const fakeWechatSpec: McpStdioSpec = {
  command: '/usr/bin/bun',
  args: ['/abs/path/src/mcp-servers/wechat/main.ts'],
  env: { WECHAT_INTERNAL_API: 'http://127.0.0.1:1234', WECHAT_INTERNAL_TOKEN_FILE: '/state/internal-token' },
}

describe('registerProviders — first-use probe messages', () => {
  async function withCodexFixture(run: (deps: ProviderDeps, logs: Array<[string, string]>, fetchProbe: ReturnType<typeof vi.fn>) => Promise<void>) {
    const { deps, logs } = baseDepsWithLogs({
      probeVersion: async () => ({ ok: true, firstLine: 'codex-cli 1.2.3', ms: 0 }),
    })
    writeFileSync(join(deps.stateDir, process.platform === 'win32' ? 'codex.exe' : 'codex'), '')
    vi.stubEnv('PATH', [deps.stateDir, process.env.PATH].join(delimiter))
    vi.stubEnv('WECHAT_CC_DISABLE_CODEX_AUTOFIX', '1')
    vi.stubEnv('CODEX_MODEL', undefined)
    vi.stubEnv('CODEX_HOME', deps.stateDir)
    const fetchProbe = vi.fn(async () => { throw new Error('daemon must not fetch the Codex gateway') })
    vi.stubGlobal('fetch', fetchProbe)
    fakeProbe.codexGateway = gatewayConfig()
    const configPath = join(deps.stateDir, 'config.toml')
    writeFileSync(configPath, `model_provider = "gateway"\n[model_providers.gateway]\nname = "Gateway"\nbase_url = "${probeGateway}"\nwire_api = "responses"\n`)
    try { await run(deps, logs, fetchProbe) }
    finally {
      fakeProbe.error = null
      fakeProbe.codexError = null
      fakeProbe.codexStartupFailure = null
      fakeProbe.codexResumeModel = null
      fakeProbe.codexEmpty = false
      fakeProbe.codexReroute = false
      fakeProbe.codexTurns = []
      fakeProbe.models = {}
      fakeProbe.codexConfig.clear()
      fakeProbe.codexThreads = []
      fakeProbe.codexGateway = {}
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
      rmSync(deps.stateDir, { recursive: true, force: true })
    }
  }

  const probeCtx = { chatId: 'probe', permissionMode: 'strict', tierProfile: TIER_PROFILES.guest } as const

  it('documents real-turn confirmation for both providers in the checkup handbook', () => {
    const handbook = readFileSync(new URL('../../../docs/maintainer/butler-checkup.md', import.meta.url), 'utf8')
    expect(handbook).toContain('Claude 和 Codex 都由真实的对话回合确认连接')
    expect(handbook).not.toContain('可复现的 Responses 网关用单独的 HTTP 请求探测')
    expect(handbook).not.toContain('环境变量密钥只用于用户配置层')
  })

  it('uses the native project model and endpoint without a request before the first real Codex turn', () => withCodexFixture(async (deps, _logs, fetchProbe) => {
    const user = { alias: 'user-default', path: join(deps.stateDir, 'ordinary') }
    const project = { alias: 'project', path: join(deps.stateDir, 'project') }
    mkdirSync(user.path)
    mkdirSync(join(project.path, '.codex'), { recursive: true })
    writeFileSync(join(deps.stateDir, 'config.toml'), 'model = "bad-default"\n')
    writeFileSync(join(project.path, '.codex', 'config.toml'), 'model = "project-model"\n')
    fakeProbe.codexConfig.set(user.path, gatewayConfig(probeGateway, 'bad-default'))
    fakeProbe.codexConfig.set(project.path, gatewayConfig(probeGateway, 'project-model'))
    const targets: CallTarget[] = []
    deps.networkGate = {
      classify: target => { targets.push(target); return classifyCall(target) },
      check: async () => ({ safe: true, source: 'off', detail: 'test' }),
    }
    const { registry, stopProviderProbes } = await registerProviders(deps)
    try {
      const provider = registry.get('codex')!.provider
      const ordinary = await provider.spawn(user, probeCtx)
      try {
        fakeProbe.codexError = 'model not found'
        expect((await collectTurn(ordinary.dispatch('use ordinary model'))).errorCode).toBe('incompatible')
      } finally { await ordinary.close() }

      fakeProbe.codexError = null
      const session = await provider.spawn(project, { ...probeCtx, appendInstructions: 'owner thread instruction' })
      try {
        const path = join(deps.stateDir, 'first-use-probes.json')
        expect(session.callTarget?.()?.model).toBe('project-model')
        expect(fetchProbe).not.toHaveBeenCalled()
        expect(fakeProbe.codexThreads).toEqual([{ cwd: user.path, cheap: false }, { cwd: project.path, cheap: false }])
        expect(fakeProbe.codexTurns).toEqual(['use ordinary model'])
        expect(existsSync(path)).toBe(false)
        expect((await collectTurn(session.dispatch('first project turn'))).assistantText.join('')).toBe('native reply')
        expect(fakeProbe.codexTurns).toEqual(['use ordinary model', 'first project turn'])
        expect(fetchProbe).not.toHaveBeenCalled()
        expect(targets).toContainEqual(expect.objectContaining({ model: 'project-model', baseUrl: probeGateway }))
        expect(JSON.parse(readFileSync(path, 'utf8')).codex).toEqual([
          expect.objectContaining({ model: 'project-model', endpoint: probeEndpointKey({ baseUrl: probeGateway }) }),
        ])
      } finally { await session.close() }
    } finally { stopProviderProbes() }
  }))

  it('isolates Codex confirmations and invalidation by endpoint for the same model across restarts', () => withCodexFixture(async (deps, _logs, fetchProbe) => {
    const a = { alias: 'A', path: join(deps.stateDir, 'a') }
    const b = { alias: 'B', path: join(deps.stateDir, 'b') }
    const model = 'same-model'
    mkdirSync(a.path)
    mkdirSync(b.path)
    const endpointB = 'https://other-gateway.example/v1'
    fakeProbe.codexConfig.set(a.path, gatewayConfig(probeGateway, model))
    fakeProbe.codexConfig.set(b.path, gatewayConfig(endpointB, model))
    async function run(check: (turn: (project: typeof a) => Promise<Awaited<ReturnType<typeof collectTurn>>>) => Promise<void>) {
      const { registry, stopProviderProbes } = await registerProviders(deps)
      try {
        await check(async project => {
          const session = await registry.get('codex')!.provider.spawn(project, probeCtx)
          try { return await collectTurn(session.dispatch('user turn')) }
          finally { await session.close() }
        })
      } finally { stopProviderProbes() }
    }
    const path = join(deps.stateDir, 'first-use-probes.json')
    await run(async turn => {
      expect((await turn(a)).error).toBeUndefined()
      expect((await turn(b)).error).toBeUndefined()
    })
    expect(JSON.parse(readFileSync(path, 'utf8')).codex).toEqual([
      expect.objectContaining({ model, endpoint: probeEndpointKey({ baseUrl: probeGateway }) }),
      expect.objectContaining({ model, endpoint: probeEndpointKey({ baseUrl: endpointB }) }),
    ])
    await run(async turn => {
      fakeProbe.codexError = 'protocol mismatch'
      expect((await turn(a)).errorCode).toBe('incompatible')
      expect(JSON.parse(readFileSync(path, 'utf8')).codex).toEqual([
        expect.objectContaining({ model, endpoint: probeEndpointKey({ baseUrl: endpointB }) }),
      ])
      fakeProbe.codexError = null
      expect((await turn(a)).error).toBeUndefined()
    })
    expect(JSON.parse(readFileSync(path, 'utf8')).codex).toHaveLength(2)
    expect(fetchProbe).not.toHaveBeenCalled()
  }))

  it('reports a successful reply under the unpinned Codex native default model', () => withCodexFixture(async (deps, _logs, fetchProbe) => {
    writeFileSync(join(deps.stateDir, 'config.toml'), '')
    fakeProbe.codexGateway = {}
    const { registry, providerNotes, stopProviderProbes } = await registerProviders(deps)
    try {
      const provider = registry.get('codex')!.provider
      const session = await provider.spawn({ alias: 'project', path: deps.stateDir }, probeCtx)
      try {
        expect(session.callTarget?.()?.model).toBe('scripted-model')
        expect(fetchProbe).not.toHaveBeenCalled()
        expect(fakeProbe.codexThreads.every(thread => !thread.cheap)).toBe(true)
        expect(fakeProbe.codexTurns).toHaveLength(0)
        expect(providerNotes().codex).toContain('还没用过，第一次对话时确认')
        await collectTurn(session.dispatch('first real turn'))
        expect(providerNotes().codex).toContain('已通过对话确认连接')
        expect(JSON.parse(readFileSync(join(deps.stateDir, 'first-use-probes.json'), 'utf8')).codex)
          .toEqual([expect.objectContaining({ model: 'scripted-model', endpoint: 'native' })])
      } finally { await session.close() }
    } finally { stopProviderProbes() }
  }))

  it('confirms the model reported by Codex rerouting without changing the thread default', () => withCodexFixture(async deps => {
    const project = { alias: 'probe', path: deps.stateDir }
    const original = 'scripted-model'
    const path = join(deps.stateDir, 'first-use-probes.json')
    saveAgentConfig(deps.stateDir, baseConfig({ provider: 'codex', model: original }))
    const { registry, providerNotes, stopProviderProbes } = await registerProviders(deps)
    const provider = registry.get('codex')!.provider
    const session = await provider.spawn(project, probeCtx)
    try {
      fakeProbe.codexReroute = true
      expect((await collectTurn(session.dispatch('rerouted turn'))).assistantText.join('')).toBe('native reply')
      expect(JSON.parse(readFileSync(path, 'utf8')).codex).toEqual([expect.objectContaining({ model: 'rerouted-model' })])
      expect(providerNotes().codex).toContain('还没用过')
      expect(session.callTarget?.()?.model).toBe(original)

      const restarted = await registerProviders(deps)
      try {
        expect(restarted.providerNotes().codex).toContain('还没用过')
        saveAgentConfig(deps.stateDir, baseConfig({ provider: 'codex', model: 'rerouted-model' }))
        expect(restarted.providerNotes().codex).toContain('沿用上次的结果')
      } finally { restarted.stopProviderProbes() }
      saveAgentConfig(deps.stateDir, baseConfig({ provider: 'codex', model: original }))
      const fresh = await provider.spawn(project, probeCtx)
      try { expect(fresh.callTarget?.()?.model).toBe(original) }
      finally { await fresh.close() }

      fakeProbe.codexReroute = false
      await collectTurn(session.dispatch('ordinary next turn'))
      expect(providerNotes().codex).toContain('已通过对话确认连接')
      expect(JSON.parse(readFileSync(path, 'utf8')).codex.map((entry: { model: string }) => entry.model))
        .toEqual(['rerouted-model', original])
    } finally { await session.close(); stopProviderProbes() }
  }))

  it('requires a real reply after a Codex build change or a legacy confirmation', () => withCodexFixture(async (deps, _logs, fetchProbe) => {
    const project = { alias: 'probe', path: deps.stateDir }
    const recordPath = join(deps.stateDir, 'first-use-probes.json')
    const model = 'stable-model'
    saveAgentConfig(deps.stateDir, baseConfig({ provider: 'codex', model }))
    const sdkVersion = `${APP_VERSION}+${BUILD_SHA}`
    const endpoint = probeEndpointKey({ baseUrl: probeGateway })
    const oldRecords = [
      { cliVersion: '1.2.3', model, sdkVersion: APP_VERSION, at: 1000 },
      { cliVersion: '1.2.3', model, endpoint, sdkVersion: `${APP_VERSION}+previous-build`, at: 1000, confirmedByTurn: true },
      { cliVersion: '1.2.3', model, endpoint, sdkVersion, at: 1000 },
    ]
    for (const oldRecord of oldRecords) {
      writeFileSync(recordPath, JSON.stringify({ codex: [oldRecord] }))
      const { registry, providerNotes, stopProviderProbes } = await registerProviders(deps)
      try {
        const session = await registry.get('codex')!.provider.spawn(project, { ...probeCtx, model })
        try {
          expect(providerNotes().codex).toContain('还没用过，第一次对话时确认')
          expect(JSON.parse(readFileSync(recordPath, 'utf8')).codex).toEqual([oldRecord])
          await collectTurn(session.dispatch('user turn'))
          expect(JSON.parse(readFileSync(recordPath, 'utf8')).codex).toEqual([
            expect.objectContaining({ model, sdkVersion, confirmedByTurn: true }),
          ])
        } finally { await session.close() }
      } finally { stopProviderProbes() }
      const restarted = await registerProviders(deps)
      try { expect(restarted.providerNotes().codex).toContain('沿用上次的结果') }
      finally { restarted.stopProviderProbes() }
    }
    expect(fetchProbe).not.toHaveBeenCalled()
  }))

  it.each([
    { error: 'API Error: 529 overloaded', kind: 'transient', code: 'server_error', note: '暂时忙不过来（529）', notice: '暂时忙不过来', clears: false },
    { error: 'HTTP error: 403 Forbidden', kind: 'auth', code: 'auth_rejected', note: '拒绝了凭证（403）', notice: '请主人在电脑上检查一下账号或密钥', clears: false },
    { error: 'HTTP error: 429 insufficient_quota', kind: 'quota', code: 'quota', note: '额度用完了', notice: '等额度恢复,或者先换一个脑子', clears: false },
    { error: 'This model requires a newer version of Codex.', kind: 'incompatible', code: 'incompatible', note: '客户端协议不兼容', notice: '请检查 CLI 版本或换一个模型', clears: true },
    { error: null, kind: 'empty reply', code: 'incompatible', note: '客户端协议不兼容', notice: '请检查 CLI 版本或换一个模型', clears: true },
  ])('reports a real Codex $kind failure and sends the very next turn', ({ error, code, note, notice, clears }) => withCodexFixture(async (deps, _logs, fetchProbe) => {
    const model = 'stable-model'
    saveAgentConfig(deps.stateDir, baseConfig({ provider: 'codex', model }))
    const { registry, providerNotes, stopProviderProbes } = await registerProviders(deps)
    const path = join(deps.stateDir, 'first-use-probes.json')
    try {
      const session = await registry.get('codex')!.provider.spawn({ alias: 'probe', path: deps.stateDir }, probeCtx)
      try {
        await collectTurn(session.dispatch('confirm'))
        const saved = readFileSync(path, 'utf8')
        fakeProbe.codexError = error
        fakeProbe.codexEmpty = error === null
        const failure = await collectTurn(session.dispatch('fail'))
        expect(failure.errorCode).toBe(code)
        const message = code === 'auth_rejected' ? authFailNotice('codex', code) : turnErrorNotice('codex', failure.error, failure.errorCode)
        expect(message).toContain(notice)
        if (code === 'server_error') expect(message).not.toMatch(/版本|SDK|模型|登录|npm i/)
        expect(providerNotes().codex).toContain(note)
        const next = readFileSync(path, 'utf8')
        if (clears) expect(JSON.parse(next)).toEqual({})
        else expect(next).toBe(saved)
        fakeProbe.codexError = null
        fakeProbe.codexEmpty = false
      fakeProbe.codexReroute = false
        expect((await collectTurn(session.dispatch('try again now'))).assistantText.join('')).toBe('native reply')
        expect(fakeProbe.codexTurns).toEqual(['confirm', 'fail', 'try again now'])
        expect(fetchProbe).not.toHaveBeenCalled()
        expect(providerNotes().codex).toContain('已通过对话确认连接')
        if (clears) expect(JSON.parse(readFileSync(path, 'utf8')).codex).toHaveLength(1)
        else expect(readFileSync(path, 'utf8')).toBe(saved)
      } finally { await session.close() }
    } finally { stopProviderProbes() }
  }))

  it('runs a Codex evaluation on its own model while the chat model is unavailable', () => withCodexFixture(async (deps, _logs, fetchProbe) => {
    vi.stubEnv('WECHAT_CODEX_CHEAP_MODEL', 'codex-eval')
    saveAgentConfig(deps.stateDir, baseConfig({ provider: 'codex', model: 'codex-chat' }))
    const { registry, stopProviderProbes } = await registerProviders(deps)
    try {
      const provider = registry.get('codex')!.provider
      await expect(provider.cheapEval!('evaluate this')).resolves.toBe('evaluation answer')
      expect(fakeProbe.models.codex).toBe('codex-eval')
      const session = await provider.spawn({ alias: 'probe', path: deps.stateDir }, probeCtx)
      try {
        expect(session.callTarget?.()?.model).toBe('codex-chat')
        fakeProbe.codexError = 'model not found'
        expect((await collectTurn(session.dispatch('real turn'))).errorCode).toBe('incompatible')
        await expect(provider.cheapEval!('evaluate this')).resolves.toBe('evaluation answer')
        expect(fakeProbe.models.codex).toBe('codex-eval')
        expect(fetchProbe).not.toHaveBeenCalled()
        expect(existsSync(join(deps.stateDir, 'first-use-probes.json'))).toBe(false)
      } finally { await session.close() }
    } finally { stopProviderProbes() }
  }))

  it.each(['config', 'thread'] as const)('reports startup failure at Codex %s and invalidates only a known target', stage => withCodexFixture(async (deps) => {
    const model = 'stable-model'
    saveAgentConfig(deps.stateDir, baseConfig({ provider: 'codex', model }))
    const path = join(deps.stateDir, 'first-use-probes.json')
    const { registry, providerNotes, stopProviderProbes } = await registerProviders(deps)
    const provider = registry.get('codex')!.provider
    const project = { alias: 'probe', path: deps.stateDir }
    try {
      const session = await provider.spawn(project, probeCtx)
      try { await collectTurn(session.dispatch('confirm before failure')) }
      finally { await session.close() }
      const saved = readFileSync(path, 'utf8')
      fakeProbe.codexStartupFailure = stage
      await expect(provider.spawn(project, probeCtx)).rejects.toMatchObject({ providerErrorCode: 'incompatible' })
      expect(providerNotes().codex).toContain('模型或客户端协议不兼容')
      if (stage === 'config') {
        expect(providerNotes().codex).toContain('启动失败')
        expect(readFileSync(path, 'utf8')).toBe(saved)
      } else {
        expect(providerNotes().codex).not.toContain('启动失败')
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({})
      }
      fakeProbe.codexStartupFailure = null
      const retry = await provider.spawn(project, probeCtx)
      try {
        await collectTurn(retry.dispatch('retry now'))
        expect(providerNotes().codex).toContain('已通过对话确认连接')
      } finally { await retry.close() }
    } finally { stopProviderProbes() }
  }))

  it('keeps a resumed Codex reply on its retained model without pinning a new thread', () => withCodexFixture(async deps => {
    writeFileSync(join(deps.stateDir, 'config.toml'), '')
    fakeProbe.codexGateway = {}
    fakeProbe.codexResumeModel = 'retained-model'
    const project = { alias: 'probe', path: deps.stateDir }
    const { registry, providerNotes, stopProviderProbes } = await registerProviders(deps)
    const provider = registry.get('codex')!.provider
    try {
      expect(providerNotes().codex).toContain('还没用过')
      const resumed = await provider.spawn(project, { ...probeCtx, resumeSessionId: 'resumed-thread' })
      try {
        expect(resumed.resumedHistory).toBe(true)
        expect(resumed.callTarget?.()?.model).toBe('retained-model')
        await collectTurn(resumed.dispatch('continue after restart'))
        expect(providerNotes().codex).toContain('还没用过')
        const saved = JSON.parse(readFileSync(join(deps.stateDir, 'first-use-probes.json'), 'utf8'))
        expect(saved.codex).toEqual([expect.objectContaining({ model: 'retained-model' })])
        const fresh = await provider.spawn(project, probeCtx)
        try {
          expect(fresh.callTarget?.()?.model).toBe('scripted-model')
          expect(providerNotes().codex).toContain('还没用过')
        }
        finally { await fresh.close() }
      } finally { await resumed.close() }
    } finally { stopProviderProbes() }
  }))

  async function withClaudeFixture(run: (deps: ProviderDeps, project: { alias: string; path: string }) => Promise<void>) {
    const { deps } = baseDepsWithLogs({
      sdkOptionsForProject: (_alias, cwd) => ({ cwd, model: 'claude-configured', settingSources: ['project', 'local'] }),
    })
    const project = { alias: 'project', path: join(deps.stateDir, 'project') }
    mkdirSync(project.path)
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://daemon.example/v1')
    fakeProbe.claudeSettings = { env: { ANTHROPIC_BASE_URL: 'https://project.example/v1' } }
    try { await run(deps, project) }
    finally {
      fakeProbe.claudeOneShots = []
      fakeProbe.claudeCalls = []
      fakeProbe.claudeInputs = []
      fakeProbe.claudeSettings = {}
      fakeProbe.claudeResult = null
      fakeProbe.error = null
      vi.unstubAllEnvs()
      rmSync(deps.stateDir, { recursive: true, force: true })
    }
  }

  it.each(['claude', 'codex'] as const)('invalidates the installed %s version and records the executable version used by each session', id => {
    const run = async (deps: ProviderDeps, project: { alias: string; path: string }) => {
      const bin = join(deps.stateDir, id === 'codex' && process.platform === 'win32' ? 'codex.exe' : id)
      const model = id === 'claude' ? 'claude-reported' : 'scripted-model'
      writeFileSync(bin, '1.2.3')
      const originalProbe = deps.probeVersion
      let releaseVersion!: () => void
      const versionReady = new Promise<void>(resolve => { releaseVersion = resolve })
      deps.probeVersion = async file => {
        if (file !== bin) return originalProbe?.(file) ?? { ok: true, firstLine: '1.2.3', ms: 0 }
        const firstLine = readFileSync(file, 'utf8')
        if (firstLine === '2.3.4') await versionReady
        return { ok: true, firstLine, ms: 0 }
      }
      if (id === 'claude') {
        deps.claudeBin = bin
        deps.currentClaudeModel = () => model
        deps.sdkOptionsForProject = () => ({ model, pathToClaudeCodeExecutable: bin })
        fakeProbe.claudeSettings = {}
      } else saveAgentConfig(deps.stateDir, baseConfig({ provider: id, model }))
      const { registry, providerNotes, stopProviderProbes } = await registerProviders(deps)
      const provider = registry.get(id)!.provider
      const old = await provider.spawn(project, probeCtx)
      try {
        await collectTurn(old.dispatch('old executable'))
        expect(providerNotes()[id]).toContain('已通过对话确认连接')
        const pending = bin + '.next'
        writeFileSync(pending, '2.3.4')
        renameSync(pending, bin)
        expect(providerNotes()[id]).toContain('还没用过')
        await collectTurn(old.dispatch('retained old process'))
        expect(providerNotes()[id]).toContain('还没用过')

        const fresh = await provider.spawn(project, probeCtx)
        try {
          releaseVersion()
          await collectTurn(fresh.dispatch('new executable'))
          expect(providerNotes()[id]).toContain('已通过对话确认连接')
        } finally { await fresh.close() }
        const path = join(deps.stateDir, 'first-use-probes.json')
        expect(JSON.parse(readFileSync(path, 'utf8'))[id]).toEqual([
          expect.objectContaining({ model, cliVersion: '1.2.3' }),
          expect.objectContaining({ model, cliVersion: '2.3.4' }),
        ])
      } finally { releaseVersion(); await old.close(); stopProviderProbes() }
    }
    return id === 'claude' ? withClaudeFixture(run) : withCodexFixture(deps => run(deps, { alias: 'probe', path: deps.stateDir }))
  })

  it('sends only real Claude project turns, and immediately retries a first-turn 529 on the project gateway', () => withClaudeFixture(async (deps, project) => {
    const { registry, providerNotes, stopProviderProbes } = await registerProviders(deps)
    const path = join(deps.stateDir, 'first-use-probes.json')
    const provider = registry.get('claude')!.provider
    try {
      const session = await provider.spawn(project, probeCtx)
      try {
        expect(fakeProbe.claudeCalls).toEqual([{ cwd: project.path, sources: ['project', 'local'], maxTurns: undefined }])
        expect(fakeProbe.claudeOneShots).toEqual([])
        expect(fakeProbe.claudeInputs).toEqual([])
        expect(existsSync(path)).toBe(false)
        expect(providerNotes().claude).toContain('还没用过，第一次对话时确认')
        fakeProbe.claudeResult = { result: 'Please try again later', api_error_status: 529 }
        const first = await collectTurn(session.dispatch('first'))
        expect(first.errorCode).toBe('server_error')
        expect(turnErrorNotice('claude', first.error, first.errorCode)).toContain('Claude 暂时忙不过来（529）')
        expect(providerNotes().claude).toContain('还没用过')
        expect(existsSync(path)).toBe(false)
        fakeProbe.claudeResult = null
        expect((await collectTurn(session.dispatch('second'))).error).toBeUndefined()
        expect(fakeProbe.claudeInputs).toEqual(['first', 'second'])
        expect(fakeProbe.claudeOneShots).toEqual([])
        expect(providerNotes().claude).toContain('还没用过')
        expect(JSON.parse(readFileSync(path, 'utf8')).claude).toEqual([
          expect.objectContaining({ model: 'claude-reported', endpoint: probeEndpointKey({ baseUrl: 'https://project.example/v1' }), confirmedByTurn: true }),
        ])
      } finally { await session.close() }
    } finally { stopProviderProbes() }
  }))

  it.each([
    { status: 403, result: 'Request not allowed', code: 'auth_rejected', note: '拒绝了凭证（403）', notice: '检查一下账号或密钥' },
    { status: 429, result: 'Claude AI usage limit reached|4102444800', code: 'quota', note: '额度用完了（预计', notice: '等额度恢复' },
    { status: 400, result: 'Credit balance is too low', sdkError: 'billing_error', code: 'quota', note: '额度用完了', notice: '等额度恢复' },
    { status: 404, result: 'model not found', code: 'incompatible', note: '客户端协议不兼容', notice: '检查 CLI 版本或换一个模型' },
  ])('classifies a real Claude SDK failure with status $status and immediately sends the next sentence', ({ status, result, sdkError, code, note, notice }) => withClaudeFixture(async (deps, project) => {
    deps.currentClaudeModel = () => 'claude-reported'
    fakeProbe.claudeSettings = {}
    const { registry, providerNotes, stopProviderProbes } = await registerProviders(deps)
    const path = join(deps.stateDir, 'first-use-probes.json')
    try {
      const session = await registry.get('claude')!.provider.spawn(project, probeCtx)
      try {
        await collectTurn(session.dispatch('confirm'))
        const confirmed = readFileSync(path, 'utf8')
        fakeProbe.claudeResult = { result, api_error_status: status, sdkError }
        const summary = await collectTurn(session.dispatch('fail'))
        expect(summary.errorCode).toBe(code)
        expect(summary.assistantText).toEqual([])
        const message = code === 'auth_rejected' ? authFailNotice('claude', code) : turnErrorNotice('claude', summary.error, summary.errorCode)
        expect(message).toContain(notice)
        expect(providerNotes().claude).toContain(note)
        if (code === 'incompatible') expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({})
        else expect(readFileSync(path, 'utf8')).toBe(confirmed)
        fakeProbe.claudeResult = null
        expect((await collectTurn(session.dispatch('try again now'))).error).toBeUndefined()
        expect(fakeProbe.claudeInputs).toEqual(['confirm', 'fail', 'try again now'])
        expect(fakeProbe.claudeOneShots).toEqual([])
        expect(JSON.parse(readFileSync(path, 'utf8')).claude).toHaveLength(1)
      } finally { await session.close() }
    } finally { stopProviderProbes() }
  }))

  it('delivers the real Claude reply without confirming a guessed endpoint for an unknown transport', () => withClaudeFixture(async (deps, project) => {
    fakeProbe.claudeSettings = { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }
    const { registry, providerNotes, stopProviderProbes } = await registerProviders(deps)
    try {
      const session = await registry.get('claude')!.provider.spawn(project, probeCtx)
      try {
        expect((await collectTurn(session.dispatch('owner question'))).error).toBeUndefined()
        expect(providerNotes().claude).toContain('还没用过')
        expect(existsSync(join(deps.stateDir, 'first-use-probes.json'))).toBe(false)
      } finally { await session.close() }
    } finally { stopProviderProbes() }
  }))

  it('preserves isolated Claude evaluation and SDK result errors without confirming chat', () => withClaudeFixture(async (deps, project) => {
    const { registry, providerNotes, stopProviderProbes } = await registerProviders(deps)
    const provider = registry.get('claude')!.provider
    try {
      fakeProbe.claudeResult = { result: 'Please try again later', api_error_status: 529 }
      await expect(provider.cheapEval!('evaluation')).rejects.toMatchObject({ status: 529, providerErrorCode: 'server_error' })
      fakeProbe.claudeResult = null
      const session = await provider.spawn(project, { ...probeCtx, evaluation: {
        tools: { tools: [], call: async () => '', close: async () => {}, serverOf: () => undefined }, mcpServer: { url: 'http://127.0.0.1:1' }, maxSteps: 3, maxOutputTokens: 128,
      } })
      try {
        await collectTurn(session.dispatch('checkup'))
        expect(fakeProbe.claudeCalls.at(-1)).toEqual({ cwd: project.path, sources: [], maxTurns: 3 })
        expect(fakeProbe.claudeOneShots).toEqual(['evaluation'])
        expect(providerNotes().claude).toContain('还没用过')
        expect(existsSync(join(deps.stateDir, 'first-use-probes.json'))).toBe(false)
      } finally { await session.close() }
    } finally { stopProviderProbes() }
  }))

})

describe('registerProviders — Grok ACP account discovery (no model calls)', () => {
  it('does not probe/register Grok ACP on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const probe = vi.fn(async () => ({ ok: true as const, firstLine: 'fake', ms: 0 }))
      const { registry, stopProviderProbes } = await registerProviders(baseDeps({ configuredAgent: baseConfig({ grokBin: '/fake/grok' }), probeVersion: probe }))
      try {
        expect(registry.has('grok')).toBe(false)
        expect(probe).not.toHaveBeenCalledWith('/fake/grok')
      } finally { stopProviderProbes() }
    } finally { vi.restoreAllMocks() }
  })
  it('never discovers the real Grok on test-runner PATH', async () => {
    const { registry, stopProviderProbes } = await registerProviders(baseDeps())
    try { expect(registry.has('grok')).toBe(false) } finally { stopProviderProbes() }
  })

  it.runIf(process.platform !== 'win32')('registers a fake binary with dynamic bin, a dedicated-login note, isolated probe and no eval callbacks', async () => {
    const probe = vi.fn(async (_bin: string, _options?: { env?: NodeJS.ProcessEnv }) => ({ ok: true as const, firstLine: 'grok 1.0.77', ms: 0 }))
    const deps = baseDeps({ configuredAgent: baseConfig({ grokBin: '/fake/grok' }), probeVersion: probe })
    saveAgentConfig(deps.stateDir, deps.configuredAgent)
    const { registry, defaultProviderId, providerNotes, stopProviderProbes } = await registerProviders(deps)
    try {
      expect(registry.has('grok')).toBe(true)
      expect(defaultProviderId).toBe('claude')
      expect(registry.get('grok')?.opts.bin?.()).toBe('/fake/grok')
      expect(registry.get('grok')?.provider.cheapEval).toBeUndefined()
      expect(registry.get('grok')?.provider.strongEval).toBeUndefined()
      expect(providerNotes().grok).toContain('Grok 还没在 CC 里登录')
      expect(probe.mock.calls.find(([bin]) => bin === '/fake/grok')?.[1]?.env?.HOME).toBe(join(deps.stateDir, 'executors/grok/home'))
    } finally { stopProviderProbes() }
  })

  it('does not claim that Grok has a shared trusted MCP token when selected as the configured default', async () => {
    const { deps, logs } = baseDepsWithLogs({ configuredAgent: baseConfig({ provider: 'grok' }) })
    const wiring = await registerProviders(deps)
    try {
      expect(logs.some(([, line]) => line.includes('默认 provider 是 grok') && line.includes('共享一把 trusted'))).toBe(false)
      expect(logs.some(([, line]) => line.includes('所有对话共用一把 trusted') && line.includes('grok'))).toBe(false)
    } finally { wiring.stopProviderProbes() }
  })
})

describe('registerProviders — agy (fix round 1: test-runner guard)', () => {
  // This whole file runs under vitest, so UNDER_TEST_RUNNER is genuinely
  // true here — no env-var stubbing needed to exercise the guard.

  it('without agyBin opt-in, agy is NOT registered — the real-PATH fallback is disabled under a test runner', async () => {
    const { deps, logs } = baseDepsWithLogs()
    const { registry } = await registerProviders(deps)
    expect(registry.has('agy')).toBe(false)
    expect(logs.some(([tag, line]) => tag === 'BOOT' && line.includes('agy: binary not found'))).toBe(true)
  })

  // Win-only note (fix round 2): `makeFakeAgyBin` writes a POSIX `#!/bin/sh`
  // shebang script. On windows-latest CI (which runs this file's test step
  // ungated), spawning that path directly isn't a valid Windows executable
  // — a `.cmd`/`.bat` needs cmd.exe, and Bun.spawn doesn't shell out to one
  // implicitly, so `agyVersionOk`'s spawn would fail there and flip these
  // three opt-in assertions red (macOS-only green blind spot — this repo
  // has hit that exact failure class before). Gated the same way
  // powershell-validator.test.ts:31 gates its Windows-only cases —
  // `describe.runIf` on the platform, rather than trying to author a
  // cross-platform fixture that can't be verified from here.
  describe.runIf(process.platform !== 'win32')('opt-in (spawns a real subprocess — POSIX shell fixture)', () => {
    it('agyBin opt-in but NO wechatStdioForAgy/mintSessionToken ⇒ registers WITHOUT touching the MCP config (no homedir default reached)', async () => {
      const binDir = mkdtempSync(join(tmpdir(), 'providers-test-bin-'))
      const agyBin = makeFakeAgyBin(binDir)
      const { deps, logs } = baseDepsWithLogs({
        configuredAgent: baseConfig({ agyBin }),
        // Deliberately omitted: wechatStdioForAgy, mintSessionToken, agyGeminiConfigDir.
      })
      const { registry } = await registerProviders(deps)
      expect(registry.has('agy')).toBe(true)
      expect(logs.some(([tag, line]) => tag === 'BOOT' && line.includes('internalApi/mintSessionToken unavailable'))).toBe(true)
    })

    it('agyBin opt-in + explicit agyGeminiConfigDir ⇒ registered, named "Gemini" (收敛清单 ⑥), and the global MCP config is written to THAT dir (never the real home dir)', async () => {
      const binDir = mkdtempSync(join(tmpdir(), 'providers-test-bin-'))
      const agyBin = makeFakeAgyBin(binDir)
      const geminiConfigDir = mkdtempSync(join(tmpdir(), 'providers-test-gemini-config-'))
      const mintSessionToken = vi.fn((_tier: string, _key: string) => 'tok-agy-static')
      const deps = baseDeps({
        configuredAgent: baseConfig({ agyBin }),
        wechatStdioForAgy: fakeWechatSpec,
        mintSessionToken: mintSessionToken as unknown as ProviderDeps['mintSessionToken'],
        agyGeminiConfigDir: geminiConfigDir,
      })
      const { registry } = await registerProviders(deps)

      expect(registry.has('agy')).toBe(true)
      const entry = registry.get('agy')
      expect(registry.namesOf('agy')).toEqual({ name: 'Gemini', short: 'Gemini', settings: 'Gemini · 账号连接' })
      expect(entry?.opts.canResume('/any/cwd', 'any-thread')).toBe(true)

      // mintSessionToken was called with the tier-C fixed shape: ONE
      // long-lived 'trusted' token, never a per-session one.
      expect(mintSessionToken).toHaveBeenCalledWith('trusted', 'agy-static')

      // The write landed in the EXPLICIT dir, not the real ~/.gemini/config.
      const raw = readFileSync(join(geminiConfigDir, 'mcp_config.json'), 'utf8')
      const parsed = JSON.parse(raw)
      expect(Object.keys(parsed.mcpServers)).toEqual([AGY_WECHAT_MCP_NAMESPACE_ID])
      expect(parsed.mcpServers[AGY_WECHAT_MCP_NAMESPACE_ID].env.WECHAT_SESSION_TOKEN).toBe('tok-agy-static')
      expect(parsed.mcpServers[AGY_WECHAT_MCP_NAMESPACE_ID].env.WECHAT_SESSION_TIER).toBe('trusted')
    })

    it('agyBin opt-in but omitted agyGeminiConfigDir under a test runner ⇒ registers, but setupAgyGlobalMcp skips (never defaults to the real home dir)', async () => {
      const binDir = mkdtempSync(join(tmpdir(), 'providers-test-bin-'))
      const agyBin = makeFakeAgyBin(binDir)
      const mintSessionToken = vi.fn((_tier: string, _key: string) => 'tok-agy-static')
      const { deps, logs } = baseDepsWithLogs({
        configuredAgent: baseConfig({ agyBin }),
        wechatStdioForAgy: fakeWechatSpec,
        mintSessionToken: mintSessionToken as unknown as ProviderDeps['mintSessionToken'],
        // agyGeminiConfigDir deliberately omitted.
      })
      const { registry } = await registerProviders(deps)

      expect(registry.has('agy')).toBe(true)
      // setupAgyGlobalMcp's own UNDER_TEST_RUNNER guard fired BEFORE calling
      // mintToken — so the fixed 'trusted' token was never even minted.
      expect(mintSessionToken).not.toHaveBeenCalled()
      expect(logs.some(([tag, line]) => tag === 'agy-mcp' && line.includes('skipped under test runner'))).toBe(true)
    })
  })
})


// ── cursor: ACP 对话 provider 的 Windows 门(2026-09-18 评审 C1)────────────────
// acp-agent-provider 的 close() 靠杀进程组收尾,win32 上没验过、spawn 直接抛。
// 以前 providers.ts 照样注册,于是 Windows 上每一轮对话都撞那句抛错。
describe('registerProviders — cursor ACP chat provider on Windows', () => {
  it('win32 ⇒ 不注册 ACP 对话 provider、记一行 BOOT,并照旧落到 SDK 兜底的判断(这里没有 CURSOR_API_KEY ⇒ 未注册)', async () => {
    // codex-app-server.test.ts 的姿势:直接换 process.platform 的 getter。
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const prevKey = process.env.CURSOR_API_KEY
    delete process.env.CURSOR_API_KEY
    try {
      // 二进制路径随便给一个:win32 分支在 probeBinaryVersion 之前就短路了,
      // 所以这条测试不起任何子进程,三个平台跑出来是同一条路径。
      const { deps, logs } = baseDepsWithLogs({
        configuredAgent: baseConfig({ cursorAgentBin: join(tmpdir(), 'cursor-agent-that-is-never-spawned') }),
      })
      const { registry } = await registerProviders(deps)

      expect(registry.has('cursor')).toBe(false)
      expect(logs.some(([tag, line]) => tag === 'BOOT' && line === 'cursor: ACP 对话 provider 暂不支持 Windows(进程组清理未验证),未注册')).toBe(true)
      // 兜底逻辑没被跳过:它自己判断出"没有 API key ⇒ 不注册"。
      expect(logs.some(([tag, line]) => tag === 'BOOT' && line.includes('CURSOR_API_KEY not set'))).toBe(true)
    } finally {
      if (prevKey === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = prevKey
      vi.restoreAllMocks()
    }
  })
})

// B2(2026-10-25):OpenAI 兼容一份实现 —— 对话侧登记带着会话存档(有 DB 才续接);工作台不拿微信工具。
describe('registerProviders — openai (one session type, B2)', () => {
  const openaiConfig = baseConfig({ openaiBaseUrl: 'https://gateway.example/v1', openaiModel: 'fixture-model' })
  it('background evaluation targets the current main gateway model unless an eval model is configured',async()=>{
    vi.stubEnv('WECHAT_OPENAI_API_KEY','offline-fixture')
    const deps=baseDeps({configuredAgent:openaiConfig})
    try{
      saveAgentConfig(deps.stateDir,{...openaiConfig,openaiModel:'Kimi-Code'})
      const {registry}=await registerProviders(deps)
      const p=registry.get('openai')!.provider
      expect(p.callTarget?.('cheapEval')?.model).toBe('Kimi-Code')
      saveAgentConfig(deps.stateDir,{...openaiConfig,openaiModel:'DeepSeek',openaiEvalModel:'GLM-FLASH'})
      expect(p.callTarget?.('cheapEval')?.model).toBe('GLM-FLASH')
      expect(p.callTarget?.('strongEval')?.model).toBe('GLM-FLASH')
      saveAgentConfig(deps.stateDir,{...openaiConfig,openaiModel:'DeepSeek'})
      expect(p.callTarget?.('cheapEval')?.model).toBe('DeepSeek')
    }finally{vi.unstubAllEnvs()}
  })
  it('with a db: canResume reads the chat session store; the registration hands the workbench no wechat tools', async () => {
    vi.stubEnv('WECHAT_OPENAI_API_KEY', 'fixture-key')
    try {
      const db = openTestDb()
      const { registry } = await registerProviders(baseDeps({ configuredAgent: openaiConfig, db, wechatStdioForOpenai: fakeWechatSpec }))
      const entry = registry.get('openai')!
      expect(entry.opts.canResume('/p', 'no-such-session')).toBe(false)
      expect(Object.keys(entry.opts)).not.toContain('workbenchMcpTools')
      const bare = await registerProviders(baseDeps({ configuredAgent: openaiConfig }))
      expect(bare.registry.get('openai')!.opts.canResume('/p', 'x')).toBe(false)
    } finally { vi.unstubAllEnvs() }
  })
})
