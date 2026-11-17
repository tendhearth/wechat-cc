import type { CheckupEstimate, CheckupView } from '@wechat-cc/protocol'
export interface CheckupCliOptions { full?:boolean;providerId?:string;model?:string;estimateOnly?:boolean;signal?:AbortSignal }
export interface CheckupCliDeps {
  request(method:'GET'|'POST',path:string,body?:object):Promise<unknown>
  estimate(value:CheckupEstimate):void
  sleep(ms:number):Promise<void>
}
/** eval run's CLI/daemon split: CLI displays cost and polls; the daemon owns provider calls and archive. */
export async function runCheckupCli(d:CheckupCliDeps,o:CheckupCliOptions={}) {
  const body={full:!!o.full,...o.providerId?{providerId:o.providerId}:{},...o.model?{model:o.model}:{}}
  const quote=await d.request('POST','/v1/checkup/estimate',body) as CheckupEstimate
  d.estimate(quote)
  if(o.estimateOnly)return {estimate:quote}
  o.signal?.throwIfAborted()
  let view=await d.request('POST','/v1/checkup/run',{...body,expectedTargetKey:quote.targetKey}) as CheckupView
  const query=new URLSearchParams({run:quote.targetKey})
  let cancelled=false
  while(view.attempt?.status==='running') {
    if(o.signal?.aborted && !cancelled){await d.request('POST','/v1/checkup/cancel',{});cancelled=true}
    if(!cancelled)await d.sleep(500)
    view=await d.request('GET',`/v1/checkup${query.size?'?'+query:''}`) as CheckupView
    if(!view.attempt)throw new Error('checkup_run_unknown')
  }
  return {view}
}
