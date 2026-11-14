/** Extract complete synthetic conclusions and receipts, never session credentials. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {Database} from 'bun:sqlite'

const root=resolve(process.argv[2]??''),output=resolve(process.argv[3]??'')
if(!root.startsWith('/private/tmp/')||!root.endsWith('/acc/state')||!output.startsWith(resolve(root,'../..')+'/'))throw Error('explicit temporary acceptance paths required')
const runs=process.argv.slice(4)
if(!runs.length||runs.some(r=>!/^run-\d+$/.test(r)))throw Error('explicit run names required')
const jsonl=(dir:string,name:string):any[]=>existsSync(join(dir,name))?readFileSync(join(dir,name),'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s)):[]
const result=runs.map(run=>{
 const dir=join(root,run)
 if(!existsSync(join(dir,'.acceptance-only')))throw Error('acceptance marker missing')
 const evidence=jsonl(dir,'relay-evidence.jsonl'),decisions=jsonl(dir,'relay-decisions.jsonl'),requests=jsonl(dir,'gateway.jsonl'),responses=jsonl(dir,'gateway-responses.jsonl')
 const db=new Database(join(dir,'wechat-cc.db'),{readonly:true})
 try{
  const tasks=db.query("SELECT id,title,state FROM matters WHERE kind='task' ORDER BY created_at").all()
  const turns=db.query('SELECT * FROM matter_turns ORDER BY started_at,seq').all()
  const agents=db.query('SELECT * FROM matter_agents ORDER BY matter_id,position').all()
  const messages=db.query("SELECT matter_id,turn_id,kind,payload_json,created_at FROM matter_items WHERE kind IN ('agent_message','system') ORDER BY created_at,cursor").all().map((r:any)=>({...r,payload:JSON.parse(r.payload_json),payload_json:undefined}))
  const toolErrors:any[]=[]
  for(const r of db.query('SELECT messages_json FROM openai_chat_sessions').all() as any[]){
   for(const m of JSON.parse(r.messages_json))if(m.role==='tool'&&Array.isArray(m.content))for(const item of m.content)if(['matter_plan','matter_handoff'].includes(item.toolName))toolErrors.push(item)
  }
  const metrics=evidence.filter(r=>r.kind==='result').map(r=>{
   const start=r.value.requestStart,end=r.value.requestEnd,selected=requests.slice(start,end),ids=new Set(selected.map(q=>q.id)),usage=responses.filter(s=>ids.has(s.responseOf))
   return {...r.value,requests:selected.length,reportedOutputTokens:usage.reduce((n,s)=>n+(s.usage?.completion_tokens??s.usage?.output_tokens??0),0),missingResponses:selected.filter(q=>!usage.some(s=>s.responseOf===q.id)).length,responsesWithoutOutputUsage:usage.filter(s=>s.usage?.completion_tokens===undefined&&s.usage?.output_tokens===undefined).length,errors:selected.filter(s=>s.status!==200||s.transportError),models:Object.fromEntries([...new Set(selected.map(s=>s.model))].map(m=>[m,selected.filter(s=>s.model===m).length]))}
  })
  return {run,evidence,decisions,toolCalls:jsonl(dir,'relay-tool-calls.jsonl'),tasks,turns,agents,messages,toolErrors,metrics,requests,responses,cleanup:existsSync(join(dir,'stop-audit.json'))?JSON.parse(readFileSync(join(dir,'stop-audit.json'),'utf8')):null,observerFailure:readFileSync(join(dir,'daemon.log'),'utf8').includes('RELAY_OBSERVER_FAILURE')}
 }finally{db.close()}
})
const safe=JSON.stringify(result,null,2).replace(/\b[a-f0-9]{64}\b/g,'[HEX64]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi,'Bearer [REDACTED]')
writeFileSync(output,safe)
console.log(JSON.stringify({runs:result.length,tasks:result.reduce((n,r)=>n+r.tasks.length,0),decisions:result.reduce((n,r)=>n+r.decisions.length,0),observerFailure:result.some(r=>r.observerFailure)}))
