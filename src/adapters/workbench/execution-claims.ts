import {realpathSync} from 'node:fs'
import {pathsConflict} from './scheduler'
export interface ExecutionClaim {owner:string;path:string;providerId:string;nativeId:string|null}
export function canonicalClaimPath(path:string):string {try{return realpathSync(path)}catch{return path}}
export function claimConflicts(a:ExecutionClaim,b:ExecutionClaim):boolean {
 return a.owner!==b.owner&&((!!a.nativeId&&a.providerId===b.providerId&&a.nativeId===b.nativeId)||pathsConflict(canonicalClaimPath(a.path),canonicalClaimPath(b.path)))
}
/** Daemon-local ownership only; this does not detect or terminate outside CLIs. */
export function makeExecutionClaims(){
 const claims=new Map<string,ExecutionClaim>()
 return{
  conflicts(claim:ExecutionClaim){return [...claims.values()].some(other=>claimConflicts(claim,other))},
  acquire(claim:ExecutionClaim){
   if(this.conflicts(claim))throw new Error('native_session_busy')
   const old=claims.get(claim.owner)
   if(old&&JSON.stringify(old)!==JSON.stringify(claim))throw new Error('native_session_busy')
   claims.set(claim.owner,claim)
   return()=>{if(claims.get(claim.owner)===claim)claims.delete(claim.owner)}
  },
 }
}
