/**
 * 外部 CLI 流格式契约测试 —— **真机、可选、要花钱**。
 *
 * agy / cursor-agent 的解析器(agy-stream.ts / cursor-cli-stream.ts)都是照
 * 真机样本写的;2026-09-08 cursor 的 envelope 和我们类推的形状完全不同,
 * 整条路一个 tool_call 都没解析出来过,靠主人截图才发现(双发旁白)。
 * 这个测试把「真跑一句 → 过我们的解析器 → 形状还对不对」做成一条命令:
 *
 *   bun run test:live-cli            # WECHAT_CC_LIVE_CLI=1
 *   WECHAT_CC_LIVE_CLI=agy bun --bun vitest run src/core/external-cli-contract.live.test.ts
 *
 * 前提:daemon 在跑(它开机时把我们的 wechat MCP 写进各 CLI 的全局配置,
 * 关机时删掉)。每家一次真调用,走主人的订阅 —— 所以默认不跑,CI 不跑。
 * 失败时把原始 stdout 落到 tmpdir,路径打在断言信息里,拿去更新单测 fixture。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { findOnPath } from '../lib/util'
import { readJsonFile } from '../lib/read-json-file'
import { AGY_WECHAT_MCP_NAMESPACE_ID, normalizeWechatMcpServer } from './agent-provider'
import { makeAgyStreamParser } from './agy-stream'
import { makeCursorStreamParser } from './cursor-cli-stream'
import { agyBaseArgs, DEFAULT_AGY_MODEL } from './agy-agent-provider'
import { cursorBaseArgs } from './cursor-eval'
import { DEFAULT_CURSOR_MODEL } from './acp-cursor-chat'

// cursor 全局 mcp_config 里我们的键 —— 只有一次性评估(cursor-eval.ts,print
// 模式,读 cursor-agent 自己的全局配置)还会撞见它;对话侧已经走 ACP 逐会话
// 注入,不再靠这把全局命名空间钥匙。这个常量本体已随 print-mode 对话
// provider 一起从 agent-provider.ts 退休,这里内联同一个字面量。
const CURSOR_MCP_NAMESPACE_KEY = 'wechat-cc:wechat'

const LIVE = process.env.WECHAT_CC_LIVE_CLI ?? ''
const wants = (cli: string) => LIVE === '1' || LIVE.split(',').map(s => s.trim()).includes(cli)

const PROMPT = '调用 wechat MCP 服务器的 ping 工具(不带参数),然后只回复两个字母:ok。不要调用其他任何工具,不要给任何人发消息。'
const TIMEOUT_MS = 120_000

interface Shape { texts: number; toolCalls: Array<{ tool: string; server?: string }>; results: number; errors: string[] }

async function runCli(cmd: string[], cwd: string): Promise<{ raw: string; code: number }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const killer = setTimeout(() => proc.kill(), TIMEOUT_MS)
  try {
    const raw = await new Response(proc.stdout).text()
    const code = await proc.exited
    return { raw, code }
  } finally { clearTimeout(killer) }
}

function dump(cli: string, raw: string): string {
  const p = join(tmpdir(), `wechat-cc-live-${cli}-${Date.now()}.jsonl`)
  writeFileSync(p, raw)
  return p
}

function assertContract(cli: string, shape: Shape, raw: string, expectedRawServer: string) {
  const where = () => `原始 stdout 已落到 ${dump(cli, raw)} —— 拿去对 ${cli === 'agy' ? 'agy-stream' : 'cursor-cli-stream'}.test 的 fixture`
  // 后端不可达(cursor 第一次跑:17 行全是 connection/reconnecting + retry,
  // 没有任何 assistant/tool/result)—— 这是网络,不是格式漂移,别混成一类。
  if (shape.texts === 0 && shape.toolCalls.length === 0 && shape.results === 0 && shape.errors.length === 0) {
    const noise = raw.split('\n').filter(l => /"type":"(connection|retry)"|"event":"(retry|connection)"/.test(l)).length
    if (noise > 0) throw new Error(`${cli}:后端不可达(${noise} 行 connection/retry,零输出)—— 网络问题,不是格式问题;稍后重跑。${where()}`)
  }
  expect(shape.errors, `${cli} 报了 error:${shape.errors.join(' | ')}。${where()}`).toEqual([])
  expect(shape.results, `${cli} 没有 result 事件。${where()}`).toBeGreaterThanOrEqual(1)
  const pings = shape.toolCalls.filter(t => t.tool === 'ping')
  expect(pings.length, `${cli} 没解析出 ping 的 tool_call(解析出的:${JSON.stringify(shape.toolCalls)})。这正是 2026-09-08 双发的形状。${where()}`).toBe(1)
  expect(pings[0]!.server, `${cli} 报的 server 名变了(期望 ${expectedRawServer})。${where()}`).toBe(expectedRawServer)
  expect(normalizeWechatMcpServer(pings[0]!.server), `${cli} 的 server 名折不回 wechat —— isReplyToolCall 会认不出。${where()}`).toBe('wechat')
  expect(shape.texts, `${cli} 没有 text 事件。${where()}`).toBeGreaterThanOrEqual(1)
}

describe.skipIf(!LIVE)('external CLI stream contract (live, opt-in)', () => {
  const agyBin = findOnPath('agy')
  const agyCfg = join(homedir(), '.gemini', 'config', 'mcp_config.json')
  const agyWired = existsSync(agyCfg) && AGY_WECHAT_MCP_NAMESPACE_ID in ((readJsonFile<{ mcpServers?: Record<string, unknown> }>(agyCfg).mcpServers) ?? {})

  it.skipIf(!wants('agy') || !agyBin || !agyWired)(
    `agy: text + call_mcp_tool(ServerName=${AGY_WECHAT_MCP_NAMESPACE_ID}, ToolName=ping) + result`,
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'live-agy-'))
      // 生产在 --dangerously 下带 --dangerously-skip-permissions;不带它 agy 会
      // 拒掉 MCP 调用(第一次跑这条测试就撞上:permission check failed for mcp)。
      const args = [...agyBaseArgs(PROMPT, DEFAULT_AGY_MODEL, TIMEOUT_MS), '--dangerously-skip-permissions', '--new-project']
      const { raw } = await runCli([agyBin!, ...args], cwd)
      const parser = makeAgyStreamParser()
      const shape: Shape = { texts: 0, toolCalls: [], results: 0, errors: [] }
      for (const line of raw.split('\n')) for (const ev of parser.feed(line)) {
        if (ev.kind === 'text') shape.texts++
        else if (ev.kind === 'tool_call') shape.toolCalls.push({ tool: ev.tool, ...(ev.server !== undefined ? { server: ev.server } : {}) })
        else if (ev.kind === 'result') shape.results++
        else if (ev.kind === 'error') shape.errors.push(ev.message)
      }
      for (const ev of parser.flush()) if (ev.kind === 'text') shape.texts++
      assertContract('agy', shape, raw, AGY_WECHAT_MCP_NAMESPACE_ID)
    },
    TIMEOUT_MS + 10_000,
  )

  const cursorBin = findOnPath('cursor-agent')
  const cursorCfg = join(homedir(), '.cursor', 'mcp.json')
  const cursorWired = existsSync(cursorCfg) && CURSOR_MCP_NAMESPACE_KEY in ((readJsonFile<{ mcpServers?: Record<string, unknown> }>(cursorCfg).mcpServers) ?? {})

  it.skipIf(!wants('cursor') || !cursorBin || !cursorWired)(
    `cursor-agent: text + tool_call.mcpToolCall(serverIdentifier=${CURSOR_MCP_NAMESPACE_KEY}, toolName=ping) + result`,
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'live-cursor-'))
      // --yolo:生产在 --dangerously 下就是这么跑的;不带它 MCP 调用会被 cursor 自己拒掉(2026-09-08 探针)。
      const args = [...cursorBaseArgs(PROMPT, DEFAULT_CURSOR_MODEL), '--yolo']
      const { raw } = await runCli([cursorBin!, ...args], cwd)
      const parser = makeCursorStreamParser()
      const shape: Shape = { texts: 0, toolCalls: [], results: 0, errors: [] }
      for (const line of raw.split('\n')) for (const ev of parser.feed(line)) {
        if (ev.kind === 'text') shape.texts++
        else if (ev.kind === 'tool_call') shape.toolCalls.push({ tool: ev.tool, ...(ev.server !== undefined ? { server: ev.server } : {}) })
        else if (ev.kind === 'result') shape.results++
        else if (ev.kind === 'error') shape.errors.push(ev.message)
      }
      assertContract('cursor', shape, raw, CURSOR_MCP_NAMESPACE_KEY)
    },
    TIMEOUT_MS + 10_000,
  )
})
