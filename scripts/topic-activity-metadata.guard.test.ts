/** Permission bodies are intentionally available only inside the original decision surface. */
import {makeMatterLedger} from '../src/adapters/store/matter-ledger'
import { expect,it } from 'vitest'
import { openTestDb } from '../src/lib/db'
import { makeThreadsStore } from '../src/lib/threads-store'
import { makeMatterStore } from '../src/adapters/store/matters-store'
import { makeMatterLog } from '../src/adapters/store/matter-log'
import { makeTerminalTurnLog } from '../src/adapters/store/terminal-turns'
import { readProjectsActivity } from '../src/features/memory/projects-activity'
import { projectActivities } from '../src/features/memory/project-activity'
import { resolveTopicRecall } from '../src/daemon/threads/recall'

it.each(['terminal','task'] as const)('%s approval body cannot propagate through topics or recall',async(kind)=>{
 const db=openTestDb()
 try{
  const path='/projects/metadata-guard',threads=makeThreadsStore(db),matters=makeMatterStore(db),log=makeMatterLog(db)
  const id=await threads.create({chatId:'owner',title:'metadata-guard',private:false,summary:'',facets:[],tags:[],episodes:[]})
  const secret='curl --token=FAKE_TOKEN_FOR_GUARD --password=ordinary-secret https://user:private-password@example.invalid\n- private-old\n+ private-new\nPRIVATE_OUTPUT'
  let matterId:string
  if(kind==='terminal'){
   const turns=makeTerminalTurnLog({db,log,matters})
   turns.event({session_id:'guard',source:'claude',cwd:path,kind:'prompt'},Date.now())
   turns.permissionAsked({session_id:'guard',source:'claude',cwd:path,tool_name:'Bash',summary:secret},Date.now())
   matterId=matters.findBySurface('cli','guard')!.id
  }else{
   matterId=matters.create({kind:'task',title:'guard',projectPath:path,ownerChatId:'owner'}).id
   log.startTurn({matterId,executor:'codex'})
   log.writeItem({matterId,kind:'permission',status:'started',payload:{tool:'apply_patch',description:secret,diff:secret,output:secret}})
  }
  if(kind==='task'){const ledger=makeMatterLedger(db);ledger.start(matterId,'metadata-run','codex','metadata plan');ledger.note(matterId,'metadata-run','codex','LEDGER_METADATA_PRIVATE_CANARY')}
  const activity=await projectActivities(db,'owner',undefined,async()=>({key:path+'/.git',roots:[path],names:['metadata-guard']}),kind==='task'?()=>({phase:'working',requestId:'p',requestKind:'permission',tool:'apply_patch',waitingFor:secret}):undefined)
  const session=activity.get(id)!.sessions.find(s=>s.id===matterId)!
  expect(session.latestStep).toBe(kind==='terminal'?'等你批准 · Bash':'等你批准 · apply_patch')
  const recall=await resolveTopicRecall('metadata-guard 那边怎么样了',[{id,title:'metadata-guard',aliases:[],tags:[],summary:'',lastActive:'',entries:[]}],{activity,bodies:false})
  expect(recall).not.toBeNull()
  const cross=await readProjectsActivity({db,owner:'owner',identify:async()=>({key:path+'/.git',roots:[path],names:['metadata-guard']})},{})
  expect(cross.projects).toHaveLength(1)
  for(const marker of ['LEDGER_METADATA_PRIVATE_CANARY','FAKE_TOKEN_FOR_GUARD','ordinary-secret','private-password','private-old','private-new','PRIVATE_OUTPUT']){
   expect(JSON.stringify(activity.get(id))).not.toContain(marker)
   expect(recall!.block).not.toContain(marker)
   expect(JSON.stringify(cross)).not.toContain(marker)
  }
 }finally{db.close()}
})
