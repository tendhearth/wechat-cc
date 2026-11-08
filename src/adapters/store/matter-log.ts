import { log } from '../../lib/log'
import { makeTopicBubbles } from '../../lib/topic-bubbles'
import {randomBytes} from 'node:crypto'
import type {Db} from '../../lib/db'
import type {TurnUsage} from '../../domain/turn-usage'
import {matterFeed} from './matter-feed'
import type {FinishTurn,MatterItem,MatterItemKind,MatterItemStatus,MatterLog,MatterOutcome,MatterState,MatterTurn,MatterTurnStatus,StartTurn,WriteItem} from '../../ports/matters'

/**
 * matter-log.ts —— 一件事的轮(matter_turns)与步(matter_items)唯一的写口(v92,设计稿 2026-10-31 §3.1、M1)。
 * 每次调用一个事务:写行、取下一个全库游标、按轮与「等你」的步重推这件事的统一状态、刷新 updated_at。
 */
const ITEM_KINDS=new Set<string>(['user_message','agent_message','tool_call','permission','question','artifact','delivery','system','error'])
const ITEM_STATUSES=new Set<string>(['started','completed','failed'])
const TURN_ENDINGS=new Set<string>(['completed','failed','cancelled','interrupted'])
const OUTCOMES=new Set<string>(['open','done','failed','cancelled'])
const TEXT_MAX=40_000

type TurnRow={id:string;matter_id:string;seq:number;run_id:string|null;executor:string;model:string|null;native_session_id:string|null;status:MatterTurnStatus;error_code:string|null;usage_json:string|null;policy_json:string|null;started_at:number;ended_at:number|null;cursor:number}
type ItemRow={id:number;matter_id:string;turn_id:string|null;seq:number;kind:MatterItemKind;status:MatterItemStatus;item_key:string|null;message_id:string|null;payload_json:string;created_at:number;updated_at:number;cursor:number}
const toTurn=(r:TurnRow):MatterTurn=>({id:r.id,matterId:r.matter_id,seq:r.seq,runId:r.run_id,executor:r.executor,model:r.model,nativeSessionId:r.native_session_id,status:r.status,errorCode:r.error_code,
  usage:r.usage_json?JSON.parse(r.usage_json) as TurnUsage:null,policy:r.policy_json?JSON.parse(r.policy_json) as Record<string,unknown>:null,startedAt:r.started_at,endedAt:r.ended_at,cursor:r.cursor})
const toItem=(r:ItemRow):MatterItem=>({id:r.id,matterId:r.matter_id,turnId:r.turn_id,seq:r.seq,kind:r.kind,status:r.status,key:r.item_key,messageId:r.message_id,payload:JSON.parse(r.payload_json) as Record<string,unknown>,createdAt:r.created_at,updatedAt:r.updated_at,cursor:r.cursor})

export function makeMatterLog(db:Db,now:()=>number=()=>Date.now()):MatterLog {
  const feed=matterFeed(db)
  /**
   * 取下一个全库游标,同时记成这件事最后一次有动静的游标(matters.cursor,v96),交给变化通知(P1a)。
   * 通知要等调用方的同步代码跑完、确认真落了库才发(matter-feed.ts),所以在外层事务里调也安全。
   */
  const nextCursor=(matterId:string)=>{
    const value=(db.query<{value:number},[]>('UPDATE matter_log_cursor SET value=value+1 WHERE id=1 RETURNING value').get()!).value
    db.query('UPDATE matters SET cursor=MAX(cursor,?) WHERE id=?').run(value,matterId)
    feed.noted(matterId,value)
    return value
  }
  const matterRow=(id:string)=>db.query<{state:MatterState;archived_at:number|null},[string]>('SELECT state,archived_at FROM matters WHERE id=?').get(id)
  const requireMatter=(id:string)=>{const m=matterRow(id);if(!m)throw new Error('matter_not_found');return m}
  const turnRow=(id:string)=>db.query<TurnRow,[string]>('SELECT * FROM matter_turns WHERE id=?').get(id)
  const itemRow=(id:number)=>db.query<ItemRow,[number]>('SELECT * FROM matter_items WHERE id=?').get(id)!
  const running=(matterId:string)=>db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM matter_turns WHERE matter_id=? AND status='running'").get(matterId)!.n
  /**
   * 统一状态只在这里推:开着的权限卡 / 提问 ⇒ waiting;否则有轮在跑 ⇒ working;否则(只在轮开始 / 结束时,`turnEdge`)
   * working / waiting 落回 `settled`(轮结束时给的结局,默认 open),其余结局保持。普通的一步不把 working 落回去 ——
   * 轮还没开始记的那段(一起做 M2b 之前)working 由旧路径维护,写一步不能把正在跑的事改成 open(Codex 评审 P2)。
   * 每次写都刷新 updated_at —— 这件事最后一次有动静的时间。
   */
  const settle=(matterId:string,settled:MatterOutcome='open',turnEdge=true)=>{
    const waiting=db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM matter_items WHERE matter_id=? AND kind IN ('permission','question') AND status='started'").get(matterId)!.n
    const current=requireMatter(matterId).state
    const next:MatterState=waiting?'waiting'
      :running(matterId)?'working'
      :current==='waiting'?(turnEdge?settled:'working')
      :current==='working'&&turnEdge?settled
      :current
    db.query('UPDATE matters SET state=?,updated_at=? WHERE id=?').run(next,now(),matterId)
    try { makeTopicBubbles(db).matterChanged(matterId, next !== current) } catch { log('TOPICS', `bubble update failed matter=${matterId}`) }
  }

  const startTurn=db.transaction((input:StartTurn):MatterTurn=>{
    requireMatter(input.matterId)
    if(typeof input.executor!=='string'||!input.executor.trim())throw new Error('invalid_turn_executor')
    const id=randomBytes(8).toString('hex')
    const seq=db.query<{n:number},[string]>('SELECT COALESCE(MAX(seq),0)+1 AS n FROM matter_turns WHERE matter_id=?').get(input.matterId)!.n
    db.query('INSERT INTO matter_turns(id,matter_id,seq,run_id,executor,model,native_session_id,status,policy_json,started_at,cursor) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,input.matterId,seq,input.runId??null,input.executor,input.model??null,input.nativeSessionId??null,'running',input.policy?JSON.stringify(input.policy):null,input.startedAt??now(),nextCursor(input.matterId))
    settle(input.matterId)
    return toTurn(turnRow(id)!)
  })

  const finishTurn=db.transaction((turnId:string,input:FinishTurn):MatterTurn=>{
    const turn=turnRow(turnId);if(!turn)throw new Error('turn_not_found')
    if(turn.status!=='running')return toTurn(turn)
    if(!TURN_ENDINGS.has(input.status))throw new Error('invalid_turn_status')
    if(input.matterState!==undefined&&!OUTCOMES.has(input.matterState))throw new Error('invalid_matter_state')
    const ts=now()
    // 轮结束时还开着的步(转圈的工具、没人答的卡)一律记失败:不留僵尸,也不让一张过期的卡把这件事一直挂在「等你」。
    for(const open of db.query<{id:number},[string]>("SELECT id FROM matter_items WHERE turn_id=? AND status='started' ORDER BY seq").all(turnId))
      db.query("UPDATE matter_items SET status='failed',updated_at=?,cursor=? WHERE id=?").run(ts,nextCursor(turn.matter_id),open.id)
    db.query('UPDATE matter_turns SET status=?,error_code=?,usage_json=?,native_session_id=COALESCE(?,native_session_id),ended_at=?,cursor=? WHERE id=?')
      .run(input.status,input.errorCode??null,input.usage?JSON.stringify(input.usage):null,input.nativeSessionId??null,input.endedAt??ts,nextCursor(turn.matter_id),turnId)
    settle(turn.matter_id,input.matterState)
    // 还有别的轮在跑 ⇒ 上面 settle 留在 working / waiting,matterState 不生效;没有 ⇒ 结局按 matterState 落定。
    if(!running(turn.matter_id)&&input.matterState)db.query('UPDATE matters SET state=? WHERE id=?').run(input.matterState,turn.matter_id)
    return toTurn(turnRow(turnId)!)
  })

  const updateTurn=db.transaction((turnId:string,patch:{model?:string|null;policy?:Record<string,unknown>|null}):MatterTurn=>{
    const turn=turnRow(turnId);if(!turn)throw new Error('turn_not_found')
    const model=patch.model===undefined?turn.model:patch.model
    const policy=patch.policy===undefined?turn.policy_json:patch.policy?JSON.stringify(patch.policy):null
    db.query('UPDATE matter_turns SET model=?,policy_json=?,cursor=? WHERE id=?').run(model,policy,nextCursor(turn.matter_id),turnId)
    return toTurn(turnRow(turnId)!)
  })

  const writeItem=db.transaction((input:WriteItem):MatterItem=>{
    if(!ITEM_KINDS.has(input.kind))throw new Error('invalid_item_kind')
    if(!ITEM_STATUSES.has(input.status))throw new Error('invalid_item_status')
    requireMatter(input.matterId)
    let status=input.status
    if(input.turnId!=null){
      const turn=turnRow(input.turnId);if(!turn||turn.matter_id!==input.matterId)throw new Error('turn_not_in_matter')
      // 轮已经结束 ⇒ 迟到的 started 记成 failed(和 finishTurn 收尾时一样),别让一张过期的卡把这件事拉回「等你」。
      if(turn.status!=='running'&&status==='started')status='failed'
    }
    const key=input.key??null,ts=now()
    const previous=key===null?null:db.query<ItemRow,[string,string]>('SELECT * FROM matter_items WHERE matter_id=? AND item_key=?').get(input.matterId,key)
    if(previous&&previous.kind!==input.kind)throw new Error('item_kind_mismatch')
    // 做完 / 失败的步不会被迟到的 started 倒回去(重复的开始事件可能在完成之后才到)。
    if(previous&&previous.status!=='started'&&status==='started')return toItem(previous)
    const base=input.payload??(previous?JSON.parse(previous.payload_json) as Record<string,unknown>:{})
    const payload=input.appendText===undefined?base:{...base,text:(String(base.text??'')+input.appendText).slice(0,TEXT_MAX)}
    let id:number
    if(previous){
      db.query('UPDATE matter_items SET status=?,turn_id=COALESCE(?,turn_id),message_id=COALESCE(?,message_id),payload_json=?,updated_at=?,cursor=? WHERE id=?')
        .run(status,input.turnId??null,input.messageId??null,JSON.stringify(payload),ts,nextCursor(input.matterId),previous.id)
      id=previous.id
    } else {
      const seq=db.query<{n:number},[string]>('SELECT COALESCE(MAX(seq),0)+1 AS n FROM matter_items WHERE matter_id=?').get(input.matterId)!.n
      id=Number(db.query('INSERT INTO matter_items(matter_id,turn_id,seq,kind,status,item_key,message_id,payload_json,created_at,updated_at,cursor) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(input.matterId,input.turnId??null,seq,input.kind,status,key,input.messageId??null,JSON.stringify(payload),ts,ts,nextCursor(input.matterId)).lastInsertRowid)
    }
    settle(input.matterId,'open',false)
    return toItem(itemRow(id))
  })

  const setState=db.transaction((matterId:string,state:MatterOutcome)=>{
    if(!OUTCOMES.has(state))throw new Error('invalid_matter_state')
    requireMatter(matterId)
    if(running(matterId))throw new Error('matter_has_running_turn')
    db.query('UPDATE matters SET state=?,updated_at=? WHERE id=?').run(state,now(),matterId)
  })

  const touch=db.transaction((matterId:string):number=>{requireMatter(matterId);return nextCursor(matterId)})

  return {
    startTurn:input=>startTurn(input),
    finishTurn:(turnId,input)=>finishTurn(turnId,input),
    updateTurn:(turnId,patch)=>updateTurn(turnId,patch),
    touch:matterId=>touch(matterId),
    writeItem:input=>writeItem(input),
    setState:(matterId,state)=>setState(matterId,state),
    state(matterId){const m=matterRow(matterId);return m?{state:m.state,archivedAt:m.archived_at}:null},
    item(matterId,key){const r=db.query<ItemRow,[string,string]>('SELECT * FROM matter_items WHERE matter_id=? AND item_key=?').get(matterId,key);return r?toItem(r):null},
    turns:matterId=>db.query<TurnRow,[string]>('SELECT * FROM matter_turns WHERE matter_id=? ORDER BY seq').all(matterId).map(toTurn),
    items:(matterId,opts={})=>(opts.afterCursor===undefined
      ?db.query<ItemRow,[string]>('SELECT * FROM matter_items WHERE matter_id=? ORDER BY seq').all(matterId)
      :db.query<ItemRow,[string,number]>('SELECT * FROM matter_items WHERE matter_id=? AND cursor>? ORDER BY seq').all(matterId,opts.afterCursor)).map(toItem),
  }
}
