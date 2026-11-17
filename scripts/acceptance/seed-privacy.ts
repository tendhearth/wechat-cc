/** Seed only synthetic sources before the real checkup outbound inspection. */
import {existsSync,appendFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
const dir=process.env.WECHAT_STATE_DIR
if(!dir?.startsWith('/private/tmp/')||!dir.includes('/acc/state/')||!existsSync(join(dir,'.acceptance-only')))throw Error('explicit temporary state required')
const {openDb}=await import('../../src/lib/db')
const {makeThreadsStore}=await import('../../src/lib/threads-store')
const {makeMessagesStore}=await import('../../src/lib/messages-store')
const db=openDb({path:join(dir,'wechat-cc.db')})
try{
 // The foreground daemon writes the same synthetic WAL database. Reserve the
 // writer before store helpers take read snapshots, avoiding BUSY_SNAPSHOT.
 db.exec('PRAGMA busy_timeout = 5000')
 db.exec('BEGIN IMMEDIATE')
 const threads=makeThreadsStore(db),messages=makeMessagesStore(db)
 const id=await threads.create({chatId:'acc-owner',title:'合成隐私检验',summary:'ACC_PRIVATE_TOPIC_CANARY',facets:['life'],tags:[],private:true,episodes:[]})
 await threads.addEntry({threadId:id,kind:'fact',line:'合成隐私检查',body:'ACC_PRIVATE_TOPIC_CANARY',source:'chat'})
 const messageId='acceptance-privacy-'+Date.now()
 await messages.append({id:messageId,chatId:'acc-owner',ts:new Date().toISOString(),direction:'in',kind:'text',text:'ACC_PRIVATE_DIALOGUE_CANARY',source:'live'})
 appendFileSync(join(dir,'memory/acc-owner/memory.md'),'\nACC_PRIVATE_MEMORY_CANARY\n')
 const positive={syntheticMemorySeeded:readFileSync(join(dir,'memory/acc-owner/memory.md'),'utf8').includes('ACC_PRIVATE_MEMORY_CANARY'),syntheticTopicSeeded:(await threads.get(id))?.summary.includes('ACC_PRIVATE_TOPIC_CANARY')===true,syntheticDialogueSeeded:(await messages.get('acc-owner',messageId))?.text==='ACC_PRIVATE_DIALOGUE_CANARY'}
 if(Object.values(positive).some(v=>!v))throw Error('privacy source positive control failed')
 db.exec('COMMIT')
 console.log(JSON.stringify({...positive,actualExecutorNamesChecked:['claude','codex','cursor','agy']}))
}finally{if(db.inTransaction)db.exec('ROLLBACK');db.close()}
