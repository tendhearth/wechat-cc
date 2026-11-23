import type { CliSessionRowT, MatterDetailT } from '../backend/types'
import type { Lang } from '../i18n'
import { agentName } from './agents'
export function directHeaderView(value: MatterDetailT | CliSessionRowT, lang: Lang) {
  const zh=lang==='zh-Hans'
  if ('session_id' in value) {
    const name=value.displayName||value.source
    return {current:value.source,name,titleLines:1 as const,title:zh?`在跟 ${name} 说 · ${value.project}`:`Talking to ${name} · ${value.project}`,subtitle:value.project,project:value.project,placeholder:zh?`对 ${name} 说…`:`Say to ${name}…`,relay:[] as {id:string;name:string;current:boolean}[]}
  }
  const runs=[...(value.agentRuns??[])].sort((a,b)=>a.position-b.position)
  const active=runs.find(r=>r.runId===value.runId)??runs.find(r=>r.status==='running')
  const current=active?.executor??value.task?.providerId??value.matter.agents?.[0]??''
  const name=agentName(current,value.matter.agentNames)
  const project=value.matter.projectPath?.split(/[\\/]/).filter(Boolean).at(-1)??''
  const index=active?runs.indexOf(active)+1:1
  const count=runs.length||1
  return {current,name,titleLines:2 as const,title:value.matter.title,project,
    subtitle:[project,zh?`第 ${index} 棒 / ${count}`:`Leg ${index} / ${count}`].filter(Boolean).join(' · '),placeholder:zh?`对 ${name} 说…`:`Say to ${name}…`,
    relay:runs.length>1?runs.map(r=>({id:r.runId,name:agentName(r.executor,value.matter.agentNames),current:r===active})):[]}
}
export type DirectHeaderView=ReturnType<typeof directHeaderView>
