/**
 * 本机运维用的三个信号(从 main.ts 抽出来,2026-10-26;开机成功之后才装):
 *  - SIGUSR1:拉消息那一层重新对一遍账号(polling reconcile);
 *  - SIGUSR2:现在就跑一拍伙伴推送(不等 ~20 分钟的定时器),`wechat-cc companion push` 发的(cli/companion-push.ts);
 *  - SIGWINCH:现在就跑一拍每天的反省(+ 可选的画室)。测试 / 运维用,平时照旧每天一次。
 */
import { log } from '../../lib/log'

export function installOperatorSignals(handle: {
  pollingReconcile?(): Promise<void>
  fireTick(kind: 'push' | 'introspect', at: Date): Promise<void>
}): void {
  process.on('SIGUSR1', () => { handle.pollingReconcile?.()?.catch(err => log('RECONCILE', `SIGUSR1 reconcile failed: ${err instanceof Error ? err.message : String(err)}`)) })
  process.on('SIGUSR2', () => {
    log('SCHED', 'SIGUSR2 — manual push tick requested')
    handle.fireTick('push', new Date()).catch(err => log('SCHED', `SIGUSR2 push tick failed: ${err instanceof Error ? err.message : String(err)}`))
  })
  process.on('SIGWINCH', () => {
    log('SCHED', 'SIGWINCH — manual introspect tick requested')
    handle.fireTick('introspect', new Date()).catch(err => log('SCHED', `SIGWINCH introspect tick failed: ${err instanceof Error ? err.message : String(err)}`))
  })
}
