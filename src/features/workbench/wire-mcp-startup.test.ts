import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wireWorkbench } from './wire'
import { wireModelOptions } from '../../daemon/bootstrap/wire-model-options'
import { createProviderRegistry } from '../../app/provider-registry'
import { openDb } from '../../lib/db'
import { saveAgentConfig } from '../../lib/agent-config'
import { TIER_PROFILES } from '../../domain/user-tier'
import type { Bootstrap } from '../../daemon/bootstrap/types'
import type { ClaudeAgentProviderOptions } from '../../adapters/executors/claude/claude-agent-provider'
import * as mcp from '../../mcp-servers/claude-sdk-mcp'

const captured = vi.hoisted(() => ({ options: undefined as ClaudeAgentProviderOptions | undefined }))
// Capture the production workbench options seam without starting a real CLI.
vi.mock('../../adapters/executors/claude/claude-agent-provider', async importOriginal => {
  const original = await importOriginal<typeof import('../../adapters/executors/claude/claude-agent-provider')>()
  return { ...original, createClaudeAgentProvider: (options: ClaudeAgentProviderOptions) => {
    captured.options = options
    return { spawn: async () => { throw new Error('must not start a CLI') } }
  } }
})
afterEach(() => { captured.options = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('workbench spawn options construct only its notebook MCP and never probe conversation health', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'workbench-mcp-startup-'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', stateDir)
  saveAgentConfig(stateDir, { provider: 'claude', dangerouslySkipPermissions: false, autoStart: false, closeStopsDaemon: false })
  const db = openDb({ path: join(stateDir, 'state.db') })
  const registry = createProviderRegistry()
  registry.register('claude', { spawn: async () => { throw new Error('unused boot provider') } }, { canResume: () => true })
  const spec = { command: 'unused', env: { WECHAT_INTERNAL_API: 'http://offline.invalid', WECHAT_DELEGATE_PEER: 'codex' } }
  const options = wireModelOptions({ stateDir }, {
    plugins: { wechatStdioForClaude: spec, delegateStdioForClaude: spec, pluginMcpForClaude: {} },
    permissionMode: 'strict', buildCanUseTool: () => async () => ({ behavior: 'allow' }), claudeBin: undefined,
  })
  const fetch = vi.fn(async () => Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetch)
  const constructing = vi.spyOn(mcp, 'claudeSdkMcp')
  const service = wireWorkbench({
    db, stateDir, boot: { ...options, registry, defaultProviderId: 'claude', holdBusy: () => () => {} } as unknown as Bootstrap,
    internalApi: { port: () => 1, mintSessionToken: () => 'offline-token', invalidateSession: () => {} },
    askUser: async () => 'allow', log: () => {},
  })
  try {
    const builder = captured.options!.sdkOptionsForProject
    const built = await builder('workbench:test', stateDir, TIER_PROFILES.admin, 'owner', {
      WECHAT_SESSION_TOKEN: 'offline-token', WECHAT_SESSION_TIER: 'admin',
    }, 'task only', { permissionMode: 'strict', matterLedger: true, tierProfile: TIER_PROFILES.admin, chatId: 'owner' })
    try {
      expect(constructing.mock.calls.map(call => call[0])).toEqual(['wechat-cc-matter'])
      expect(fetch).not.toHaveBeenCalled()
      expect(Object.keys(built.mcpServers!)).toEqual(['wechat-cc-matter'])
    } finally { built.abortController?.abort() }
  } finally { await service.shutdown(); db.close(); rmSync(stateDir, { recursive: true, force: true }) }
})
