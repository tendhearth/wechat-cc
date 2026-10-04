/**
 * 网络守护「暂停在跑的任务」的逐执行者沙盒验证(主人 2026-10-03):
 *
 *   真的执行者 CLI(claude / codex)连 127.0.0.1 上的假模型服务;第一次流式请求吐半句就挂住;
 *   这时 SIGSTOP 整棵进程树(走产品里的 session.suspension),服务端趁它停着把流掐断,过一会儿 SIGCONT。
 *   要求:执行者自己重试接上,这一轮以「RECOVERED」正常结束。接不上的执行者不实现 suspension,
 *   守护对它退回原来的停法(docs/reference/network-guard.md「暂停在跑的任务」)。
 *
 * 只在显式打开时跑(要本机装着 claude / codex,且会真起子进程):
 *   WECHAT_CC_SUSPEND_SANDBOX=1 bun --bun vitest run src/core/workbench/suspend-resume.sandbox.test.ts
 *
 * 流量一律不出本机:端点钉在 127.0.0.1;HTTP(S)_PROXY 指向 127.0.0.1:9(死端口),漏网的请求在本机就失败;
 * HOME / CLAUDE_CONFIG_DIR / CODEX_HOME 全是临时目录,不读主人的配置。codex 不认 OPENAI_BASE_URL,
 * 所以端点写进沙盒 CODEX_HOME/config.toml 的自定义 model_provider。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentSession } from '../agent-provider'
import { TIER_PROFILES } from '../user-tier'

const ENABLED = process.env.WECHAT_CC_SUSPEND_SANDBOX === '1' && process.platform !== 'win32'
const which = (bin: string) => { try { return execFileSync('/usr/bin/which', [bin], { encoding: 'utf8' }).trim() || null } catch { return null } }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const DEAD_PROXY = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ALL_PROXY: '' }

/** 第一次流式请求:吐「PARTIAL」后挂住,等 drop();之后的请求:完整吐「RECOVERED」。 */
function fakeServer(kind: 'anthropic' | 'openai') {
  let streams = 0
  const hanging = new Set<Socket>()
  const log: string[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      log.push(`${req.method} ${req.url}`)
      if (kind === 'openai' && req.url?.includes('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[],"models":[]}'); return }
      let parsed: Record<string, unknown> = {}
      try { parsed = JSON.parse(body) } catch { /* not json */ }
      if (kind === 'anthropic') {
        if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return }
        if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":10}'); return }
        const msg = { id: 'msg', type: 'message', role: 'assistant', model: parsed.model ?? 'claude-x', content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }
        if (!parsed.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text: 'RECOVERED' }], stop_reason: 'end_turn' })); return }
        const k = ++streams, text = k === 1 ? 'PARTIAL' : 'RECOVERED'
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        ev('message_start', { message: { ...msg, id: `msg_${k}` } })
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
        if (k === 1) { hanging.add(req.socket); return }
        ev('content_block_stop', { index: 0 })
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
        ev('message_stop', {})
        res.end()
        return
      }
      if (!req.url?.includes('/responses')) { res.writeHead(404); res.end('{}'); return }
      const k = ++streams, text = k === 1 ? 'PARTIAL' : 'RECOVERED'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const ev = (data: { type: string } & Record<string, unknown>) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
      ev({ type: 'response.created', response: { id: `resp_${k}` } })
      ev({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `m_${k}`, role: 'assistant', content: [] } })
      ev({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: `m_${k}`, delta: text })
      if (k === 1) { hanging.add(req.socket); return }
      ev({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: `m_${k}`, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } })
      ev({ type: 'response.completed', response: { id: `resp_${k}`, usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 8 } } })
      res.end()
    })
  })
  return {
    log,
    get streams() { return streams },
    hangingCount: () => hanging.size,
    drop() { for (const socket of hanging) socket.destroy(); hanging.clear() },
    listen: () => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))),
    close: () => new Promise<void>(resolve => { for (const socket of hanging) socket.destroy(); server.close(() => resolve()) }),
  }
}

/** 共同的剧本:等第一次流挂住 → 冻住 → 掐断 → 停一会儿 → 放开 → 等这一轮结束。 */
async function suspendDropResume(session: AgentSession, server: ReturnType<typeof fakeServer>, events: AgentEvent[], done: () => boolean) {
  for (let i = 0; i < 300 && server.hangingCount() === 0; i++) await sleep(100)
  expect(server.hangingCount()).toBe(1)
  expect(session.suspension?.suspend()).toBe(true)
  await sleep(500)
  server.drop()                       // 服务端趁它停着把流掐断
  await sleep(3_000)                  // 停着的这段:它看不到断线,也发不出新请求
  expect(server.streams).toBe(1)
  session.suspension!.resume()
  for (let i = 0; i < 600 && !done(); i++) await sleep(100)
  expect(events.some(e => e.kind === 'error')).toBe(false)
  expect(events.some(e => e.kind === 'result')).toBe(true)
  expect(events.filter(e => e.kind === 'text').map(e => (e as { text: string }).text).join('')).toContain('RECOVERED')
  expect(server.streams).toBeGreaterThanOrEqual(2)   // 放开后自己重试了
}

describe.skipIf(!ENABLED)('suspend → drop → resume, real executors against 127.0.0.1 fakes', () => {
  let root = ''
  const saved: Record<string, string | undefined> = {}
  const setEnv = (vars: Record<string, string>) => { for (const [k, v] of Object.entries(vars)) { if (!(k in saved)) saved[k] = process.env[k]; process.env[k] = v } }
  beforeAll(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-suspend-sandbox-'))) })
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(!which('claude'))('Claude Code (workbench runtime) retries the dropped stream after SIGCONT', async () => {
    const { createClaudeWorkbenchSession } = await import('../claude-workbench-runtime')
    const server = fakeServer('anthropic'), port = await server.listen()
    const home = join(root, 'claude-home'), work = join(root, 'claude-work')
    mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(work, { recursive: true })
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-ant-sandbox',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
      ...DEAD_PROXY,
    }
    const session = createClaudeWorkbenchSession(
      { cwd: work, env, model: 'claude-sonnet-4-5', pathToClaudeCodeExecutable: which('claude')!, settingSources: [], permissionMode: 'default', stderr: () => {} },
      { tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', chatId: 'sandbox', workbenchLifecycle: true },
      { content: text => [{ type: 'text', text }], tool: block => ({ kind: 'tool_call', tool: block.name ?? 'tool' }), label: name => ({ type: 'tool', label: name }) },
    )
    const events: AgentEvent[] = []
    const runtime = session.workbenchRuntime!
    void (async () => { try { for await (const e of runtime.events) events.push(e) } catch (error) { events.push({ kind: 'error', message: String(error) }) } })()
    runtime.start('say hi')
    try {
      await suspendDropResume(session, server, events, () => events.some(e => e.kind === 'result' || e.kind === 'error'))
    } finally { await session.close().catch(() => {}); await server.close() }
  }, 120_000)

  it.skipIf(!which('codex'))('Codex (workbench app-server) reconnects after SIGCONT', async () => {
    const server = fakeServer('openai'), port = await server.listen()
    const home = join(root, 'codex-home'), codexHome = join(root, 'codex-config'), work = join(root, 'codex-work')
    for (const dir of [home, codexHome, work]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(codexHome, 'config.toml'), [
      'model = "gpt-sandbox"', 'model_provider = "sandbox"',
      '[model_providers.sandbox]', 'name = "sandbox"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'env_key = "SANDBOX_KEY"',
      'request_max_retries = 4', 'stream_max_retries = 5', 'stream_idle_timeout_ms = 300000', '',
    ].join('\n'))
    // 工作台 codex 的子进程环境取自 daemon 的 process.env(workbenchCodexEnv):这里换成沙盒的。
    setEnv({ HOME: home, CODEX_HOME: codexHome, SANDBOX_KEY: 'sk-sandbox', ...DEAD_PROXY })
    const { createWorkbenchCodexProvider } = await import('./codex-app-server')
    const session = await createWorkbenchCodexProvider({ codexPathOverride: which('codex')!, timeouts: { firstEventTimeoutMs: 60_000, connectTimeoutMs: 60_000 } })
      .spawn({ alias: 'sandbox', path: work }, { tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', chatId: 'sandbox' })
    const events: AgentEvent[] = []
    let finished = false
    void (async () => { try { for await (const e of session.dispatch('say hi')) events.push(e) } catch (error) { events.push({ kind: 'error', message: String(error) }) } finally { finished = true } })()
    try {
      await suspendDropResume(session, server, events, () => finished)
    } finally { await session.close().catch(() => {}); await server.close() }
  }, 120_000)
})
