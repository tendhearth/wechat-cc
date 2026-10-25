/**
 * 把一个现成的 `register*() → Lifecycle` 包成 DaemonModule(第三批 3b;架构终态 A1 起所有模块都在 main.ts 的同一个容器里)。
 *
 * `register*()` 是「起了就跑」的:所以它在 start 段才调(init 段只登记),停法在 init 段就登记好 ——
 * start 段起到一半收到关机,也停得到。起失败 ⇒ 可选模块 degraded,`required` ⇒ 整个开机失败(跟以前一样)。
 * 提供出去的是 `{ current() }`:start 段之前是 null,起来以后是那个 Lifecycle(别的模块经 needs / lazy 拿)。
 */
import type { Lifecycle } from '../../lib/lifecycle'
import type { DaemonModule, ModuleCtx } from './container'

export interface LifecycleModuleOpts {
  /** 起不来就整个开机失败(核心链:会话、ilink、拉消息……)。缺省:起不来 ⇒ degraded,不拖垮开机。 */
  required?: true
  needs?: readonly string[]
  wants?: readonly string[]
  lazy?: readonly string[]
  enabled?: () => boolean
}

export interface LifecycleHolder<L> { current(): L | null }

export function lifecycleModule<L extends Lifecycle>(name: string, start: (ctx: ModuleCtx) => L | Promise<L>, opts: LifecycleModuleOpts = {}): DaemonModule<LifecycleHolder<L>> {
  return {
    name,
    optional: !opts.required,
    ...(opts.needs ? { needs: opts.needs } : {}),
    ...(opts.wants ? { wants: opts.wants } : {}),
    ...(opts.lazy ? { lazy: opts.lazy } : {}),
    ...(opts.enabled ? { enabled: opts.enabled } : {}),
    init(ctx) {
      let lc: L | null = null
      ctx.onStart('start', async () => { lc = await start(ctx) })
      ctx.own('stop', () => lc?.stop())
      return { current: () => lc }
    },
  }
}
