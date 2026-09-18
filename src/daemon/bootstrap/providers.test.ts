import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerProviders, type ProviderDeps } from './providers'
import { openTestDb } from '../../lib/db'
import { makeConversationStore } from '../../core/conversation-store'
import type { AgentConfig } from '../../lib/agent-config'
import type { McpStdioSpec } from '../../core/mcp-stdio-spec'
import { AGY_WECHAT_MCP_NAMESPACE_ID } from './agy-mcp-config'

/**
 * A tiny real executable that exits 0 on `--version` — stands in for the
 * `agy` CLI so these tests never depend on (or spawn) the real Antigravity
 * binary, and pass identically whether or not the host machine happens to
 * have one installed. `agyVersionOk` (agy-version-check.ts) just spawns
 * `[bin, '--version']` and checks the exit code, so a one-line shell script
 * satisfies it exactly like a real CLI would.
 */
function makeFakeAgyBin(dir: string): string {
  const path = join(dir, 'fake-agy')
  writeFileSync(path, '#!/bin/sh\necho "1.0.0-fake"\nexit 0\n')
  chmodSync(path, 0o755)
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

    it('agyBin opt-in + explicit agyGeminiConfigDir ⇒ registered, displayName = "Gemini (agy)", and the global MCP config is written to THAT dir (never the real home dir)', async () => {
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
      expect(entry?.opts.displayName).toBe('Gemini (agy)')
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
