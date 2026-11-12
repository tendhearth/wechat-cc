import {expect,it} from 'vitest'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openTestDb} from '../../lib/db'
import {makeMatterStore} from '../../adapters/store/matters-store'
import {makeWorkbenchStore} from '../../adapters/store/workbench/store'
import {createProviderRegistry} from '../../app/provider-registry'
import {makeMattersService} from '../../app/matters/service'
import {createInternalApi} from '../../daemon/internal-api'
import {makeWorkbenchService} from './service'
import {workbenchRoutes} from './routes'
import {makeSettingsPanel} from '../phone/settings-panel'

it('real authenticated HTTP protects every detail and notebook read, including long polls and forged executor scope',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cc-ledger-http-')),db=openTestDb(),matters=makeMatterStore(db),store=makeWorkbenchStore(db)
  const workbench=makeWorkbenchService({store,registry:createProviderRegistry(),stateDir:dir,ownerChatId:()=>'owner',matters})
  const api=createInternalApi({stateDir:dir,daemonPid:7777,resolveAdminChatId:()=>'owner',matters:makeMattersService({store:matters,workbench,ownerChatId:()=>'owner'})})
  try{
    const task=store.create({title:'task',providerId:'codex',ownerChatId:'owner',path:'/projects/ledger'})
    store.update(task.id,'completed');store.ledger.start(task.id,'first','codex','plan');store.ledger.note(task.id,'first','codex','LEDGER_HTTP_PRIVATE_CANARY')
    store.ledger.finish(task.id,'first','completed','')
    const other=store.create({title:'other',providerId:'claude',ownerChatId:'owner',path:'/projects/other'})
    const foreign=store.create({title:'foreign',providerId:'claude',ownerChatId:'another-owner',path:'/projects/foreign'})
    store.ledger.start(foreign.id,'foreign','claude','FOREIGN_LEDGER_CANARY')
    api.mount('workbench',workbenchRoutes({workbench,resolveAdminChatId:()=>'owner'}))
    const {port,operatorTokenFilePath}=await api.start()
    const owner=api.mintSessionToken('admin','claude/default/owner'),admin=api.mintSessionToken('admin','claude/default/other'),guest=api.mintSessionToken('guest','claude/default/owner')
    const operator=readFileSync(operatorTokenFilePath,'utf8').trim()
    const executor=api.mintSessionToken('trusted',`workbench/${task.id}`,{routeAllow:new Set(['GET /v1/matter/notes','POST /v1/matter/note'])})
    const get=async(path:string,token:string)=>{const r=await fetch(`http://127.0.0.1:${port}${path}`,{headers:{authorization:`Bearer ${token}`}});return {status:r.status,body:await r.json()}}
    for(const token of [owner,operator]){
      const r=await get(`/v1/matter/notes?matter=${task.id}`,token)
      expect(r.status).toBe(200);expect(JSON.stringify(r.body)).toContain('LEDGER_HTTP_PRIVATE_CANARY')
    }
    for(const path of [`/v1/matter?id=${foreign.id}`,`/v1/workbench/task?id=${foreign.id}`])expect(JSON.stringify((await get(path,owner)).body)).not.toContain('FOREIGN_LEDGER_CANARY')
    for(const token of [admin,guest]){
      expect((await get(`/v1/matter/notes?matter=${task.id}`,token)).status).toBe(403)
      for(const path of [`/v1/matter?id=${task.id}`,`/v1/workbench/task?id=${task.id}`,`/v1/workbench/task?id=${task.id}&since=0&wait_ms=1`,`/v1/workbench/task?id=${task.id}&since_cursor=0&wait_ms=1`]){
        expect(JSON.stringify((await get(path,token)).body)).not.toContain('LEDGER_HTTP_PRIVATE_CANARY')
      }
    }
    for(const token of [owner,operator])for(const path of [`/v1/matter?id=${task.id}`,`/v1/workbench/task?id=${task.id}`])expect(JSON.stringify((await get(path,token)).body)).toContain('LEDGER_HTTP_PRIVATE_CANARY')
    const panel=makeSettingsPanel({stateDir:dir,ownerChatId:()=>'owner',chatPrefs:{get:()=>({}),set:()=>({})},getUserName:()=>null,setUserName:async()=>{},log:()=>{},tokens:api.panelTokens,v1:api.panelDispatch})
    try{
      let link=panel.issueToken()
      const paired=await panel.handleRequest(new Request(`http://127.0.0.1:1/set/api/pair?t=${link}`,{method:'POST'}))
      expect(paired.status).toBe(200)
      const device=(await paired.json() as {device_token:string}).device_token
      link=panel.issueToken()
      for(const route of ['/v1/matter','/m/api/matter'])for(const [token,param,visible]of [[device,'d',true],[link,'t',false]] as const){
        const r=await panel.handleRequest(new Request(`http://127.0.0.1:1${route}?id=${task.id}&${param}=${token}`))
        expect(r.status).toBe(200)
        expect(JSON.stringify(await r.json()).includes('LEDGER_HTTP_PRIVATE_CANARY')).toBe(visible)
      }
    }finally{await panel.stop()}
    expect(JSON.stringify((await get('/v1/matter/notes',executor)).body)).toContain('LEDGER_HTTP_PRIVATE_CANARY')
    expect((await get(`/v1/matter/notes?matter=${other.id}`,executor)).status).toBe(403)
    expect((await get(`/v1/matter?id=${task.id}`,executor)).status).toBe(403)
    expect((await get('/v1/matter/owner-chat',executor)).status).toBe(403)
    expect((await get('/v1/health',executor)).status).toBe(403)
  }finally{await api.stop({unlinkToken:true});await workbench.shutdown();db.close();rmSync(dir,{recursive:true,force:true})}
})
