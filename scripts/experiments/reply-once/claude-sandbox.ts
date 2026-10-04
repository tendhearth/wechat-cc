/**
 * EXPERIMENT ONLY — reply-once harness 的 Claude 真模型沙盒(回复交付第 5 步,2026-10-03)。daemon 不 import 它。
 *
 * 真 Claude Code(主人装的那个 `claude` 二进制,经 Agent SDK 的 `query()`)+ 真模型(api.anthropic.com,需要保护的
 * 端点)+ **生产的** Claude provider 与 wechat MCP 入口,背后是本进程里的假 internal API。主人的东西一样都不碰:
 *
 *   - **HOME 是临时目录**(于是 Claude Code 的配置目录 `~/.claude` 也在沙盒里):不读主人的 settings / CLAUDE.md /
 *     hooks / skills / 插件 / MCP,也不往主人的 `~/.claude` 写会话、历史、遥测。
 *   - **登录只读、不落盘**:Claude Code 的登录在钥匙串(「Claude Code-credentials」),沙盒 HOME 下它找不到。这里在
 *     进程内读一次那条钥匙串的 access token,只经 `CLAUDE_CODE_OAUTH_TOKEN` 环境变量交给子进程 —— 不写文件、不打印,
 *     **不给 refresh token** ⇒ 子进程没法刷新 / 轮换主人的登录。离过期不到 60 分钟就拒跑(宁可不跑)。跑完核对钥匙串
 *     那一项的修改时间没变(assertKeychainUntouched)。
 *   - 工作目录是临时目录;内置工具一律经 canUseTool 记账并**拒绝**(spec §5.8:Claude 用 canUseTool 只记账全拒),
 *     wechat MCP 的工具放行(它背后是假 API)。
 *   - 每一轮之前 `bx status --json` 必须 protected + healthy(assertBxProtected),否则整批中止;另按守护的判定核对
 *     这次连的是官方端点(classifyCall)。
 *   - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`:除了模型调用不连别的。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { query, type CanUseTool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { classifyCall } from '../../../src/lib/call-classifier'
import { claudeBaseUrl } from '../../../src/core/claude-agent-provider'

const KEYCHAIN_SERVICE = 'Claude Code-credentials'
/** access token 离过期不到这么久就拒跑(Claude Code 快过期时会刷新 —— 这里不给 refresh token,刷不了也不该让它去刷)。 */
const MIN_TOKEN_LIFE_MS = 60 * 60_000

export interface ClaudeSandbox { home: string; workdir: string; env: Record<string, string>; keychainMdat: string }

function keychainAttrs(): string {
  const r = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('[reply-once/claude] 钥匙串里没有 Claude Code 的登录 —— 不跑真模型')
  return r.stdout
}
const mdatOf = (attrs: string): string => /"mdat"<timedate>=([^\n]*)/.exec(attrs)?.[1]?.trim() ?? ''

/** 读一次 access token(只在内存里),检查剩余寿命。 */
function readAccessToken(now: number): string {
  const r = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('[reply-once/claude] 读不到 Claude Code 的登录 —— 不跑真模型')
  let j: { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }
  try { j = JSON.parse(r.stdout.trim()) } catch { throw new Error('[reply-once/claude] 登录格式认不得 —— 不跑真模型') }
  const tok = j.claudeAiOauth?.accessToken
  const exp = j.claudeAiOauth?.expiresAt
  if (!tok || typeof exp !== 'number') throw new Error('[reply-once/claude] 登录里没有 access token / expiresAt —— 不跑真模型')
  if (exp - now < MIN_TOKEN_LIFE_MS) throw new Error(`[reply-once/claude] access token ${Math.round((exp - now) / 60000)} 分钟后过期(< 60)—— 拒跑,不去碰刷新`)
  return tok
}

export function makeClaudeSandbox(root: string, opts: { now?: number } = {}): ClaudeSandbox {
  const keychainMdat = mdatOf(keychainAttrs())
  const token = readAccessToken(opts.now ?? Date.now())
  const home = join(root, 'home')
  const workdir = join(root, 'work')
  for (const d of [home, workdir]) mkdirSync(d, { recursive: true })
  // 子进程的**整份**环境(SDK 的 options.env 不和 process.env 合并):不继承 ANTHROPIC_* / CLAUDE_CONFIG_DIR 之类。
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: join(root, 'tmp'),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  }
  mkdirSync(env.TMPDIR!, { recursive: true })
  return { home, workdir, env, keychainMdat }
}

/** 跑完核对:主人那条钥匙串登录的修改时间没变 ⇒ 没被刷新 / 轮换 / 改写。 */
export function assertKeychainUntouched(sb: ClaudeSandbox): void {
  const now = mdatOf(keychainAttrs())
  if (now !== sb.keychainMdat) throw new Error(`[reply-once/claude] 钥匙串登录的修改时间变了(${sb.keychainMdat} → ${now})—— 立刻停下查原因`)
}

/** 这次真的会打到哪里:子进程环境里没有 ANTHROPIC_BASE_URL ⇒ 官方端点;守护同一套判定,必须是受保护的官方端点。 */
export function assertSandboxTarget(sb: ClaudeSandbox, model: string): string {
  const c = classifyCall({ provider: 'claude', model, baseUrl: claudeBaseUrl(sb.env) })
  if (!c.protected || c.kind !== 'official') throw new Error(`[reply-once/claude] 目标不是预期的官方端点(${JSON.stringify(c)})—— 拒跑`)
  return `${c.kind} ${c.host ?? ''}`.trim()
}

/** 内置工具一律记账并拒绝;wechat MCP 放行(背后是假 internal API)。 */
export function sandboxCanUseTool(onBuiltin: (name: string) => void): CanUseTool {
  return async (toolName) => {
    if (toolName.startsWith('mcp__wechat__')) return { behavior: 'allow' }
    onBuiltin(toolName)
    return { behavior: 'deny', message: `(实验环境:${toolName} 未执行)` }
  }
}

/** 包一层真的 query():每条 SDK 消息另抄一份(录流),每条 user 消息(= 一个真模型回合)计数。 */
export function teeQuery(o: { onMessage?: (m: SDKMessage) => void; onTurn?: () => void }): typeof query {
  return ((args: Parameters<typeof query>[0]) => {
    const prompt = args.prompt
    const counted = typeof prompt === 'string' ? prompt : (async function* () { for await (const m of prompt) { o.onTurn?.(); yield m } })()
    const q = query({ ...args, prompt: counted })
    async function* gen(): AsyncGenerator<SDKMessage> { for await (const m of q) { o.onMessage?.(m); yield m } }
    const g = gen()
    return Object.assign(g, {
      interrupt: () => q.interrupt(),
      close: () => (q as unknown as { close?: () => void }).close?.(),
    })
  }) as unknown as typeof query
}

/** 生产 sdkOptionsForProject 的形状(wire-model-options.ts),换成沙盒:cwd / env / 设置来源 / 权限。 */
export function sandboxSdkOptions(sb: ClaudeSandbox, o: { model: string; claudeBin: string; append: string; wechat: { command: string; args: string[]; env: Record<string, string> }; canUseTool: CanUseTool }): Options {
  return {
    cwd: sb.workdir,
    model: o.model,
    env: sb.env,
    mcpServers: { wechat: { type: 'stdio', ...o.wechat } },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: o.append },
    settingSources: [],
    pathToClaudeCodeExecutable: o.claudeBin,
    permissionMode: 'default',
    canUseTool: o.canUseTool,
  }
}
