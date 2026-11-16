import type {Db} from '../../lib/db'
import {readCliSession} from '../../adapters/store/cli-session-store'
/** Resolve before approval and again at execution. Never choose the newest prefix match. */
export function resolveTerminalParticipation(db:Db,action:'attach'|'detach',input:unknown,owner:string){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('invalid_request')
  const b=input as Record<string,unknown>
  const allowed=action==='attach'?['sessionId','code','matter']:['participationId','matter']
  if(Object.keys(b).some(k=>!allowed.includes(k))||Object.values(b).some(v=>typeof v!=='string'||!v.trim()))throw Error('invalid_request')
  let sid:string,matter:string,id:string|undefined
  if(action==='attach'){
    if(typeof b.matter!=='string'||! /^[a-f0-9]{8}$/.test(b.matter)||!!b.sessionId===!!b.code)throw Error('invalid_request')
    matter=b.matter
    if(b.code){
      const code=b.code as string
      if(!/^[a-zA-Z0-9-]{4,64}$/.test(code))throw Error('invalid_request')
      const matches=db.query<{sessionId:string;cwd:string},[string,string]>('SELECT session_id AS sessionId,cwd FROM cli_sessions WHERE substr(session_id,1,length(?))=?').all(code,code)
      if(matches.length!==1)throw Error(matches.length?'短码有歧义，请问主人选哪条：'+matches.map(s=>`${s.sessionId} · ${s.cwd}`).join('；'):'terminal_session_unavailable')
      sid=matches[0]!.sessionId
    }else sid=b.sessionId as string
  }else{
    if(!!b.participationId===!!b.matter)throw Error('invalid_request')
    const row=b.participationId?db.query<{id:string;matter:string;sid:string},[string]>('SELECT id,matter_id AS matter,session_id AS sid FROM terminal_participations WHERE id=? AND detached_at IS NULL').get(b.participationId as string):db.query<{id:string;matter:string;sid:string},[string]>('SELECT id,matter_id AS matter,session_id AS sid FROM terminal_participations WHERE matter_id=? AND detached_at IS NULL').get(b.matter as string)
    if(!row)throw Error('terminal_participation_unavailable')
    id=row.id;matter=row.matter;sid=row.sid
  }
  const target=db.query<{title:string},[string,string]>('SELECT title FROM matters WHERE id=? AND owner_chat_id=?').get(matter,owner)
  const session=readCliSession(db,sid)
  if(!target||!session)throw Error('terminal_target_unavailable')
  return {body:action==='attach'?{sessionId:sid,matter}:{participationId:id!},code:sid.slice(0,6),cwd:session.cwd,title:target.title}
}
