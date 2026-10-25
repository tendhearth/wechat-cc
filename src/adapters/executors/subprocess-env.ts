/**
 * 工作台起的每一个子进程(Codex app-server、ACP 执行者,以及它们自己再 spawn 出去的 MCP 子进程)
 * 共用的环境变量过滤:供应商鉴权与代理照留,daemon 自己的凭据与状态指针一律摘掉 ——
 * 它们在工作台子进程里没有任何用途,留着只是把主人的微信凭据递给一个外部 CLI。
 */
const DAEMON_CREDENTIAL = /^(WECHAT_|HEARTH_|WXVAULT_|WXGRAPH_)/i

export function workbenchSubprocessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const name of Object.keys(env)) if (DAEMON_CREDENTIAL.test(name)) delete env[name]
  return env
}
