/**
 * CC 的信(2026-10-16)—— 一个功能一个目录(架构终态 A5)。不定期写一封信、排成信纸寄到微信;
 * 主人说「给我写封信」时 cc_letter 工具当场写。开关 companion.letters_enabled 默认关(关着时模块照样在:
 * 看状态、打开它都要走它的路由)。
 *
 *  - `compose` / `render` / `schedule` / `runtime` / `archive`:写信、排版、什么时候写、写和寄、存档;
 *  - `wire.ts`:把它们接起来(调度器、App 那条路、记忆素材);
 *  - `routes.ts`:`/v1/letters*`(路由表标了 module: 'letters');`mobile.ts`:手机网页的只读存档;
 *  - 这个文件:模块清单。它要的东西(`WireLettersDeps`)由组装的地方(daemon-modules.ts)从上游模块里填。
 * 可选模块:坏了只降级。
 */
import type { Lifecycle } from '../../lib/lifecycle'
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import { wireLetters, type WireLettersDeps } from './wire'
import { lettersRoutes } from './routes'

export { listLetters, letterPagePath } from './archive'
export type { LetterListItem } from './archive'
export { mobileLettersRoutes, type MobileLettersDeps } from './mobile'
export type { WireLettersDeps } from './wire'

export function lettersFeature(o: { needs: readonly string[]; deps: (ctx: ModuleCtx) => WireLettersDeps }): DaemonModule<void> {
  return {
    name: 'letters',
    optional: true,
    needs: ['internal-api', ...o.needs],
    init(ctx) {
      const d = o.deps(ctx)
      const letters = wireLetters(d)
      ctx.get<InternalApiLifecycle>('internal-api').mount('letters', lettersRoutes(letters.runtime, d.stateDir))
      let lc: Lifecycle | null = null
      ctx.onStart('start', () => { lc = letters.start() })
      ctx.own('stop', () => lc?.stop())
    },
  }
}
