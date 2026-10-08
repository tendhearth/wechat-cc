/**
 * `wechat-cc cli acp list|add|remove` 的纯逻辑(2026-10-07):改 agent-config 的 acp_agents。生效要重启 daemon。
 */
import { ACP_PRESETS, acpAgentProblem, type AcpCustomAgent } from '../core/acp/agents'

type Agent = { id: string; name: string; command: string; args?: string[]; auth_method?: string }

/** 加一个:给了预设 id 且没给命令 ⇒ 用预设(命令名要在 PATH 上找得到);同 id ⇒ 替换。 */
/**
 * 加一个。authMethod 没给时,预设可以自己从 agent 的配置里读出本机在用的登录方式(Gemini CLI:~/.gemini/settings.json)。
 */
export function addAcpAgent(agents: readonly Agent[], input: { id: string; name?: string; command?: string; args?: string[]; authMethod?: string }, findOnPath: (cmd: string) => string | null, detectAuth: (presetId: string) => string | null = () => null):
  { ok: true; agents: Agent[]; agent: Agent; replaced: boolean } | { ok: false; error: string } {
  const preset = ACP_PRESETS[input.id]
  if (!input.command && !preset) return { ok: false, error: `${input.id} 不是已知的预设(${Object.keys(ACP_PRESETS).join(' / ')}),请用 --command 给出启动命令` }
  const command = input.command ?? preset!.bin
  if (!input.command && !findOnPath(command)) return { ok: false, error: `没找到 ${command},先装好它再加` }
  const authMethod = input.authMethod ?? (preset ? detectAuth(input.id) : null)
  const agent: Agent = { id: input.id, name: input.name ?? preset?.name ?? input.id, command, ...(input.args ?? preset?.args ? { args: input.args ?? [...preset!.args] } : {}), ...(authMethod ? { auth_method: authMethod } : {}) }
  const problem = acpAgentProblem(agent)
  if (problem) return { ok: false, error: problem }
  const replaced = agents.some(a => a.id === agent.id)
  return { ok: true, agents: [...agents.filter(a => a.id !== agent.id), agent], agent, replaced }
}

export function removeAcpAgent(agents: readonly Agent[], id: string): { ok: true; agents: Agent[] } | { ok: false; error: string } {
  if (!agents.some(a => a.id === id)) return { ok: false, error: `没有叫 ${id} 的执行者` }
  return { ok: true, agents: agents.filter(a => a.id !== id) }
}

export function formatAcpAgents(agents: readonly Agent[], findOnPath: (cmd: string) => string | null): string {
  const lines = agents.length
    ? agents.map(a => `${a.id}  ${a.name}  ${[a.command, ...(a.args ?? [])].join(' ')}${a.command.startsWith('/') || findOnPath(a.command) ? '' : '  (找不到命令,不会登记)'}`)
    : ['还没有自定义 ACP 执行者。']
  const presets = Object.entries(ACP_PRESETS).map(([id, p]) => `  ${id}  ${p.name}  ${[p.bin, ...p.args].join(' ')}${findOnPath(p.bin) ? '  (已装)' : ''}${p.note ? `\n      ${p.note}` : ''}`)
  return [...lines, '', '预设(wechat-cc cli acp add <预设>):', ...presets, '', '改完要重启 daemon 才生效:wechat-cc service stop && wechat-cc service start'].join('\n')
}
export type { AcpCustomAgent }

/** 本机 Gemini CLI 在用的登录方式(settings.json 的 security.auth.selectedType,老版本叫 selectedAuthType)。读不到 ⇒ null。 */
export function detectGeminiAuthMethod(readSettings: () => string | null): string | null {
  try {
    const raw = readSettings(); if (!raw) return null
    const s = JSON.parse(raw) as { security?: { auth?: { selectedType?: unknown } }; selectedAuthType?: unknown }
    const v = s.security?.auth?.selectedType ?? s.selectedAuthType
    return typeof v === 'string' && /^[a-z0-9-]{1,64}$/.test(v) ? v : null
  } catch { return null }
}
