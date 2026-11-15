import {workbenchErrorHttp,matterToolFailure} from '../../../packages/protocol/src/workbench-errors'
import {ownerLedgerCaller,ownerLedgerConversation} from '../../lib/matter-ledger-access'
import type {WorkbenchService} from './service'
import type {RouteTable} from '../../daemon/internal-api/types'
import {PlanInputError,type PlanCaller,type PlanConversation} from '../../adapters/workbench/matter-plan-input'
import {MatterPlanRequest} from '../../../packages/protocol/src/desktop-api'

const ID=/^[a-f0-9]{8}$/
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const forbidden=()=>({status:403,body:{error:'matter_ledger_forbidden'}})
const invalid=()=>({status:400,body:{error:'invalid_request'}})
export function ledgerRoutes(d:{workbench:WorkbenchService;resolveAdminChatId?:()=>string|null;planConversation?:(caller:PlanCaller)=>PlanConversation|null}):RouteTable{
  return {
    'POST /v1/matter/plan':async(q,b,c)=>{
      if(!ownerLedgerConversation(d.resolveAdminChatId?.()??null,c))return {status:403,body:matterToolFailure('matter_ledger_forbidden',false)}
      const approved=d.workbench.matterApprovalStatus?.('mcp__wechat__matter_plan',b,c??{})??false
      const parsed=MatterPlanRequest.safeParse(b)
      if([...q.keys()].length||!parsed.success)return {status:400,body:matterToolFailure('invalid_matter_plan',approved)}
      try{return {status:202,body:await d.workbench.matterPlan(parsed.data,d.planConversation?.(c??{})??undefined)}}
      catch(error){const code=error instanceof Error?error.message:'';return {status:code==='matter_ledger_forbidden'?403:409,body:matterToolFailure(code,approved,'plan',error instanceof PlanInputError?error.projects:undefined)}}
    },
    'GET /v1/matter/context':async(q,_b,c)=>{
      if(c?.origin!=='session'||c.tier==='guest'||!/^workbench\/[a-f0-9]{8}$/.test(c.sessionKey??''))return forbidden()
      if([...q.keys()].some(k=>k!=='matter'||q.getAll(k).length>1))return invalid()
      const id=q.get('matter')??undefined
      if(id!==undefined&&!ID.test(id))return invalid()
      try{return {status:200,body:await d.workbench.matterContext(c.sessionKey,id)}}catch{return forbidden()}
    },
    'GET /v1/matter/notes':async(q,_b,c)=>{
      const owner=d.resolveAdminChatId?.()??null
      const executor=c?.origin==='session'&&c.tier!=='guest'&&/^(?:workbench\/[a-f0-9]{8}|terminal-participation\/[A-Za-z0-9_-]+)$/.test(c.sessionKey??'')
      if(!executor&&!ownerLedgerCaller(owner,c))return forbidden()
      const allowed=executor?['matter','runId','before','limit']:['matter']
      if([...q.keys()].some(k=>!allowed.includes(k)||q.getAll(k).length>1))return invalid()
      const runId=q.get('runId')??undefined,before=q.has('before')?Number(q.get('before')):undefined,limit=q.has('limit')?Number(q.get('limit')):undefined
      if(runId!==undefined&&(!runId.trim()||runId.length>200)||before!==undefined&&(!/^\d+$/.test(q.get('before')!)||!Number.isSafeInteger(before)||before<1)||limit!==undefined&&(!/^\d+$/.test(q.get('limit')!)||!Number.isSafeInteger(limit)||limit<1||limit>50))return invalid()
      const id=q.get('matter')??undefined
      if(id!==undefined&&!ID.test(id))return invalid()
      try{
        if(executor)return {status:200,body:d.workbench.matterNotes(c?.sessionKey,id,{runId,before,limit})}
        if(!id||!d.workbench.ledgerOwned(id,owner))return forbidden()
        return {status:200,body:d.workbench.ledgerRead(id)}
      }catch{return forbidden()}
    },
    'POST /v1/matter/note':async(q,b,c)=>{
      if(c?.origin!=='session'||c.tier==='guest'||!/^(?:workbench\/[a-f0-9]{8}|terminal-participation\/[A-Za-z0-9_-]+)$/.test(c.sessionKey??''))return forbidden()
      if([...q.keys()].length)return invalid()
      if(!object(b)||Object.keys(b).some(k=>k!=='text')||typeof b.text!=='string'||!b.text.trim()||b.text.length>1000)return invalid()
      try{return {status:200,body:d.workbench.matterNote(c.sessionKey,b.text)}}catch(error){const code=error instanceof Error?error.message:'';if(['matter_note_limit','matter_session_ended'].includes(code)){const mapped=workbenchErrorHttp(code,'desktop');return {status:mapped.status,body:{error:mapped.error}}}return forbidden()}
    },
    'POST /v1/matter/relay':async(_q,b,c)=>{
      if(!ownerLedgerConversation(d.resolveAdminChatId?.()??null,c))return {status:403,body:matterToolFailure('matter_ledger_forbidden',false,'handoff')}
      const approved=d.workbench.matterApprovalStatus?.('mcp__wechat__matter_handoff',b,c??{})??false
      if(!object(b)||Object.keys(b).some(k=>!['matter','executor','brief'].includes(k))||typeof b.matter!=='string'||!ID.test(b.matter)||typeof b.executor!=='string'||typeof b.brief!=='string'||!b.brief.trim()||b.brief.length>20_000)return {status:400,body:matterToolFailure('invalid_request',approved,'handoff')}
      try{return {status:202,body:{task:await d.workbench.matterHandoff(b.matter,b.executor,b.brief)}}}
      catch(error){const code=error instanceof Error?error.message:'';return {status:code==='matter_ledger_forbidden'?403:409,body:matterToolFailure(code,approved,'handoff')}}
    },
  }
}
