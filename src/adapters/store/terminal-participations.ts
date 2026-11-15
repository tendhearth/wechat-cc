import {canonicalClaimPath,pathsConflict} from '../../lib/claim-paths'
import {hostname} from 'node:os'
import {randomUUID} from '../../lib/random'
import type {Db} from '../../lib/db'
import type {TerminalParticipation} from '../../ports/matters'
import {readCliSession} from './cli-session-store'

const COLS='id,matter_id AS matterId,session_id AS sessionId,source_matter_id AS sourceMatterId,run_id AS runId,generation,author,attached_at AS attachedAt,detached_at AS detachedAt,detach_reason AS detachReason'
export const terminalParticipationKey=(p:TerminalParticipation)=>`terminal-participation/${Buffer.from(JSON.stringify([p.id,p.sessionId,p.matterId,p.generation])).toString('base64url')}`
export function makeTerminalParticipations(db:Db,now=()=>Date.now(),machine=hostname()){
  const list=(matterId:string)=>db.query<TerminalParticipation,[string]>(`SELECT ${COLS} FROM terminal_participations WHERE matter_id=? ORDER BY attached_at,id`).all(matterId)
  function eligible(sessionId:string){
    // Exact lookup only: never authorize by the registry's fuzzy prefix resolver.
    const s=readCliSession(db,sessionId)
    if(!s||sessionId.length<=6||s.origin_agent||s.machine!==machine||s.status==='ended'||now()-s.last_event_at>30*60_000)throw Error('terminal_session_unavailable')
    if(db.query("SELECT matter_id FROM matter_bindings WHERE surface='cli' AND surface_key=?").all(sessionId).length!==1)throw Error('terminal_session_unavailable')
    const source=db.query<{id:string},[string]>("SELECT m.id FROM matter_bindings b JOIN matters m ON m.id=b.matter_id WHERE b.surface='cli' AND b.surface_key=? AND m.kind='terminal' AND m.archived_at IS NULL").get(sessionId)
    if(!source)throw Error('terminal_session_unavailable')
    return {s,source}
  }
  const active=(id:string)=>db.query('SELECT 1 FROM terminal_participations WHERE matter_id=? AND detached_at IS NULL').get(id)!==null
  return {
    list,active,
    endSession(sessionId:string){db.query("UPDATE terminal_participations SET detached_at=?,detach_reason='session_end' WHERE session_id=? AND detached_at IS NULL").run(now(),sessionId)},
    conflicts(path:string){return db.query<{sessionId:string},[]>('SELECT session_id AS sessionId FROM terminal_participations WHERE detached_at IS NULL').all().map(r=>readCliSession(db,r.sessionId)).some(s=>s!==null&&pathsConflict(canonicalClaimPath(path),canonicalClaimPath(s.cwd)))},
    restart(){db.query("UPDATE terminal_participations SET detached_at=?,detach_reason='restart' WHERE detached_at IS NULL").run(now())},
    detach(id:string,reason='owner'){return db.query('UPDATE terminal_participations SET detached_at=?,detach_reason=? WHERE id=? AND detached_at IS NULL').run(now(),reason,id).changes>0},
    attach(sessionId:string,matterId:string,owner:string){return db.transaction(()=>{
      const {s,source}=eligible(sessionId)
      const target=db.query<{owner:string|null;archived:number|null},[string]>('SELECT owner_chat_id AS owner,archived_at AS archived FROM matters WHERE id=?').get(matterId)
      if(!target||target.owner!==owner||target.archived!==null||source.id===matterId)throw Error('terminal_target_unavailable')
      if(db.query("SELECT 1 FROM workbench_tasks WHERE matter_id=? AND (status IN ('queued','running','cancelling') OR error='writer_not_closed')").get(matterId)||db.query("SELECT 1 FROM matter_plans WHERE matter_id=? AND state='approved'").get(matterId))throw Error('workbench_busy')
      if(active(matterId)||db.query('SELECT 1 FROM terminal_participations WHERE session_id=? AND detached_at IS NULL').get(sessionId))throw Error('terminal_already_attached')
      const generation=db.query<{n:number},[string]>('SELECT COALESCE(MAX(generation),0)+1 AS n FROM terminal_participations WHERE session_id=?').get(sessionId)!.n
      const p:TerminalParticipation={id:randomUUID(),matterId,sessionId,sourceMatterId:source.id,runId:randomUUID(),generation,author:`${s.source} · 终端 · ${sessionId.slice(0,6)}`,attachedAt:now(),detachedAt:null,detachReason:null}
      db.query('INSERT INTO terminal_participations(id,matter_id,session_id,source_matter_id,run_id,generation,author,attached_at) VALUES(?,?,?,?,?,?,?,?)').run(p.id,p.matterId,p.sessionId,p.sourceMatterId,p.runId,p.generation,p.author,p.attachedAt)
      return p
    })()},
    bound(key:string|undefined,requested?:string){
      if(!key?.startsWith('terminal-participation/'))throw Error('matter_ledger_forbidden')
      let tuple:unknown
      try{tuple=JSON.parse(Buffer.from(key.slice('terminal-participation/'.length),'base64url').toString())}catch{throw Error('matter_ledger_forbidden')}
      if(!Array.isArray(tuple)||tuple.length!==4||typeof tuple[0]!=='string')throw Error('matter_ledger_forbidden')
      const p=db.query<TerminalParticipation,[string]>(`SELECT ${COLS} FROM terminal_participations WHERE id=? AND detached_at IS NULL`).get(tuple[0])
      if(!p||terminalParticipationKey(p)!==key)throw Error('matter_ledger_forbidden')
      const {source}=eligible(p.sessionId)
      if(source.id!==p.sourceMatterId||!db.query('SELECT 1 FROM matters WHERE id=? AND archived_at IS NULL').get(p.matterId))throw Error('matter_ledger_forbidden')
      if(requested!==undefined&&requested!==p.matterId)throw Error('matter_scope_mismatch')
      return p
    },
  }
}
