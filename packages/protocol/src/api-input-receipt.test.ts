import {describe,expect,it} from 'vitest'
import {MatterInput,MatterInputReceiptResult,PHONE_API_SCHEMAS,type MatterInputReceiptResultT} from './index'

const input={id:'123e4567-e89b-42d3-a456-426614174000',taskId:'deadbeef',runId:'123e4567-e89b-42d3-a456-426614174001',text:'保留原来的话\r\n继续',status:'held' as const}

describe('durable single input receipt contract',()=>{
  it('accepts old MatterInput bodies without an error and preserves new restart reasons',()=>{
    expect(MatterInput.parse(input)).toEqual(input)
    const result:MatterInputReceiptResultT={ok:true,input:{...input,error:'daemon_restarted'}}
    expect(MatterInputReceiptResult.parse(result)).toEqual(result)
    expect(MatterInputReceiptResult.parse({ok:true,input:{...input,status:'delivered',error:null}}).input.error).toBeNull()
  })
  it('registers success and missing/error responses without weakening the success schema',()=>{
    const schema=PHONE_API_SCHEMAS['GET /m/api/matter/input-receipt']!
    expect(schema.parse({ok:true,input})).toEqual({ok:true,input})
    expect(schema.parse({ok:false,error:'not_found'})).toEqual({ok:false,error:'not_found'})
    expect(schema.parse({ok:false,error:'unauthorized'})).toEqual({ok:false,error:'unauthorized'})
    expect(schema.safeParse({ok:true,input:{...input,status:'unknown'}}).success).toBe(false)
    expect(schema.safeParse({ok:true}).success).toBe(false)
    expect(schema.safeParse({ok:true,input:{...input,error:4}}).success).toBe(false)
  })
})


it('preserves a readable model error and its inert diagnostic while accepting older events',async()=>{
  const {MatterEvent}=await import('./index')
  const old={kind:'error',text:'old message',createdAt:1}
  expect(MatterEvent.parse(old)).toEqual(old)
  const current={...old,text:'当前账号不支持所用模型。',errorCode:'execution_model_unsupported',diagnostic:'<script>literal</script>'}
  expect(MatterEvent.parse(current)).toEqual(current)
})
