/**
 * facts.ts — 从执行者的工具参数里取放行规则要的原文:命令(不压缩,截 2000)与文件路径。
 * Claude / Codex 的 hook tool_input、Claude SDK 的 canUseTool input 形状相同。拿不到就不给 —— 规则不猜。
 */
export const PERMISSION_COMMAND_MAX = 2000
const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const

export function toolInputFacts(input: unknown): { command?: string; paths: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { paths: [] }
  const o = input as Record<string, unknown>
  const cmd = o['command']
  const command = typeof cmd === 'string' ? cmd : Array.isArray(cmd) ? cmd.map(String).join(' ') : undefined
  const paths = PATH_KEYS.map(k => o[k]).filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1000)
  return command?.trim() ? { command: command.slice(0, PERMISSION_COMMAND_MAX), paths } : { paths }
}
