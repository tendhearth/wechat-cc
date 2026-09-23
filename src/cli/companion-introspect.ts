/**
 * companion introspect — tell THIS machine's running daemon to fire the
 * introspection + Atelier tick immediately. Unix only, matching companion-push.
 */
import { join } from 'node:path'

export interface IntrospectTickDeps {
  readPid: (path: string) => string | null
  kill: (pid: number, signal: string) => void
}

export function requestIntrospectTick(deps: IntrospectTickDeps, stateDir: string): { pid: number } {
  const raw = deps.readPid(join(stateDir, 'server.pid'))
  if (!raw) throw new Error('daemon 没在本机运行(无 server.pid)— 先启动本机 daemon')
  const pid = parseInt(raw.trim(), 10)
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`server.pid 内容无效: ${raw.trim()}`)
  // SIGWINCH is supported by Node on macOS and is ignored by default when no
  // handler is installed; the daemon opts into it below as a local control.
  deps.kill(pid, 'SIGWINCH')
  return { pid }
}
