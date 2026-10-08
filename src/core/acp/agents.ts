/**
 * 走 ACP 的执行者启动描述。只认 cursor(`cursor-agent acp` 在用户已装的 CLI 里,零额外安装);
 * agy 的 ACP 面是 dl.google.com 上的独立二进制,按 2026-09-17 评估备忘推迟。
 * 不探测 --version、不起进程:能不能用由第一次 initialize 真跑说了算(codex-version-coupling 定案)。
 */
export interface AcpAgentLaunch { id: 'cursor'; displayName: string; command: string; args: string[] }

export function resolveAcpAgent(id: 'cursor', config: { cursorAgentBin?: string }, findOnPath: (cmd: string) => string | null): AcpAgentLaunch | null {
  if (id !== 'cursor') return null
  // `||` 而不是 `??`:配成空串等于没配(面板清空一格就是空串),该回落到 PATH 上找。
  const command = config.cursorAgentBin || findOnPath('cursor-agent')
  return command ? { id: 'cursor', displayName: 'Cursor', command, args: ['acp'] } : null
}

/**
 * 自定义 ACP 执行者(2026-10-07,主人定位「取代 Paseo 这一层」的第二项:能接的 agent 更多)。
 * 任何会说 ACP 的 CLI 都能接进一起做,像 Zed 的 custom agent servers:配置里写 id / 名字 / 命令,开机登记成执行者。
 * 常见的给预设(装了就能一键加);别的照写命令。
 */
export interface AcpCustomAgent { id: string; name: string; command: string; args: string[] }
/** 内置执行者的 id 不能被占(claude / codex / cursor / agy / openai / gemini …)。 */
export const RESERVED_EXECUTOR_IDS: ReadonlySet<string> = new Set(['claude', 'codex', 'cursor', 'agy', 'openai', 'gemini', 'api'])
export const ACP_AGENT_ID = /^[a-z][a-z0-9-]{1,30}$/
/** 已知会说 ACP 的 CLI:命令名 + 参数。版本不对的话第一次 initialize 会如实报错,这里不探测。 */
export const ACP_PRESETS: Readonly<Record<string, { name: string; bin: string; args: string[] }>> = Object.freeze({
  'gemini-cli': { name: 'Gemini CLI', bin: 'gemini', args: ['--acp'] },
  opencode: { name: 'OpenCode', bin: 'opencode', args: ['acp'] },
  goose: { name: 'Goose', bin: 'goose', args: ['acp'] },
  'qwen-code': { name: 'Qwen Code', bin: 'qwen', args: ['--acp'] },
})

/** 校验一条配置;不合格 ⇒ 原因(给 CLI 说清楚,开机时记一行日志跳过)。 */
export function acpAgentProblem(agent: { id?: unknown; name?: unknown; command?: unknown; args?: unknown }): string | null {
  if (typeof agent.id !== 'string' || !ACP_AGENT_ID.test(agent.id)) return 'id 只能是小写字母开头的字母 / 数字 / 连字符,2–31 个字符'
  if (RESERVED_EXECUTOR_IDS.has(agent.id)) return `${agent.id} 是内置执行者的名字`
  if (typeof agent.name !== 'string' || !agent.name.trim() || agent.name.length > 40) return '名字要 1–40 个字'
  if (typeof agent.command !== 'string' || !agent.command.trim()) return '要有启动命令'
  if (agent.args !== undefined && (!Array.isArray(agent.args) || agent.args.some(a => typeof a !== 'string') || agent.args.length > 20)) return '参数要是字符串列表'
  return null
}

/** 命令是绝对路径 ⇒ 原样;否则在 PATH 上找。找不到 ⇒ null(不登记,记一行)。 */
export function resolveCustomAcpAgent(agent: AcpCustomAgent, findOnPath: (cmd: string) => string | null): AcpCustomAgent | null {
  const command = agent.command.startsWith('/') || /^[A-Za-z]:[\\/]/.test(agent.command) ? agent.command : findOnPath(agent.command)
  return command ? { ...agent, command } : null
}
