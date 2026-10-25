/**
 * 伙伴的日志(背包)—— 一个功能一个目录(架构终态 A5)。主人在桌面看到的一条时间线:打猎带回的东西、串门见闻、
 * 明信片、回忆(kind 分四种,见 adapters/store/journal-store.ts)。
 *
 *  - 表本身(`journal`,v36 起)不在这里:四种东西各有各的写手(打猎、社交、串门来客、回忆),桌宠 / 手机首屏 /
 *    设置面板 / 微信「背包」也读它,所以 store 放在 `src/adapters/store/journal-store.ts`,地基里一份;
 *  - `routes.ts`:`/v1/journal*`(列表 / 明信片册 / 收藏 / 状态 / 删 / 看到哪了),路由表标了 `module: 'journal'`;
 *  - 这个文件:模块清单。它要的东西(`JournalRoutesDeps`)由组装的地方(daemon-modules.ts)从地基里填。
 */
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
// 只要 mount 这一口(types.ts 里的 InternalApi),同画室:不引 internal-api/lifecycle。
import type { InternalApi } from '../../daemon/internal-api/types'
import { journalRoutes, type JournalRoutesDeps } from './routes'

export type JournalFeatureDeps = JournalRoutesDeps

export function journalFeature(o: { needs: readonly string[]; deps: (ctx: ModuleCtx) => JournalFeatureDeps }): DaemonModule<void> {
  return {
    name: 'journal',
    needs: ['internal-api', ...o.needs],
    init(ctx) {
      ctx.get<Pick<InternalApi, 'mount'>>('internal-api').mount('journal', journalRoutes(o.deps(ctx)))
    },
  }
}
