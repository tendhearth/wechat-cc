import type { Lifecycle } from '../../lib/lifecycle'
import { startGuardScheduler, type SchedulerDeps, type GuardState } from './scheduler'

export interface GuardLifecycle extends Lifecycle {
  current(): GuardState
  /** 马上跑一拍(单飞);网络闸门在读数过期时用。 */
  pokeNow(): Promise<GuardState>
}

export function registerGuard(deps: SchedulerDeps): GuardLifecycle {
  const handle = startGuardScheduler(deps)
  let stopped = false
  return {
    name: 'guard',
    stop: async () => { if (!stopped) { stopped = true; await handle.stop() } },
    current: () => handle.current(),
    pokeNow: () => handle.pokeNow(),
  }
}
