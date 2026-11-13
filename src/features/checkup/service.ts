import { createHash } from 'node:crypto'
import { checkupReview } from '@wechat-cc/protocol'
import type { CheckupAttempt, CheckupProfile, CheckupTarget, CheckupView } from '@wechat-cc/protocol'
import { median, type CheckupSample, type CheckupTurn } from '../../domain/butler-checkup'
import { addressHash, checkupKey, type CheckupStore } from '../../adapters/store/checkup-store'
import { buildInterviewPlan, estimateInterview, scoreInterview, summarizeInterview } from '../../domain/checkup-interview'
import { extractCheckupPersona } from '../../domain/checkup-persona'
import { interviewInstructions } from './instructions'
import { estimateTokens } from '../../domain/butler-checkup'
import { providerErrorCodeOf } from '../../lib/provider-error-code'

export interface CheckupOptions { full?: boolean; providerId?: string; model?: string; expectedTargetKey?: string; runKey?: string }
export interface CheckupServiceDeps {
  store: CheckupStore
  prepareTarget?(options?:CheckupOptions):Promise<void>
  resolveTarget(options?: CheckupOptions): CheckupTarget
  run(sample: CheckupSample, target: CheckupTarget, signal: AbortSignal): Promise<CheckupTurn>
  persona?: () => string
  executors?: () => string[]
  holdBusy?: (label:string) => () => void
  version: string
  now?: () => Date
}
/** Overall deadline includes spawn, dispatch and retry; cancellation never waits for an uncooperative model. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve,reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'))
    signal.addEventListener('abort',abort,{once:true})
    work.then(resolve,reject).finally(() => signal.removeEventListener('abort',abort))
  })
}
const errorCode = (e: unknown): string => {
  if(e instanceof Error && e.name==='TimeoutError')return 'turn_timeout'
  const code = providerErrorCodeOf(e) ?? (e && typeof e === 'object' && 'code' in e ? String(e.code) : '')
  return ['rate_limited','auth_failed','auth_rejected','network','network_unprotected','server_error','turn_timeout','isolated_evaluation_unavailable','target_changed','config_unreadable','config_busy','no_measurement'].includes(code) ? code : 'provider_error'
}
export function makeCheckupService(d: CheckupServiceDeps) {
  const now = d.now ?? (() => new Date())
  let active: { key:string; abort:AbortController; done:Promise<void> } | null = null
  const attempts = new Map<string,CheckupAttempt>()
  const targets = new Map<string,CheckupTarget>()
  const view = (options: CheckupOptions = {}): CheckupView => {
    const pinned=options.runKey?targets.get(options.runKey):undefined
    if(options.runKey&&!pinned)throw new Error('checkup_run_unknown')
    const target = pinned ?? d.resolveTarget(options), profile = d.store.profile(target), probe = d.store.probe(target)
    const stored=d.store.attempt(target)
    // A pin switch must not hide the cancel control for an already running test.
    const activeAttempt=!options.runKey && active?attempts.get(active.key):undefined
    const attempt=activeAttempt ?? attempts.get(checkupKey(target)) ?? (stored?.status==='running'?{...stored,status:'failed' as const,errorCode:'interrupted'}:stored)
    const data:CheckupView={ target,name:extractCheckupPersona(d.persona?.()??'').name,profile,attempt,suspectedChanged:!!probe?.suspectedChanged && (!profile||Date.parse(probe.testedAt)>Date.parse(profile.testedAt)),periodicProbe:d.store.readSettings().periodicProbe === true };return {...data,review:checkupReview(data)}
  }
  const interviewOptions = (target:CheckupTarget,full:boolean) => {
    const persona=extractCheckupPersona(d.persona?.()??''),executors=(d.executors?.().length??0)>0?['阿禾']:[]
    return {windowTokens:target.windowTokens,full,persona,executors,systemTokens:estimateTokens(interviewInstructions(target.provider,target.model,persona,executors))}
  }
  const receipt=(t:CheckupTarget,full:boolean)=>createHash('sha256').update(JSON.stringify([checkupKey(t),full,t.windowTokens,t.windowKnown])).digest('hex')
  const hold=(label:string)=>{try{return d.holdBusy?.(label)??(()=>{})}catch{return()=>{}}}
  const estimate = (o: CheckupOptions = {}) => { const t=d.resolveTarget(o),options=interviewOptions(t,!!o.full);return {...estimateInterview({...options,windowKnown:t.windowKnown}),targetKey:receipt(t,!!o.full)} }
  const runSample = async (s: CheckupSample,t:CheckupTarget,signal:AbortSignal) => {
    const deadline = AbortSignal.timeout(120_000)
    return abortable(d.run(s,t,AbortSignal.any([signal,deadline])),AbortSignal.any([signal,deadline]))
  }
  const start = (o: CheckupOptions = {}, caller:{operator?:boolean}={}) => {
    if (active) throw new Error('checkup_busy')
    const target = d.resolveTarget(o), key = checkupKey(target), abort = new AbortController()
    if(o.expectedTargetKey && o.expectedTargetKey!==receipt(target,!!o.full))throw new Error('checkup_target_changed')
    const options=interviewOptions(target,!!o.full),plan=buildInterviewPlan(options),samples=plan.samples
    const attempt: CheckupAttempt = {status:'running',completedRequests:0,totalRequests:samples.length,startedAt:now().toISOString()}
    d.store.prepareProfileWrite()
    d.store.claimManual(target,now().toISOString().slice(0,10),caller.operator===true)
    d.store.saveAttempt(target,attempt)
    attempts.set(key,attempt)
    targets.set(receipt(target,!!o.full),target)
    const release=hold('checkup')
    const run = async () => {
      try {
        const results: CheckupTurn[] = []
        for (const sample of samples) { abort.signal.throwIfAborted(); results.push(await runSample(sample,target,abort.signal)); attempt.completedRequests++; d.store.saveAttempt(target,attempt) }
        abort.signal.throwIfAborted()
        const scores=samples.map((sample,i)=>scoreInterview(sample,results[i]!,options.persona))
        if(!scores.some(s=>s.observed))throw Object.assign(new Error('no measurement'),{code:'no_measurement'})
        const summary=summarizeInterview(samples,scores)
        const stages=summary.stages
        const toolAccuracy=summary.business.ratio??0
        const textTimes = results.map(r=>r.firstTextMs).filter((n):n is number=>n!==null)
        const profile: CheckupProfile = {provider:target.provider,addressHash:addressHash(target.address),model:target.model,windowTokens:target.windowTokens,windowKnown:target.windowKnown,reliableFillRatio:summary.reliableFillRatio,memory:(summary.qualities.memory.ratio??0)>=.8?'good':(summary.qualities.memory.ratio??0)>=.5?'fair':'weak',stages,interview:{version:plan.version,name:options.persona.name,delegationAvailable:options.executors.length>0,reliableDay:summary.reliableDay,reliableTokens:summary.reliableTokens,qualities:summary.qualities,business:summary.business},tools:toolAccuracy>=.8?'stable':'flaky',toolAccuracy,firstTextMedianMs:textTimes.length?median(textTimes):null,completionMedianMs:median(results.map(r=>r.durationMs)),testedAt:now().toISOString(),ccVersion:d.version,short:!o.full,seed:plan.seed}
        d.store.save(target,profile)
        try { d.store.saveProbe(target,{testedAt:profile.testedAt,lastAttemptAt:profile.testedAt,suspectedChanged:false}) }
        catch { /* The complete measurement was committed; optional probe bookkeeping cannot undo it. */ }
        attempt.status='completed'
      } catch(e) { attempt.status=abort.signal.aborted?'cancelled':'failed'; if(attempt.status==='failed')attempt.errorCode=errorCode(e) }
      finally { attempt.finishedAt=now().toISOString(); active=null; try{d.store.saveAttempt(target,attempt)}catch{/* A storage failure must never overwrite the previous complete profile. */} try{release()}catch{} }
    }
    // Defer so cancel() can win before the very first session is spawned.
    const done = Promise.resolve().then(run)
    active={key,abort,done}
    return { done }
  }
  return {
    view,estimate,start,
    async prepareEstimate(o:CheckupOptions={}){await d.prepareTarget?.(o);return estimate(o)},
    cancel() { active?.abort.abort(new Error('cancelled')) },
    settings(enabled:boolean) { d.store.settings(enabled); return view() },
    contextBudgetFor(provider:string,model:string) { return d.store.contextBudgetFor(d.resolveTarget({providerId:provider,model}),model) },
    async stop() { active?.abort.abort(new Error('cancelled')); await active?.done },
    async probeIfDue() {
      if (active || d.store.readSettings().periodicProbe !== true) return
      const target=d.resolveTarget(), profile=d.store.profile(target), previous=d.store.probe(target)
      if (!profile || profile.interview?.version!=='interview-v1') return
      const lastAttemptAt = previous?.lastAttemptAt ?? previous?.testedAt ?? profile.testedAt
      const lastAttemptMs = Date.parse(lastAttemptAt)
      if (Number.isFinite(lastAttemptMs) && now().getTime()-lastAttemptMs < 7*86400_000) return
      d.store.prepareProfileWrite()
      const release=hold('checkup-probe')
      const abort=new AbortController(), key=checkupKey(target)
      const done=Promise.resolve().then(async()=>{
        try {
          // Record the spending attempt before calling a model. Network/auth failures
          // and cancellation keep the same weekly bound, including across restarts.
          const attemptedAt=now().toISOString()
          d.store.saveProbe(target,{testedAt:previous?.testedAt ?? profile.testedAt,lastAttemptAt:attemptedAt,suspectedChanged:!!previous?.suspectedChanged})
          const options=interviewOptions(target,false),plan=buildInterviewPlan(options)
          // Three tiny checkpoints from the same v1 day: recall, ask and handoff.
          const samples=plan.samples.slice(0,3),turns:CheckupTurn[]=[]
          for(const s of samples){abort.signal.throwIfAborted();turns.push(await runSample(s,target,abort.signal))}
          const scores=samples.map((s,i)=>scoreInterview(s,turns[i]!,options.persona))
          const memoryAccuracy=scores[0]!.qualities.memory?1:0,toolAccuracy=scores.slice(1).filter(s=>s.business).length/2
          const expectedMemory=profile.stages[0]?.accuracy??0
          const suspectedChanged=!!previous?.suspectedChanged || expectedMemory-memoryAccuracy>=.5 || profile.toolAccuracy-toolAccuracy>=.5
          abort.signal.throwIfAborted()
          d.store.saveProbe(target,{testedAt:now().toISOString(),lastAttemptAt:attemptedAt,suspectedChanged})
        } catch { /* Infrastructure failure provides no evidence that the model changed. */ }
        finally { active=null;try{release()}catch{} }
      })
      active={key,abort,done}; await done
    },
  }
}
export type CheckupService = ReturnType<typeof makeCheckupService>
