import { readJsonFile } from '../../lib/read-json-file'
import { join } from 'node:path'
import type { InternalApiDeps, RouteTable } from './types'

/** Owner-only retained planning notes. Deliberately excludes chat IDs and prompt context. */
export function thoughtRoutes(deps: InternalApiDeps): RouteTable {
  return {'GET /v1/companion/thoughts': () => {
    try {
      let raw: unknown
      try {raw=readJsonFile(join(deps.stateDir,'companion','plan-log.json'))}
      catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return {status:200,body:{items:[]}};throw e}
      if(!raw||typeof raw!=='object')throw new Error('invalid_plan_log')
      const r=raw as {days?:Record<string,unknown>; day?:string; entries?:unknown[]}
      const days=r.days??(typeof r.day==='string'&&Array.isArray(r.entries)?{[r.day]:r.entries}:null)
      if(!days||typeof days!=='object'||Array.isArray(days))throw new Error('invalid_plan_days')
      const labels:Record<string,string>={hunt:'想去找些东西',visit:'想去看看朋友',gap:'想和你聊聊',none:'决定先安静待着'}
      const items=Object.keys(days).sort().slice(-14).flatMap(day=>{
        const entries=days[day];if(!Array.isArray(entries))throw new Error('invalid_plan_entries')
        return entries.flatMap((e,i)=>{
          if(!e||typeof e.at!=='string'||!Number.isFinite(Date.parse(e.at))||typeof e.why!=='string')throw new Error('invalid_plan_entry')
          if(e.source!=='model'||!e.why.trim()||/^\((failed|skipped)\) /.test(e.why))return []
          return [{id:`${day}:${i}`,ts:e.at,title:labels[e.decision]??'留下了一点想法',note:e.why}]
        })
      }).sort((a,b)=>b.ts.localeCompare(a.ts))
      return {status:200,body:{items}}
    } catch {return {status:503,body:{error:'thoughts_unavailable'}}}
  }}
}
