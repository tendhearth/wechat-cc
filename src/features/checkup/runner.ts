/** Same one-turn lifecycle as output-eval: registry spawn, events, bounded close. No production instructions. */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { AgentMcpTools, AgentProvider, AgentSession } from '../../ports/agent-provider'
import type { CheckupTarget } from '@wechat-cc/protocol'
import { JOB_PROFILE } from '../../domain/user-tier'
import type { CheckupSample, CheckupTurn } from '../../domain/butler-checkup'
import { checkupAddress } from '../../adapters/store/checkup-store'
import { errorWithProviderCode } from '../../lib/provider-error-code'
import { abortable } from './service'

/** An unguessable loopback MCP endpoint. It can only echo invented parameters. */
export async function fakeCheckupTools(sample: CheckupSample) {
  const calls: CheckupTurn['toolCalls'] = []
  const tools: AgentMcpTools = {
    tools: sample.kind === 'tool' ? [{name:sample.tool,description:'A fictional checkup tool. No real-world effects.',parameters:{type:'object',properties:{code:{type:'string'},place:{type:'string'}},required:['code','place'],additionalProperties:false}}] : [],
    async call(name,input) { calls.push({name,input}); return '虚构操作已完成。' },
    async close() {},
    serverOf: () => 'checkup',
  }
  const path = `/checkup-${randomUUID()}`
  const transports = new Set<StreamableHTTPServerTransport>()
  const http = createServer(async(req,res) => {
    if (req.url !== path) { res.writeHead(404).end(); return }
    // Streamable HTTP clients probe GET for SSE; 405 is the protocol's
    // supported stateless/no-SSE response. 404 would report a broken server.
    if (req.method !== 'POST') { res.writeHead(405,{Allow:'POST'}).end(); return }
    const server = new Server({name:'cc-synthetic-checkup',version:'1'},{capabilities:{tools:{}}})
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:tools.tools.map(t=>({name:t.name,description:t.description,inputSchema:t.parameters as {type:'object'}}))}))
    server.setRequestHandler(CallToolRequestSchema,async r=> {
      // Even an unknown tool has no effects. Keep it for the deterministic scorer.
      const text = await tools.call(r.params.name,r.params.arguments)
      return {content:[{type:'text',text}]}
    })
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true})
    transports.add(transport)
    res.on('close',()=>{transports.delete(transport);void server.close().catch(()=>{})})
    try { await server.connect(transport); await transport.handleRequest(req,res) }
    catch { if(!res.headersSent) res.writeHead(500).end(); else res.end() }
  })
  await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',()=>{http.removeListener('error',reject);resolve()})})
  const addr=http.address()
  if(!addr || typeof addr==='string')throw new Error('checkup_listener_failed')
  return {tools,calls,url:`http://127.0.0.1:${addr.port}${path}`,async close(){for(const t of transports)void t.close().catch(()=>{});http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()))}}
}

const closeSession = async (session: AgentSession) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([session.close().catch(()=>{}),new Promise<void>(r=>{timer=setTimeout(r,3000)})]) }
  finally { clearTimeout(timer) }
}
export function makeCheckupTurn(getProvider:(id:string)=>AgentProvider|null) {
  return async(sample:CheckupSample,target:CheckupTarget,signal:AbortSignal):Promise<CheckupTurn> => {
    signal.throwIfAborted()
    const provider=getProvider(target.provider)
    if(!provider)throw errorWithProviderCode('provider unavailable','provider_error')
    if(provider.supportsIsolatedEvaluation!==true)throw Object.assign(new Error('isolated_evaluation_unavailable'),{code:'isolated_evaluation_unavailable'})
    const project=mkdtempSync(join(tmpdir(),'cc-synthetic-checkup-'))
    let bridge: Awaited<ReturnType<typeof fakeCheckupTools>> | undefined, session:AgentSession|undefined
    const started=performance.now()
    const cancel=()=>{void session?.cancel?.().catch(()=>{});if(session)void closeSession(session)}
    signal.addEventListener('abort',cancel,{once:true})
    try {
      bridge=await fakeCheckupTools(sample)
      signal.throwIfAborted()
      const pending=provider.spawn({alias:'synthetic-checkup',path:project},{tierProfile:JOB_PROFILE,permissionMode:'strict',chatId:`checkup-${randomUUID()}`,model:target.model,appendInstructions:'只根据本次完全编造的题目作答。禁止读取文件、记忆、项目或调用本次练习以外的工具。',evaluation:{tools:bridge.tools,mcpServer:{url:bridge.url},maxSteps:sample.kind==='tool'?2:1,maxOutputTokens:512}})
      void pending.then(s=>{if(signal.aborted)void closeSession(s)},()=>{})
      session=await abortable(pending,signal)
      const actual=session.callTarget?.()
      if(actual && ((actual.model && actual.model!==target.model) || checkupAddress(actual.baseUrl??'default')!==checkupAddress(target.address)))throw Object.assign(new Error('target changed'),{code:'target_changed'})
      let text='',firstTextMs:number|null=null,completed=false,toolError=false
      for await(const ev of session.dispatch(sample.prompt)) {
        signal.throwIfAborted()
        if(ev.kind==='text') { if(firstTextMs===null && ev.text.trim())firstTextMs=performance.now()-started;text=ev.textMode==='replace'?ev.text:text+ev.text }
        else if(ev.kind==='error') {
          if(sample.kind==='tool' && ev.code==='checkup_step_budget') { toolError=true;completed=true }
          else throw Object.assign(errorWithProviderCode('model request did not complete',undefined),{code:ev.code??'provider_error'})
        }
        else if(ev.kind==='result')completed=true
        if(text.length>16_384)throw errorWithProviderCode('checkup output exceeded limit','invalid_request')
      }
      if(!completed)throw errorWithProviderCode('turn ended without completion','provider_error')
      return {text,toolCalls:bridge.calls,firstTextMs,durationMs:performance.now()-started,...(toolError?{toolError:true}:{})}
    } finally {
      signal.removeEventListener('abort',cancel)
      if(session)await closeSession(session)
      await bridge?.close()
      rmSync(project,{recursive:true,force:true})
    }
  }
}
