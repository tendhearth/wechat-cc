/**
 * 唯一的 stdio MCP 子进程 spec(spec 2026-08-17-provider-runtime-dedup §1a)。
 * 此前五份结构等同的定义(bootstrap/mcp-specs、openai-mcp-bridge、cursor、
 * gemini、codex)收敛于此;全部是结构赋值互通,调用点零改动。
 */
export interface McpStdioSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

/**
 * 子进程 env 合并的唯一出口:继承宿主 env(PATH/HOME —— gemini 曾因缺这层
 * 而拿不到 PATH),叠加 spec 自带 env,最后叠加会话级 mcpEnv
 * (WECHAT_SESSION_TOKEN/_TIER —— gemini 曾因缺这层而绕过 tier 鉴权)。
 * 合并顺序即优先级:mcpEnv > spec.env > process.env。
 */
export function childEnvFor(spec: McpStdioSpec, mcpEnv?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') base[k] = v
  }
  return { ...base, ...(spec.env ?? {}), ...(mcpEnv ?? {}) }
}

/**
 * delegate 工具一次调用最多等多久(各家 MCP 客户端的缺省都是 60s:MCP SDK 的 DEFAULT_REQUEST_TIMEOUT_MSEC、
 * codex 的 tool_timeout_sec)。一次咨询 = 另起一个 AI 冷启动 + 回答,真机 10-24 两次是 147s / 275s;
 * 60s 就放弃的话,后台那份回答照样跑完、白白丢掉。只放宽 delegate,别的工具照旧。
 */
export const DELEGATE_TOOL_TIMEOUT_MS = 600_000
