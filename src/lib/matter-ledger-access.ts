import {ownerTopicCaller} from './topic-provenance'
type Caller={tier:string;origin:string;chatId?:string;sharedTurn?:string;turnChatId?:string}
/** Paired phone devices are the owner and may read; link tokens may never read. Mirrors projects_activity's authenticated owner surfaces. */
export function ownerLedgerConversation(owner:string|null,caller?:Caller):boolean {
  return !!owner&&caller?.tier==='admin'&&caller.origin==='session'&&(caller.chatId===owner||caller.sharedTurn==='bound'&&caller.turnChatId===owner)
}
export function ownerLedgerCaller(owner:string|null,caller?:Caller):boolean {
  return ownerTopicCaller(owner,caller)||!!owner&&caller?.tier==='admin'&&(caller.origin==='device'||ownerLedgerConversation(owner,caller))
}
export function scopeMatterLedger<T extends object>(detail:T,allowed:boolean):T {
  if(allowed)return detail
  const {notes:_notes,agentRuns:_agents,notesTotal:_total,...rest}=detail as T&{notes?:unknown;agentRuns?:unknown;notesTotal?:unknown}
  return rest as T
}
