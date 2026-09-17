import type {ListMatters,MatterKind,MatterStatus} from '../../core/matters/store'
import type {InternalApiDeps,RouteTable} from './types'

/**
 * routes-matters — 「一件事」的三条路由(docs/cc-workbench.md「一件事」,2026-09-16)。
 * 各表面共用:桌面现在就能调,手机端经隧道调同一份。全部 admin 档(route-tiers),
 * operator 凭据放行(token-registry)。查询参数风格沿用 workbench:`?id=`,不走路径参数。
 */
const ID=/^[a-f0-9]{8}$/
const KINDS=new Set<string>(['chat','task','companion']),STATUSES=new Set<string>(['open','replied','done','archived'])
const invalid=()=>({status:400,body:{error:'invalid_request'}})
const known=(message:string)=>/^(invalid_|matter_|workbench_|chat_)/.test(message)

export function mattersRoutes(deps:InternalApiDeps):RouteTable {
  return {
    'GET /v1/matters': async query => {
      for(const key of ['kind','status','since','limit'])if(query.getAll(key).length>1)return invalid()
      const kind=query.get('kind'),status=query.get('status'),since=query.get('since'),limit=query.get('limit')
      if((kind!==null&&!KINDS.has(kind))||(status!==null&&status.split(',').some(s=>!STATUSES.has(s)))||(since!==null&&!/^\d+$/.test(since))||(limit!==null&&(!/^\d+$/.test(limit)||Number(limit)<1||Number(limit)>200)))return invalid()
      if(!deps.matters)return {status:503,body:{error:'matters_not_wired'}}
      const filter:ListMatters={
        ...(kind!==null?{kind:kind as MatterKind}:{}),
        ...(status!==null?{statuses:status.split(',') as MatterStatus[]}:{}),
        ...(since!==null?{since:Number(since)}:{}),
        ...(limit!==null?{limit:Number(limit)}:{}),
      }
      return {status:200,body:{matters:deps.matters.list(filter)}}
    },
    'GET /v1/matter': async query => {
      const id=query.get('id')
      if(query.getAll('id').length!==1||!id||!ID.test(id))return invalid()
      if(!deps.matters)return {status:503,body:{error:'matters_not_wired'}}
      try{return {status:200,body:deps.matters.detail(id)}}
      catch(error){const message=error instanceof Error?error.message:'internal';return message==='matter_not_found'?{status:404,body:{error:message}}:known(message)?{status:400,body:{error:message}}:{status:500,body:{error:'internal'}}}
    },
    'POST /v1/matter/say': async (_query,body) => {
      const input=body&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:null
      const id=input?.id,text=input?.text
      if(typeof id!=='string'||!ID.test(id)||typeof text!=='string'||!text.trim()||text.length>20_000)return invalid()
      if(!deps.matters)return {status:503,body:{error:'matters_not_wired'}}
      try{return {status:200,body:await deps.matters.say(id,text)}}
      catch(error){
        const message=error instanceof Error?error.message:'internal'
        if(message==='matter_not_found')return {status:404,body:{error:message}}
        if(message==='workbench_busy'||message==='reply_sink_busy')return {status:409,body:{error:message}}
        return known(message)?{status:400,body:{error:message}}:{status:500,body:{error:'internal'}}
      }
    },
  }
}
