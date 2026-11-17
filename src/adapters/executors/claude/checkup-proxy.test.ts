import {expect,it,vi} from 'vitest'
import {makeCheckupProxy,isCheckupProxyEndpoint,usesCheckupProxy} from './checkup-proxy'
import {makeCheckupBudget} from '../../../domain/checkup-budget'
const sse=(events:unknown[])=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
const post=async(url:string,thinking?:number)=>{
  const response=await fetch(url+'/v1/messages?beta=true',{method:'POST',headers:{authorization:'Bearer fictional','content-type':'application/json'},body:JSON.stringify({max_tokens:4096,...thinking?{thinking:{type:'enabled',budget_tokens:thinking}}:{}})})
  await response.text();return response.status
}
for(const [url,allowed] of [
  [null,false],[undefined,false],['',false],['https://anthropic.com',false],
  ['https://api.anthropic.com/v1',false],['https://nested.api.anthropic.com',false],
  ['https://API.AnThRoPiC.CoM:8443/v1',false],['https://api.anthropic.com.:443',false],
  ['https://api.openai.com',false],['https://generativelanguage.googleapis.com',false],
  ['https://gateway.invalid:8443/anthropic',true],['http://localhost:8000',true],
  ['https://anthropic.com.gateway.invalid',true],['invalid url',false],['file:///fictional',false],
] as const)it(`classifies a checkup proxy endpoint: ${String(url)}`,()=>{
  expect(isCheckupProxyEndpoint(url)).toBe(allowed)
})
it('only relays custom API-key transports, keeping OAuth and native transports direct',()=>{
  const base={ANTHROPIC_BASE_URL:'https://gateway.invalid',ANTHROPIC_API_KEY:'fictional'}
  expect(usesCheckupProxy(base)).toBe(true)
  expect(usesCheckupProxy({ANTHROPIC_BASE_URL:base.ANTHROPIC_BASE_URL})).toBe(false)
  expect(usesCheckupProxy({...base,CLAUDE_CODE_OAUTH_TOKEN:'fictional'})).toBe(false)
  expect(usesCheckupProxy({...base,ANTHROPIC_UNIX_SOCKET:'/fictional/socket'})).toBe(false)
  for(const key of ['CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_USE_ANTHROPIC_AWS','CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD','CLAUDE_CODE_USE_MANTLE'])expect(usesCheckupProxy({...base,[key]:'1'})).toBe(false)
})
it('refuses to create an official endpoint forwarder even if called directly',async()=>{
  const send=vi.fn()
  await expect(makeCheckupProxy({upstream:'https://api.anthropic.com',budget:makeCheckupBudget({maxOutputTokens:5000,maxRequests:5}),maxOutputTokens:4096,signal:new AbortController().signal,onLimit:()=>{},fetch:send as unknown as typeof fetch})).rejects.toThrow('custom endpoint')
  expect(send).not.toHaveBeenCalled()
})
it('forwards only to the pinned endpoint, clamps thinking, and uses cumulative final SSE usage once',async()=>{
  const budget=makeCheckupBudget({maxOutputTokens:2000,maxRequests:3}),caps:number[]=[],thinking:number[]=[],onLimit=vi.fn()
  const proxy=await makeCheckupProxy({upstream:'https://fictional.invalid/api',budget,maxOutputTokens:4096,signal:new AbortController().signal,onLimit,fetch:(async(url:unknown,init?:RequestInit)=>{
    expect(String(url)).toBe('https://fictional.invalid/api/v1/messages?beta=true')
    expect(new Headers(init?.headers).get('authorization')==='Bearer fictional').toBe(true)
    expect(init?.redirect==='error').toBe(true)
    const body=JSON.parse(String(init?.body));caps.push(body.max_tokens);thinking.push(body.thinking.budget_tokens)
    return sse([{type:'message_start',message:{usage:{output_tokens:0}}},{type:'message_delta',usage:{output_tokens:20}},{type:'message_delta',usage:{output_tokens:caps.length===1?700:1300}},{type:'message_stop'}])
  }) as unknown as typeof fetch})
  try{
    expect(await post(proxy.url,2500)).toBe(200)
    expect(budget.usage.outputTokens).toBe(700)
    expect(await post(proxy.url,1800)).toBe(200)
    expect(caps).toEqual([2000,1300]);expect(thinking).toEqual([1999,1299])
    expect(budget.usage).toEqual({requests:2,outputTokens:2000})
    expect(await post(proxy.url)).toBe(429);expect(onLimit).toHaveBeenCalledOnce();expect(caps).toHaveLength(2)
  }finally{await proxy.close()}
})
it('does not refund initial zero usage or a nonterminal SSE response',async()=>{
  const budget=makeCheckupBudget({maxOutputTokens:4096,maxRequests:10})
  const proxy=await makeCheckupProxy({upstream:'https://fictional.invalid',budget,maxOutputTokens:4096,signal:new AbortController().signal,onLimit:()=>{},fetch:(async()=>sse([{type:'message_start',message:{usage:{output_tokens:0}}},{type:'content_block_delta',delta:{thinking:'unfinished reasoning'}}])) as unknown as typeof fetch})
  try{
    expect(await post(proxy.url)).toBe(200)
    expect(budget.usage.outputTokens).toBeGreaterThan(0)
    expect(budget.exhausted).toBe(true)
    expect(await post(proxy.url)).toBe(429)
  }finally{await proxy.close()}
})
it('does not send an invalid thinking request when the remainder cannot fit its minimum',async()=>{
  const budget=makeCheckupBudget({maxOutputTokens:1000,maxRequests:2}),send=vi.fn(async()=>Response.json({})),onLimit=vi.fn()
  const proxy=await makeCheckupProxy({upstream:'https://fictional.invalid',budget,maxOutputTokens:4096,signal:new AbortController().signal,onLimit,fetch:send as unknown as typeof fetch})
  try{
    expect(await post(proxy.url,2000)).toBe(429)
    expect(send).not.toHaveBeenCalled();expect(onLimit).toHaveBeenCalledOnce()
    expect(budget.usage).toEqual({requests:0,outputTokens:0})
  }finally{await proxy.close()}
})

it('accepts only verified native settings and refuses a Unix socket override without exposing settings',async()=>{
  const {checkupTransportSafe}=await import('./checkup-proxy')
  expect(checkupTransportSafe({effective:{env:{ANTHROPIC_UNIX_SOCKET:''}},sources:[{source:'flagSettings',settings:{env:{ANTHROPIC_UNIX_SOCKET:''}}}]})).toBe(true)
  expect(checkupTransportSafe({effective:{env:{ANTHROPIC_UNIX_SOCKET:'/fictional/socket'}},sources:[]})).toBe(false)
  expect(checkupTransportSafe({effective:{},sources:[{source:'policySettings',settings:{env:{ANTHROPIC_UNIX_SOCKET:'/fictional/socket'}}}]})).toBe(false)
  expect(checkupTransportSafe({})).toBe(false)
})
