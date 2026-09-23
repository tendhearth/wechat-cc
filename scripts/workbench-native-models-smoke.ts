/** Actual native catalog + execution proof, confined to owned loopback endpoints.
 * Run: bun scripts/workbench-native-models-smoke.ts --run
 * Add --split-codex-preset-ids to alter only model/list preset IDs in an owned protocol bridge.
 * Native model slugs/capabilities, execution requests, and model endpoints remain untouched. */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {chmod,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {gunzipSync} from 'node:zlib'
import type {AgentExecutionChoice,AgentExecutionObservation,AgentProvider,AgentSession} from '../src/core/agent-provider'
import {createClaudeAgentProvider} from '../src/core/claude-agent-provider'
import {createWorkbenchCodexProvider} from '../src/core/workbench/codex-app-server'
import {workbenchClaudeOptions} from '../src/daemon/bootstrap/wire-workbench'
import {TIER_PROFILES} from '../src/core/user-tier'
import {findCodexBinary} from '../src/lib/find-codex-binary'

if(!process.argv.includes('--run')) {console.log('Use --run for owned loopback-only native model fixtures.');process.exit(0)}
assert.equal(process.platform,'darwin','This proof requires macOS sandbox-exec network isolation.')
const claudeBinary=Bun.which('claude'),codexBinary=findCodexBinary();assert(claudeBinary&&codexBinary)
const versions={claude:execFileSync(claudeBinary,['--version'],{encoding:'utf8'}).trim(),codex:execFileSync(codexBinary,['--version'],{encoding:'utf8'}).trim()}
const area=await realpath(await mkdtemp(join(tmpdir(),'cc-native-models-'))),safePath=process.env.PATH??'/usr/bin:/bin'
for(const key of Object.keys(process.env))delete process.env[key]
Object.assign(process.env,{PATH:safePath,LANG:'en_US.UTF-8',TERM:'dumb',HOME:area,TMPDIR:area})
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`
const profile='(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))'
const requests:{claude:any[];codex:any[]}={claude:[],codex:[]},routes:string[]=[]
const server=createServer(async(request,response)=>{
  routes.push(request.url??'')
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
  const raw=Buffer.concat(chunks),body=JSON.parse((request.headers['content-encoding']==='gzip'?gunzipSync(raw):raw).toString()||'{}')
  const provider=request.url?.startsWith('/codex/')?'codex':'claude'
  if(!request.url?.endsWith('/responses')&&!request.url?.includes('/v1/messages')) {response.setHeader('content-type','application/json');response.end('{}');return}
  requests[provider].push(body);const id=`owned-${provider}-${requests[provider].length}`
  response.setHeader('content-type','text/event-stream')
  const event=(value:any)=>response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
  if(provider==='codex') {
    const item={id:`message-${id}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'OWNED_MODEL_COMPLETE',annotations:[]}]}
    event({type:'response.created',response:{id}});event({type:'response.output_item.added',output_index:0,item});event({type:'response.output_item.done',output_index:0,item})
    event({type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:10,total_tokens:20}}})
  } else {
    event({type:'message_start',message:{id,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:0}}})
    event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OWNED_MODEL_COMPLETE'}});event({type:'content_block_stop',index:0})
    event({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}});event({type:'message_stop'})
  }
  response.end()
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port
const wrappers={claude:join(area,'claude'),codex:join(area,'codex')}
const splitPresetIds=process.argv.includes('--split-codex-preset-ids'),presetEvidence=join(area,'preset-evidence.ndjson')
const bridge=join(area,'codex-preset-bridge.ts')
if(splitPresetIds)await writeFile(bridge,`
import {spawn} from 'node:child_process'
import {appendFileSync} from 'node:fs'
import {createInterface} from 'node:readline'
const child=spawn('/usr/bin/sandbox-exec',['-p',${JSON.stringify(profile)},${JSON.stringify(codexBinary)},...process.argv.slice(2)],{stdio:['pipe','pipe','inherit'],windowsHide:true})
const catalogs=new Set(),appServer=process.argv.slice(2).includes('app-server')
if(appServer) {
  const input=createInterface({input:process.stdin})
  input.on('line',line=>{const message=JSON.parse(line);if(message.method==='model/list')catalogs.add(message.id);child.stdin.write(line+'\\n')})
  input.on('close',()=>child.stdin.end())
  createInterface({input:child.stdout}).on('line',line=>{
    const message=JSON.parse(line)
    if(catalogs.delete(message.id)&&Array.isArray(message.result?.data)) {
      message.result.data=message.result.data.map(model=>{
        const changed={...model,id:'owned-preset-'+model.id}
        appendFileSync(${JSON.stringify(presetEvidence)},JSON.stringify({id:changed.id,model:model.model})+'\\n')
        return changed
      })
    }
    process.stdout.write(JSON.stringify(message)+'\\n')
  })
} else {process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout)}
child.stdin.on('error',()=>{})
child.on('error',()=>process.exit(1))
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal))
child.on('close',code=>process.exit(code??0))
`)
for(const [key,binary] of [['claude',claudeBinary],['codex',codexBinary]] as const) {
  const command=key==='codex'&&splitPresetIds?`${quote(process.execPath)} ${quote(bridge)}`:`/usr/bin/sandbox-exec -p ${quote(profile)} ${quote(binary)}`
  await writeFile(wrappers[key],`#!/bin/sh\nexport HOME=${quote(area)}\nexport CODEX_HOME=${quote(area)}\nexec ${command} "$@"\n`);await chmod(wrappers[key],0o700)
}
await mkdir(join(area,'.claude'));await mkdir(join(area,'project'));const project={alias:'owned-models',path:join(area,'project')}
const marker=join(area,'MCP_MUST_NOT_START')
await writeFile(join(area,'forbidden-mcp.sh'),`#!/bin/sh\nprintf started > ${quote(marker)}\nexit 1\n`);await chmod(join(area,'forbidden-mcp.sh'),0o700)
// A configured external MCP exists only during catalog discovery. Its marker proves no startup.
const codexConfig=`model='owned-configured-default'\nmodel_provider='fixture'\n[model_providers.fixture]\nname='Owned model fixture'\nbase_url='http://127.0.0.1:${port}/codex/v1'\nwire_api='responses'\nrequires_openai_auth=false\nsupports_websockets=false\n[features]\nplugins=false\napps=false\nhooks=false\n`
await writeFile(join(area,'config.toml'),codexConfig+`[mcp_servers.owned_forbidden]\ncommand=${JSON.stringify(join(area,'forbidden-mcp.sh'))}\nenabled=true\n`)
await writeFile(join(project.path,'.mcp.json'),JSON.stringify({mcpServers:{owned_forbidden:{command:join(area,'forbidden-mcp.sh')}}}))
await mkdir(join(project.path,'.claude'));await writeFile(join(project.path,'.claude','settings.json'),JSON.stringify({enableAllProjectMcpServers:true,hooks:{SessionStart:[{hooks:[{type:'command',command:join(area,'forbidden-mcp.sh')}]}]}}))
const claudeEnv={HOME:area,CLAUDE_CONFIG_DIR:join(area,'.claude'),XDG_CONFIG_HOME:join(area,'.config'),ANTHROPIC_API_KEY:'owned-model-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}/claude`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DISABLE_AUTOUPDATER:'1'}
const baseOptions=()=>workbenchClaudeOptions({cwd:project.path,model:'owned-cc-fallback',pathToClaudeCodeExecutable:wrappers.claude,env:claudeEnv},'Owned model fixture only.',async()=>({behavior:'deny',message:'Tools are unavailable in this fixture.'}))
const providers:Record<'claude'|'codex',AgentProvider>={claude:createClaudeAgentProvider({sdkOptionsForProject:baseOptions}),codex:createWorkbenchCodexProvider({codexPathOverride:wrappers.codex,model:'owned-cc-fallback'})}
async function paths(path:string):Promise<string[]> {
  const entries=await readdir(path,{withFileTypes:true}).catch(()=>[])
  return (await Promise.all(entries.map(async entry=>entry.isDirectory()?paths(join(path,entry.name)):[join(path,entry.name)]))).flat()
}
async function collect(session:AgentSession,text:string) {
  const events:any[]=[],timer=setTimeout(()=>void session.close(),30_000)
  try {for await(const event of session.dispatch(text))events.push(event)}finally{clearTimeout(timer)}
  assert(!events.some(e=>e.kind==='error'),JSON.stringify(events.filter(e=>e.kind==='error')))
  assert(events.some(e=>e.kind==='text'&&e.text.includes('OWNED_MODEL_COMPLETE')))
  const result=events.find(e=>e.kind==='result');assert(result);return result.sessionId as string
}
const results:any[]=[]
try {
  for(const name of ['claude','codex'] as const) {
    await writeFile(join(area,'config.toml'),codexConfig+`[mcp_servers.owned_forbidden]\ncommand=${JSON.stringify(join(area,'forbidden-mcp.sh'))}\nenabled=true\n`)
    const before=(await paths(area)).filter(path=>path.endsWith('.jsonl')),calls=requests[name].length
    const catalog=await providers[name].modelCatalog!(project)
    assert(catalog.models.length>0);assert.equal(requests[name].length,calls,'Catalog generated a model request')
    assert.deepEqual((await paths(area)).filter(path=>path.endsWith('.jsonl')),before,'Catalog persisted an empty native transcript')
    await assert.rejects(readFile(marker),'Catalog started a native MCP server or configured Claude startup hook')
    if(name==='codex'&&splitPresetIds) {
      const evidence=(await readFile(presetEvidence,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
      assert(evidence.length>0&&evidence.every(value=>value.id!==value.model),'Fixture did not separate native preset and execution identities')
      assert(catalog.models.every(model=>evidence.some(value=>value.model===model.id)&&!model.id.startsWith('owned-preset-')),'Catalog exposed a preset id as an execution key')
    }
    // Restore an MCP-free native task config, leaving discovery marker evidence intact.
    await writeFile(join(area,'config.toml'),codexConfig)
    const candidates=catalog.models.filter(model=>model.reasoningEfforts.length>=2)
    assert(candidates.length>0,'Native catalog contains no model with two effort choices')
    const selected=candidates[0]!,firstEffort=selected.reasoningEfforts[0]!,secondEffort=selected.reasoningEfforts.find(value=>value==='high'&&value!==firstEffort)??selected.reasoningEfforts.filter(value=>value!==firstEffort&&value!=='ultra'&&value!=='persistent').at(-1)!
    const resumedModel=candidates.find(model=>model.id!==selected.id&&!model.id.includes('[')&&model.reasoningEfforts.includes(secondEffort))
    assert(resumedModel,'Native catalog needs a second model for the resume-switch proof')
    const observations:AgentExecutionObservation[]=[]
    const spawn=(execution:AgentExecutionChoice,resumeSessionId?:string)=>providers[name].spawn(project,{tierProfile:TIER_PROFILES.trusted,permissionMode:'strict',chatId:'owned-model-task',workbenchTimeline:true,execution,resumeSessionId,reportExecution:value=>observations.push(value)})
    let session=await spawn({defaults:'provider',model:selected.id,reasoningEffort:firstEffort})
    let nativeId:string
    try {
      nativeId=await collect(session,'Owned model first turn')
      const first=requests[name].at(-1)
      assert.equal(name==='claude'?first.output_config?.effort:first.reasoning?.effort,firstEffort,`${name} first actual request effort mismatch`)
      assert.equal(first.model,observations.at(-1)?.model,`${name} model differs from native observation`)
      if(name==='codex')assert.equal(first.model,selected.id,'Codex first request did not use the advertised execution slug')
      assert.notEqual(first.model,'owned-cc-fallback')
      assert.equal(await collect(session,'Owned model continuation'),nativeId)
      assert.equal(name==='claude'?requests[name].at(-1).output_config?.effort:requests[name].at(-1).reasoning?.effort,firstEffort)
      await session.close();session=await spawn({defaults:'native',model:resumedModel.id,reasoningEffort:secondEffort},nativeId)
      assert.equal(await collect(session,'Owned model changed effort resume'),nativeId)
      const changed=requests[name].at(-1)
      assert.notEqual(changed.model,first.model,`${name} resumed explicit model switch did not change actual requests`)
      if(name==='codex')assert.equal(changed.model,resumedModel.id,'Codex resumed request did not use the advertised execution slug')
      assert.equal(name==='claude'?changed.output_config?.effort:changed.reasoning?.effort,secondEffort,`${name} resumed actual effort mismatch: ${JSON.stringify({selected,observation:observations.at(-1),actualModel:changed.model,reasoning:changed.reasoning})}`)
      assert(JSON.stringify(changed).includes('Owned model first turn'),'Resume lost original conversation')
      await session.close();session=await spawn({defaults:'provider',model:null,reasoningEffort:null},nativeId)
      assert.equal(await collect(session,'Owned automatic resume'),nativeId)
      const automatic=requests[name].at(-1)
      assert.notEqual(automatic.model,'owned-cc-fallback',`${name} automatic resume applied CC fallback`)
      assert.equal(automatic.model,changed.model,`${name} automatic resume lost the selected native model`)
      const count=requests[name].length
      await assert.rejects(spawn({defaults:'native',model:selected.id,reasoningEffort:'owned-unsupported-effort'}),/execution_effort_unsupported/)
      assert.equal(requests[name].length,count,'Invalid effort reached native model endpoint')
      let nativeAlias:unknown
      if(name==='codex'&&selected.reasoningEfforts.includes('ultra')) {
        await session.close();session=await spawn({defaults:'native',model:selected.id,reasoningEffort:'ultra'},nativeId)
        assert.equal(await collect(session,'Owned native effort alias'),nativeId)
        const aliased=requests.codex.at(-1)
        assert.equal(observations.at(-1)?.reasoningEffort,'ultra')
        assert.notEqual(aliased.reasoning?.effort,'ultra')
        assert(selected.reasoningEfforts.includes(aliased.reasoning?.effort))
        nativeAlias={selection:'ultra',nativeAcknowledgement:'ultra',ordinaryRequestEffort:aliased.reasoning.effort}
      }
      results.push({provider:name,catalogModels:catalog.models.length,catalogZeroGeneration:true,catalogNoTranscript:true,catalogNoMcp:true,selectedModel:selected.id,initialActualModel:first.model,resumedSelectedModel:resumedModel.id,actualModel:changed.model,initialEffort:firstEffort,resumedEffort:secondEffort,automaticResumeModel:automatic.model,automaticResumeEffort:name==='claude'?automatic.output_config?.effort:automatic.reasoning?.effort,sameNativeSession:true,continuationHistory:true,unsupportedEffortNoGeneration:true,...(nativeAlias?{nativeAlias}:{})})
    } finally {await session.close()}
  }
  console.log(JSON.stringify({versions,results,loopbackOnly:true,codexCatalogEnvelope:splitPresetIds?'synthetic-distinct-preset-ids':'unmodified-native'},null,2))
} finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(area,{recursive:true,force:true})}
