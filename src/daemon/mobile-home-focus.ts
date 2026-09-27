/** A read-only shortcut, never an approval snapshot. Opening it fetches fresh detail. */
type Source={list(filter:{kind:'task';statuses:('open'|'replied'|'done')[];limit:number}):unknown[];detail(id:string):unknown|Promise<unknown>}
type Focus={id:string;title:string;kind:'decision'|'result'|'working'}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
export async function mobileHomeFocus(source:Source|undefined):Promise<{focus:Focus|null;partial:boolean}>{
  if(!source)return {focus:null,partial:true}
  let rows:unknown[]
  try{rows=source.list({kind:'task',statuses:['open','replied','done'],limit:200})}catch{return {focus:null,partial:true}}
  let partial=rows.length>=200
  const candidates:Focus[]=[]
  // Task detail is local; keep concurrency bounded and never load chat histories.
  for(let start=0;start<Math.min(rows.length,200);start+=8){
    const batch=await Promise.all(rows.slice(start,start+8).map(async row=>{
      if(!object(row)||row.kind!=='task'||typeof row.id!=='string'||!/^[a-f0-9]{8}$/.test(row.id)||typeof row.title!=='string')return null
      try{
        const d=await source.detail(row.id)
        if(!object(d)||!object(d.matter)||d.matter.id!==row.id||!object(d.task)||d.task.id!==row.id){partial=true;return null}
        const own=(key:string)=>Array.isArray(d[key])&&(d[key] as unknown[]).some(r=>object(r)&&r.taskId===row.id)
        const recent=typeof row.updatedAt==='number'&&Date.now()-row.updatedAt<24*60*60*1000
        const kind=typeof d.runId==='string'&&(own('permissions')||own('questions'))?'decision':recent&&d.task.status==='completed'&&own('artifacts')?'result':['running','queued','interrupted'].includes(String(d.task.status))?'working':null
        return kind?{id:row.id,title:row.title,kind} as Focus:null
      }catch{partial=true;return null}
    }))
    candidates.push(...batch.filter((r):r is Focus=>r!==null))
  }
  return {focus:candidates.find(r=>r.kind==='decision')??candidates.find(r=>r.kind==='result')??candidates[0]??null,partial}
}
