import {ownerLedgerCaller,ownerLedgerConversation} from '../../lib/matter-ledger-access'
import type {WorkbenchService} from './service'
import type {RouteTable} from '../../daemon/internal-api/types'

const ID=/^[a-f0-9]{8}$/
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const forbidden=()=>({status:403,body:{error:'forbidden'}})
const invalid=()=>({status:400,body:{error:'invalid_request'}})
export function ledgerRoutes(d:{workbench:WorkbenchService;resolveAdminChatId?:()=>string|null}):RouteTable{
  return {
    'GET /v1/matter/notes':async(q,_b,c)=>{
      const owner=d.resolveAdminChatId?.()??null
      const executor=c?.origin==='session'&&c.tier!=='guest'&&/^workbench\/[a-f0-9]{8}$/.test(c.sessionKey??'')
      if(!executor&&!ownerLedgerCaller(owner,c))return forbidden()
      if([...q.keys()].some(k=>k!=='matter')||q.getAll('matter').length>1)return invalid()
      const id=q.get('matter')??undefined
      if(id!==undefined&&!ID.test(id))return invalid()
      try{
        if(executor)return {status:200,body:{notes:d.workbench.matterNotes(c?.sessionKey,id)}}
        if(!id||!d.workbench.ledgerOwned(id,owner))return forbidden()
        return {status:200,body:d.workbench.ledgerRead(id)}
      }catch{return forbidden()}
    },
    'POST /v1/matter/note':async(q,b,c)=>{
      if(c?.origin!=='session'||c.tier==='guest'||!/^workbench\/[a-f0-9]{8}$/.test(c.sessionKey??''))return forbidden()
      if([...q.keys()].length)return invalid()
      if(!object(b)||Object.keys(b).some(k=>k!=='text')||typeof b.text!=='string'||!b.text.trim()||b.text.length>1000)return invalid()
      try{return {status:200,body:d.workbench.matterNote(c.sessionKey,b.text)}}catch{return forbidden()}
    },
    'POST /v1/matter/relay':async(_q,b,c)=>{
      if(!ownerLedgerConversation(d.resolveAdminChatId?.()??null,c))return forbidden()
      if(!object(b)||Object.keys(b).some(k=>!['matter','executor','brief'].includes(k))||typeof b.matter!=='string'||!ID.test(b.matter)||typeof b.executor!=='string'||typeof b.brief!=='string'||!b.brief.trim()||b.brief.length>20_000)return invalid()
      try{return {status:202,body:{task:await d.workbench.matterHandoff(b.matter,b.executor,b.brief)}}}
      catch(error){const code=error instanceof Error?error.message:'';return {status:code==='forbidden'?403:409,body:{error:/^[a-z_]+$/.test(code)?code:'matter_handoff_failed'}}}
    },
  }
}
