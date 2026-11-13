/** Same one-turn lifecycle as output-eval: registry spawn, events, bounded close. Projected identity only; no production memories. */
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
import { interviewInstructions } from './instructions'
import { CHECKUP_OUTPUT_BUDGETS, CHECKUP_MAX_STEPS, scoreInterview } from '../../domain/checkup-interview'
import type { CheckupBudget } from '../../domain/checkup-budget'

/** An unguessable loopback MCP endpoint. It can only echo invented parameters. */
export async function fakeCheckupTools(sample: CheckupSample, onAction?:(name:string,input:unknown)=>void) {
  const calls: CheckupTurn['toolCalls'] = []
  const tools: AgentMcpTools = {
    tools: sample.kind === 'interview' ? [
      {name:'reply',description:'回用户的话。',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}},
      {name:'ask_user',description:'拿不准时，问用户一句。',parameters:{type:'object',properties:{question:{type:'string'}},required:['question'],additionalProperties:false}},
      ...(sample.executors.length?[{name:'delegate',description:'把具体工作交给一个执行者。',parameters:{type:'object',properties:{executor:{type:'string',enum:sample.executors},instruction:{type:'string'}},required:['executor','instruction'],additionalProperties:false}}]:[]),
    ] : sample.kind === 'tool' ? [{name:sample.tool,description:'A fictional checkup tool. No real-world effects.',parameters:{type:'object',properties:{code:{type:'string'},place:{type:'string'}},required:['code','place'],additionalProperties:false}}] : [],
    async call(name,input) { calls.push({name,input});onAction?.(name,input); return sample.kind==='interview'?'已收到。':'虚构操作已完成。' },
    async close() {},
    serverOf: () => 'wechat',
  }
  const path = `/conversation-${randomUUID()}`
  const transports = new Set<StreamableHTTPServerTransport>()
  const http = createServer(async(req,res) => {
    if (req.url !== path) { res.writeHead(404).end(); return }
    // Streamable HTTP clients probe GET for SSE; 405 is the protocol's
    // supported stateless/no-SSE response. 404 would report a broken server.
    if (req.method !== 'POST') { res.writeHead(405,{Allow:'POST'}).end(); return }
    const server = new Server({name:'wechat',version:'1'},{capabilities:{tools:{}}})
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
  const attempt = async(sample:CheckupSample,target:CheckupTarget,signal:AbortSignal,maxOutputTokens:number,budget?:CheckupBudget):Promise<CheckupTurn> => {
    signal.throwIfAborted()
    const provider=getProvider(target.provider)
    if(!provider)throw errorWithProviderCode('provider unavailable','provider_error')
    if(provider.supportsIsolatedEvaluation!==true)throw Object.assign(new Error('isolated_evaluation_unavailable'),{code:'isolated_evaluation_unavailable'})
    const project=mkdtempSync(join(tmpdir(),sample.kind==='interview'?'cc-conversation-':'cc-synthetic-checkup-'))
    let bridge: Awaited<ReturnType<typeof fakeCheckupTools>> | undefined, session:AgentSession|undefined
    const started=performance.now()
    let firstActionMs:number|null=null
    const cancel=()=>{void session?.cancel?.().catch(()=>{});if(session)void closeSession(session)}
    signal.addEventListener('abort',cancel,{once:true})
    try {
      bridge=await fakeCheckupTools(sample,(name,input)=>{if(sample.kind==='interview'&&firstActionMs===null&&['reply','ask_user'].includes(name)&&input&&typeof input==='object'&&Object.values(input).some(v=>typeof v==='string'&&v.trim()))firstActionMs=performance.now()-started})
      signal.throwIfAborted()
      const pending=provider.spawn({alias:sample.kind==='interview'?'conversation':'synthetic-checkup',path:project},{tierProfile:JOB_PROFILE,permissionMode:'strict',chatId:`conversation-${randomUUID()}`,model:target.model,appendInstructions:sample.kind==='interview'?interviewInstructions(target.provider,target.model,sample.persona,sample.executors):'只根据本次完全编造的题目作答。禁止读取文件、记忆、项目或调用本次练习以外的工具。',evaluation:{tools:bridge.tools,mcpServer:{url:bridge.url},maxSteps:sample.kind==='memory'?1:sample.kind==='interview'?CHECKUP_MAX_STEPS:2,maxOutputTokens,budget}})
      void pending.then(s=>{if(signal.aborted)void closeSession(s)},()=>{})
      session=await abortable(pending,signal)
      const actual=session.callTarget?.()
      if(actual && ((actual.model && actual.model!==target.model) || checkupAddress(actual.baseUrl??'default')!==checkupAddress(target.address)))throw Object.assign(new Error('target changed'),{code:'target_changed'})
      let text='',firstTextMs:number|null=null,completed=false,toolError=false,usageLimited=false
      for await(const ev of session.dispatch(sample.prompt)) {
        signal.throwIfAborted()
        if(ev.kind==='text') { if(firstTextMs===null && ev.text.trim())firstTextMs=performance.now()-started;text=ev.textMode==='replace'?ev.text:text+ev.text }
        else if(ev.kind==='error') {
          if(sample.kind==='interview' && ['checkup_output_exhausted','checkup_usage_limit'].includes(ev.code??'') && scoreInterview(sample,{text,toolCalls:bridge.calls,firstTextMs:null,durationMs:0},sample.persona).observed) {
            // The visible answer is the fake action, not the optional final
            // prose. An exhausted sign-off cannot erase an observed reply.
            completed=true
            usageLimited ||= ev.code==='checkup_usage_limit'
          }
          else if(sample.kind!=='memory' && ev.code==='checkup_step_budget') { toolError=true;completed=true }
          else throw Object.assign(errorWithProviderCode('model request did not complete',undefined),{code:ev.code??'provider_error'})
        }
        else if(ev.kind==='result')completed=true
        if(text.length>16_384)throw errorWithProviderCode('checkup output exceeded limit','invalid_request')
      }
      if(!completed)throw errorWithProviderCode('turn ended without completion','provider_error')
      return {text,toolCalls:bridge.calls,firstTextMs:sample.kind==='interview'?(firstActionMs??firstTextMs):firstTextMs,durationMs:performance.now()-started,...(toolError?{toolError:true}:{}),...(usageLimited?{usageLimited:true}:{})}
    } finally {
      signal.removeEventListener('abort',cancel)
      if(session)await closeSession(session)
      await bridge?.close()
      rmSync(project,{recursive:true,force:true})
    }
  }
  return async(sample:CheckupSample,target:CheckupTarget,signal:AbortSignal,budget?:CheckupBudget):Promise<CheckupTurn> => {
    const started=performance.now()
    for(const [index,outputCap] of CHECKUP_OUTPUT_BUDGETS.entries()){
      signal.throwIfAborted()
      const elapsed=performance.now()-started
      try {
        const turn=await attempt(sample,target,signal,outputCap,budget)
        return {...turn,firstTextMs:turn.firstTextMs===null?null:turn.firstTextMs+elapsed,durationMs:performance.now()-started}
      } catch(error) {
        // Every attempt owns fresh fake tools and scratch state. Replaying this
        // invented question cannot duplicate a real action; no provider fallback.
        if(signal.aborted || index===CHECKUP_OUTPUT_BUDGETS.length-1 || !(error && typeof error==='object' && 'code' in error && error.code==='checkup_output_exhausted'))throw error
      }
    }
    throw new Error('checkup_output_exhausted')
  }
}
