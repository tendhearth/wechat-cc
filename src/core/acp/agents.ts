/**
 * 走 ACP 的执行者启动描述。只认 cursor(`cursor-agent acp` 在用户已装的 CLI 里,零额外安装);
 * agy 的 ACP 面是 dl.google.com 上的独立二进制,按 2026-09-17 评估备忘推迟。
 * 不探测 --version、不起进程:能不能用由第一次 initialize 真跑说了算(codex-version-coupling 定案)。
 */
export interface AcpAgentLaunch { id: 'cursor'; displayName: string; command: string; args: string[] }

export function resolveAcpAgent(id: 'cursor', config: { cursorAgentBin?: string }, findOnPath: (cmd: string) => string | null): AcpAgentLaunch | null {
  if (id !== 'cursor') return null
  const command = config.cursorAgentBin ?? findOnPath('cursor-agent')
  return command ? { id: 'cursor', displayName: 'Cursor', command, args: ['acp'] } : null
}
