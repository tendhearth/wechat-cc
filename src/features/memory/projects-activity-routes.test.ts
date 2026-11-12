import { expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { projectsActivityRoutes } from './projects-activity-routes'
import { makeThreadsStore } from '../../lib/threads-store'
import { ROUTES } from '@wechat-cc/protocol/routes'

it('authorizes only the owner admin, validates windows and remains read-only through real SQL',async()=>{
 const db=openTestDb()
 try{
  let owner:string|null='owner'
  const threads=makeThreadsStore(db)
  const id=await threads.create({chatId:'owner',title:'rici',private:false,summary:'',facets:[],tags:[],episodes:[]})
  await threads.addEntry({threadId:id,kind:'progress',line:'已整理菜谱',ts:'2026-11-10T20:00:00Z'})
  const route=projectsActivityRoutes({db,ownerChatId:()=>owner,now:()=>Date.parse('2026-11-11T20:00:00Z')})['POST /v1/memory/projects/activity']!
  expect(ROUTES['POST /v1/memory/projects/activity']).toEqual({module:'memory',desktop:{tier:'admin'}})
  const q=new URLSearchParams()
  for(const caller of [undefined,{tier:'guest',origin:'session',chatId:'owner'},{tier:'trusted',origin:'session',chatId:'owner'},{tier:'admin',origin:'session',chatId:'other'},{tier:'admin',origin:'link'},{tier:'admin',origin:'session',sharedTurn:'ambiguous',turnChatId:'owner'}] as const){
   const r=await route(q,{},caller)
   expect(r.status).toBe(403)
   expect(JSON.stringify(r.body)).not.toContain('rici')
  }
  const before=db.query<{n:number},[]>('SELECT total_changes() AS n').get()!.n
  for(const caller of [{tier:'admin',origin:'session',chatId:'owner'},{tier:'admin',origin:'session',sharedTurn:'bound',turnChatId:'owner'},{tier:'admin',origin:'operator'},{tier:'admin',origin:'device'}] as const){
   const r=await route(q,{projects:['rici']},caller)
   expect(r.status).toBe(200)
   expect(r.body).toMatchObject({projects:[{project:'rici',entries:[{line:'已整理菜谱'}]}]})
  }
  expect(db.query<{n:number},[]>('SELECT total_changes() AS n').get()!.n).toBe(before)
  for(const body of [{since:'yesterday'},{since:'2026-11-12T00:00:00Z',until:'2026-11-11T00:00:00Z'},{projects:[]},{projects:['rici'],chat_id:'other'}])expect((await route(q,body,{tier:'admin',origin:'session',chatId:'owner'})).status).toBe(400)
  owner=null
  expect((await route(q,{}, {tier:'admin',origin:'operator'})).status).toBe(403)
 }finally{db.close()}
})

it('is reachable through the real authenticated HTTP dispatcher with an owner session token',async()=>{
 const {createInternalApi}=await import('../../daemon/internal-api')
 const {mkdtempSync,rmSync}=await import('node:fs')
 const {tmpdir}=await import('node:os')
 const {join}=await import('node:path')
 const dir=mkdtempSync(join(tmpdir(),'cc-projects-activity-')),db=openTestDb()
 const api=createInternalApi({stateDir:dir,daemonPid:7777})
 try{
  const threads=makeThreadsStore(db),id=await threads.create({chatId:'owner',title:'bx',private:false,summary:'',facets:[],tags:[],episodes:[]})
  await threads.addEntry({threadId:id,kind:'decision',line:'离线记录可查'})
  api.mount('memory',projectsActivityRoutes({db,ownerChatId:()=> 'owner'}))
  const {port}=await api.start()
  for(const [tier,chat,expected]of [['admin','owner',200],['admin','visitor',403],['trusted','owner',403],['guest','owner',403]] as const){
   const token=api.mintSessionToken(tier,`claude/default/${chat}`)
   const response=await fetch(`http://127.0.0.1:${port}/v1/memory/projects/activity`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({projects:['bx']})})
   expect(response.status).toBe(expected)
   const body=await response.json()
   if(expected===200)expect(body).toMatchObject({projects:[{project:'bx',entries:[{line:'离线记录可查'}]}]})
   else expect(JSON.stringify(body)).not.toContain('bx')
  }
 }finally{await api.stop({unlinkToken:true});db.close();rmSync(dir,{recursive:true,force:true})}
})
