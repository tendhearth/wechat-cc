/**
 * 进程级的兜底(从 main.ts 抽出来,2026-10-26):退出前后各记一行;没接住的异常 / 被拒的 promise 记下原因再 exit(1),
 * 交给 launchd / systemd 拉起(main() 在开机成功之后才装)。
 */
import { log } from '../../lib/log'

function errorDetails(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message
  try { return JSON.stringify(err) } catch { return String(err) }
}

export function installCrashGuards(): void {
  process.on('beforeExit', (code) => log('DAEMON', `beforeExit code=${code}`))
  process.on('exit', (code) => log('DAEMON', `exit code=${code}`))
  process.on('uncaughtException', (err) => {
    log('DAEMON', `uncaughtException: ${errorDetails(err)}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    log('DAEMON', `unhandledRejection: ${errorDetails(reason)}`)
    process.exit(1)
  })
}
