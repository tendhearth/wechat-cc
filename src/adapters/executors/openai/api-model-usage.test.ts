import {it,expect} from 'vitest'
import {createApiModel,userMessage} from './api-model'
import type {FetchLike} from '../../../lib/timeout-fetch'

const ok=()=>new Response([
  {id:'r',object:'chat.completion.chunk',created:1,model:'Kimi-Code',choices:[{index:0,delta:{content:'ready'},finish_reason:null}]},
  {id:'r',object:'chat.completion.chunk',created:1,model:'Kimi-Code',choices:[{index:0,delta:{},finish_reason:'stop'}]},
  {id:'r',object:'chat.completion.chunk',created:1,model:'Kimi-Code',choices:[],usage:{prompt_tokens:123,completion_tokens:2,total_tokens:125}},
].map(chunk=>`data: ${JSON.stringify(chunk)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
const rejected=(message:string,status=400)=>new Response(JSON.stringify({error:{message,type:'invalid_request_error'}}),{status,headers:{'content-type':'application/json'}})
const make=(endpoint:string,fetch:FetchLike)=>createApiModel({baseURL:`https://${endpoint}.invalid/v1`,apiKey:'offline-fixture',model:'Kimi-Code',fetch,maxRetries:0})
async function stream(api:ReturnType<typeof make>){
  const turn=api.stream([userMessage('你好')],[],new AbortController().signal)
  for await(const _ of turn.deltas){/* consume */}
  return {turn,result:await turn.finished}
}

it('requests stream usage and reports the UTF-8 size of the serialized request',async()=>{
  let body=''
  const api=make('usage-request',async(_url,init)=>{body=String(init?.body);return ok()})
  const {turn,result}=await stream(api)
  expect(JSON.parse(body)).toMatchObject({stream:true,stream_options:{include_usage:true}})
  expect(result.usage).toEqual({input:123,output:2})
  expect((turn as {requestBytes?:number}).requestBytes).toBe(Buffer.byteLength(body))
  await api.generate([userMessage('evaluate')])
  expect(JSON.parse(body)).toMatchObject({stream:true,stream_options:{include_usage:true}})
})

for(const path of ['stream','generate'] as const)it(`${path}: retries an unsupported stream_options parameter once and remembers the endpoint across model instances`,async()=>{
  const bodies:Record<string,unknown>[]=[]
  const fetch:FetchLike=async(_url,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);return body.stream_options?rejected('Unrecognized request argument supplied: stream_options'):ok()}
  const api=make(`usage-downgrade-${path}`,fetch)
  if(path==='stream')await stream(api);else expect(await api.generate([userMessage('eval')])).toBe('ready')
  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toHaveProperty('stream_options.include_usage',true)
  expect(bodies[1]).not.toHaveProperty('stream_options')
  await stream(make(`usage-downgrade-${path}`,fetch))
  expect(bodies).toHaveLength(3);expect(bodies[2]).not.toHaveProperty('stream_options')
  await stream(make(`usage-other-${path}`,fetch))
  expect(bodies).toHaveLength(5);expect(bodies[3]).toHaveProperty('stream_options')
})
for(const [message,status] of [['Unsupported stream_options',400],['stream_options: Extra inputs are not permitted',422]] as const)it(`downgrades an explicit unsupported/extra field rejection (${status})`,async()=>{
  let calls=0
  const api=make(`usage-explicit-${status}`,async(_url,init)=>{calls++;return JSON.parse(String(init?.body)).stream_options?rejected(message,status):ok()})
  await stream(api);expect(calls).toBe(2)
})

it('bounds parameter fallback at two attempts even when the second request is rejected too',async()=>{
  let calls=0
  const api=make('usage-rejected-twice',async()=>{calls++;return rejected('Unsupported parameter: stream_options')})
  await expect(stream(api)).rejects.toThrow('Unsupported parameter')
  expect(calls).toBe(2)
})

it('does not resend after the retry guard rejects the changed request',async()=>{
  let calls=0
  const api=createApiModel({baseURL:'https://usage-retry-guard.invalid/v1',apiKey:'offline-fixture',model:'Kimi-Code',maxRetries:0,fetch:async()=>{calls++;return rejected('Unsupported parameter: stream_options')},beforeRetry:async()=>{throw Error('fixture_guard_denied')}})
  await expect(stream(api)).rejects.toThrow('fixture_guard_denied');expect(calls).toBe(1)
})

for(const message of ['Invalid API key','Invalid model Kimi-Code','stream_options.include_usage must be a boolean','Unsupported parameter value: stream_options.include_usage must be false'])it(`does not downgrade for an unrelated/invalid-value 400: ${message}`,async()=>{
  let calls=0
  await expect(stream(make(`usage-no-downgrade-${message.split(' ')[0]}`,async()=>{calls++;return rejected(message)}))).rejects.toThrow(message)
  expect(calls).toBe(1)
})
