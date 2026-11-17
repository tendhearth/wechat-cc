import type { Db } from '../../lib/db'
import type { RouteTable } from '../../daemon/internal-api/types'
import type { MatterSeen } from '../../adapters/store/matter-seen'
import type { ProjectTaskActivitySource } from '../../ports/topic-activity'
import { ProjectsActivityQuery, activityWindow } from '../../domain/projects-activity'
import { readProjectsActivity } from './projects-activity'
export function projectsActivityRoutes(d:{db:Db;ownerChatId():string|null;now?:()=>number;seen?:MatterSeen;taskActivity?:ProjectTaskActivitySource;executorName?:(id:string)=>string}):RouteTable{
 const forbidden=()=>({status:403,body:{error:'forbidden'}})
 return {'POST /v1/memory/projects/activity':async(_q,body,caller)=>{
  const owner=d.ownerChatId()
  const allowed=()=>!!owner&&d.ownerChatId()===owner&&caller?.tier==='admin'&&(
   caller.origin==='operator'||caller.origin==='device'||caller.origin==='session'&&(
    caller.chatId===owner||caller.sharedTurn==='bound'&&caller.turnChatId===owner))
  if(!allowed())return forbidden()
  const parsed=ProjectsActivityQuery.safeParse(body??{})
  if(!parsed.success)return {status:400,body:{error:'invalid_params'}}
  try{activityWindow(parsed.data,d.now?.()??Date.now())}catch{return {status:400,body:{error:'invalid_window'}}}
  try{
   const result=await readProjectsActivity({...d,owner:owner!},parsed.data)
   if(!allowed())return forbidden()
   return {status:200,body:result}
  }catch{return {status:503,body:{error:'projects_activity_unavailable'}}}
 }}
}
