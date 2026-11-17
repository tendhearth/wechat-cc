import type {RouteTable,RouteHandler} from '../../daemon/internal-api/types'
import {ownerLedgerConversation} from '../../lib/matter-ledger-access'

type Caller=Parameters<RouteHandler>[2]
export interface ParticipationRoutesDeps {
  resolve?(action:'attach'|'detach',input:unknown,owner:string):{body:unknown}
  owner():string|null
  approved(tool:string,input:unknown,caller:NonNullable<Caller>):boolean
  consume(tool:string,input:unknown,caller:NonNullable<Caller>):void
  attach(sessionId:string,matterId:string,owner:string):{credentialPath:string;instructions:string}
  detach(id:string,owner:string):boolean
}
export function participationRoutes(d:ParticipationRoutesDeps):RouteTable {
  const route=(action:'attach'|'detach'):RouteHandler=>async(q,body,caller)=>{
    const owner=d.owner(),tool=`mcp__wechat__terminal_${action}`
    const operator=caller?.origin==='operator'&&caller.tier==='admin'
    if(!owner||!operator&&!ownerLedgerConversation(owner,caller))return {status:403,body:{error:'forbidden'}}
    if(!body||typeof body!=='object'||Array.isArray(body)||[...q.keys()].length)return {status:400,body:{error:'invalid_request'}}
    try{if(d.resolve)body=d.resolve(action,body,owner).body}catch(error){return {status:409,body:{error:error instanceof Error?error.message:'invalid_request'}}}
    const b=body as Record<string,unknown>,keys=action==='attach'?['sessionId','matter']:['participationId']
    if(Object.keys(b).length!==keys.length||Object.keys(b).some(k=>!keys.includes(k))||keys.some(k=>typeof b[k]!=='string'||!(b[k] as string).trim())||action==='attach'&&!/^[a-f0-9]{8}$/.test(b.matter as string))return {status:400,body:{error:'invalid_request'}}
    if(!operator&&!d.approved(tool,body,caller!))return {status:403,body:{error:'terminal_not_approved'}}
    try{
      const result=action==='attach'?(()=>{
        const {credentialPath,instructions}=d.attach(b.sessionId as string,b.matter as string,owner)
        return {credentialPath,instructions}
      })():{ok:d.detach(b.participationId as string,owner)}
      if(!operator)d.consume(tool,body,caller!)
      return {status:200,body:result}
    }catch(error){return {status:409,body:{error:error instanceof Error?error.message:'terminal_attach_failed'}}}
  }
  return {'POST /v1/cli/attach':route('attach'),'POST /v1/cli/detach':route('detach')}
}
