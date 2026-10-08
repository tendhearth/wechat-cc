// `wechat-cc cli acp list|add|remove` —— 自定义 ACP 执行者(2026-10-07):任何会说 ACP 的 CLI 接进一起做。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'

async function deps() {
  const { loadAgentConfig, saveAgentConfig } = await import('../../lib/agent-config')
  const { findOnPath } = await import('../../lib/util')
  return { load: () => loadAgentConfig(STATE_DIR), save: (c: Parameters<typeof saveAgentConfig>[1]) => saveAgentConfig(STATE_DIR, c), findOnPath }
}

const listCmd = defineCommand({
  meta: { name: 'list', description: '列出自定义 ACP 执行者和可用的预设' },
  async run() {
    const d = await deps(), { formatAcpAgents } = await import('../acp-agents')
    console.log(formatAcpAgents(d.load().acp_agents ?? [], d.findOnPath))
  },
})
const addCmd = defineCommand({
  meta: { name: 'add', description: '加一个 ACP 执行者:预设(gemini-cli / opencode / goose / qwen-code)或 --command 自定义' },
  args: {
    id: { type: 'positional', required: true, description: '执行者 id(预设名或自定义,小写字母 / 数字 / 连字符)' },
    name: { type: 'string', description: '显示名' },
    command: { type: 'string', description: '启动命令(可执行文件名或绝对路径)' },
    args: { type: 'string', description: '参数,空格分隔,如 "acp" 或 "--acp"' },
    'auth-method': { type: 'string', description: 'ACP 登录方式 id(如 oauth-personal);预设会自己从 agent 配置里读' },
  },
  async run({ args }) {
    const d = await deps(), { addAcpAgent, detectGeminiAuthMethod } = await import('../acp-agents')
    const { readFileSync } = await import('node:fs'), { homedir } = await import('node:os'), { join } = await import('node:path')
    const detect = (presetId: string) => presetId === 'gemini-cli' ? detectGeminiAuthMethod(() => { try { return readFileSync(join(homedir(), '.gemini', 'settings.json'), 'utf8') } catch { return null } }) : null
    const config = d.load()
    const r = addAcpAgent(config.acp_agents ?? [], { id: args.id, ...(args.name ? { name: args.name } : {}), ...(args.command ? { command: args.command } : {}), ...(args.args !== undefined ? { args: args.args.split(/\s+/).filter(Boolean) } : {}), ...(args['auth-method'] ? { authMethod: args['auth-method'] } : {}) }, d.findOnPath, detect)
    if (!r.ok) { console.error(`cli acp add: ${r.error}`); process.exit(1) }
    d.save({ ...config, acp_agents: r.agents })
    console.log(`${r.replaced ? '已更新' : '已加'} ${r.agent.id}(${r.agent.name}):${[r.agent.command, ...(r.agent.args ?? [])].join(' ')}${r.agent.auth_method ? `,登录方式 ${r.agent.auth_method}` : ''}\n重启 daemon 后出现在一起做的执行者里:wechat-cc service stop && wechat-cc service start`)
  },
})
const removeCmd = defineCommand({
  meta: { name: 'remove', description: '去掉一个自定义 ACP 执行者' },
  args: { id: { type: 'positional', required: true, description: '执行者 id' } },
  async run({ args }) {
    const d = await deps(), { removeAcpAgent } = await import('../acp-agents')
    const config = d.load()
    const r = removeAcpAgent(config.acp_agents ?? [], args.id)
    if (!r.ok) { console.error(`cli acp remove: ${r.error}`); process.exit(1) }
    d.save({ ...config, acp_agents: r.agents })
    console.log(`已去掉 ${args.id}。重启 daemon 后生效:wechat-cc service stop && wechat-cc service start`)
  },
})
export const cliAcpCmd = defineCommand({
  meta: { name: 'acp', description: '自定义 ACP 执行者:任何会说 ACP 的 CLI(Gemini CLI / OpenCode / Goose …)接进一起做' },
  subCommands: { list: listCmd, add: addCmd, remove: removeCmd },
})
