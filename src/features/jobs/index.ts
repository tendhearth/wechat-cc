/**
 * 定时 / 早报 / 周报 / 换一家来审 —— 一个功能一个目录(架构终态 A5)。
 *
 *  - `command.ts` / `asks-reply.ts`:微信「定时 …」和早报里拍板项的回话;`view.ts` / `mobile.ts`:手机上看、停、删;
 *  - `brief.ts` / `recap.ts`:早报、周报那一轮;`runner.ts`:每分钟一拍;`wire.ts`:把它们接起来;
 *  - 这个文件:两个模块 ——
 *    `jobs`(必需):命令和「换一家来审」,命令表要它,所以开机就得有;
 *    `scheduled-jobs`(可选):每分钟一拍的 runner,坏了只降级。
 * 它要的东西(`WireJobsDeps`)由同目录的 `module.ts`(接进 daemon 的那一份)从上游模块里填。
 */
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import { lifecycleModule } from '../../daemon/modules/lifecycle-module'
import { wireJobs, type WireJobsDeps } from './wire'

export { statusWord } from './command'
export { jobsView, jobsAction, type JobsActionKind } from './view'
export { mobileJobsRoutes, type MobileJobsDeps } from './mobile'
export type { WireJobsDeps } from './wire'
// 输出评测(features/output-eval)按生产那一份拼早报信封、接拍板候选。
export { buildBriefMaterial, buildBriefText, attachAsks, type BriefInputs } from './brief'

export type JobsFeature = ReturnType<typeof wireJobs>

export function jobsFeature(o: { needs: readonly string[]; lazy?: readonly string[]; deps: (ctx: ModuleCtx) => WireJobsDeps }): DaemonModule<JobsFeature> {
  return {
    name: 'jobs',
    needs: o.needs,
    ...(o.lazy ? { lazy: o.lazy } : {}),
    init: (ctx) => wireJobs(o.deps(ctx)),
  }
}

/** 每分钟一拍的 runner(可选):要 wired(只读那一轮)起来以后才开动。 */
export function jobsRunnerFeature(o: { needs: readonly string[] }): DaemonModule {
  return lifecycleModule('scheduled-jobs', (ctx) => ctx.get<JobsFeature>('jobs').startRunner(), { needs: ['jobs', ...o.needs] })
}
