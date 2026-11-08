import type { Db } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'

/** A consultation is an owner-initiated act, not a workbench task id. */
export function makeOwnerDelegationRecorder(d:{db:Db;ownerChatId():string|null;name(peer:string):string}) {
  const matters=makeMatterStore(d.db),log=makeMatterLog(d.db),messages=makeMessagesStore(d.db)
  return (callerChatId:string|undefined,peer:string,prompt:string,topicIds:readonly string[]=[]) => {
    const owner=d.ownerChatId()
    if(!owner||callerChatId!==owner)return null
    const {matter,turn}=d.db.transaction(()=>{
      const matter=matters.create({kind:'act',initiator:'owner',ownerChatId:owner,title:`${d.name(peer)} · ${prompt.slice(0,120)}`})
      const messageId=`delegate:${matter.id}`
      messages.appendSync!({id:messageId,chatId:owner,ts:new Date().toISOString(),direction:'out',kind:'text',text:`${d.name(peer)}：${prompt}`,source:'workbench'})
      d.db.query('INSERT INTO conversation_work_references VALUES(?,?,?)').run(owner,matter.id,messageId)
      for(const topic of topicIds)if(d.db.query('SELECT 1 FROM threads WHERE id=? AND chat_id=?').get(topic,owner))d.db.query('INSERT OR IGNORE INTO matter_topics(matter_id,thread_id,attached_ts) VALUES(?,?,?)').run(matter.id,topic,new Date().toISOString())
      const turn=log.startTurn({matterId:matter.id,executor:peer,policy:{who:'delegate'}})
      log.writeItem({matterId:matter.id,turnId:turn.id,kind:'user_message',status:'completed',key:`delegate:${matter.id}:prompt`,messageId,payload:{text:prompt}})
      return {matter,turn}
    })()
    return (result:{ok:true;response:string}|{ok:false;reason:string}) => d.db.transaction(()=>{
      // The callback may be observed twice; MatterLog keys and finished turn status preserve identity.
      if(log.turns(matter.id).find(t=>t.id===turn.id)?.status!=='running')return
      log.writeItem({matterId:matter.id,turnId:turn.id,kind:result.ok?'agent_message':'error',status:result.ok?'completed':'failed',key:`delegate:${matter.id}:result`,payload:{text:result.ok?result.response:result.reason}})
      log.finishTurn(turn.id,{status:result.ok?'completed':'failed',matterState:result.ok?'done':'failed'})
    })()
  }
}
