/**
 * 空闲自动重启是一个模块(第三批 3b 第 5 步):没有 requestRestart(测试、嵌入)⇒ off;它只造一个 check 函数,
 * 自己不起定时器(谁来拍它见 wiring),所以没有要停的东西。
 * 单独成文件、从 ./wire-self-restart import:bootstrap.test 用 vi.mock 包了真的 wireSelfRestart 来核对传进去的闭包,
 * 同一个文件里的调用走的是本地绑定,mock 看不到。
 */
import type { DaemonModule } from '../modules/container'
import { wireSelfRestart, type WireSelfRestartDeps, type WireSelfRestartResult } from './wire-self-restart'

export function selfRestartModule(deps: WireSelfRestartDeps): DaemonModule<WireSelfRestartResult> {
  return {
    name: 'self-restart',
    optional: true,
    enabled: () => !!deps.requestRestart,
    async init() {
      const r = await wireSelfRestart(deps)
      if (!r) throw new Error('self-restart: requestRestart missing')   // enabled() 已经挡过,到不了
      return r
    },
  }
}
