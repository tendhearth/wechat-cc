/** Deterministic, bounded evidence for the owner's cross-project questions. No I/O. */
import z from 'zod'
const iso=z.string().datetime({offset:true})
export const ProjectsActivityQuery=z.object({since:iso.optional(),until:iso.optional(),projects:z.array(z.string().trim().min(1).max(160)).min(1).max(12).optional()}).strict()
export type ProjectsActivityQueryT=z.infer<typeof ProjectsActivityQuery>
const kind=z.enum(['terminal','task'])
const session=z.object({id:z.string(),kind,code:z.string().optional(),executor:z.string(),activity:z.enum(['waiting','running','unread','idle']),latestStep:z.string(),updatedAt:z.number()})
const history=z.object({id:z.string(),kind,code:z.string().optional(),executor:z.string(),at:z.number(),step:z.string()})
const entry=z.object({id:z.string(),kind:z.enum(['decision','progress','conclusion']),line:z.string(),status:z.enum(['live','done']),updatedAt:z.number()})
export const ProjectActivityEvidence=z.object({id:z.string(),title:z.string(),aliases:z.array(z.string()).default([]),private:z.boolean().default(false),entries:z.array(entry).default([]),history:z.array(history).default([]),current:z.array(session).default([])})
export type ProjectActivityEvidenceT=z.input<typeof ProjectActivityEvidence>
export const ProjectsActivityFixture=z.object({text:z.string().min(1).max(4000),query:ProjectsActivityQuery.default({}),now:iso,evidence:z.array(ProjectActivityEvidence.refine(p=>p.entries.length<=1000&&p.history.length<=2000&&p.current.length<=2000)).max(100)})
const norm=(s:string)=>s.normalize('NFKC').trim().toLowerCase()
export function activityWindow(query:ProjectsActivityQueryT,now:number){
 const until=query.until??new Date(now).toISOString(),since=query.since??null
 const start=since?Date.parse(since):-Infinity,end=Date.parse(until)
 if(!Number.isFinite(end)||start>=end)throw Error('invalid_window')
 return {since,until,start,end}
}
export function summarizeProjectsActivity(query:ProjectsActivityQueryT,evidence:ProjectActivityEvidenceT[],now=Date.now()){
 query=ProjectsActivityQuery.parse(query)
 const window=activityWindow(query,now),inside=(at:number)=>at>=window.start&&at<window.end
 let truncated=false
 const wanted=query.projects?.map(norm),found=new Set<string>()
 const projects=evidence.flatMap(raw=>{
  const p=ProjectActivityEvidence.parse(raw)
  if(p.private)return []
  const names=[p.id,p.title,...p.aliases].map(norm)
  if(wanted&&!wanted.some(n=>names.includes(n)))return []
  const entries=p.entries.filter(e=>inside(e.updatedAt)).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id))
  const history=p.history.filter(h=>inside(h.at)).sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id))
  const current=p.current.filter(s=>s.updatedAt<=now)
  // An explicit historical window does not pull unrelated current-only projects into that window.
  if(!entries.length&&!history.length&&((query.since||query.until)||!current.length))return []
  for(const n of names)found.add(n)
  const rank=(a:typeof current[number])=>a.activity==='waiting'?0:a.activity==='running'?1:a.activity==='unread'?2:3
  current.sort((a,b)=>rank(a)-rank(b)||b.updatedAt-a.updatedAt||a.id.localeCompare(b.id))
  const limited=entries.length>3||history.length>3||current.length>3
  truncated||=limited
  const sessions=current.slice(0,3).map(s=>({id:s.id,kind:s.kind,...(s.code?{code:s.code.slice(0,6)}:{}),executor:s.executor.slice(0,80),activity:s.activity,latestStep:s.latestStep.slice(0,160),updatedAt:s.updatedAt}))
  return [{topicId:p.id,project:p.title.slice(0,160),replyTopic:p.title.slice(0,160),
   current:{asOf:new Date(now).toISOString(),waiting:current.filter(s=>s.activity==='waiting').length,running:current.filter(s=>s.activity==='running').length,unread:current.filter(s=>s.activity==='unread').length,sessions},
   entries:entries.slice(0,3).map(e=>({id:e.id,kind:e.kind,line:e.line.slice(0,160),updatedAt:e.updatedAt})),
   history:history.slice(0,3).map(h=>({id:h.id,kind:h.kind,...(h.code?{code:h.code.slice(0,6)}:{}),executor:h.executor.slice(0,80),at:h.at,step:h.step.slice(0,160)})),truncated:limited}]
 })
 const latest=(p:typeof projects[number])=>Math.max(0,...p.history.map(h=>h.at),...p.entries.map(e=>e.updatedAt),...p.current.sessions.map(s=>s.updatedAt))
 projects.sort((a,b)=>Number(b.current.waiting>0)-Number(a.current.waiting>0)||Number(b.current.running>0)-Number(a.current.running>0)||latest(b)-latest(a)||a.topicId.localeCompare(b.topicId))
 if(projects.length>12){projects.length=12;truncated=true}
 const result={window:{since:window.since,until:window.until},generatedAt:new Date(now).toISOString(),projects,noData:(query.projects??[]).filter(n=>!found.has(norm(n))),truncated,
  coverage:'仅有可靠公开话题归属的已记录活动；未登记、归属不明或无记录不代表没有工作。历史为窗口内记录，current为此刻；条目时间是记忆更新时间。',
  empty:projects.length===0?'没有符合条件的项目活动记录。':null}
 // Keep valid structured output; remove low-priority rows, never cut JSON mid-value.
 while(JSON.stringify(result).length>12000&&result.projects.length){result.projects.pop();result.truncated=true}
 return result
}
