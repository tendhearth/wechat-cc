import { basename } from 'node:path'
import type { Db } from '../../lib/db'
import type { ContextInput } from '../../app/context-rotation'
import type { HandoffTurn } from '../../domain/provider-handoff'
import { inboundFallbackMessageId } from '../../lib/messages-store'
import { parseExtras } from '../app-reply'

type Row={id:string;direction:'in'|'out';text:string;ts:string;source:string;kind:string;extras:string|null;rowid:number}
/** Canonical messages, independent of provider transcripts and accounting source policy. */
export function contextHistory(db:Db){
  const rows=(chatId:string,current?:ContextInput)=>{
    const id=!current?'':current.at?current.id:inboundFallbackMessageId(current.userId??chatId,current.text??'')
    const filter="chat_id=? AND id!=? AND NOT (id LIKE 'app:%' AND id LIKE ?) AND source!='workbench'"
    const args:[string,string,string]=[chatId,id,current?`%:${current.at}:in`:'']
    const anchor=current?db.query<Row,typeof args>(`SELECT rowid,* FROM messages WHERE chat_id=? AND direction='in' AND (id=? OR (id LIKE 'app:%' AND id LIKE ?)) ORDER BY ts DESC,rowid DESC LIMIT 1`).get(...args):null
    // Later inbound rows can already be persisted while this turn waits for the chat mutex.
    // Outgoing remains unbounded: the preceding reply may be delivered after this inbound.
    const incoming=anchor?db.query<Row,[...typeof args,string,string,number]>(`SELECT rowid,* FROM messages WHERE ${filter} AND direction='in' AND (ts<? OR (ts=? AND rowid<?)) ORDER BY ts DESC,rowid DESC LIMIT 6`).all(...args,anchor.ts,anchor.ts,anchor.rowid)
      :db.query<Row,typeof args>(`SELECT rowid,* FROM messages WHERE ${filter} AND direction='in' ORDER BY ts DESC,rowid DESC LIMIT 6`).all(...args)
    const outgoing=db.query<Row,typeof args>(`SELECT rowid,* FROM messages WHERE ${filter} AND direction='out' ORDER BY ts DESC,rowid DESC LIMIT 129`).all(...args)
    const oldest=incoming.at(-1)
    return [...incoming,...outgoing.filter(r=>!oldest||r.ts>oldest.ts||(r.ts===oldest.ts&&r.rowid>oldest.rowid))].sort((a,b)=>a.ts.localeCompare(b.ts)||a.rowid-b.rowid)
  }
  const render=(r:Row):HandoffTurn=>{
    const attachments=parseExtras(r.extras)?.attachments??[]
    const files=attachments.map(a=>a.kind==='file'?`[文件/图片：${basename(a.name)}]`:a.kind==='sticker'?`[贴纸：${a.label}]`:`[语音：${a.text}]`)
    return {dir:r.direction,ts:r.ts,source:r.source,text:[r.text,...files,...(!r.text&&!files.length?[`[${r.kind}]`]:[])].filter(Boolean).join('\n')}
  }
  return {
    latestTs(chatId:string,current?:ContextInput){return rows(chatId,current).filter(r=>!r.source.startsWith('speech:')).at(-1)?.ts??null},
    recent(chatId:string,current?:ContextInput){
      const history=rows(chatId,current),outgoing=history.filter(r=>r.direction==='out')
      const dropped=outgoing.length>128?outgoing[0]:undefined
      const recent=history.filter(r=>r!==dropped).map(render)
      if(dropped)recent.unshift({dir:'out',text:'',ts:dropped.ts,omitted:true})
      const toolRows=db.query<{payload:string;status:string;ts:number},[string]>(`SELECT i.payload_json AS payload,t.status,t.ended_at AS ts FROM matter_items i JOIN matter_turns t ON t.id=i.turn_id WHERE i.kind='tool_call' AND t.id=(SELECT t.id FROM matter_turns t JOIN matters m ON m.id=t.matter_id WHERE m.kind='chat' AND m.owner_chat_id=? AND t.ended_at IS NOT NULL ORDER BY t.ended_at DESC,t.cursor DESC LIMIT 1) ORDER BY i.seq LIMIT 16`).all(chatId)
      for(const r of toolRows){
        try{
          const p=JSON.parse(r.payload) as {tool?:string;activity?:{status?:string;detail?:string}}
          if(p.tool)recent.push({dir:'out',ts:new Date(r.ts).toISOString(),text:`[工具 ${p.tool}：${p.activity?.status??`已调用；该轮 ${r.status}，结果未记录`}]`})
        }catch{/* corrupt optional metadata */}
      }
      return recent
    },
    proactive(chatId:string,current?:ContextInput){
      const history=rows(chatId,current),last=history.filter(r=>r.direction==='in').at(-1)
      return history.filter(r=>r.direction==='out'&&r.source.startsWith('speech:')&&(!last||r.ts>last.ts||(r.ts===last.ts&&r.rowid>last.rowid))).map(r=>`[${r.ts}] ${render(r).text}`)
    },
  }
}
