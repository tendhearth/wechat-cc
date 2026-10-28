import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import WORKBENCH_ROUTES from './src-tauri/generated/workbench-routes.json'

// 放行名单是生成物(重构第二批 5a):路由表 packages/protocol/src/routes.ts 里 `desktop.devProxy` 的行,
// `bun run gen:routes` 写进这份 JSON;lib.rs 读同一份文件的 `tauri` 名单。别在这里手加。
const ROUTES:ReadonlySet<string> = new Set(WORKBENCH_ROUTES.devProxy)
interface Options {
  stateDir:string; dryRun:boolean; allowWrites:boolean
  fetch?:(url:string,init?:RequestInit)=>Promise<Response>
}
/** Enforce byte limits while reading, before any concatenation or upstream request. */
async function boundedBody(req:Request,maxBytes:number):Promise<string> {
  if(Number(req.headers.get('content-length'))>maxBytes){void req.body?.cancel().catch(()=>{});throw Error('request_body_too_large')}
  if(!req.body)return ''
  const reader=req.body.getReader(),chunks:Buffer[]=[]
  let bytes=0
  try {
    for(;;){
      const next=await reader.read()
      if(next.done)break
      bytes+=next.value.byteLength
      if(bytes>maxBytes){chunks.length=0;void reader.cancel().catch(()=>{});throw Error('request_body_too_large')}
      chunks.push(Buffer.from(next.value))
    }
    return Buffer.concat(chunks,bytes).toString('utf8')
  }finally{reader.releaseLock()}
}
/** Development counterpart of the native host proxy; never expose its token to JS. */
export function createWorkbenchProxy(opts:Options) {
  return async (req:Request):Promise<Response|null> => {
    const url=new URL(req.url)
    // /v1/connections(此刻的连接浮层)、/v1/phone/*(连接手机)、/v1/cli/sessions(此刻里的终端会话)也走这里;mock 模式下交给 test-shim 的演示路由。
    // 架构终态 F6 起,桌面不再起 CLI 读的那些主人私事(记忆页、对话页、会话名单 ……)也是:名单里有、又不是工作台的,一律按这一类。
    const isWorkbench=url.pathname==='/v1/workbench'||url.pathname.startsWith('/v1/workbench/')
    const ownerSurface=url.pathname==='/v1/connections'||url.pathname.startsWith('/v1/phone/')||url.pathname==='/v1/cli/sessions'||url.pathname.startsWith('/v1/cli/hooks/')
      ||(!isWorkbench&&ROUTES.has(`${req.method} ${url.pathname}`))
    if(!ownerSurface&&!isWorkbench)return null
    if(ownerSurface&&opts.dryRun)return null
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return Response.json({error:'forbidden'},{status:403})
    const origin=req.headers.get('origin'), site=req.headers.get('sec-fetch-site')
    if((origin&&origin!==url.origin)||(site&&!['same-origin','none'].includes(site)))return Response.json({error:'forbidden'},{status:403})
    if(!ROUTES.has(`${req.method} ${url.pathname}`))return Response.json({error:'method_not_allowed'},{status:405})
    if(opts.dryRun)return Response.json({error:'workbench_not_wired_in_mock'},{status:503})
    if(req.method!=='GET'&&!opts.allowWrites)return Response.json({error:'workbench_read_only_preview'},{status:403})
    try {
      const body=req.method==='POST'?await boundedBody(req,url.pathname==='/v1/workbench/attachment'?12*1024*1024:128*1024):undefined
      const info=JSON.parse(await readFile(join(opts.stateDir,'internal-api-info.json'),'utf8'))
      const base=new URL(info.baseUrl)
      if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||!info.operatorTokenFilePath)throw new Error('invalid_info')
      const token=(await readFile(info.operatorTokenFilePath,'utf8')).trim()
      const res=await (opts.fetch??fetch)(base.origin+url.pathname+url.search,{
        method:req.method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
        ...(body!==undefined?{body}:{}),signal:AbortSignal.timeout(30_000),
      })
      if(res.status===404&&url.pathname==='/v1/workbench')return Response.json({error:'workbench_endpoint_missing'},{status:404})
      return new Response(await res.text(),{status:res.status,headers:{'content-type':'application/json'}})
    } catch(error) {
      if(error instanceof Error&&error.message==='request_body_too_large')return Response.json({error:'request_body_too_large'},{status:413})
      return Response.json({error:'workbench_connection_unavailable'},{status:502})
    }
  }
}
