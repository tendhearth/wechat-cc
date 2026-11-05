import type { ListMatters, MatterKind, MatterSurface } from '../../ports/matters'
import { LEGACY_MATTER_STATUSES, type LegacyMatterStatus, type WireMatter } from '../../domain/matters/legacy-status'
import type { MatterSayInput } from '../../app/matters/service'
import {MATTER_KINDS} from '@wechat-cc/protocol'
import {framedTooLargeFor,withoutOldNarrationFor,withoutReplyExtras} from '../../domain/matters/phone-scope'
import type {InternalApiDeps,RouteHandler,RouteTable} from './types'

/**
 * routes-matters — 「一件事」的路由(docs/cc-workbench.md「一件事」,2026-09-16)。
 * 各表面共用:桌面经宿主代理用 operator 凭据调;手机的设备 / 链接令牌从设置面板那一口进来也是这几条(P3c-1,
 * 设计稿 2026-11-05-p3-one-route-family —— 老 App / 网页读的 `/m/api/*` 是别名,src/features/phone/legacy-routes.ts 翻过来)。
 * 查询参数风格沿用 workbench:`?id=`,不走路径参数。
 *
 * 手机令牌看到的范围按 caller 收,一处一个函数(domain/matters/phone-scope.ts),不看路径:
 *   - 能看哪些:device / link 只见主人能在手机上打开的(别人的聊天不给,按 id 打开也回「没有这件」);operator 见全部;
 *   - 链接令牌读得少一点:详情去掉 replyExtras / messageId;
 *   - 帧预算:从面板进来的(caller.frameBudget)详情按帧裁旁白,还装不下 ⇒ 413 detail_too_large;
 *   - 出生地:手机令牌读列表 / 详情记一次「在手机露过面」;说一句按手机表面说(附件策略、出生地)。
 */
const ID=/^[a-f0-9]{8}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const KINDS=new Set<string>(MATTER_KINDS),STATUSES=new Set<string>(LEGACY_MATTER_STATUSES),SURFACES=new Set<string>(['wechat','desktop','phone','cli'])
const invalid=()=>({status:400,body:{error:'invalid_request'}})
const known=(message:string)=>/^(invalid_|matter_|workbench_|chat_)/.test(message)
type Caller=Parameters<RouteHandler>[2]
/** 手机设置面板那一口的令牌(设备 / 链接)。 */
const fromPhone=(caller:Caller)=>caller?.origin==='device'||caller?.origin==='link'
/** 筛过之后最多取多少再截(手机看别人的聊天要筛掉,不能先截后筛)。 */
const FILTER_FETCH=200

/**
 * 列表每件任务带上任务真正的状态(设计稿 2026-10-31 U5):matter 的 open / done 说不清「停下了」(重启打断的仍是 open)、
 * 「没做成」(失败也记 done)和「等你」。逐件读本机详情,一次 8 件;读不到的那件不带,不让整张列表失败。
 */
async function withTaskState(source:{detail(id:string):unknown},rows:unknown[]):Promise<unknown[]> {
  const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
  const out:unknown[]=[]
  for(let start=0;start<rows.length;start+=8){
    out.push(...await Promise.all(rows.slice(start,start+8).map(async row=>{
      if(!obj(row)||row.kind!=='task'||typeof row.id!=='string')return row
      try{
        const d=await source.detail(row.id)
        if(!obj(d)||!obj(d.task)||typeof d.task.status!=='string')return row
        const own=(key:string)=>Array.isArray(d[key])?(d[key] as unknown[]).filter(r=>obj(r)&&r.taskId===row.id).length:0
        return {...row,taskState:{status:d.task.status,...(typeof d.task.phase==='string'?{phase:d.task.phase}:{}),pending:own('permissions')+own('questions')}}
      }catch{return row}
    })))
  }
  return out
}

/**
 * 说一句的可选材料(手机:回执 id / 这一轮 / 草稿 / 附件)。不对 ⇒ 抛 invalid_request / invalid_attachment。
 * 别的键照旧不看(桌面一直是这样);手机别名那边先按手机的规矩(多一个键就拒)验过。
 */
function sayInput(body:Record<string,unknown>):MatterSayInput|undefined {
  if(body.requestId===undefined&&body.runId===undefined&&body.draftId===undefined&&body.attachmentIds===undefined)return undefined
  if(typeof body.requestId!=='string'||!UUID.test(body.requestId)||(body.runId!==undefined&&(typeof body.runId!=='string'||!UUID.test(body.runId)))||(body.draftId!==undefined&&(typeof body.draftId!=='string'||!UUID.test(body.draftId))))throw Error('invalid_request')
  let ids:string[]|undefined
  if(body.attachmentIds!==undefined){
    if(!Array.isArray(body.attachmentIds)||body.attachmentIds.length>8||body.attachmentIds.some(id=>typeof id!=='string'||!UUID.test(id)))throw Error('invalid_attachment')
    ids=body.attachmentIds.map(id=>(id as string).toLowerCase());if(new Set(ids).size!==ids.length)throw Error('invalid_attachment')
  }
  return {requestId:body.requestId.toLowerCase(),...(body.runId!==undefined?{runId:(body.runId as string).toLowerCase()}:{}),...(body.draftId!==undefined?{draftId:(body.draftId as string).toLowerCase()}:{}),...(ids?{attachmentIds:ids}:{})}
}

export function mattersRoutes(deps:InternalApiDeps):RouteTable {
  return {
    // 可选参数(P3c-1,手机别名要的那几样,谁都能用):exclude=<kind,…> 不要这几类;taskState=1 任务行带任务真正的状态;
    // kind=act ⇒ act 行带发起方与最近那一轮。筛了(手机令牌 / exclude)⇒ 先取 200 再筛,limit 截的是筛过的。
    'GET /v1/matters': async (query,_body,caller) => {
      for(const key of ['kind','status','since','limit','surface','exclude','taskState'])if(query.getAll(key).length>1)return invalid()
      const kind=query.get('kind'),status=query.get('status'),since=query.get('since'),limit=query.get('limit'),surface=query.get('surface'),exclude=query.get('exclude'),taskState=query.get('taskState')
      if((surface!==null&&!SURFACES.has(surface))||(kind!==null&&!KINDS.has(kind))||(status!==null&&status.split(',').some(s=>!STATUSES.has(s)))||(since!==null&&!/^\d+$/.test(since))||(limit!==null&&(!/^\d+$/.test(limit)||Number(limit)<1||Number(limit)>200)))return invalid()
      if((exclude!==null&&exclude.split(',').some(k=>!KINDS.has(k)))||(taskState!==null&&taskState!=='1'))return invalid()
      if(!deps.matters)return {status:503,body:{error:'matters_not_wired'}}
      const service=deps.matters,phone=fromPhone(caller),drop=new Set(exclude?exclude.split(','):[])
      const filtering=phone||drop.size>0
      const filter:ListMatters={
        ...(kind!==null?{kind:kind as MatterKind}:{}),
        ...(status!==null?{legacy:status.split(',') as LegacyMatterStatus[]}:{}),
        ...(since!==null?{since:Number(since)}:{}),
        ...(filtering?{limit:FILTER_FETCH}:limit!==null?{limit:Number(limit)}:{}),
        ...(surface!==null?{surface:surface as MatterSurface}:{}),
      }
      let rows:WireMatter[]=service.list(filter)
      if(filtering){
        // 手机令牌:别人的聊天 matter(updated_at 会被微信入站推高)不给,也不挤掉任务
        rows=rows.filter(m=>(!phone||service.phoneMayOpen(m))&&!drop.has(m.kind))
        if(limit!==null)rows=rows.slice(0,Number(limit))
      }
      // 网络守护冻住的那几件(2026-10-03):手机显示「已暂停(网络未受保护)」。matter 与工作台任务同 id。
      let frozen=new Set<string>()
      try{frozen=new Set((deps.workbenchSuspended?.()??[]).map(t=>t.taskId))}catch{/* 只是少一个标记 */}
      rows=rows.map(m=>frozen.has(m.id)?{...m,networkSuspended:true as const}:m)
      // 「CC 最近在忙」(M5c):点名要 act 的才去读轮(一件一两次查询);不点名不碰轮
      if(kind==='act')rows=service.withActs(rows)
      if(phone)for(const m of rows){try{service.seenOnPhone(m.id)}catch{/* 只是露面登记 */}}
      return {status:200,body:{matters:taskState==='1'?await withTaskState(service,rows):rows}}
    },
    'GET /v1/matter/owner-chat': async () => {
      if(!deps.matters)return {status:503,body:{error:'matters_not_wired'}}
      try{const d=await deps.matters.ownerChat('desktop');return d?{status:200,body:d}:{status:404,body:{error:'owner_chat_not_configured'}}}
      catch(error){const message=error instanceof Error?error.message:'internal';return known(message)?{status:400,body:{error:message}}:{status:500,body:{error:'internal'}}}
    },
    'GET /v1/matter/owner-chat/file': async query => {
      const allowed=['id','i','offset','sha256','size']
      if([...query.keys()].some(k=>!allowed.includes(k)||query.getAll(k).length!==1))return invalid()
      const id=query.get('id'),i=query.get('i'),offset=query.get('offset')??'0',sha256=query.get('sha256'),size=query.get('size')
      if(!id||id.length>200||/[\x00-\x1f]/.test(id)||i===null||!/^\d{1,2}$/.test(i)||!/^\d{1,9}$/.test(offset)||(sha256!==null&&!/^[a-f0-9]{64}$/.test(sha256))||(size!==null&&(!/^\d{1,9}$/.test(size)||Number(size)>20*1024*1024)))return invalid()
      if(!deps.matters)return {status:503,body:{error:'matters_not_wired'}}
      try{return await deps.matters.ownerChatFile({id,i:Number(i),offset:Number(offset),...(sha256?{sha256}:{}),...(size!==null?{size:Number(size)}:{})})}
      catch{return {status:503,body:{error:'unavailable'}}}
    },
    // 在主人那条对话里搜(2026-10-06):q 1–200 字,limit ≤ 50,新的在前。
    'GET /v1/matter/owner-chat/search': async query => {
      const q=query.get('q')??'',limit=Number(query.get('limit')??'30')
      if(query.getAll('q').length!==1||!q.trim()||q.length>200||!Number.isFinite(limit))return invalid()
      if(!deps.matters)return {status:503,body:{error:'matters_not_wired'}}
      try{const r=await deps.matters.searchOwnerChat(q,limit);return r?{status:200,body:r}:{status:404,body:{error:'owner_chat_not_configured'}}}
      catch(error){const message=error instanceof Error?error.message:'internal';return message==='invalid_query'?invalid():{status:500,body:{error:'internal'}}}
    },
    'GET /v1/matter': async (query,_body,caller) => {
      const id=query.get('id')
      if(query.getAll('id').length!==1||!id||!ID.test(id))return invalid()
      if(!deps.matters)return {status:503,body:{error:'matters_not_wired'}}
      const service=deps.matters
      let detail:Awaited<ReturnType<typeof service.detail>>
      try{detail=await service.detail(id)}
      catch(error){const message=error instanceof Error?error.message:'internal';return message==='matter_not_found'?{status:404,body:{error:message}}:known(message)?{status:400,body:{error:message}}:{status:500,body:{error:'internal'}}}
      if(!fromPhone(caller)){
        // 桌面读这件事的详情 = 在电脑上看过了(S3b):先只在桌面提示的那一件到点就不再推手机
        try{deps.desktopSeen?.(id)}catch{/* 只是记一笔 */}
        return {status:200,body:detail}
      }
      // 手机令牌:跟列表同一条规矩,别人的聊天按 id 也打不开,回得跟「没有这件」一样(不让人拿 id 试探)
      if(!service.phoneMayOpen(detail.matter))return {status:404,body:{error:'matter_not_found'}}
      try{service.seenOnPhone(id)}catch{/* 只是露面登记 */}
      const scoped=caller?.origin==='link'?withoutReplyExtras(detail):detail
      if(caller?.frameBudget===undefined)return {status:200,body:scoped}
      const fitted=withoutOldNarrationFor(scoped,caller.frameBudget)
      return framedTooLargeFor(fitted,caller.frameBudget)?{status:413,body:{error:'detail_too_large'}}:{status:200,body:JSON.parse(fitted)}
    },
    // 可选材料(P3c-1,手机从这里说):requestId / runId / draftId / attachmentIds,规矩同工作台输入回执;带附件时 text 可以空。
    // 手机令牌按手机表面说(附件按主人那一份查、出生地按传输);错误回包带 cause(原始码),手机别名据此换成手机那一列。
    'POST /v1/matter/say': async (_query,body,caller) => {
      const input=body&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:null
      const id=input?.id,text=input?.text
      if(typeof id!=='string'||!ID.test(id)||typeof text!=='string'||text.length>20_000)return invalid()
      let extra:MatterSayInput|undefined
      try{extra=sayInput(input!)}catch(error){const code=(error as Error).message;return {status:400,body:{error:code},cause:code}}
      if(!text.trim()&&!extra?.attachmentIds?.length)return invalid()
      if(!deps.matters)return {status:503,body:{error:'matters_not_wired'}}
      const surface=fromPhone(caller)?'phone' as const:undefined
      try{return {status:200,body:await (surface||extra?deps.matters.say(id,text,surface,extra):deps.matters.say(id,text))}}
      catch(error){
        const message=error instanceof Error?error.message:'internal'
        // 只带码一样的原始码(不带消息原文:路径之类漏不出去 —— 虽然 cause 本来就不出面板)
        const cause=error instanceof Error&&/^[a-z][a-z0-9_]{0,63}$/.test(message)?{cause:message}:{}
        if(message==='matter_not_found')return {status:404,body:{error:message},...cause}
        if(message==='workbench_busy'||message==='reply_sink_busy')return {status:409,body:{error:message},...cause}
        return known(message)?{status:400,body:{error:message},...cause}:{status:500,body:{error:'internal'},...cause}
      }
    },
  }
}
