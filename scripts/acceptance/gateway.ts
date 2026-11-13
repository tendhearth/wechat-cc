/** Transparent loopback relay: exact upstream path/body; never logs headers/body. */
import { appendFileSync, writeFileSync,existsSync,readFileSync } from 'node:fs'
import { join } from 'node:path'
const dir=process.env.WECHAT_STATE_DIR
if(!dir?.startsWith('/private/tmp/')||!dir.includes('/acc/state/'))throw Error('explicit temporary state required')
let sequence=existsSync(join(dir,'gateway.jsonl'))?readFileSync(join(dir,'gateway.jsonl'),'utf8').split('\n').filter(Boolean).reduce((n,s)=>Math.max(n,JSON.parse(s).id??0),0):0
const port=process.env.ACCEPTANCE_GATEWAY_PORT?Number(process.env.ACCEPTANCE_GATEWAY_PORT):0
if(!Number.isInteger(port)||port<0||port>65535)throw Error('invalid acceptance proxy port')
const server=Bun.serve({hostname:'127.0.0.1',port,idleTimeout:255,async fetch(req){
  const u=new URL(req.url)
  if(!['/v1/messages','/v1/messages/count_tokens','/v1/chat/completions','/v1/responses','/v1/models'].includes(u.pathname))return new Response('acceptance endpoint denied',{status:403})
  const body=req.method==='POST'?await req.text():undefined
  let b:any={};try{b=JSON.parse(body??'{}')}catch{}
  const tools=(b.tools??[]).map((t:any)=>t.name??t.function?.name).filter(Boolean)
  const row:any={id:++sequence,at:new Date().toISOString(),path:u.pathname,bodyBytes:Buffer.byteLength(body??''),model:b.model??null,maxTokens:b.max_tokens??b.max_output_tokens??null,temperature:b.temperature??null,toolCount:tools.length,toolNames:tools,hasMemoryCanary:body?.includes('ACC_PRIVATE_MEMORY_CANARY')??false,hasTopicCanary:body?.includes('ACC_PRIVATE_TOPIC_CANARY')??false,hasDialogueCanary:body?.includes('ACC_PRIVATE_DIALOGUE_CANARY')??false,hasExecutorCanary:body?.includes('ACC_PRIVATE_EXECUTOR_CANARY')??false,hasPersonaName:body?.includes('验收CC')??false,hasStatePath:body?.includes(dir)??false}
  row.includeUsageRequested=b.stream_options?.include_usage===true
  row.messageCount=b.messages?.length??null
  row.systemChars=typeof b.system==='string'?b.system.length:Array.isArray(b.system)?b.system.reduce((n:number,s:any)=>n+(s.text?.length??0),0):(b.messages??[]).filter((m:any)=>m.role==='system').reduce((n:number,m:any)=>n+(typeof m.content==='string'?m.content.length:JSON.stringify(m.content).length),0)
  row.toolDefinitionBytes=Buffer.byteLength(JSON.stringify(b.tools??[]))
  row.onlyFakeTools=tools.length>0&&tools.every((n:string)=>['reply','ask_user','delegate'].includes(n.replace(/^mcp__wechat__/,'')))
  row.hasActualExecutorName=/\b(?:claude|codex|cursor|agy)\b/i.test(body??'')
  row.hasNotebook=body?.includes('matter_ledger_data')??false
  row.hasHandoffFile=body?.includes('handoff.txt')??false
  row.hasResultSupplement=body?.includes('把结果交给我看一下')??false
  row.hasBackendSupplement=body?.includes('把表单提交给后端')??false
  row.hasCodexTranscriptEnvelope=/"(?:thread_id|parent_tool_use_id)"|"type":"(?:turn.started|item.completed)"/.test(body??'')
  const canaryFile=join(dir,'transcript-canaries.json')
  row.hasTranscriptOnlyCanary=existsSync(canaryFile)&&(JSON.parse(readFileSync(canaryFile,'utf8')) as string[]).some(c=>(body??'').includes(c))
  const headers=new Headers(req.headers);headers.delete('host');headers.delete('connection');headers.delete('content-length')
  try{
    const r=await fetch('https://llm.youdamaster.cc'+u.pathname+u.search,{method:req.method,body,headers,redirect:'manual',signal:req.signal})
    row.status=r.status
    if(r.status>=300&&r.status<400){row.redirectBlocked=true;appendFileSync(join(dir,'gateway.jsonl'),JSON.stringify(row)+'\n');return new Response('redirect denied',{status:502})}
    const outHeaders=new Headers(r.headers);outHeaders.delete('content-encoding');outHeaders.delete('content-length')
    if(!r.ok){
      const error=await r.text();row.errorBytes=Buffer.byteLength(error)
      // Structured infrastructure errors only. Never retain echoed story/body.
      let parsed:any;try{parsed=JSON.parse(error.replace(/^upstream error:\s*/,''))}catch{}
      row.errorCode=parsed?.error?.code??null;row.errorType=parsed?.error?.type??null
      const message=parsed?.error?.message??''
      row.contextOverflow=/context.{0,30}(?:exceed|length|window|maximum)|prompt.{0,20}(?:long|token)|request exceeded model token limit/i.test(message)
      if(row.contextOverflow){let safe=String(message).slice(0,500);for(const name of ['authorization','x-api-key']){const secret=req.headers.get(name)?.replace(/^Bearer\s+/i,'');if(secret)safe=safe.split(secret).join('[REDACTED]')}row.contextError=safe.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi,'[REDACTED]')}
      appendFileSync(join(dir,'gateway.jsonl'),JSON.stringify(row)+'\n');return new Response(error,{status:r.status,headers:outHeaders})
    }
    appendFileSync(join(dir,'gateway.jsonl'),JSON.stringify(row)+'\n')
    if(!r.body)return new Response(null,{status:r.status,headers:outHeaders})
    const [stream,observation]=r.body.tee()
    void(async()=>{
      let buffer='',usage:unknown=null,names:string[]=[],finishReasons:string[]=[],textChars=0,reasoningChars=0
      const decoder=new TextDecoder(),reader=observation.getReader()
      try{for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop()??'';for(const line of lines){if(!line.startsWith('data:'))continue;try{const event=JSON.parse(line.slice(5));usage=event.usage??event.message?.usage??event.response?.usage??usage;const choice=event.choices?.[0],delta=choice?.delta;for(const call of delta?.tool_calls??[])if(call.function?.name)names.push(call.function.name);if(event.content_block?.type==='tool_use')names.push(event.content_block.name);const finish=choice?.finish_reason??event.delta?.stop_reason??event.response?.incomplete_details?.reason;if(finish)finishReasons.push(finish);textChars+=(delta?.content?.length??0)+(event.delta?.text?.length??0);reasoningChars+=(delta?.reasoning_content?.length??0)+(event.delta?.thinking?.length??0)}catch{}}if(buffer.length>1000000)buffer=''}
      appendFileSync(join(dir,'gateway-responses.jsonl'),JSON.stringify({responseOf:row.id,status:r.status,usage,toolCalls:names,finishReasons,textChars,reasoningChars})+'\n')
      }catch{appendFileSync(join(dir,'gateway-responses.jsonl'),JSON.stringify({responseOf:row.id,incomplete:true})+'\n')}
    })()
    return new Response(stream,{status:r.status,headers:outHeaders})
  }catch{row.transportError=true;appendFileSync(join(dir,'gateway.jsonl'),JSON.stringify(row)+'\n');return new Response('gateway transport failed',{status:502})}
}})
writeFileSync(join(dir,'gateway.json'),JSON.stringify({baseUrl:`http://127.0.0.1:${server.port}`}))
process.on('SIGTERM',()=>{server.stop(true);process.exit(0)})
