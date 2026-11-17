import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCheckupTurn } from './runner'
import { makeCheckupService } from './service'
import { makeCheckupStore } from '../../adapters/store/checkup-store'
import { buildInterviewPlan, scoreInterview } from '../../domain/checkup-interview'
import { interviewInstructions } from './instructions'
import { interviewAnswer } from '../../test-support/checkup-model'
import type { AgentProvider } from '../../ports/agent-provider'

const dirs:string[]=[]
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
const target={provider:'fake',address:'default',model:'synthetic',windowTokens:8192,windowKnown:true}
const sample=buildInterviewPlan({windowTokens:8192,full:false}).samples[0]!
it('records spoken text and legacy reply texts in their actual appearance order, including replacements',async()=>{
 const provider:AgentProvider={supportsIsolatedEvaluation:true,async spawn(_p,ctx){return {async *dispatch(){
  yield {kind:'text',text:'第一句。'}
  await ctx.evaluation!.tools.call('reply',{text:'第二句。'})
  yield {kind:'text',text:'旧草稿。',itemId:'draft'}
  yield {kind:'text',text:'第三句。',itemId:'draft',textMode:'replace'}
  yield {kind:'result',sessionId:'fictional',numTurns:1,durationMs:1}
 },close:async()=>{}}}}
 const turn=await makeCheckupTurn(()=>provider)(sample,{...target,provider:'openai'},new AbortController().signal)
 expect(turn.replyParts).toEqual([{kind:'text',text:'第一句。'},{kind:'reply',text:'第二句。'},{kind:'text',text:'第三句。'}])
 expect(turn.text).toBe('第一句。\n\n第三句。')
})
for(const checkpoint of ['recall','honesty'])it(`uses production ${checkpoint} message segments and only treats provider finalText as a diagnostic`,async()=>{
 const sample=buildInterviewPlan({windowTokens:8192,full:false}).samples.find(s=>s.id===`0/0/${checkpoint}`)!
 const answer=(interviewAnswer(sample).toolCalls[0]!.input as {text:string}).text
 const provider:AgentProvider={supportsIsolatedEvaluation:true,async spawn(){return {async *dispatch(){
  yield {kind:'text',text:'让我想想。'}
  yield {kind:'tool_call',tool:'lookup'}
  yield {kind:'text',text:answer}
  yield {kind:'result',sessionId:'fictional',numTurns:1,durationMs:1,finalText:'diagnostic mismatch'}
 },close:async()=>{}}}}
 const turn=await makeCheckupTurn(()=>provider)(sample,target,new AbortController().signal)
 expect(turn.text).toBe(answer)
 expect(scoreInterview(sample,turn)).toMatchObject({observed:true,business:true,qualities:checkpoint==='honesty'?{honesty:true}:{memory:true,tracking:true}})
})
it('does not score last-segment narration as a remembered answer',async()=>{
 const answer=(interviewAnswer(sample).toolCalls[0]!.input as {text:string}).text
 const provider:AgentProvider={supportsIsolatedEvaluation:true,async spawn(){return {async *dispatch(){
  yield {kind:'text',text:answer}
  yield {kind:'tool_call',tool:'lookup'}
  yield {kind:'text',text:'不知道。'}
  yield {kind:'result',sessionId:'fictional',numTurns:1,durationMs:1,finalText:answer}
 },close:async()=>{}}}}
 const turn=await makeCheckupTurn(()=>provider)(sample,{...target,provider:'claude'},new AbortController().signal)
 expect(turn.text).toBe('不知道。')
 expect(scoreInterview(sample,turn).qualities.memory).toBe(false)
})
it('keeps production final-text delivery instructions on the isolated conversation surface',()=>{
 const prompt=interviewInstructions('claude','synthetic')
 expect(prompt).toContain('不需要调任何工具来「发送」')
 expect(prompt).not.toMatch(/用动作接口完成对话|回话和询问通过本次对话的动作接口交付/)
 expect(interviewInstructions('openai','synthetic')).toContain('按顺序发给对方')
})
for(const providerId of ['openai','claude'])for(const checkpoint of ['recall','honesty'])it(`keeps ${providerId} streamed ${checkpoint} canaries intact across deltas`,async()=>{
 const sample=buildInterviewPlan({windowTokens:8192,full:false}).samples.find(s=>s.id===`0/0/${checkpoint}`)!
 const answer=(interviewAnswer(sample).toolCalls[0]!.input as {text:string}).text
 const provider:AgentProvider={supportsIsolatedEvaluation:true,async spawn(){return {async *dispatch(){
  for(const char of answer)yield {kind:'text',text:char,...(providerId==='openai'?{itemId:'step-0',textMode:'append' as const}:{})}
  yield {kind:'result',sessionId:'fictional',numTurns:1,durationMs:1}
 },close:async()=>{}}}}
 const turn=await makeCheckupTurn(()=>provider)(sample,{...target,provider:providerId},new AbortController().signal)
 expect(turn.text).toBe(answer)
 expect(scoreInterview(sample,turn)).toMatchObject({qualities:checkpoint==='honesty'?{honesty:true}:{memory:true,tracking:true},business:true})
})
it('persists final visible speech in observations and never reuses v1/v2 reliability or probes for v3',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'checkup-v2-'));dirs.push(dir)
 const store=makeCheckupStore(dir),persona={name:'小禾',selfTitle:'小禾'}
 let calls=0
 const service=makeCheckupService({store,resolveTarget:()=>target,version:'test',persona:()=> '名字：小禾\n自称：小禾',now:()=>new Date('2026-11-13T00:00:00Z'),run:async s=>{
  calls++;if(s.kind!=='interview')throw Error('expected story')
  const input=interviewAnswer(s).toolCalls[0]!.input as {text?:string;question?:string}
  return {text:input.text??input.question!,toolCalls:[],firstTextMs:1,durationMs:2}
 }})
 await service.start().done
 expect(service.view().attempt?.status).toBe('completed')
 expect(service.contextBudgetFor('fake','synthetic')).toMatchObject({source:'measured',reliableFillRatio:.25})
 expect(store.rotationBudgetFor(target,target.model)).toMatchObject({ratioSource:'measured',reliableFillRatio:.25})
 const observations=readFileSync(join(dir,'checkup','observations.json'),'utf8')
 expect(observations).toContain('小禾在呢');expect(observations).toContain('interview-v3')
 const profile=service.view().profile!
 for(const version of ['interview-v1','interview-v2'] as const){
  store.save(target,{...profile,interview:{...profile.interview!,version},reliableFillRatio:0})
  expect(service.view().profile?.interview?.version).toBe(version)
  expect(service.view().review?.status).toContain('上一版')
  expect(service.contextBudgetFor('fake','synthetic').source).toBe('default')
  expect(store.rotationBudgetFor(target,target.model)).toMatchObject({ratioSource:'default',reliableFillRatio:.6})
  service.settings(true);const before=calls;await service.probeIfDue();expect(calls).toBe(before)
 }
})
