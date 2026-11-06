import { createHash } from 'node:crypto'
import type z from 'zod'
import type { ConversationWindowQuery } from '../../../packages/protocol/src/owner-conversation'
import type { Db } from '../../lib/db'
import { makeMessagesStore, type MessageRecord } from '../../lib/messages-store'
import { ownerChatReadingEvent } from './owner-chat-reading'

const conversationScope=(owner:string)=>createHash('sha256').update(owner).digest('hex').slice(0,24)

export type WindowInput = z.infer<typeof ConversationWindowQuery>
/** Timestamp + id is a total order even for split replies persisted in the same millisecond. */
export function makeOwnerConversationReader(db: Db, inboxDir?: string) {
  const messages = makeMessagesStore(db)
  return async (owner: string, p: WindowInput) => {
    const id = p.anchor ?? p.before ?? p.after
    const pivot = id ? await messages.get(owner, id) : null
    if (id && !pivot) return null
    const literal = p.q?.replace(/[\\%_]/g, c => `\\${c}`)
    const read = (direction: 'before' | 'after', limit: number, at = pivot): {id:string}[] => {
      const op = direction === 'before' ? '<' : '>'
      const order = direction === 'before' ? 'DESC' : 'ASC'
      const args: (string | number)[] = [owner]
      let where = 'chat_id=?'
      if (at) { where += ` AND (ts,id) ${op} (?,?)`; args.push(at.ts, at.id) }
      if (literal) { where += " AND text LIKE ? ESCAPE '\\'"; args.push(`%${literal}%`) }
      args.push(limit)
      const rows = db.query<{ id: string }, (string | number)[]>(`SELECT id FROM messages WHERE ${where} ORDER BY ts ${order},id ${order} LIMIT ?`).all(...args)
      // Already owner scoped; use the store's canonical DTO conversion.
      return rows
    }
    let ids: string[]
    if (p.anchor) ids = [...read('before', Math.floor(p.limit / 2)).reverse().map(r => r.id), pivot!.id, ...read('after', Math.floor(p.limit / 2)).map(r => r.id)]
    else if (p.after) ids = read('after', p.limit).map(r => r.id)
    else ids = read('before', p.limit).reverse().map(r => r.id)
    const rows = (await Promise.all(ids.map(id => messages.get(owner, id)))).filter((r): r is MessageRecord => r !== null)
    const first = rows[0], last = rows.at(-1)
    return { scope:conversationScope(owner),messages: rows.map(row => {const event=ownerChatReadingEvent(row,inboxDir);return {...event,text:event.text.slice(0,4000),...(event.text.length>4000?{truncated:true}:{})}}), anchor: p.anchor ?? null,
      earlier: first && read('before', 1, first).length ? first.id : null,
      later: last && read('after', 1, last).length ? last.id : null }
  }
}

/** Durable origins and MatterLog ids are the identity; clients never manufacture completion entries. */
export function ownerConversationWork(db: Db, owner: string, p:{cursor?:string;limit?:number}={}) {
  const scope=conversationScope(owner)
  let before:{at:number;id:string}|null=null
  if(p.cursor){
    try{const [bound,at,id]=JSON.parse(Buffer.from(p.cursor,'base64url').toString());if(bound!==scope||!Number.isSafeInteger(at)||typeof id!=='string'||id.length>256)throw Error();before={at,id}}catch{throw Error('invalid_cursor')}
  }
  const limit=Math.max(1,Math.min(50,p.limit??30))
  type Row={type:'reference'|'result';id:string;matterId:string;messageId:string;kind:'task'|'terminal'|'act';title:string;createdAt:number;turnId:string|null;text:string|null}
  const rows=db.query<Row,(string|number)[]>(`WITH timeline AS (
    SELECT 'reference' AS type,'work:'||m.id AS id,m.id AS matterId,COALESCE(m.origin_message_id,r.message_id) AS messageId,m.kind,substr(m.title,1,160) AS title,m.created_at AS createdAt,NULL AS turnId
    FROM matters m LEFT JOIN conversation_work_references r ON r.chat_id=m.owner_chat_id AND r.matter_id=m.id
    JOIN messages msg ON msg.id=COALESCE(m.origin_message_id,r.message_id) AND msg.chat_id=m.owner_chat_id
    WHERE m.owner_chat_id=? AND m.kind IN ('task','terminal','act')
    UNION ALL
    SELECT 'result','result:'||t.id,m.id,COALESCE(m.origin_message_id,r.message_id),m.kind,substr(m.title,1,160),t.ended_at,t.id
    FROM matter_turns t JOIN matters m ON m.id=t.matter_id LEFT JOIN conversation_work_references r ON r.chat_id=m.owner_chat_id AND r.matter_id=m.id
    JOIN messages msg ON msg.id=COALESCE(m.origin_message_id,r.message_id) AND msg.chat_id=m.owner_chat_id
    WHERE m.owner_chat_id=? AND m.kind IN ('task','terminal','act') AND t.status='completed'
  ),page AS MATERIALIZED (SELECT * FROM timeline ${before?'WHERE (createdAt,id)<(?,?)':''} ORDER BY createdAt DESC,id DESC LIMIT ?)
  SELECT page.*,CASE WHEN type='result' THEN COALESCE((SELECT json_extract(i.payload_json,'$.text') FROM matter_items i WHERE (i.turn_id=page.turnId OR (i.turn_id IS NULL AND i.matter_id=page.matterId
      AND json_extract(i.payload_json,'$.runId')=(SELECT run_id FROM matter_turns WHERE id=page.turnId)
      AND (SELECT COUNT(*) FROM matter_turns old WHERE old.matter_id=page.matterId AND old.run_id=json_extract(i.payload_json,'$.runId'))=1)) AND i.kind='agent_message' AND i.status='completed' ORDER BY i.seq DESC LIMIT 1),'') ELSE NULL END AS text FROM page ORDER BY createdAt DESC,id DESC`)
    .all(owner,owner,...(before?[before.at,before.id]:[]),limit+1)
  const page=rows.slice(0,limit),last=page.at(-1)
  return {scope,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify([scope,last.createdAt,last.id])).toString('base64url'):null,
    references:page.filter(r=>r.type==='reference').map(({id,matterId,messageId,kind,title,createdAt})=>({id,matterId,messageId,kind,title,createdAt,detailRoute:`/v1/matter?id=${encodeURIComponent(matterId)}`})),
    results:page.filter(r=>r.type==='result'&&!!r.text).map(({id,matterId,messageId,turnId,text,createdAt})=>({id,matterId,messageId,turnId:turnId!,text:(text??'').slice(0,16000),...((text?.length??0)>16000?{truncated:true}:{}),createdAt}))}
}

export function ownerConversationEvents(db: Db, owner: string, since: number, limit=50) {
  const running=db.query<{turnId:string;runId:string|null},[string]>(`SELECT t.id AS turnId,t.run_id AS runId FROM matter_turns t JOIN matters m ON m.id=t.matter_id WHERE m.kind='chat' AND m.owner_chat_id=? AND t.status='running' ORDER BY t.started_at DESC LIMIT 1`).get(owner)
  const events=db.query<{id:number;turnId:string|null;cursor:number;kind:string;text:string;createdAt:number},[string,number,number,number]>(`SELECT i.id,i.turn_id AS turnId,i.cursor,i.kind,COALESCE(json_extract(i.payload_json,'$.text'),'') AS text,i.created_at AS createdAt FROM matter_items i JOIN matters m ON m.id=i.matter_id WHERE m.kind='chat' AND m.owner_chat_id=? AND i.cursor>? AND (? > 0 OR i.turn_id IN (SELECT id FROM matter_turns WHERE status='running')) ORDER BY i.cursor LIMIT ?`).all(owner,since,since,limit)
  return {scope:conversationScope(owner),running:running??null,events:events.map(e=>({...e,text:e.text.slice(0,16000),...(e.text.length>16000?{truncated:true}:{}),id:`item:${e.id}`})),cursor:events.at(-1)?.cursor??since}
}

/** Compare the exact observed turn synchronously before signalling the coordinator. */
export function stopOwnerConversation(db:Db,owner:string,turnId:string,cancel:(owner:string)=>boolean) {
  if(!db.query(`SELECT t.id FROM matter_turns t JOIN matters m ON m.id=t.matter_id WHERE m.kind='chat' AND m.owner_chat_id=? AND t.id=? AND t.status='running'`).get(owner,turnId))return false
  return cancel(owner)
}
