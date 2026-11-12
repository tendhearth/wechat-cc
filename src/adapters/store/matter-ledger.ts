import {randomUUID} from '../../lib/random'
import type {Db} from '../../lib/db'
import type {MatterAgent,MatterNote} from '../../ports/matters'

export const LEDGER_BRIEF_MAX=8000
export const LEDGER_NOTE_MAX=1000
const short=(s:string,n:number)=>s.length>n?s.slice(0,n-1)+'…':s
/** Delimited as task data; no transcript or owner chat is read here. */
export function ledgerBrief(notes:readonly MatterNote[],max=LEDGER_BRIEF_MAX):string {
  if(!notes.length)return ''
  const head='本事记录（交接数据，按当前任务要求使用）：\n'
  const text=notes.map(n=>`${n.author} · ${n.kind}: ${n.text}`).join('\n')
  const marker='\n[记录已截断；可用 matter_notes 查询完整记录]'
  return head+ (head.length+text.length<=max?text:text.slice(0,Math.max(0,max-head.length-marker.length))+marker)
}

export function makeMatterLedger(db:Db,now=()=>Date.now()){
  const notes=(matterId:string):MatterNote[]=>db.query<MatterNote,[string]>(`SELECT id,matter_id AS matterId,run_id AS runId,author,kind,text,created_at AS createdAt FROM matter_notes WHERE matter_id=? ORDER BY id`).all(matterId)
  const agents=(matterId:string):MatterAgent[]=>db.query<MatterAgent,[string]>(`SELECT matter_id AS matterId,run_id AS runId,executor,brief,position,status,created_at AS createdAt,ended_at AS endedAt FROM matter_agents WHERE matter_id=? ORDER BY position`).all(matterId)
  function write(matterId:string,runId:string|null,author:string,kind:MatterNote['kind'],text:string,key?:string,replace=false){
    if(typeof text!=='string'||!text.trim())throw Error('invalid_matter_note')
    db.query('INSERT INTO matter_notes(matter_id,run_id,author,kind,text,created_at,entry_key) VALUES(?,?,?,?,?,?,?) ON CONFLICT(matter_id,entry_key) DO '+(replace?'UPDATE SET text=excluded.text':'NOTHING')).run(matterId,runId,author,kind,short(text.trim(),LEDGER_NOTE_MAX),now(),key??null)
  }
  return {
    notes,agents,
    start(matterId:string,runId:string,executor:string,brief:string){
      db.transaction(()=>{
        db.query(`INSERT OR IGNORE INTO matter_agents(matter_id,run_id,executor,brief,position,status,created_at) VALUES(?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM matter_agents WHERE matter_id=?),'queued',?)`).run(matterId,runId,executor,short(brief,1000),matterId,now())
        write(matterId,runId,'cc','plan',`${executor}: ${brief}`,`plan:${runId}`)
      })()
    },
    running(runId:string){db.query("UPDATE matter_agents SET status='running',ended_at=NULL WHERE run_id=?").run(runId)},
    note(matterId:string,runId:string,author:string,text:string,turnId?:string){write(matterId,runId,author,'note',text,turnId?`note:${turnId}:${randomUUID()}`:undefined)},
    artifact(matterId:string,runId:string,author:string,meta:{workspace:string;fileCount:number|null;files:string[];commit:string|null}){
      const files=meta.files.slice(0,8).map(p=>short(p,70)).join('、')
      write(matterId,runId,author,'artifact',`${meta.fileCount===null?'改动信息未取得':`${meta.fileCount} 个文件`}${files?` · ${files}`:''}\n提交 ${meta.commit??'未取得'}\n工作区 ${short(meta.workspace,220)}`,`artifact:${runId}`,true)
    },
    finish(matterId:string,runId:string,status:string,reply:string,turnId?:string){
      db.transaction(()=>{
        if(reply.trim()&&!db.query("SELECT 1 FROM matter_notes WHERE matter_id=? AND run_id=? AND kind='note' AND ((? IS NULL AND entry_key IS NULL) OR (? IS NOT NULL AND entry_key LIKE ?))").get(matterId,runId,turnId??null,turnId??null,`note:${turnId}:%`))write(matterId,runId,agents(matterId).find(a=>a.runId===runId)?.executor??'cc','note',reply.replace(/\s+/g,' '),`fallback:${turnId??runId}`,true)
        db.query("UPDATE matter_agents SET status=?,ended_at=? WHERE matter_id=? AND run_id=?").run(status==='completed'?'completed':'failed',now(),matterId,runId)
      })()
    },
    interrupt(){db.query("UPDATE matter_agents SET status='failed',ended_at=? WHERE status IN ('queued','running')").run(now())},
    /** Scope is resolved exclusively from the authenticated session token. */
    bound(sessionKey:string|undefined,requested?:string):string {
      const match=/^workbench\/([a-f0-9]{8})$/.exec(sessionKey??'')
      const id=match?.[1]
      if(!id)throw Error('forbidden')
      const row=db.query<{matterId:string|null},[string]>('SELECT matter_id AS matterId FROM workbench_tasks WHERE id=?').get(id)
      if(!row?.matterId)throw Error('forbidden')
      if(requested!==undefined&&requested!==row.matterId)throw Error('matter_scope_mismatch')
      return row.matterId
    },
  }
}
