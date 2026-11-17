import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScriptedCodex } from '../../test-support/executors/codex-scripted'
import { buildDelegateDispatch } from './delegate'

const boundary = vi.hoisted(() => ({ codex: vi.fn(), claude: vi.fn() }))
vi.mock('../../adapters/executors/codex/codex-app-server-process', () => ({ spawnCodexAppServerProcess: boundary.codex }))
vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => {
  const sdk = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return { ...sdk, query: (input: Parameters<typeof sdk.query>[0]) => sdk.query({ ...input, options: {
    ...input.options, executable: 'node', pathToClaudeCodeExecutable: '/offline/fake-claude.js',
    spawnClaudeCodeProcess: opts => { boundary.claude(opts); throw Error('captured_offline_delegate_spawn') },
  } }) }
})
afterEach(() => { vi.unstubAllEnvs(); boundary.codex.mockReset(); boundary.claude.mockReset() })

it('bare Codex and Claude delegate spawn argv/general env have no session token or recursive core MCP', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'token-delegate-'))
  vi.stubEnv('WECHAT_SESSION_TOKEN', 'DELEGATE_AMBIENT_SECRET_CANARY')
  const scripted = createScriptedCodex({ turns: [{ steps: [{ say: 'offline opinion' }] }] })
  boundary.codex.mockImplementation(scripted.spawn)
  try {
    const dispatch = buildDelegateDispatch({ stateDir, codexPathOverride: '/offline/codex', claudeAvailable: true })
    expect(await dispatch('codex', 'offline')).toMatchObject({ ok: true, response: 'offline opinion' })
    const [command, args, options] = boundary.codex.mock.calls[0]!
    const codexLeak = [command, ...args, ...Object.values(options.env) as string[]].some(v => v?.includes('SECRET_CANARY'))
    expect((scripted.threadStarts[0]!.params.config as any)?.mcp_servers ?? {}).toEqual({})
    const claudeResult = await dispatch('claude', 'offline')
    expect(claudeResult.ok).toBe(false) // Captured at real SDK boundary; no CLI/model was started.
    expect(boundary.claude).toHaveBeenCalledOnce()
    const captured = boundary.claude.mock.calls[0]![0]
    expect(captured.args).not.toContain('--mcp-config')
    const claudeLeak = [...captured.args, ...Object.values(captured.env) as string[]].some(v => v?.includes('SECRET_CANARY'))
    expect({ codexLeak, claudeLeak }).toEqual({ codexLeak: false, claudeLeak: false })
  } finally { rmSync(stateDir, { recursive: true, force: true }) }
})
