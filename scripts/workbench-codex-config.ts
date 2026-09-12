/** Explicit overrides: an empty MCP table merges with the user's configuration. */
export const workbenchFeatureConfig = { features: { plugins: false, apps: false, hooks: false } }
export function workbenchCodexConfig(servers: unknown) {
  if (!Array.isArray(servers) || servers.some(server => !server || typeof server.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(server.name))) {
    throw new Error('无法核实 Codex 的工具配置；暂不启动任务。')
  }
  return {
    ...workbenchFeatureConfig,
    mcp_servers: Object.fromEntries(servers.map(server => [server.name, { enabled: false }])),
  }
}
