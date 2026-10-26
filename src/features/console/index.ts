/**
 * 桌面控制台(架构终态 F6)—— 桌面以前起 CLI 读写的那些主人私事,现在由 daemon 回:对话页、会话名单、观察 / 里程碑 / 决策、
 * 头像、allowlist 里的 admins、对话模式快照。路由在 `routes.ts`(每条 = 一条 CLI 命令,同一个函数、同一个形状)。
 * 记忆页那几条归记忆功能(`src/features/memory/owner-routes.ts`)。
 *
 * 只造、只挂路由,不干活;要的就是地基里的 db 和对话 store。
 * 删掉这个功能 = 删目录 + daemon-modules.ts 里那一行 + 路由表里标 `module: 'console'` 的那几行(桌面那些页面就读不到了)。
 */
import type { DaemonModule } from '../../daemon/modules/container'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import { consoleRoutes, type ConsoleRoutesDeps } from './routes'

export function consoleFeature(d: ConsoleRoutesDeps): DaemonModule {
  return {
    name: 'console',
    needs: ['internal-api'],
    init(ctx) {
      ctx.get<InternalApiLifecycle>('internal-api').mount('console', consoleRoutes(d))
    },
  }
}
