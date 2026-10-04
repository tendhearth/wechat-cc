import {afterEach,describe,expect,it,vi} from 'vitest'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildPipelineDeps} from './pipeline-deps'
import {Ref} from '../../lib/lifecycle'
import {openTestDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {makeReplySinks} from '../reply-sinks'
import {mobileReadsRoute,type MobileReadsDeps} from '../mobile-reads'
import type {Bootstrap} from '../bootstrap'
import type {PipelineDepsOpts} from './pipeline-deps'

const panel=vi.hoisted(()=>({deps:null as MobileReadsDeps|null}))
vi.mock('../settings-panel',()=>({makeSettingsPanel:(deps:MobileReadsDeps)=>{panel.deps=deps;return{}}}))
vi.mock('../../lib/access',async(importOriginal)=>({
  ...(await importOriginal<typeof import('../../lib/access')>()),
  loadAccess:()=>({dmPolicy:'allowlist',admins:['owner'],allowFrom:['owner']}),isAdmin:(id:string)=>id==='owner',
}))
const resources:Array<{dir:string;db:Db}>=[]
afterEach(()=>{for(const {dir,db} of resources.splice(0)){db.close();removeTempDir(dir)};panel.deps=null})
function setup(workbench?:PipelineDepsOpts['workbench']){
  const dir=mkdtempSync(join(tmpdir(),'pipeline-native-history-')),db=openTestDb();resources.push({dir,db})
  const boot={
    sessionManager:{isInFlight:()=>false},sessionStore:{},conversationStore:{upsertIdentity(){}},
    registry:{get:()=>undefined,list:()=>[],getCheapEval:()=>null,has:()=>false},
    coordinator:{dispatch:async()=>{},getMode:()=>({kind:'solo',provider:'claude'}),cancel:()=>false},resolve:()=>null,
    formatInbound(){},sdkOptionsForProject(){},buildInstructions:()=>'',defaultProviderId:'claude',agentProviderKind:'claude',dispatchDelegate(){},
    a2aServer:null,agentConfig:{bot_name:null},health:{health:{shouldSuspend:()=>false,get:()=>({consecutiveFailures:0})}},
  } as unknown as Bootstrap
  buildPipelineDeps({stateDir:dir,db,boot,ilink:{} as PipelineDepsOpts['ilink'],log(){},
    chatPrefs:{get:()=>({}),set:()=>({}),list:()=>[]},careLedger:{} as PipelineDepsOpts['careLedger'],replySinks:makeReplySinks(),...(workbench?{workbench}:{})},
    {polling:new Ref('polling'),guard:new Ref('guard'),pipeline:new Ref('pipeline'),ingestNudge:new Ref('ingestNudge')})
  return panel.deps!
}

describe('phone history wiring uses the public read-only workbench facade',()=>{
  it('wires recent and start independently, single-flights the recent window and forwards searched pages',async()=>{
    const preview={session:{key:'key',providerId:'claude',title:'Session',cwd:'/private/project',updatedAt:1,observedState:'active'},messages:[],nextCursor:null,managedTaskId:'managed'}
    const listNativeHistory=vi.fn(async()=>({items:[],nextCursor:null,coverage:'native_supported_history'})),readNativeHistory=vi.fn(async()=>preview),readRecentNativeHistory=vi.fn(async()=>preview)
    const deps=setup({listNativeHistory,readNativeHistory,readRecentNativeHistory} as unknown as PipelineDepsOpts['workbench'])
    const read=(query:string)=>{const url=new URL('http://x/m/api/session?key=key'+query);return mobileReadsRoute(deps,url,new Request(url))}
    const responses=await Promise.all([read('&window=recent'),read('&window=recent'),read('')])
    expect(readRecentNativeHistory).toHaveBeenCalledExactlyOnceWith('key',{limit:20})
    expect(readNativeHistory).toHaveBeenCalledExactlyOnceWith('key',{limit:20})
    expect(await responses[0]!.json()).toMatchObject({window:'recent',managed:true})
    expect(await responses[2]!.json()).toMatchObject({window:'start',managed:true})
    const url=new URL('http://x/m/api/sessions?provider=claude&q=%20search%20&cursor=next')
    expect((await mobileReadsRoute(deps,url,new Request(url)))!.status).toBe(200)
    expect(listNativeHistory).toHaveBeenCalledExactlyOnceWith('claude',{q:'search',limit:30,cursor:'next'})
  })
  it('omits session readers when workbench is not wired',()=>{expect(setup().sessions).toBeUndefined()})
})
