/**
 * bootstrap 还没整块变成模块之前,一组 DaemonModule 怎么接进来(第三批 3b 第 2 步,设计稿 2026-10-22-daemon-module-design)。
 *
 * 顺序就是保证:
 *  1. 先建句柄、**先把 stopAll 交给收尾清单**,再 start —— 开机途中收到 SIGTERM,收尾清单也停得到这一组起了一半的东西;
 *  2. 这一组的状态交给 SubsystemSupervisor 收养(活的),/v1/health.subsystems 仍是唯一的一份;
 *  3. 组里全是 optional 时 start 不会抛;有非 optional 的抛了 ⇒ 照抛,开机失败(跟今天核心链一样)。
 * 等 bootstrap 全部迁完,这一层跟着收尾清单、Supervisor 一起删掉。
 */
import { createModules, type DaemonModule, type StartedModules } from '../modules/container'
import type { BootstrapCtx } from './types'

export async function runModuleGroup(
  ctx: Pick<BootstrapCtx, 'sup' | 'log' | 'teardown'>,
  name: string,
  mods: readonly DaemonModule[],
): Promise<StartedModules> {
  const group = createModules(mods, { log: (tag, line) => ctx.log(tag, line) })
  ctx.teardown.add('MODULES', `${name} group`, () => group.stopAll())
  ctx.sup.adopt(group)
  await group.start()
  return group
}
