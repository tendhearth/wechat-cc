import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

const ROUTES = new Set([
  'GET /v1/workbench','GET /v1/workbench/sessions','GET /v1/workbench/session','GET /v1/workbench/task','GET /v1/workbench/artifact',
  'POST /v1/workbench/create','POST /v1/workbench/continue','POST /v1/workbench/cancel','POST /v1/workbench/approve','POST /v1/workbench/permission','POST /v1/workbench/archive',
  'POST /v1/workbench/import',
  'POST /v1/workbench/prepare-resume',
])
interface Options {
  stateDir:string; dryRun:boolean; allowWrites:boolean
  fetch?:(url:string,init?:RequestInit)=>Promise<Response>
}
/** Development counterpart of the native host proxy; never expose its token to JS. */
export function createWorkbenchProxy(opts:Options) {
  return async (req:Request):Promise<Response|null> => {
    const url=new URL(req.url)
    if(url.pathname!=='/v1/workbench'&&!url.pathname.startsWith('/v1/workbench/'))return null
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return Response.json({error:'forbidden'},{status:403})
    const origin=req.headers.get('origin'), site=req.headers.get('sec-fetch-site')
    if((origin&&origin!==url.origin)||(site&&!['same-origin','none'].includes(site)))return Response.json({error:'forbidden'},{status:403})
    if(!ROUTES.has(`${req.method} ${url.pathname}`))return Response.json({error:'method_not_allowed'},{status:405})
    if(opts.dryRun)return Response.json({error:'workbench_not_wired_in_mock'},{status:503})
    if(req.method!=='GET'&&!opts.allowWrites)return Response.json({error:'workbench_read_only_preview'},{status:403})
    try {
      const info=JSON.parse(await readFile(join(opts.stateDir,'internal-api-info.json'),'utf8'))
      const base=new URL(info.baseUrl)
      if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||!info.operatorTokenFilePath)throw new Error('invalid_info')
      const token=(await readFile(info.operatorTokenFilePath,'utf8')).trim()
      const res=await (opts.fetch??fetch)(base.origin+url.pathname+url.search,{
        method:req.method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
        ...(req.method==='POST'?{body:await req.text()}:{}),signal:AbortSignal.timeout(30_000),
      })
      if(res.status===404&&url.pathname==='/v1/workbench')return Response.json({error:'workbench_endpoint_missing'},{status:404})
      return new Response(await res.text(),{status:res.status,headers:{'content-type':'application/json'}})
    } catch { return Response.json({error:'workbench_connection_unavailable'},{status:502}) }
  }
}
