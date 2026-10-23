/**
 * 把一个现成的 `register*() → Lifecycle` 包成 DaemonModule(第三批 3b 第 5 步:main.ts 里的定时器们)。
 *
 * 以前的写法是两行、靠人记得配对:
 *   const xLc = await sup.start('x', () => registerX(...))
 *   if (xLc) lc.register(xLc)
 * 现在一行:`await startLifecycleModule(host, 'x', () => registerX(...))`。起失败 ⇒ degraded、回 undefined
 * (跟 sup.start 一样);状态照旧进 /v1/health.subsystems(Supervisor 收养)。
 *
 * **停的顺序不变**:每个就地起成一个只有它自己的组,组的 stopAll 经 `host.register` 登记在它原来那一行的位置上
 * (main.ts 里就是 lc.register —— LifecycleSet 倒序停)。所以跟核心那几样(会话、ilink、拉消息)交错的顺序一点没动。
 * 这几个 register* 都是起了就跑的叶子(到点才第一次拍),没有环,所以在 start 段直接调。
 */
import type { Lifecycle } from '../../lib/lifecycle'
import type { SubsystemSupervisor } from '../subsystems'
import { createModules, type DaemonModule } from './container'

/**
 * `required`:起不来就整个开机失败(跟今天一样往上抛;已登记的先停掉)。核心链(会话、ilink、拉消息、工作台…)
 * 就地搬进来时用它 —— 搬家这一步不改「起不来怎么办」,那是另一个决定(设计稿 2026-10-23-core-chain-modules)。
 */
export interface LifecycleModuleOpts { required?: true }

export function lifecycleModule<L extends Lifecycle>(name: string, start: () => L | Promise<L>, opts: LifecycleModuleOpts = {}): DaemonModule<{ current(): L | null }> {
  return {
    name,
    optional: !opts.required,
    init(m) {
      let lc: L | null = null
      m.onStart('start', async () => { lc = await start() })
      m.own('stop', () => lc?.stop())
      return { current: () => lc }
    },
  }
}

export interface LifecycleModuleHost {
  sup: Pick<SubsystemSupervisor, 'adopt'>
  log: (tag: string, line: string) => void
  /** 这一组的 stopAll 登记到哪(main.ts:lc.register,就在原来那一行的位置)。 */
  register(name: string, stop: () => Promise<void>): void
}

/** 就地起一个,回它的 Lifecycle;起失败 ⇒ undefined(状态 degraded,已经停掉它登记的)。`required` ⇒ 起失败往上抛。 */
export async function startLifecycleModule<L extends Lifecycle>(host: LifecycleModuleHost, name: string, start: () => L | Promise<L>, opts: LifecycleModuleOpts = {}): Promise<L | undefined> {
  const group = createModules([lifecycleModule(name, start, opts)], { log: host.log })
  host.register(name, () => group.stopAll())
  host.sup.adopt(group)
  await group.start()
  return group.provided<{ current(): L | null }>(name)?.current() ?? undefined
}
