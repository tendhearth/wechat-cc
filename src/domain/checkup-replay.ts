import { scoreInterview, summarizeInterview } from './checkup-interview'
import type { InterviewSample, InterviewScore } from './checkup-interview'
import type { CheckupTurn } from './checkup-types'

export interface SavedInterviewObservation extends Omit<CheckupTurn,'text'|'firstTextMs'> {
 id:string
 text?:string
 score:InterviewScore
}
/** Missing final prose is missing evidence, never an empty answer or model failure. */
export function replayInterviewObservations(samples:InterviewSample[],observations:SavedInterviewObservation[]) {
 const rows=samples.map(sample=>{
  const saved=observations.find(o=>o.id===sample.id)
  if(!saved||typeof saved.text!=='string'&&saved.toolCalls.length===0)return {id:sample.id,status:'无法重放' as const,old:saved?.score??null,score:{qualities:{},business:null,observed:false,unmeasured:true} as InterviewScore}
  const score=scoreInterview(sample,{...saved,text:saved.text??'',firstTextMs:null},sample.persona)
  return {id:sample.id,status:'已重放' as const,evidence:typeof saved.text==='string'?'完整观察' as const:'仅已保存工具文本' as const,old:saved.score,score}
 })
 return {rows,unavailable:rows.filter(r=>r.status==='无法重放').length,
  old:{...summarizeInterview(samples,rows.map(r=>r.old??{qualities:{},business:null,unmeasured:true})),version:'interview-v1' as const},
  replay:summarizeInterview(samples,rows.map(r=>r.score))}
}
