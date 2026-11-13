import type { RouteTable, RouteHandler } from '../../daemon/internal-api/types'
import type { CheckupOptions, CheckupService } from './service'
const owner = (c:Parameters<RouteHandler>[2]) => c?.tier==='admin' && (c.origin==='operator'||c.origin==='device')
function options(value:unknown):CheckupOptions|null {
  if(!value || typeof value!=='object' || Array.isArray(value))return null
  const b=value as Record<string,unknown>
  if(Object.keys(b).some(k=>!['full','providerId','model','expectedTargetKey'].includes(k)) || (b.expectedTargetKey!==undefined&&(typeof b.expectedTargetKey!=='string'||!/^[a-f0-9]{64}$/.test(b.expectedTargetKey))) || (b.full!==undefined && typeof b.full!=='boolean') || (b.providerId!==undefined && (typeof b.providerId!=='string'||!/^[a-z][a-z0-9._-]{0,63}$/.test(b.providerId))) || (b.model!==undefined && (typeof b.model!=='string'||!b.model.trim()||b.model.length>200)))return null
  return b as CheckupOptions
}
export function checkupRoutes(service:CheckupService):RouteTable {
  const handlers:RouteTable = {
    'GET /v1/checkup': q=>{
      const runKey=q.get('run')
      if(runKey){
        if(!/^[a-f0-9]{64}$/.test(runKey))return {status:400,body:{error:'checkup_invalid_request'}}
        try{return {status:200,body:service.view({runKey})}}
        catch(e){if(e instanceof Error&&e.message==='checkup_run_unknown')return {status:404,body:{error:'checkup_run_unknown'}};throw e}
      }
      const o=options({...q.has('provider')?{providerId:q.get('provider')!}:{},...q.has('model')?{model:q.get('model')!}:{}})
      return o?{status:200,body:service.view(o)}:{status:400,body:{error:'checkup_invalid_request'}}
    },
    'POST /v1/checkup/estimate':async(_q,b)=>{const o=options(b);return o?{status:200,body:await service.prepareEstimate(o)}:{status:400,body:{error:'checkup_invalid_request'}}},
    'POST /v1/checkup/run':(_q,b,c)=>{
      const o=options(b);if(!o?.expectedTargetKey)return {status:400,body:{error:'checkup_invalid_request'}}
      try { service.start(o,{operator:c?.origin==='operator'});return {status:202,body:service.view(o)} }
      catch(e){if(e instanceof Error&&e.message==='checkup_rate_limited')return {status:429,body:{error:e.message}};if(e instanceof Error && ['checkup_busy','checkup_target_changed'].includes(e.message))return {status:409,body:{error:e.message}};throw e}
    },
    'POST /v1/checkup/cancel':()=>{service.cancel();return {status:200,body:service.view()}},
    'POST /v1/checkup/settings':(_q,b)=>{
      if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==1||!('periodicProbe'in b)||typeof b.periodicProbe!=='boolean')return {status:400,body:{error:'checkup_invalid_request'}}
      return {status:200,body:service.settings(b.periodicProbe)}
    },
  }
  return Object.fromEntries(Object.entries(handlers).map(([key,handler])=>[key,async(q,b,c,ctx)=> owner(c) && !(c?.origin==='device'&&(q.has('provider')||q.has('model')||!!b&&typeof b==='object'&&('providerId' in b||'model' in b))) ? handler!(q,b,c,ctx) : {status:403,body:{error:'forbidden'}}]))
}
