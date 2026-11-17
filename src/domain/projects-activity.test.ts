import { expect, it } from 'vitest'
import { summarizeProjectsActivity, ProjectsActivityQuery } from './projects-activity'

const now=Date.parse('2026-11-11T12:00:00-08:00'), since='2026-11-10T00:00:00-08:00', until='2026-11-11T00:00:00-08:00'
const project=(id:string,at:number,waiting=false)=>({id,title:id,aliases:[],private:false,entries:[{id:'e-'+id,kind:'progress' as const,line:id+' 完成离线校验',status:'live' as const,updatedAt:at}],history:[{id:'h-'+id,kind:'terminal' as const,code:'abcdef',executor:'claude',at,step:'答完了'}],current:waiting?[{id:'m-'+id,kind:'task' as const,executor:'codex',activity:'waiting' as const,latestStep:'等你回答',updatedAt:now}]:[]})
it('separates a strict local yesterday from current owner attention and strips extra fields',()=>{
 const start=Date.parse(since),end=Date.parse(until)
 const result=summarizeProjectsActivity({since,until},[
  project('rici',start),project('bx',end-1,true),project('outside',end),{...project('secret',start),private:true},
 ],now)
 expect(result.projects.map(p=>p.project)).toEqual(['bx','rici'])
 expect(result.projects[0]!.current.waiting).toBe(1)
 expect(result.window).toEqual({since,until})
 expect(JSON.stringify(result)).not.toContain('outside')
 expect(JSON.stringify(result)).not.toContain('secret')
})
it('supports exact aliases, old last progress, missing projects, caps and explicit truncation',()=>{
 const evidence=Array.from({length:20},(_,n)=>({...project('p'+n,now-n),aliases:['alias'+n]}))
 const scoped=summarizeProjectsActivity({projects:['ALIAS19','missing']},evidence,now+1)
 expect(scoped.projects.map(p=>p.project)).toEqual(['p19'])
 expect(scoped.noData).toEqual(['missing'])
 const bounded=summarizeProjectsActivity({},evidence,now+1)
 expect(bounded.projects).toHaveLength(12)
 expect(bounded.truncated).toBe(true)
 expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(12000)
 expect(ProjectsActivityQuery.safeParse({since:'yesterday'}).success).toBe(false)
 expect(()=>summarizeProjectsActivity({since:until,until:since},[],now)).toThrow()
})
it('keeps at most three per section and never invents semantic work from metadata',()=>{
 const p=project('bx',now-1,true)
 const evidence={...p,entries:Array.from({length:10},(_,n)=>({...p.entries[0]!,id:'e'+n,line:'现有进展'+n,updatedAt:now-n-1,body:'PRIVATE_BODY'})),history:Array.from({length:10},(_,n)=>({...p.history[0]!,id:'h'+n,at:now-n-1,output:'PRIVATE_OUTPUT'}))}
 const r=summarizeProjectsActivity({},[evidence],now)
 expect(r.projects[0]!.entries).toHaveLength(3)
 expect(r.projects[0]!.history).toHaveLength(3)
 expect(r.truncated).toBe(true)
 expect(JSON.stringify(r)).not.toMatch(/PRIVATE_BODY|PRIVATE_OUTPUT/)
 expect(summarizeProjectsActivity({},[],now).projects).toEqual([])
})
