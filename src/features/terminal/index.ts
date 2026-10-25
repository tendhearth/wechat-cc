/**
 * 终端会话(spec 2026-09-09-cli-hook-push)—— 一个功能一个目录(架构终态 A5)。主人在 CC 外面开的终端 Claude Code / Codex /
 * Cursor 会话经 hooks 报进来:做完了推给主人、要批准的转成微信 y/n / 手机拍板、主人(或 CC 代主人)接着说一句。
 *
 *  - `wire.ts`:把下面这些接起来(登记处 hub、权限中继 + 放行规则、脑手转发、说一句、「今天」、接上 hooks);
 *  - `reply-handler.ts`:微信「终端 / 看 码 / @码 / y 码」和「接着跑」的 core;`terminal-say.ts`:CC 代主人说一句、等回话;
 *  - `live-window.ts`:开在电脑窗口里的 Claude 会话(话送进窗口,不另起 resume);`phone-actions.ts`:手机拍板 / 说一句;
 *  - `app-push.ts`:终端会话的事推到手机 App;`brain-forward.ts` / `remote-reply.ts`:这边 / 那边(手把事转给脑、脑把「看 / 说」派给手);
 *  - `hooks.ts`:接上 / 撤掉终端里的 hooks(只在主人点了确认时写);`today.ts`:「今天」一眼看完的两路来源;
 *  - `routes.ts`:`/v1/cli/event|permission|sessions|say|hooks/*`、`/v1/overseer/today`(路由表标了 module: 'terminal');
 *  - 这个文件:模块清单。它要的东西(`WireTerminalDeps`)由组装的地方(daemon-modules.ts)从上游模块里填。
 *
 * 纯逻辑留在 src/core(cli-events / cli-permission-relay / cli-reply / cli-transcript / cli-activity):`wechat-cc hook`
 * 子命令和工作台也用它们,不该为了这些去拉功能目录。放行规则那道门(daemon/permission-gate.ts)和拍板记录
 * (daemon/permission-decisions-store.ts)跟工作台、「做过的事」共用,也留在原处;这里只是造它们的地方,经模块的值交出去。
 *
 * 必需模块(搬家前的 cli-sessions 就是必需的):命令表、工作台、「做过的事」、定时都 needs 它。
 */
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import { wireTerminal, type WireTerminalDeps } from './wire'
import { terminalRoutes } from './routes'

export type { WireTerminalDeps, CliSessionsWorkbench } from './wire'
export type { AppPushOutlet } from './app-push'
export { PHONE_CLI_SAY_MAX, type CliPhoneActions } from './phone-actions'
export type { TerminalHooksService } from './hooks'
// 起进程、收输出、到点掐掉(进程组):日历读 JXA 也用这一个
export { defaultRunner, type Runner } from './reply-handler'

export type TerminalFeature = ReturnType<typeof wireTerminal>

export function terminalFeature(o: { needs: readonly string[]; lazy?: readonly string[]; deps: (ctx: ModuleCtx) => WireTerminalDeps }): DaemonModule<TerminalFeature> {
  return {
    name: 'terminal',
    needs: ['internal-api', ...o.needs],
    ...(o.lazy ? { lazy: o.lazy } : {}),
    init(ctx) {
      const terminal = wireTerminal(o.deps(ctx))
      ctx.get<InternalApiLifecycle>('internal-api').mount('terminal', terminalRoutes(terminal.routes))
      return terminal
    },
  }
}
