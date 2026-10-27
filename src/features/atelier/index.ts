/**
 * CC 的画室(spec 2026-09-01-cc-atelier-design)—— 一个功能一个目录(架构终态 A5)。CC 偶尔有想画的东西,
 * 在本机用 SD-Turbo 画一幅、留一段画家手记;桌面「画室」看得见,主人点了才分享到微信。
 * 开关 companion.atelier_mode 默认 off(关着时模块照样在:桌面看画、看颜料下载进度都走它的路由)。
 *
 *  - `store` / `art-impulse` / `planner` / `runtime`:画存哪、「想画什么」的形状、便宜模型出主意、画一拍;
 *  - `artwork-renderer` / `sidecar-renderer` / `renderer-resolve`:画笔(本机 sd-cli 旁车,或托管的图像接口);
 *  - `provision` / `model-provision`:第一次打开时安静地下颜料(约 5GB,按 SHA-256 验);
 *  - `tick.ts`:反省那一拍的最后一步(wiring 经 `makeAtelierTick` 接上);
 *  - `routes.ts`:`/v1/atelier/*`(路由表标了 module: 'atelier');
 *  - 这个文件:模块清单。它要的东西(`AtelierFeatureDeps`)由同目录的 `module.ts`(接进 daemon 的那一份)从上游模块里填。
 * 可选模块:坏了只降级。
 */
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
// 只要 mount 这一口(types.ts 里的 InternalApi):不引 internal-api/lifecycle —— 改配置的路由(routes-config)要经这个文件
// 踢颜料下载,引了 lifecycle 就成环(internal-api/index → routes → routes-config → 这里 → lifecycle → index)。
import type { InternalApi } from '../../daemon/internal-api/types'
import { makeAtelierStore } from './store'
import { atelierRoutes, type AtelierRoutesDeps } from './routes'

export { makeAtelierStore } from './store'
export type { AtelierStore } from './store'
export { makeAtelierTick, type AtelierTickDeps } from './tick'
// 改配置的两处(/v1/config/set、设置面板)打开画室时踢一下颜料下载;设置面板读下载进度。
export { kickAtelierModelProvision, readModelStatus, shouldProvisionOnConfigChange } from './provision'
// 两个维护脚本(scripts/atelier-*):单独试画笔。
export { makeOpenAiImageRenderer } from './artwork-renderer'
export { makeSidecarRenderer, type SpawnFn } from './sidecar-renderer'

export type AtelierFeatureDeps = Omit<AtelierRoutesDeps, 'store'>

export function atelierFeature(o: { needs: readonly string[]; deps: (ctx: ModuleCtx) => AtelierFeatureDeps }): DaemonModule<void> {
  return {
    name: 'atelier',
    optional: true,
    needs: ['internal-api', ...o.needs],
    init(ctx) {
      const d = o.deps(ctx)
      ctx.get<Pick<InternalApi, 'mount'>>('internal-api').mount('atelier', atelierRoutes({ ...d, store: makeAtelierStore(d.stateDir) }))
    },
  }
}
