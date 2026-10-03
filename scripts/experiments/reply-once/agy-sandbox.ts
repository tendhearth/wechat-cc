/**
 * EXPERIMENT ONLY — reply-once harness 的 agy 沙盒(回复交付第 2 步,2026-10-03)。daemon 不 import 它。
 *
 * agy 是外部进程(私有二进制),不吃我们传的 mcpServers,生产里只读全局 `~/.gemini/config/mcp_config.json`
 * —— 那个文件里是**正在跑的 daemon** 的 `wechat-cc-wechat` 条目,带着真的 trusted 令牌。实验绝不能碰它,
 * 也绝不能让 agy 在实验里看见它(否则模型调的 reply 会真的经 daemon 发出去)。
 *
 * 做法(agy 1.2.16 上一条条试出来的,细节见下面 agentMarkdown / sandboxAgyArgs 的注释):沙盒工作区里放一个
 * **工作区自定义 agent**(`.agents/agents/wccsandbox/agent.md`,`inheritCustomizations: false` +
 * `inheritMcp: false`,主人的全局 `wechat-cc-wechat` 就此看不见 —— 用真 agy 列过工具表核对),agent 带一个插件,
 * 插件的 `mcp_config.json` 起**生产的** wechat MCP 入口(同一份工具注册),环境变量和 daemon 写进全局配置的一样
 * (`WECHAT_SESSION_TIER=trusted`,daemon 模式多一个 `WECHAT_REPLY_DELIVERY=daemon`),只是 `WECHAT_INTERNAL_API`
 * 指向 harness 进程里的**假 internal API**(只记账:不发微信、不碰 projects.json / 记忆 / 对话)。
 * agy 项目先用 `--agy-init` 建好(不发消息),之后每轮 `--project <id> --agent wccsandbox --sandbox`。
 *
 * 每一批真模型调用之前都要 `bx status --json` 报 protected + healthy(agy 连 Google,是需要保护的端点);
 * 不满足就中止。
 */
import { mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { homedir } from 'node:os'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { findBx, readBxStatus, type BxExec } from '../../../src/daemon/guard/bx'

export const AGY_SANDBOX_AGENT = 'wccsandbox'
/** 生产的 wechat MCP 入口(源码模式)。 */
export const WECHAT_MCP_MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/mcp-servers/wechat/main.ts')

// ─── 网络守护 ─────────────────────────────────────────────────────────────

/** agy 连 Google:只在 bx 报 protected + tunnel_healthy 时跑。读不出 / 不安全 ⇒ 抛,调用方中止整批。 */
export async function assertBxProtected(opts: { exec?: BxExec; bin?: string | null } = {}): Promise<string> {
  const bin = opts.bin === undefined ? findBx() : opts.bin
  if (!bin) throw new Error('[reply-once/agy] 找不到 bx —— agy 连 Google,没有 bx 的保护信号就不跑。')
  const v = await readBxStatus(bin, opts.exec ? { exec: opts.exec } : {})
  if (!v.safe) throw new Error(`[reply-once/agy] 网络未受保护(${v.detail})—— 中止,不调 agy。`)
  return v.detail
}

// ─── 假 internal API ─────────────────────────────────────────────────────

export interface FakeInternalApi {
  url: string
  token: string
  tokenFile: string
  close(): Promise<void>
}

export type FakeApiHandler = (method: 'GET' | 'POST', path: string, body: unknown) => Promise<unknown>

/**
 * 127.0.0.1 上的假 internal API:Bearer 令牌对得上才答,答案由 handler 给(harness 的 fakeInternalApi —— 和
 * openai 臂同一套假数据)。生产的 MCP 子进程经 `createInternalApiClient` 打过来,所以 MCP 这一层是真的。
 */
export async function startFakeInternalApi(dir: string, handler: FakeApiHandler): Promise<FakeInternalApi> {
  const token = randomBytes(16).toString('hex')
  const tokenFile = join(dir, 'internal-token')
  writeFileSync(tokenFile, token, { mode: 0o600 })
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
        if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' })
        let body: unknown = null
        if (req.method === 'POST') { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return send(400, { error: 'malformed_json' }) } }
        try { send(200, await handler(req.method === 'POST' ? 'POST' : 'GET', req.url ?? '/', body)) } catch (err) { send(500, { error: String(err) }) }
      })()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('fake internal api: no port')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    token,
    tokenFile,
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}

// ─── 临时工作区 ───────────────────────────────────────────────────────────

/** 写给 agy 的 MCP 子进程环境 —— 和 daemon 写进全局配置的那一份同形(见 agy-mcp-config.ts),只是指向假 API。 */
export function sandboxMcpEnv(opts: { mode: 'tool' | 'daemon'; api: Pick<FakeInternalApi, 'url' | 'token' | 'tokenFile'>; stateDir: string }): Record<string, string> {
  return {
    WECHAT_INTERNAL_API: opts.api.url,
    WECHAT_INTERNAL_TOKEN_FILE: opts.api.tokenFile,
    WECHAT_PARTICIPANT_TAG: 'agy',
    WECHAT_SESSION_TOKEN: opts.api.token,
    WECHAT_SESSION_TIER: 'trusted',
    WECHAT_STATE_DIR: opts.stateDir,
    WECHAT_DISABLE_LOG_FILE: '1',
    ...(opts.mode === 'daemon' ? { WECHAT_REPLY_DELIVERY: 'daemon' } : {}),
  }
}

/**
 * agent 定义(agy 1.2.16 实测出来的形状,每一条都踩过):
 *   - frontmatter 里**不能**写 `mcpServers`:写了整个 agent 就「not found」,静默退回默认 agent(默认 agent
 *     会加载主人的全局 MCP);
 *   - `inheritCustomizations: false` 管 skills / rules / plugins;**全局 MCP 要另外 `inheritMcp: false`**;
 *   - 我们的 MCP 服务器放进一个插件(`plugin.json` + `mcp_config.json`),`plugins:` 里写**绝对路径**
 *     (相对路径报「AgentBasePath is not set」);
 *   - 正文是 H1 分段的系统提示,只写一句中性的话;真正的指令照生产走 `-p` 文本的前缀。
 * agent 只在已绑定到这个工作区的 agy 项目里找得到(`--project <id>`);`--new-project` 那一次找不到,
 * 所以 harness 先建项目(不发消息)再跑。
 */
export function agentMarkdown(pluginDir: string): string {
  return [
    '---',
    `name: ${AGY_SANDBOX_AGENT}`,
    'description: wechat-cc reply-once experiment sandbox',
    'inheritCustomizations: false',
    'inheritMcp: false',
    `plugins: [${JSON.stringify(pluginDir)}]`,
    '---',
    '',
    `# ${AGY_SANDBOX_AGENT}`,
    '',
    'You are a helpful assistant.',
    '',
  ].join('\n')
}

export function agentMcpConfig(opts: { command: string; args: string[]; env: Record<string, string> }): string {
  return JSON.stringify({ mcpServers: { wechat: { command: opts.command, args: opts.args, env: opts.env } } }, null, 2) + '\n'
}

export function writeAgySandboxWorkspace(dir: string, opts: { mode: 'tool' | 'daemon'; api: FakeInternalApi; stateDir: string; command?: string }): string {
  const agentDir = join(dir, '.agents', 'agents', AGY_SANDBOX_AGENT)
  const pluginDir = join(agentDir, 'plugin')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(agentDir, 'agent.md'), agentMarkdown(pluginDir))
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'wccsandbox' }) + '\n')
  writeFileSync(join(pluginDir, 'mcp_config.json'), agentMcpConfig({ command: opts.command ?? process.execPath, args: [WECHAT_MCP_MAIN], env: sandboxMcpEnv(opts) }), { mode: 0o600 })
  return agentDir
}

/**
 * provider 拼好的 agy 参数 → 沙盒参数:`--new-project` 换成 `--project <沙盒项目>`(agent 只在已绑定到工作区的
 * 项目里找得到;也不往 agy 的项目表里每次加一个);加 `--agent wccsandbox` 与 `--sandbox`(终端命令受限)。
 *
 * `--dangerously-skip-permissions` **保留**(偏离 spec §5.3 的原计划,理由):agy 1.2.16 的 print 模式不带它
 * 就把**每一次 MCP 调用**软拒掉(cli.log:`Print mode: soft-denying tool confirmation "CallMcpTool"`,第一次
 * 冒烟 d 场景实测)—— legacy 的 reply 发不出去、daemon 的附件挂不上,两臂量的都不是生产(生产对主人的会话
 * 就带这个开关)。补偿:工作区是临时目录、agent 不继承任何全局定制、所有 wechat 工具背后是假 API、终端走
 * `--sandbox`。
 */
export function sandboxAgyArgs(args: readonly string[], projectId: string): string[] {
  const out: string[] = []
  for (const a of args) {
    if (a === '--new-project') { out.push('--project', projectId); continue }
    out.push(a)
  }
  return [...out, '--agent', AGY_SANDBOX_AGENT, '--sandbox']
}

/** createAgyAgentProvider 的 spawnFn:真的 agy,沙盒参数,cwd 固定在沙盒工作区。 */
export function sandboxSpawnFn(opts: { bin: string; workspace: string; projectId: string; onArgs?: (args: string[]) => void; rawLog?: (chunk: string) => void }) {
  return (args: string[]) => {
    const full = sandboxAgyArgs(args, opts.projectId)
    opts.onArgs?.(full)
    const child = spawn(opts.bin, full, { cwd: opts.workspace, stdio: ['ignore', 'pipe', 'pipe'] })
    // 原始 NDJSON 另抄一份(排查用);解析器读的是同一份字节。
    const out = new PassThrough()
    child.stdout.on('data', (d: Buffer) => { opts.rawLog?.(d.toString('utf8')); out.write(d) })
    child.stdout.on('end', () => out.end())
    let err = ''
    child.stderr.on('data', (d: Buffer) => { if (err.length < 64 * 1024) err += d.toString('utf8') })
    const exited = new Promise<number>(r => child.on('exit', (code) => r(code ?? 1)))
    return {
      stdout: out as unknown as AsyncIterable<Uint8Array>,
      exited,
      stderr: async () => { await exited; return err },
      kill: () => { try { child.kill() } catch { /* gone */ } },
    }
  }
}

/**
 * 给沙盒工作区建一个 agy 项目,**不发任何消息**:`agy -p . --new-project` 起来、项目一建好(启动阶段,
 * 在认证与建对话之前)就杀掉。项目 id 从 agy 自己的日志里读(只读)。
 */
export async function createAgyProject(opts: { bin: string; workspace: string; appDataDir?: string; timeoutMs?: number }): Promise<string> {
  const logLink = join(opts.appDataDir ?? join(homedir(), '.gemini', 'antigravity-cli'), 'cli.log')
  const before = safeReadlink(logLink)
  const child = spawn(opts.bin, ['-p', '.', '--output-format', 'stream-json', '--new-project'], { cwd: opts.workspace, stdio: 'ignore' })
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
  try {
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
      if (safeReadlink(logLink) === before) continue
      let text = ''
      try { text = readFileSync(logLink, 'utf8') } catch { continue }
      if (!/trying silent auth|Print mode: starting/.test(text)) continue
      const m = /Backend project ID updated dynamically to: ([0-9a-f-]{36})/.exec(text)
      if (m && text.includes(`workspaceDirs=[${realpathSync(opts.workspace)}]`)) return m[1]!
      throw new Error('[reply-once/agy] 没读到沙盒项目 id(工作区对不上)')
    }
    throw new Error('[reply-once/agy] 建沙盒项目超时')
  } finally {
    try { child.kill() } catch { /* gone */ }
  }
}

function safeReadlink(p: string): string | null {
  try { return readlinkSync(p) } catch { return null }
}
