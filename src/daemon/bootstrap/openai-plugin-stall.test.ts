import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createInternalApi, type InternalApi } from '../internal-api'
import { makeMemoryFS } from '../memory/fs-api'
import { createMcpToolBridge } from '../../core/openai-mcp-bridge'
import { createOpenAiAgentProvider } from '../../core/openai-agent-provider'
import { collectTurn } from '../../core/agent-provider'
import type { ChatModelClient } from '../../core/openai-chat-model'
import { TIER_PROFILES } from '../../core/user-tier'
import { buildOpenaiMcpSpecs, openaiMcpBridgeOptions } from './mcp-specs'

/**
 * 2026-10-03 真机复现(selftest chat --provider openai 两次红):
 * `✗ replied — MCP error -32001: Request timed out (waited ~63s)`,channel.log 里没有
 * [TURN] 也没有 SESSION_SPAWN。根因:openai provider 每次 spawn 串行连 wechat、delegate
 * 和全部插件 MCP server,任何一个超时整个 spawn 就抛 —— 当时 wxvault 插件在 daemon 里
 * 启动 >60s(ps:进程卡在 U 态,sqlite pread + 目录遍历),wechat/delegate 早就 ready。
 *
 * 这里用真东西搭同一条链:真 internal-api + 真 wechat MCP 子进程(bun 跑源码)+ 一个
 * 永远不回 `initialize` 的「插件」子进程 + 真 openai provider 循环,模型是脚本(先调
 * wechat 的 ping,再说一句话)。修之前:spawn 抛 → 整轮失败;修之后:插件被跳过并被杀掉,
 * 这一轮照常走完。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const WECHAT_MCP_MAIN = join(HERE, '..', '..', 'mcp-servers', 'wechat', 'main.ts')

function pingThenAnswer(): ChatModelClient {
  let n = 0
  return {
    streamTurn() {
      n++
      const first = n === 1
      const toolCalls = first ? [{ id: 'p1', name: 'ping', input: {} }] : []
      async function* deltas() {
        if (first) yield { kind: 'tool_call' as const, id: 'p1', name: 'ping', input: {} }
        else yield { kind: 'text' as const, text: '好' }
      }
      return { deltas: deltas(), finished: Promise.resolve({ messages: [{ role: 'assistant', content: '' }] as never, toolCalls }) }
    },
    async generate() { return 'ok' },
    userMessage: (t) => ({ role: 'user', content: t } as never),
    systemMessage: (t) => ({ role: 'system', content: t } as never),
    toolResultMessage: (_id, name, r) => ({ role: 'tool', content: `${name}:${String(r)}` } as never),
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('openai session with a stalled plugin MCP server (real wechat MCP + internal API)', () => {
  let stateDir: string
  let api: InternalApi | null = null

  afterEach(async () => {
    if (api) { await api.stop({ unlinkToken: true }).catch(() => {}); api = null }
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('skips (and kills) the stalled plugin; the turn still runs through the wechat MCP', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'openai-plugin-stall-'))
    api = createInternalApi({ stateDir, daemonPid: 4242, memory: makeMemoryFS({ rootDir: join(stateDir, 'memory') }) })
    const { port, tokenFilePath } = await api.start()

    const pidFile = join(stateDir, 'stall.pid')
    // A plugin that starts but never answers `initialize` (wxvault on 2026-10-03).
    const stall = {
      command: 'bun',
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1 << 30)`],
    }
    const wechat = {
      command: 'bun',
      args: [WECHAT_MCP_MAIN],
      env: { WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`, WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath, WECHAT_PARTICIPANT_TAG: 'openai' },
    }
    const logs: string[] = []
    const log = (tag: string, line: string) => logs.push(`[${tag}] ${line}`)

    const provider = createOpenAiAgentProvider({
      makeChatModel: () => pingThenAnswer(),
      makeMcpBridge: (sessionEnv) => createMcpToolBridge(
        buildOpenaiMcpSpecs({ wechat, delegate: null, pluginMcp: { wxvault: stall } }, sessionEnv),
        { ...openaiMcpBridgeOptions(log), startupTimeoutMs: 3_000 },
      ),
      log,
    })

    const session = await provider.spawn(
      { alias: 'selftest', path: stateDir },
      { tierProfile: TIER_PROFILES.trusted, permissionMode: 'dangerously', chatId: 'selftest/selftest/x', mcpEnv: { WECHAT_SESSION_TIER: 'trusted' } },
    )
    try {
      const summary = await collectTurn(session.dispatch('自检'), { timeoutMs: 20_000 })
      expect(summary.error).toBeUndefined()
      expect(summary.toolCalls.join(',')).toContain('ping')
      expect(summary.assistantText).toEqual(['好'])
    } finally {
      await session.close()
    }

    expect(logs.some(l => l.startsWith('[MCP]') && l.includes('"wxvault"') && l.includes('3000ms'))).toBe(true)
    expect(logs.some(l => l.startsWith('[SESSION_SPAWN]'))).toBe(true)

    // The given-up child must not be left running.
    expect(existsSync(pidFile)).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const deadline = Date.now() + 5_000
    while (alive(pid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
    expect(alive(pid)).toBe(false)
  }, 30_000)
})
