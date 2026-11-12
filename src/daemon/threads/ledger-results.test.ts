import {expect,it} from 'vitest'
import {openTestDb} from '../../lib/db'
import {makeThreadsStore} from '../../lib/threads-store'
import {makeMatterLedger} from '../../adapters/store/matter-ledger'
import {makeMatterLog} from '../../adapters/store/matter-log'
import {makeMatterStore} from '../../adapters/store/matters-store'
import {readWorkResults} from './work-results'
import {makeMatterTopics} from './matter-topics'

it('two batons are one work result and one topic conclusion, including notes and artifact pointers',async()=>{
  const db=openTestDb()
  try{
    const matters=makeMatterStore(db),log=makeMatterLog(db),ledger=makeMatterLedger(db),threads=makeThreadsStore(db)
    const m=matters.create({kind:'task',title:'登录页',ownerChatId:'owner',projectPath:'/projects/login'})
    const topic=await threads.create({chatId:'owner',title:'登录页',summary:'',facets:['task'],tags:[],private:false,episodes:[]})
    db.query('INSERT INTO matter_topics VALUES(?,?,?,0)').run(m.id,topic,new Date().toISOString())
    for(const [run,executor,text]of [['r1','codex','图在 assets/dark.webp'],['r2','claude','已接进 LoginHero']] as const){
      ledger.start(m.id,run,executor,'登录页')
      const turn=log.startTurn({matterId:m.id,executor,runId:run})
      log.writeItem({matterId:m.id,turnId:turn.id,kind:'user_message',status:'completed',payload:{text:'做登录页'}})
      log.writeItem({matterId:m.id,turnId:turn.id,kind:'agent_message',status:'completed',payload:{text:`${executor} RAW_PROCESS`}})
      ledger.note(m.id,run,executor,text)
      if(run==='r1')ledger.note(m.id,run,executor,'长首棒备注'.repeat(180))
      ledger.artifact(m.id,run,executor,{workspace:'/projects/login',files:[run==='r1'?'assets/dark.webp':'LoginHero.tsx'],fileCount:1,commit:run})
      ledger.finish(m.id,run,'completed','')
      log.finishTurn(turn.id,{status:'completed',matterState:'done'})
    }
    const context={owner:'owner',machine:'local'},results=readWorkResults(db,0,context).results
    expect(results).toHaveLength(1)
    expect(results[0]!.result).toContain('codex')
    expect(results[0]!.result).toContain('LoginHero')
    expect(results[0]!.result).toContain('assets/dark.webp')
    expect(results[0]!.result).toContain('/projects/login')
    expect(results[0]!.result).not.toContain('RAW_PROCESS')
    const mt=makeMatterTopics({db,threads,ownerChatId:()=>'owner',log:()=>{}})
    expect(await mt.writeBack(m.id)).toBe(1)
    expect(await mt.writeBack(m.id)).toBe(0)
    expect((await threads.entries(topic)).filter(e=>e.matterId===m.id)).toHaveLength(1)
    expect(readWorkResults(db,0,context).results).toEqual([])
    // A late T1 result must not overwrite a later T3 baton or add a duplicate.
    await threads.addEntry({threadId:topic,kind:'conclusion',line:'new',body:'LATEST_LEDGER',source:'work',matterId:m.id,workCursor:results[0]!.cursor+10})
    await threads.addEntry({threadId:topic,kind:'conclusion',line:'old',body:'STALE_LEDGER',source:'work',matterId:m.id,workCursor:results[0]!.cursor})
    const entries=(await threads.entries(topic)).filter(e=>e.matterId===m.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.body).toBe('LATEST_LEDGER')
  }finally{db.close()}
})
