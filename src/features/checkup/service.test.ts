import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeCheckupService } from './service'
import { makeCheckupStore } from '../../adapters/store/checkup-store'
import { interviewAnswer } from '../../test-support/checkup-model'
import type { CheckupSample, CheckupTurn } from '../../domain/butler-checkup'
import type { AgentProvider } from '../../ports/agent-provider'

const dirs: string[] = []
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'cc-checkup-test-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const target = { provider: 'fake', address: 'https://example.invalid/v1', model: 'fabricated', windowTokens: 8192, windowKnown: false }
const correct = async (sample: CheckupSample): Promise<CheckupTurn> => sample.kind==='interview'?interviewAnswer(sample):({ text: sample.kind === 'memory' ? JSON.stringify(sample.answers) : '', toolCalls: sample.kind === 'tool' ? [{ name: sample.tool, input: sample.input }] : [], firstTextMs: 10, durationMs: 20 })
function setup(run = correct, now = () => new Date('2026-11-12T12:00:00Z')) {
  const stateDir = temp(), store = makeCheckupStore(stateDir)
  return { stateDir, store, service: makeCheckupService({ store, resolveTarget: o => ({...target,...(o?.model ? {model:o.model} : {})}), run, version: 'test', now, executors:()=>['worker'] }) }
}
describe('local checkup lifecycle', () => {
  it('keeps an accepted run queryable and cancellable after a pin and endpoint change',async()=>{
    let current={...target}
    const {store}=setup()
    const service=makeCheckupService({store,resolveTarget:()=>current,run:()=>new Promise<CheckupTurn>(()=>{}),version:'test'})
    const key=service.estimate().targetKey,run=service.start({expectedTargetKey:key})
    current={...target,model:'new-pin',address:'https://other.invalid'}
    expect(service.view().profile).toBeNull()
    expect(service.view().attempt?.status).toBe('running')
    expect(service.view({runKey:key}).target.model).toBe('fabricated')
    service.cancel();await run.done
    expect(service.view({runKey:key}).attempt?.status).toBe('cancelled')
  })
  it('does not leave a phantom running state when the initial atomic attempt write is refused', () => {
    const {service,store}=setup()
    const original=store.saveAttempt
    store.saveAttempt=()=>{throw new Error('disk unavailable')}
    expect(()=>service.start({})).toThrow('disk unavailable')
    expect(service.view().attempt).toBeNull()
    store.saveAttempt=original
  })
  it('uses measured budget only for the exact endpoint/model; a pin change does not run', async () => {
    const { service, store } = setup()
    expect(store.contextBudgetFor(target, target.model).source).toBe('default')
    await service.start({}).done
    expect(service.view().profile?.memory).toBe('good')
    expect(store.contextBudgetFor(target, target.model)).toEqual({ windowTokens: 8192, reliableFillRatio: .25, source: 'measured' })
    expect(store.contextBudgetFor({ ...target, address: 'https://other.invalid' }, target.model).source).toBe('default')
    expect(service.view({ model: 'new-pin' }).profile).toBeNull()
  })
  it('measures the threshold of a model that starts forgetting at 60%', async () => {
    const { service } = setup(async sample => sample.kind === 'interview' && sample.fillRatio >= .6 ? interviewAnswer(sample,'memory') : correct(sample))
    await service.start({full:true}).done
    expect(service.view().profile).toMatchObject({ memory: 'fair', reliableFillRatio: .4 })
  })
  it('finishes the profile with flaky tools when only the model fake-tool loop exceeds its bound', async () => {
    const { service } = setup(async sample => ({ ...await correct(sample), ...(sample.kind === 'interview' ? { toolError: true } : {}) }))
    await service.start({}).done
    expect(service.view().attempt?.status).toBe('completed')
    expect(service.view().profile).toMatchObject({ memory: 'good', tools: 'flaky', toolAccuracy: 0 })
  })
  it('records an all-wrong model as weak, including real tool argument mistakes', async () => {
    const { service } = setup(async () => ({ text: '', toolCalls: [{name:'reply',input:{text:'wrong'}}], firstTextMs: null, durationMs: 5 }))
    await service.start({}).done
    expect(service.view().profile).toMatchObject({ memory: 'weak', tools: 'flaky', reliableFillRatio: 0 })
  })
  for (const code of ['rate_limited', 'auth_failed']) it(`does not replace a complete profile after ${code}`, async () => {
    let fail = false, n = 0
    const { service } = setup(async sample => { if (fail && ++n === 3) throw Object.assign(new Error('private detail must not persist'), { code }); return correct(sample) })
    await service.start({}).done
    const before = service.view().profile
    fail = true
    await service.start({}).done
    expect(service.view().attempt).toMatchObject({ status: 'failed', errorCode: code })
    expect(service.view().profile).toEqual(before)
  })
  it('cancels a stalled request promptly and preserves the previous archive', async () => {
    let stall = false
    const { service } = setup(async sample => stall ? new Promise<CheckupTurn>(() => {}) : correct(sample))
    await service.start({}).done
    const before = service.view().profile
    stall = true
    const next = service.start({})
    service.cancel()
    await next.done
    expect(service.view().attempt?.status).toBe('cancelled')
    expect(service.view().profile).toEqual(before)
  })
  it('defaults periodic spending off; a three-question probe can flag a changed model', async () => {
    let wrong = false, calls = 0, clock = new Date('2026-11-12T12:00:00Z')
    const { service } = setup(async sample => { calls++; return wrong ? { text: '[]', toolCalls: [], firstTextMs: null, durationMs: 5 } : correct(sample) }, () => clock)
    await service.probeIfDue()
    expect(calls).toBe(0)
    await service.start({}).done
    service.settings(true)
    wrong = true
    clock = new Date(clock.getTime() + 7*86400_000)
    await service.probeIfDue()
    expect(calls).toBe(27)
    expect(service.view().suspectedChanged).toBe(true)
    expect(service.view().profile?.memory).toBe('good')
  })
  it('does not immediately reprobe a full checkup or repeatedly spend after probe failure', async () => {
    let calls = 0, fail = false, clock = new Date('2026-11-12T12:00:00Z')
    const run = async (sample: CheckupSample) => { calls++; if (fail) throw Object.assign(Error('offline fixture'), { code: 'network' }); return correct(sample) }
    const { service, store } = setup(run, () => clock)
    await service.start({}).done
    service.settings(true)
    await service.probeIfDue()
    expect(calls).toBe(24)
    clock = new Date(clock.getTime() + 7*86400_000)
    fail = true
    await service.probeIfDue()
    expect(calls).toBe(25)
    expect(service.view().suspectedChanged).toBe(false)
    // A fresh service reads the durable attempt timestamp after daemon restart.
    const restarted = makeCheckupService({ store, resolveTarget: () => target, run, version: 'test', now: () => clock, executors:()=>['worker'] })
    await restarted.probeIfDue()
    clock = new Date(clock.getTime() + 6*86400_000)
    await restarted.probeIfDue()
    expect(calls).toBe(25)
    clock = new Date(clock.getTime() + 86400_000)
    await restarted.probeIfDue()
    expect(calls).toBe(26)
  })
  it('keeps real state canaries out of every outgoing synthetic question', async () => {
    const sent: CheckupSample[] = []
    const { service, stateDir } = setup(async sample => { sent.push(sample); return correct(sample) })
    const canary = 'PRIVATE_STATE_CANARY_never_send_894032'
    writeFileSync(join(stateDir, 'private-secret.txt'), canary)
    await service.start({ full: true }).done
    expect(sent).toHaveLength(60)
    for (const sample of sent) {
      expect(sample.prompt).not.toContain(canary)
      expect(sample.prompt).not.toContain(stateDir)
    }
  })
  it('never reads synthetic questions from real state and never persists prompt, key or raw error', async () => {
    const { service, stateDir } = setup()
    writeFileSync(join(stateDir, 'private-secret.txt'), 'PRIVATE_CANARY_894032_API_KEY')
    await service.start({}).done
    const json = readFileSync(join(stateDir, 'checkup', 'profiles.json'), 'utf8')
    expect(json).not.toContain('PRIVATE_CANARY')
    expect(json).not.toContain('prompt')
    expect(json).not.toContain('answers')
  })
})

it('projects persona and never sends real memory/topic/conversation state, including persona prose',async()=>{
  const stateDir=temp(),store=makeCheckupStore(stateDir),sent:CheckupSample[]=[]
  const secret='PRIVATE_REAL_STATE_822343'
  writeFileSync(join(stateDir,'memory.md'),secret);writeFileSync(join(stateDir,'topics.json'),secret);writeFileSync(join(stateDir,'messages.json'),secret)
  const service=makeCheckupService({store,resolveTarget:()=>target,version:'test',persona:()=>`名字：小禾\n称呼用户：阿青\n自称：小禾\n记忆：${secret}`,executors:()=>[],run:async s=>{sent.push(s);return {text:'',toolCalls:[{name:'reply',input:{text:'阿青，小禾在呢'}}],firstTextMs:1,durationMs:2}}})
  await service.start().done
  expect(sent.length).toBeGreaterThan(2)
  expect(JSON.stringify(sent)).not.toContain(secret)
  expect(JSON.stringify(sent)).not.toContain(stateDir)
  expect(service.view().profile?.interview).toMatchObject({version:'interview-v1',name:'小禾',qualities:{privacy:{total:0},persona:{ratio:1}}})
})

it('leaves every quality ungraded when the backend cannot isolate its native tools',async()=>{
  const {service}=setup(async()=>{throw Object.assign(new Error('unsafe details'),{code:'isolated_evaluation_unavailable'})})
  await service.start().done
  const v=service.view()
  expect(v.attempt).toMatchObject({status:'failed',errorCode:'isolated_evaluation_unavailable'})
  expect(v.profile).toBeNull()
  expect(v.review?.status).toContain('这个后端暂时没法体检')
  expect(v.review?.rows).toEqual([])
  expect(JSON.stringify(v)).not.toContain('unsafe details')
})

it('does not crash or reuse a damaged v1 archive',async()=>{
  const {service,stateDir}=setup();await service.start().done
  const path=join(stateDir,'checkup','profiles.json'),raw=JSON.parse(readFileSync(path,'utf8'))
  for(const profile of Object.values(raw) as Array<Record<string,unknown>>)profile.interview={version:'interview-v1'}
  writeFileSync(path,JSON.stringify(raw))
  expect(()=>service.view()).not.toThrow()
  expect(service.view().profile).toBeNull()
  expect(service.contextBudgetFor('fake','fabricated').source).toBe('default')
})

it('does not compare a v1 probe with an earlier unversioned paper',async()=>{
  let calls=0,clock=new Date('2026-11-12T12:00:00Z')
  const {service,store}=setup(async s=>{calls++;return correct(s)},()=>clock)
  await service.start().done
  const profile=service.view().profile!,{interview:_,...older}=profile
  store.save(target,older)
  service.settings(true);const before=calls;clock=new Date(clock.getTime()+8*86400_000)
  await service.probeIfDue()
  expect(calls).toBe(before)
  expect(service.view().suspectedChanged).toBe(false)
})

it('rejects an entirely unscorable run and preserves default context budget',async()=>{
  const {service}=setup(async()=>({text:'direct speech',toolCalls:[],firstTextMs:1,durationMs:2}))
  await service.start().done
  expect(service.view().attempt).toMatchObject({status:'failed',errorCode:'no_measurement'})
  expect(service.view().profile).toBeNull()
  expect(service.contextBudgetFor('fake','fabricated').source).toBe('default')
})
it('detects corrupt profiles before any request or running attempt',async()=>{
  const {service,stateDir}=setup(async()=>{throw Error('must not spend')})
  const path=join(stateDir,'checkup','profiles.json')
  const {mkdirSync}=await import('node:fs');mkdirSync(join(stateDir,'checkup'),{recursive:true})
  for(const broken of ['{"truncated":','[]']){
    writeFileSync(path,broken)
    expect(()=>service.start()).toThrow(/读不出来/)
    expect(readFileSync(path,'utf8')).toBe(broken)
    expect(()=>readFileSync(join(stateDir,'checkup','attempts.json'))).toThrow()
  }
})
it('holds busy through manual runs and weekly probes, releasing on completion, failure and stop',async()=>{
  let held=0,calls=0,fail=false,clock=new Date('2026-11-12T12:00:00Z')
  const store=makeCheckupStore(temp())
  const service=makeCheckupService({store,resolveTarget:()=>target,version:'test',now:()=>clock,
    holdBusy:()=>{held++;return()=>{held--}},run:async s=>{calls++;expect(held).toBe(1);if(fail)throw Object.assign(Error('offline'),{code:'network'});return correct(s)}})
  const run=service.start();expect(held).toBe(1);await run.done;expect(held).toBe(0)
  service.settings(true);clock=new Date(clock.getTime()+8*86400_000)
  await service.probeIfDue();expect(calls).toBe(23);expect(held).toBe(0)
  fail=true;await service.start().done;expect(held).toBe(0)
  const cancelled=service.start();expect(held).toBe(1);await service.stop();await cancelled.done;expect(held).toBe(0)
})
it('binds a cost estimate to short versus full before spending',()=>{
  const {service}=setup(),short=service.estimate(),full=service.estimate({full:true})
  expect(short.targetKey).not.toBe(full.targetKey)
  expect(()=>service.start({full:true,expectedTargetKey:short.targetKey})).toThrow('checkup_target_changed')
  expect(service.view().attempt).toBeNull()
})
it('durably limits manual target attempts per UTC day and lets local operators bypass it',async()=>{
  const {service,store}=setup()
  for(let i=0;i<3;i++)await service.start().done
  const restart=makeCheckupService({store,resolveTarget:()=>target,run:correct,version:'test',now:()=>new Date('2026-11-12T13:00:00Z')})
  expect(()=>restart.start()).toThrow('checkup_rate_limited')
  await restart.start({}, {operator:true}).done
  const tomorrow=makeCheckupService({store,resolveTarget:()=>target,run:correct,version:'test',now:()=>new Date('2026-11-13T00:00:00Z')})
  await tomorrow.start().done
  expect(tomorrow.view().attempt?.status).toBe('completed')
})

it('keeps other observations and marks only the affected qualities incomplete after exhausted reasoning',async()=>{
  let n=0
  const {service}=setup(async sample=>{if(++n===1)throw Object.assign(Error('only reasoning'),{code:'checkup_output_exhausted'});return correct(sample)})
  await service.start().done
  const view=service.view()
  expect(n).toBe(24)
  expect(view.attempt).toMatchObject({status:'completed',completedRequests:24})
  expect(view.profile?.interview?.qualities.honesty).toEqual({passed:3,total:3,ratio:1,unmeasured:1})
  expect(view.profile?.reliableFillRatio).toBe(0)
  expect(view.review?.rows.find(r=>r.key==='honesty')).toMatchObject({grade:'好',detail:'不知道的事会直说；这一项没测全'})
  expect(view.review?.rows.find(r=>r.key==='stance')?.grade).toBe('好')
  expect(view.review?.status).not.toContain('这次没测成')
})
it('tries all questions but keeps the previous archive when every question exhausts reasoning',async()=>{
  let exhausted=false,n=0
  const {service}=setup(async sample=>{n++;if(exhausted)throw Object.assign(Error('only reasoning'),{code:'checkup_output_exhausted'});return correct(sample)})
  await service.start().done
  const before=service.view().profile
  exhausted=true;n=0;await service.start().done
  expect(n).toBe(24)
  expect(service.view().attempt).toMatchObject({status:'failed',errorCode:'no_measurement',completedRequests:24})
  expect(service.view().profile).toEqual(before)
  expect(service.view().review?.status).toContain('这次没测成')
})

it('invalidates the cost receipt if real executor availability changes before confirmation',()=>{
  const store=makeCheckupStore(temp());let available=false
  const service=makeCheckupService({store,resolveTarget:()=>target,run:correct,version:'test',executors:()=>available?['private-worker']:[]})
  const estimate=service.estimate()
  available=true
  expect(service.estimate().requests).toBe(48)
  expect(service.estimate().targetKey).not.toBe(estimate.targetKey)
  expect(()=>service.start({expectedTargetKey:estimate.targetKey})).toThrow('checkup_target_changed')
  expect(service.view().attempt).toBeNull()
})

// Round two: the quote must describe an enforced whole-run allowance.
it('quotes realistic typical output and binds both hard limits to confirmation',()=>{
  const {store}=setup()
  let limits={maxOutputTokens:300_000,maxRequests:120}
  const service=makeCheckupService({store,resolveTarget:()=>target,run:correct,version:'test',executors:()=>['worker'],limits:()=>limits})
  const quote=service.estimate()
  expect(quote).toMatchObject({outputTokens:69_600,maxOutputTokens:300_000,maxRequests:120})
  expect(quote.summary).toContain('预计用 7 万左右、最多不超过 30 万输出 token')
  limits={...limits,maxOutputTokens:200_000}
  expect(()=>service.start({expectedTargetKey:quote.targetKey})).toThrow('checkup_target_changed')
  const next=service.estimate()
  limits={...limits,maxRequests:80}
  expect(()=>service.start({expectedTargetKey:next.targetKey})).toThrow('checkup_target_changed')
})

for(const dimension of ['output','requests'] as const) it(`stops at the whole-run ${dimension} gate and keeps measured reviews`,async()=>{
  const {makeCheckupTurn}=await import('./runner')
  let calls=0,output=0
  const provider:AgentProvider={supportsIsolatedEvaluation:true,async spawn(_p,ctx){return{async *dispatch(){
    const lease=ctx.evaluation!.budget?.reserve(ctx.evaluation!.maxOutputTokens)
    const cap=lease?.maxOutputTokens??ctx.evaluation!.maxOutputTokens
    calls++;output+=cap
    await ctx.evaluation!.tools.call('reply',{text:'不知道，我不能确认。'})
    lease?.settle({outputTokens:cap})
    yield{kind:'result',sessionId:'fake',numTurns:1,durationMs:1}
  },close:async()=>{}}}}
  const {store}=setup()
  const service=makeCheckupService({store,resolveTarget:()=>target,version:'test',run:makeCheckupTurn(()=>provider),limits:()=>({maxOutputTokens:dimension==='output'?5000:100_000,maxRequests:dimension==='requests'?2:120})})
  await service.start().done
  expect(calls).toBe(2)
  expect(output).toBe(dimension==='output'?5000:8192)
  const view=service.view()
  expect(view.attempt).toMatchObject({status:'completed',errorCode:'checkup_usage_limit',completedRequests:2,usage:{requests:2,outputTokens:output}})
  expect(view.review?.status).toContain('到了本次体检的用量上限')
  expect(view.profile?.interview?.qualities.honesty).toMatchObject({passed:1,total:1,unmeasured:3})
  expect(view.review?.rows.find(r=>r.key==='honesty')).toMatchObject({grade:'好',detail:'不知道的事会直说；这一项没测全'})
  expect(view.profile?.interview?.business).toMatchObject({passed:1,total:2,unmeasured:18})
})

it('freezes the accepted allowance while config changes during a run',async()=>{
  const {store}=setup()
  let limits={maxOutputTokens:5000,maxRequests:2},calls=0
  const run:Parameters<typeof makeCheckupService>[0]['run']=async(s,_t,_signal,budget)=>{
    const lease=budget!.reserve(4096);calls++;lease.settle({outputTokens:lease.maxOutputTokens})
    limits.maxOutputTokens=100000;limits.maxRequests=120
    return correct(s)
  }
  const service=makeCheckupService({store,resolveTarget:()=>target,version:'test',run,limits:()=>limits})
  await service.start().done
  expect(calls).toBe(2)
  expect(service.view().attempt).toMatchObject({errorCode:'checkup_usage_limit',usage:{requests:2,outputTokens:5000}})
})

it('bounds the periodic probe too and does not turn an incomplete probe into model drift',async()=>{
  const {store}=setup()
  let clock=new Date('2026-11-12T12:00:00Z'),probing=false,calls=0
  const run:Parameters<typeof makeCheckupService>[0]['run']=async(s,_t,_signal,budget)=>{
    if(probing){const lease=budget!.reserve(4096);calls++;lease.settle({outputTokens:lease.maxOutputTokens})}
    return correct(s)
  }
  const service=makeCheckupService({store,resolveTarget:()=>target,version:'test',run,now:()=>clock,limits:()=>({maxOutputTokens:5000,maxRequests:2})})
  await service.start().done
  const profile=service.view().profile
  service.settings(true);probing=true;clock=new Date(clock.getTime()+7*86400000)
  await service.probeIfDue()
  expect(calls).toBe(2)
  expect(service.view().profile).toEqual(profile)
  expect(service.view().suspectedChanged).toBe(false)
})
