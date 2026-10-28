/**
 * daemon 自己要求的重启(从 main.ts 抽出来,2026-10-26):先让调用方把话说完(HTTP 回包 / 一行日志),再优雅收尾 + exit,
 * launchd / systemd 的 KeepAlive 拉起一个新的。一个闭包、两个触发:运维的 POST /v1/daemon/restart 和空闲自动重启 —— 同一条优雅路径。
 */
import { log } from '../../lib/log'
import { markCleanShutdown, markPlannedRestart } from '../../lib/restart-markers'

export function makeRequestRestart(stateDir: string, shutdown: () => Promise<void>): (reason: string) => void {
  return (reason) => {
    log('DAEMON', `restart requested (${reason}) — shutting down for KeepAlive respawn`)
    // 给下次开机留一张「这次是计划内的」纸条:daemon 自己要求的重启一律不在微信里播报。
    markPlannedRestart(stateDir, reason)
    // 这也是一次优雅退出:留优雅退出纸条,下一个进程撞上锁时才认得出「它在收尾」、等它退。
    markCleanShutdown(stateDir, `restart:${reason}`)
    setTimeout(() => { void shutdown().finally(() => process.exit(0)) }, 500)
  }
}
