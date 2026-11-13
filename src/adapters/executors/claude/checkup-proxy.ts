/** A run-owned Messages boundary: native SDK recovery loops cannot bypass it. */
import {createServer} from 'node:http'
import {randomUUID} from 'node:crypto'
import type {CheckupBudget} from '../../../domain/checkup-budget'
import {checkupUsageLimit} from '../../../domain/checkup-budget'

/** Native policy may override the flag's empty Unix socket setting. Inspect
 * only the transport decision; never log or return native settings. */
export function checkupTransportSafe(value:unknown):boolean {
  const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
  if(!object(value)||!object(value.effective)||!Array.isArray(value.sources))return false
  const safe=(settings:Record<string,unknown>)=>settings.env===undefined||object(settings.env)&&(settings.env.ANTHROPIC_UNIX_SOCKET===undefined||settings.env.ANTHROPIC_UNIX_SOCKET==='')
  return safe(value.effective)&&value.sources.every(s=>object(s)&&typeof s.source==='string'&&object(s.settings)&&safe(s.settings))&&(value.errors===undefined||Array.isArray(value.errors)&&value.errors.length===0)
}

export async function makeCheckupProxy(o:{upstream:string;budget:CheckupBudget;maxOutputTokens:number;signal:AbortSignal;onLimit():void;fetch?:typeof fetch}) {
  const prefix=`/${randomUUID()}`,controllers=new Set<AbortController>()
  const http=createServer(async(req,res)=>{
    if(!req.url?.startsWith(prefix+'/')){res.writeHead(404).end();return}
    const suffix=req.url.slice(prefix.length)
    if(req.method!=='POST'||!new URL(suffix,'http://localhost').pathname.endsWith('/messages')){res.writeHead(403).end();return}
    let lease:ReturnType<CheckupBudget['reserve']>|undefined,outputBytes=0,outputTokens:number|undefined,line='',json='',streaming=false,complete=false,finalUsage=false,stopped=false
    const abort=new AbortController();controllers.add(abort)
    res.on('close',()=>{if(!res.writableEnded)abort.abort()})
    const usage=(raw:string)=>{
      try{
        const data=JSON.parse(raw),value=data.usage?.output_tokens??data.message?.usage?.output_tokens
        if(data.type==='message_stop')stopped=true
        if(data.type==='message_delta'&&typeof value==='number'&&Number.isFinite(value)&&value>=0)finalUsage=true
        if(typeof value==='number'&&Number.isFinite(value)&&value>=0)outputTokens=Math.max(outputTokens??0,value)
      }catch{/* Unknown usage keeps the full reservation in the hard gate. */}
    }
    try{
      const chunks:Buffer[]=[];let size=0
      for await(const chunk of req){size+=chunk.length;if(size>32*1024*1024)throw Error('invalid_request');chunks.push(chunk)}
      const body=JSON.parse(Buffer.concat(chunks).toString())
      o.signal.throwIfAborted()
      lease=o.budget.reserve(o.maxOutputTokens)
      body.max_tokens=lease.maxOutputTokens
      if(body.thinking?.type==='enabled'&&body.thinking.budget_tokens>=body.max_tokens){
        // Anthropic requires an enabled thinking budget of at least 1024 and
        // strictly less than max_tokens. No valid request fits this remainder.
        if(body.max_tokens<=1024){lease.settle({outputTokens:0,requests:0});throw checkupUsageLimit()}
        body.thinking.budget_tokens=body.max_tokens-1
      }
      const headers=new Headers()
      for(const [key,value] of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length','transfer-encoding','accept-encoding'].includes(key))headers.set(key,Array.isArray(value)?value.join(','):value)
      const response=await(o.fetch??fetch)(o.upstream.replace(/\/$/,'')+suffix,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.any([o.signal,abort.signal]),redirect:'error'})
      streaming=(response.headers.get('content-type')??'').includes('text/event-stream')
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'})
      const decoder=new TextDecoder()
      if(response.body)for await(const chunk of response.body){
        outputBytes+=chunk.byteLength
        const text=decoder.decode(chunk,{stream:true})
        if(streaming){
          line+=text
          let end:number
          while((end=line.indexOf('\n'))>=0){const row=line.slice(0,end).trim();line=line.slice(end+1);if(row.startsWith('data:'))usage(row.slice(5))}
        }else if(json.length<2*1024*1024)json+=text
        res.write(chunk)
      }
      if(streaming&&line.trim().startsWith('data:'))usage(line.trim().slice(5))
      else if(!streaming)usage(json+decoder.decode())
      complete=true
    }catch(error){
      if(error&&typeof error==='object'&&'code'in error&&error.code==='checkup_usage_limit'){
        if(!res.headersSent)res.writeHead(429,{'content-type':'application/json'})
        res.end(JSON.stringify({error:{type:'rate_limit_error',message:'checkup_usage_limit'}}))
        o.onLimit()
      }else if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'}).end(JSON.stringify({error:{type:'api_error',message:'Checkup request did not complete.'}}))
    }finally{
      lease?.settle({outputTokens:complete&&(!streaming||finalUsage&&stopped)?outputTokens:undefined,outputBytes})
      controllers.delete(abort)
      res.end()
    }
  })
  await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',()=>{http.removeListener('error',reject);resolve()})})
  const addr=http.address()
  if(!addr||typeof addr==='string')throw Error('Checkup proxy could not start.')
  return {url:`http://127.0.0.1:${addr.port}${prefix}`,async close(){for(const c of controllers)c.abort();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()))}}
}
