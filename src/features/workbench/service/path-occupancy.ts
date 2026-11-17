import type { WorkbenchRuntimeState } from './state'

/** Active reservations and restored writers hold paths until their writers close. */
export function workbenchPathHolders(state:Pick<WorkbenchRuntimeState,'reservations'|'writerOrphans'>) {
  return [...state.reservations.values(),...state.writerOrphans.values()]
}
