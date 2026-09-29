import {describe,expect,it} from 'vitest'
import {mobileWorkbenchRoute} from './mobile-workbench'
import {entryFailureKind} from '../core/workbench/task-entry'

describe('phone entry rejection wire contract',()=>{
  it.each([
    ['invalid_entry',400,'rejected'],['invalid_request_id',400,'rejected'],
    ['invalid_text',400,'rejected'],['invalid_title',400,'rejected'],['invalid_context',400,'rejected'],
    ['invalid_target',400,'rejected'],['invalid_execution',400,'rejected'],['invalid_provider',400,'rejected'],
    ['invalid_attachment',400,'rejected'],['invalid_path',400,'rejected'],
    ['api_task_input_invalid',400,'rejected'],['api_task_attachment_invalid',400,'rejected'],
    ['api_task_attachment_unsupported',422,'rejected'],['unattended_ack_required',422,'rejected'],
    ['workbench_attachments_unsupported',422,'rejected'],['workbench_execution_unsupported',422,'rejected'],
    ['project_stale',409,'unknown'],['attachment_changed',409,'unknown'],['entry_expired',410,'expired'],
    ['creation_conflict',409,'unknown'],['unavailable_provider',503,'unknown'],['provider_quota_exhausted',503,'unknown'],
  ] as const)('maps create %s to HTTP %s and a %s client outcome',async(code,status,kind)=>{
    const url=new URL('http://phone.test/m/api/matter/create')
    const req=new Request(url,{method:'POST',body:JSON.stringify({requestId:crypto.randomUUID(),text:'要求',target:{kind:'managed'}})})
    const response=await mobileWorkbenchRoute(undefined,url,req,{
      entryOptions:()=>({status:'ready',defaultProviderId:null,providers:[],projects:[]}),
      createEntry:()=>{throw Error(code)},entryReceipt:()=>null,
    })
    expect(response?.status).toBe(status)
    expect(await response!.json()).toEqual({ok:false,error:code})
    expect(entryFailureKind(code,{surface:'phone',method:'POST',status:response!.status})).toBe(kind)
    expect(entryFailureKind(code,{surface:'phone',method:'GET',status:response!.status})).toBe('unknown')
  })

  it('returns invalid uploaded content as HTTP 400 without making it an entry identity rejection',async()=>{
    const url=new URL('http://phone.test/m/api/attachment/chunk')
    const req=new Request(url,{method:'POST',body:JSON.stringify({id:crypto.randomUUID(),draftId:crypto.randomUUID(),name:'bad.png',mime:'image/png',size:1,sha256:'a'.repeat(64),offset:0,contentBase64:'eA=='})})
    const response=await mobileWorkbenchRoute(undefined,url,req,undefined,{
      chunk:()=>{throw Error('upload_invalid_content')},status:()=>{throw Error('unexpected')},discard:()=>{},
    })
    expect(response?.status).toBe(400)
    expect(await response!.json()).toEqual({ok:false,error:'upload_invalid_content'})
    expect(entryFailureKind('upload_invalid_content',{surface:'phone',method:'POST',status:400})).toBe('unknown')
  })
})
