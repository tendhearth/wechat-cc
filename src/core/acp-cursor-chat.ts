/**
 * 对话侧的 Cursor:同一个 ACP 客户端(acp-agent-provider.ts),每会话一个常驻 cursor-agent acp,
 * wechat / delegate MCP 按会话注入并带逐会话 token 与 tier —— 于是主人聊天拿得到 admin 工具
 * (adminMcpTools:true),不再需要往 ~/.cursor/mcp.json 塞一把静态钥匙。
 * 一次性评估仍走 print(cursor-eval.ts)。
 */
import type { AgentProvider, ProviderCapabilities, SpawnContext } from './agent-provider'
import { assertNotAuthFailed, CORE_MCP_SERVER_NAMES } from './agent-provider'
import type { McpStdioSpec } from './mcp-stdio-spec'
import { createAcpProvider, type AcpMcpServer } from './acp-agent-provider'
import { cursorOneShotEval, defaultCursorSpawnFn, type CursorSpawnFn } from './cursor-eval'

/** cursorModel 没设时的兜底('auto' = 让 Cursor 自己挑)。 */
export const DEFAULT_CURSOR_MODEL = 'auto'

export const ACP_CURSOR_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: false,
  // session/new.mcpServers[].env 逐会话带 WECHAT_SESSION_TOKEN/_TIER(spike 2026-09-17 第 4 条实证到模型手里),
  // 所以 owner/admin 聊天真的拿到 admin tier —— 与 claude/codex 同档。
  adminMcpTools: true,
  sandboxLevels: new Set(),
  supportsDelegation: false,
  supportsResume: true,
  // Cursor 自己的工具面按 permissionMode 就地判(acp-agent-provider 的 permissions:'mode'),
  // tierProfile 根本到不了它;更要命的是工作区内的文件编辑压根不发 session/request_permission
  // (2026-09-17 真机 spike 第 2 条)—— 访客的权限约束不到它,所以 guest 一律拒。
  guestSafe: false,
  defaultPeer: 'claude',
  authFailHint: 'cursor 登录态失效,请在电脑上跑一次 `cursor-agent login` 重新登录后再发消息。',
}

export interface AcpCursorChatOptions {
  bin: string
  model: string
  log: (tag: string, line: string) => void
  /** boot 给的 MCP spec,键就是规范名;null ⇒ 不注入。 */
  mcpSpecs: { wechat: McpStdioSpec | null; delegate: McpStdioSpec | null }
  evalSpawn?: CursorSpawnFn
  spawn?: typeof import('node:child_process').spawn
}

/** MCP 子进程 env:PATH/HOME(gemini 曾因缺这层拿不到 PATH)+ spec.env + 会话 env(只给 CORE 名字,与 mergeEnvIntoMcpServers 同一条规矩)。 */
export function acpMcpServersFor(specs: AcpCursorChatOptions['mcpSpecs'], mcpEnv?: Record<string, string>): AcpMcpServer[] {
  const servers: AcpMcpServer[] = []
  for (const name of ['wechat', 'delegate'] as const) {
    const spec = specs[name]
    if (!spec) continue
    const env: Record<string, string> = {}
    for (const key of ['PATH', 'HOME']) { const value = process.env[key]; if (typeof value === 'string') env[key] = value }
    Object.assign(env, spec.env ?? {}, CORE_MCP_SERVER_NAMES.has(name) ? mcpEnv ?? {} : {})
    servers.push({ name, command: spec.command, args: spec.args ?? [], env: Object.entries(env).map(([k, v]) => ({ name: k, value: v })) })
  }
  return servers
}

export function createAcpCursorChatProvider(options: AcpCursorChatOptions): AgentProvider {
  const evalSpawn = options.evalSpawn ?? defaultCursorSpawnFn(options.bin)
  const base = createAcpProvider({
    command: options.bin, args: ['acp'], displayName: 'Cursor', log: options.log, spawn: options.spawn,
    permissions: 'mode', text: 'messages', resume: 'fallback', notice: null,
    mcpServers: (context: SpawnContext) => acpMcpServersFor(options.mcpSpecs, context.mcpEnv),
    model: (context: SpawnContext) => context.model ?? options.model,
  })
  return {
    spawn: base.spawn,
    /** CLI 子进程一档,与 codex 同量级。 */
    cheapEvalBudgetMs: 20_000,
    async cheapEval(prompt: string): Promise<string> {
      const text = await cursorOneShotEval(evalSpawn, options.model, prompt)
      assertNotAuthFailed(text, options.log, 'cursor cheapEval')
      return text
    },
    async strongEval(prompt: string): Promise<string> {
      const text = await cursorOneShotEval(evalSpawn, options.model, prompt)
      assertNotAuthFailed(text, options.log, 'cursor strongEval')
      return text
    },
  }
}
