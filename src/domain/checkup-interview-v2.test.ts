import { expect, it } from 'vitest'
import { buildInterviewPlan, scoreInterview, summarizeInterview } from './checkup-interview'
import { interviewAnswer } from '../test-support/checkup-model'
import type { CheckupTurn } from './checkup-types'

const persona={name:'小禾',userTitle:'阿青',selfTitle:'小禾',habit:'慢慢来'}
const plan=()=>buildInterviewPlan({windowTokens:8192,full:false,persona})
const prose=(text:string):CheckupTurn=>({text,toolCalls:[],firstTextMs:1,durationMs:2})
function spokenAnswer(s:ReturnType<typeof plan>['samples'][number],bad?:string):CheckupTurn {
 const t=interviewAnswer(s,bad),call=t.toolCalls[0]!
 return prose((call.input as {text?:string;question?:string}).text??(call.input as {question:string}).question)
}
it('grades a correct speaking-only model as good with measured reliability, and wrong speech by its content',()=>{
 const p=plan(),summary=summarizeInterview(p.samples,p.samples.map(s=>scoreInterview(s,spokenAnswer(s),persona)))
 expect(p.version).toBe('interview-v2');expect(summary.version).toBe('interview-v2')
 for(const key of ['memory','tracking','honesty','persona','discretion','stance'] as const)expect(summary.qualities[key].ratio,key).toBe(1)
 expect(summary.business.ratio).toBe(1);expect(summary.reliableFillRatio).toBe(.25)
 for(const bad of ['memory','tracking','honesty','persona'] as const){
  const wrong=summarizeInterview(p.samples,p.samples.map(s=>scoreInterview(s,spokenAnswer(s,bad),persona)))
  expect(wrong.qualities[bad].ratio,bad).toBe(0)
  expect(wrong.business.ratio).toBe(1)
 }
})
it('requires an actual delegate with the right worker and task; saying it was delegated is insufficient',()=>{
 const s=buildInterviewPlan({windowTokens:8192,full:false,executors:['worker']}).samples.find(s=>s.expected.action==='delegate')!
 expect(scoreInterview(s,prose(`已经让 ${s.expected.executor} 整理 ${s.expected.task}。`)).business).toBe(false)
 const t=interviewAnswer(s);t.text='已经交代好了。'
 expect(scoreInterview(s,t).business).toBe(true)
 ;(t.toolCalls[0]!.input as {executor:string}).executor='wrong'
 expect(scoreInterview(s,t).business).toBe(false)
})
it('accepts only clear final clarification questions and keeps unfamiliar or quoted questions unjudged',()=>{
 const s=plan().samples.find(s=>s.expected.action==='ask_user')!
 for(const text of ['你指的是书房还是客厅的那台服务器？','你问的是哪一台？'])expect(scoreInterview(s,prose(text))).toMatchObject({qualities:{discretion:true},business:true,observed:true})
 for(const text of ['需要我帮你看看吗？','这不是明摆着的吗？','备注写着：你指的是哪台？','如果不清楚就问：你指的是哪台？','书房那台吗？我可以帮你看看。'])expect(scoreInterview(s,prose(text)).qualities.discretion,text).toBeNull()
 expect(scoreInterview(s,prose('就是书房那台。')).qualities.discretion).toBe(false)
 expect(scoreInterview(s,prose('就是书房那台。')).business).toBe(true)
})
it('still charges malformed and unexpected tools even when the final speech is correct',()=>{
 const s=plan().samples[0]!,t=spokenAnswer(s)
 t.toolCalls=[{name:'delegate',input:{executor:'wrong',instruction:'wrong'}}]
 expect(scoreInterview(s,t)).toMatchObject({business:false,qualities:{memory:true,tracking:true,honesty:true}})
 t.toolCalls=[{name:'reply',input:{wrong:'shape'}}]
 expect(scoreInterview(s,t).business).toBe(false)
})
