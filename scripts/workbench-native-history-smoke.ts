import {MANAGED_NATIVE_CAPABILITIES} from '../src/core/workbench/executor-capabilities'
/** Manual, opt-in QA. Uses only owned temporary fixtures; never scans private sessions.
 * If an approval appears, inspect it, then enter {"taskId":"…","id":"…","decision":"allow"|"deny"}.
 * Existing native configuration and strict permissions remain in effect. */
import {execFileSync} from 'node:child_process'
import {createInterface} from 'node:readline'
import {mkdtempSync,realpathSync,mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {homedir,tmpdir} from 'node:os'
import {randomBytes} from 'node:crypto'
import {openDb} from '../src/lib/db'
import {findCodexBinary} from '../src/lib/find-codex-binary'
import {createProviderRegistry} from '../src/core/provider-registry'
import {createWorkbenchCodexProvider} from '../src/core/workbench/codex-app-server'
import {createClaudeAgentProvider,makeWorkbenchClaudeCanUseTool} from '../src/core/claude-agent-provider'
import {workbenchClaudeOptions} from '../src/daemon/bootstrap/wire-workbench'
import {workbenchClaudeAuthEnv} from './workbench-claude-config'
import {makeWorkbenchStore} from '../src/core/workbench/store'
import {saveArtifactSnapshot} from '../src/core/workbench/artifacts'
import {makeWorkbenchService} from '../src/core/workbench/service'
import {TIER_PROFILES} from '../src/core/user-tier'
import {createClaudeHistoryReader} from '../src/core/workbench/native-claude-history'
import {createCodexHistoryReader} from '../src/core/workbench/native-codex-history'
import {encodeNativeHistoryKey} from '../src/core/workbench/native-history'
import {readJsonFile} from '../src/lib/read-json-file'
if(!process.argv.includes('--run')){console.log('Manual model test. Creates disposable native sessions and a project; uses configured model access. Run with --run.');process.exit(0)}
const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-workbench-native-smoke-'))),cwd=join(root,'project');mkdirSync(cwd)
const git=(...args:string[])=>execFileSync('git',args,{cwd,stdio:'pipe'})
git('init','-q');git('config','user.name','Owned QA');git('config','user.email','qa@localhost')
writeFileSync(join(cwd,'math.mjs'),'export const sum = values => values.reduce((a, b) => a + b, 0);\n');writeFileSync(join(cwd,'notes.txt'),'user base\n');git('add','.');git('commit','-qm','Owned base');writeFileSync(join(cwd,'notes.txt'),'user unfinished notes\n')
const binary=findCodexBinary(),claude=Bun.which('claude')??join(homedir(),'.local','bin','claude'),registry=createProviderRegistry()
registry.register('codex',createWorkbenchCodexProvider({codexPathOverride:binary!}),{workbench:MANAGED_NATIVE_CAPABILITIES,displayName:'Codex',canResume:()=>true})
registry.register('claude',createClaudeAgentProvider({sdkOptionsForProject(_a,path,_t,_c,_e,instructions,context){const settingsPath=join(homedir(),'.claude','settings.json'),settings=existsSync(settingsPath)?readJsonFile(settingsPath):{};return workbenchClaudeOptions({cwd:path,pathToClaudeCodeExecutable:claude,env:{...process.env,...workbenchClaudeAuthEnv(settings,process.env)},maxTurns:12},instructions??'',makeWorkbenchClaudeCanUseTool(context?.requestPermission))}}),{workbench:MANAGED_NATIVE_CAPABILITIES,displayName:'Claude',canResume:()=>true})
const db=openDb({path:join(root,'cc.db')}),store=makeWorkbenchStore(db),service=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>null,timeoutMs:120000,permissionTimeoutMs:180000})
const approved=new Set<string>(),seen=new Set<string>();const input=createInterface({input:process.stdin});input.on('line',line=>{try{const value=JSON.parse(line);if(typeof value.taskId==='string'&&typeof value.id==='string'&&['allow','deny'].includes(value.decision)){service.resolvePermission(value.taskId,value.id,value.decision);approved.add(value.id)}}catch{console.log('Invalid approval input')}})
async function finished(id:string){const deadline=Date.now()+240000;while(['queued','running','cancelling'].includes(service.detail(id).task.status)&&Date.now()<deadline){for(const p of service.detail(id).permissions)if(!seen.has(p.id)){seen.add(p.id);console.log('PERMISSION '+JSON.stringify(p))}await Bun.sleep(100)}const d=service.detail(id);if(d.task.status!=='completed')throw Error(`${d.task.status}: ${d.task.error}`);return d}
/** Each native fixture is created by this script, then read by its exact known ID. */
async function nativeRecovery(providerId:'claude'|'codex'){
 const project=join(root,`native-${providerId}`);mkdirSync(project)
 const provider=registry.get(providerId)!.provider,marker='NATIVE-'+randomBytes(5).toString('hex')
 const native=await provider.spawn({alias:'owned-native-recovery',path:project},{tierProfile:TIER_PROFILES.trusted,permissionMode:'strict',chatId:'owned-qa',appendInstructions:'A conversation continuity test. Do not use tools or access any files.',requestPermission:async()=>false})
 let nativeId=''
 try{for await(const event of native.dispatch(`Remember this exact marker for my next turn: ${marker}. Reply only remembered.`)){if((event.kind==='init'||event.kind==='result')&&event.sessionId)nativeId=event.sessionId;if(event.kind==='error')throw Error(event.message)}}finally{await native.close()}
 if(!nativeId)throw Error('missing_native_id')
 const reader=providerId==='claude'?createClaudeHistoryReader():createCodexHistoryReader({codexPathOverride:binary!}),key=encodeNativeHistoryKey(providerId,nativeId)
 const nativeDb=openDb({path:join(root,`native-${providerId}.db`)}),nativeStore=makeWorkbenchStore(nativeDb),nativeService=makeWorkbenchService({store:nativeStore,registry,stateDir:project,ownerChatId:()=>null,nativeHistory:{[providerId]:reader},timeoutMs:60000,permissionTimeoutMs:1000})
 try{
  let imported:Awaited<ReturnType<typeof nativeService.importNativeHistory>>|undefined,refreshes=0
  // A just-closed tool can finish writing metadata after our first read. The
  // importer must reject that preview; refresh this owned fixture, never bypass
  // the fingerprint or silently start a fresh model session.
  for(let attempt=0;attempt<3;attempt++){
   const page=await reader.read(key,{limit:100})
   try{imported=await nativeService.importNativeHistory({key,pages:[{...page.page,sourceFingerprint:page.sourceFingerprint}],messageIds:page.messages.map(m=>m.id)});break}
   catch(error){if(!(error instanceof Error)||error.message!=='native_history_changed'||attempt===2)throw error;refreshes++;await Bun.sleep(250)}
  }
  if(!imported)throw Error('native_import_failed')
  const decision=await nativeService.prepareNativeResume(imported.task.id)
  await nativeService.continueNativeTask(imported.task.id,'Return only the exact marker I asked you to remember in our first turn. Do not use any tools.',decision.token)
  const deadline=Date.now()+90000
  while(['queued','running','cancelling'].includes(nativeService.detail(imported.task.id).task.status)&&Date.now()<deadline)await Bun.sleep(100)
  const d=nativeService.detail(imported.task.id),reply=d.events.filter(e=>e.kind==='text'&&!e.sourceId).at(-1)?.text??''
  const ok=d.task.status==='completed'&&nativeStore.get(imported.task.id).sessionId===nativeId&&reply.includes(marker)
  const result={providerId,taskId:imported.task.id,nativeId,ok,refreshes,status:d.task.status,error:d.task.error};console.log(JSON.stringify(result));if(!ok)throw Error(`${providerId}_native_recovery_failed`);return result
 }finally{await nativeService.shutdown();nativeDb.close()}
}
const result:Record<string,unknown>={root,ok:false,stage:'create'}
console.log('Owned handoff QA:',root)
try{
 const nativeResults=await Promise.allSettled([nativeRecovery('claude'),nativeRecovery('codex')]);result.nativeRecoveries=nativeResults
 if(nativeResults.some(r=>r.status==='rejected'))throw Error(nativeResults.filter(r=>r.status==='rejected').map(r=>String(r.reason)).join('; '))
 const marker='ORIGINAL-'+randomBytes(5).toString('hex')
 const a=service.create({path:cwd,providerId:'codex',title:'Owned code review loop',text:`Work only in this disposable project. Remember ${marker} for the next turn. Add an exported average(values) to math.mjs implemented as sum(values) / values.length. Keep sum unchanged and preserve notes.txt exactly. This first task intentionally specifies no empty-array behavior. Save a short report in your assigned output folder. Do not install anything, browse, commit or access other folders.`})
 const first=await finished(a.id),originalId=store.get(a.id).sessionId;result.sourceTaskId=a.id;result.originalNativeId=originalId
 const artifact=store.artifacts(a.id).find(a=>a.mime==='application/vnd.cc.workbench-review+json')!;if(!artifact)throw Error('missing code snapshot')
 const v1=service.artifact(a.id,artifact.id),report=JSON.parse(Buffer.from(v1.contentBase64,'base64').toString('utf8'))
 result.preexistingPreserved=report.preexistingPaths.includes('notes.txt')&&readFileSync(join(cwd,'notes.txt'),'utf8')==='user unfinished notes\n'
 result.stage='review'
 const p=await service.previewHandoff({sourceTaskId:a.id,targetProviderId:'claude',purpose:'review',request:'Read the fixed change snapshot and math.mjs in this project. A new requirement says average([]) must be 0. Check whether the new average implements it. Do not edit project code. Return a concise review containing this exact line if the issue is present: "FIX: Make average([]) return 0 and add a test for it." Then add a separate optional naming suggestion. Only write a report in the assigned output folder. Do not browse, install, commit or access other folders.',artifacts:[{taskId:a.id,artifactId:artifact.id,sha256:artifact.sha256}]})
 const b=await service.handoff({token:p.token}),review=await finished(b.task.id),event=review.events.filter(e=>e.kind==='text'&&e.text.includes('FIX:')).at(-1)!,quote=event?.text.match(/FIX: Make average\(\[\]\) return 0 and add a test for it\./)?.[0]
 if(!quote)throw Error('missing selected review quote')
 result.reviewTaskId=b.task.id;result.reviewNativeId=store.get(b.task.id).sessionId;result.stage='revision'
 const revision=await service.previewHandoff({sourceTaskId:b.task.id,targetTaskId:a.id,targetProviderId:'codex',purpose:'revision',request:'Apply only the selected correction, keep sum and notes.txt untouched, add math.test.mjs using node:assert/strict, and run node math.test.mjs. Save a short report in your output directory. Include the exact ORIGINAL marker from our first turn in your final reply. Do not install, browse, commit or access other folders.',artifacts:[],quote:{taskId:b.task.id,eventId:event.id,text:quote}})
 await service.handoff({token:revision.token});const end=await finished(a.id),last=end.events.filter(e=>e.kind==='text').at(-1)!.text
 const run=execFileSync(process.execPath,['-e',`import {average,sum} from './math.mjs'; if(average([])!==0||average([2,4])!==3||sum([2,3])!==5)process.exit(2);`],{cwd,stdio:'pipe'})
 execFileSync('node',['math.test.mjs'],{cwd,stdio:'pipe'})
 const refs=end.handoffs,after=store.artifacts(a.id).filter(a=>a.mime==='application/vnd.cc.workbench-review+json')
 result.identityPreserved=originalId===store.get(a.id).sessionId;result.markerRecovered=last.includes(marker);result.revisionCorrect=run.length===0;result.pinnedOldVersion=refs.length===2&&refs.every(h=>h.artifacts[0]?.sha256===artifact.sha256)&&service.artifact(a.id,artifact.id).sha256===v1.sha256;result.onlySelectedOpinion=revision.quote?.text===quote;result.newDiff=after.some(a=>a.sha256!==artifact.sha256);result.userNotesPreserved=readFileSync(join(cwd,'notes.txt'),'utf8')==='user unfinished notes\n';result.permissionDecisions=approved.size
 result.ok=result.identityPreserved&&result.markerRecovered&&result.revisionCorrect&&result.pinnedOldVersion&&result.onlySelectedOpinion&&result.newDiff&&result.userNotesPreserved&&result.preexistingPreserved
 result.records=refs.map(h=>({id:h.id,purpose:h.purpose,sourceTaskId:h.sourceTaskId,targetTaskId:h.targetTaskId,sourceNativeId:h.sourceNativeId,targetNativeId:h.targetNativeId,sha256:h.artifacts[0]?.sha256,requestEventId:h.requestEventId}))
}catch(error){result.error=error instanceof Error?error.message:String(error)}finally{input.close();await service.shutdown();db.close();writeFileSync(join(root,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))}

if(result.ok!==true)process.exitCode=1
