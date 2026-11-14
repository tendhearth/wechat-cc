import type {Active} from './state'
import type {TaskStatus} from '../../../adapters/store/workbench/store'

/** Called only after the turn's ledger/status transaction commits. */
export type RelayTurnHook=(running:Active,status:TaskStatus,pendingQuestion:boolean,ownerInputQueued?:boolean)=>Promise<void>
