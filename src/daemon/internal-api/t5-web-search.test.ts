import {afterEach,expect,it} from 'vitest'
import {openDb,type Db} from '../../lib/db'
import {makeMatterStore} from '../../adapters/store/matters-store'
import {makeMattersService} from '../../app/matters/service'
import {mattersRoutes} from './routes-matters'
import type {InternalApiDeps} from './types'
let db:Db|undefined
afterEach(()=>db?.close())
it('device search finds old unclassified and archived work before limits; stable tuple pagination and link isolation',async()=>{
 db=openDb({path:':memory:'});const store=makeMatterStore(db,()=>1000),old=store.create({id:'ffffffff',kind:'task',title:'旧备份',projectPath:'/backup'});store.setLifecycle(old.id,'archived')
 for(let n=0;n<510;n++)store.create({id:n.toString(16).padStart(8,'0'),kind:'task',title:'新事项 '+n,projectPath:'/current'})
 store.ensureChat('guest')
 const service=makeMattersService({store}),route=mattersRoutes({matters:service} as InternalApiDeps)['GET /v1/matters']!
 const call=(q:string,origin:'device'|'link'='device')=>route(new URLSearchParams(q),null,{origin,tier:'admin'})
 const found=await call('search=1&kind=task&q=旧备份&state=archived&project=backup')
 expect(found.status).toBe(200);expect((found.body as any).matters.map((m:any)=>m.id)).toEqual([old.id])
 expect((await call('search=1&q=%')).body).toMatchObject({matters:[]})
 expect((await call('search=1&q=旧备份','link')).status).toBe(400)
 const ids:string[]=[];let cursor:string|null=null
 do{const page=await call('search=1&kind=task&limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''));const b=page.body as any;ids.push(...b.matters.map((m:any)=>m.id));cursor=b.nextCursor}while(cursor)
 expect(ids).toHaveLength(511);expect(new Set(ids).size).toBe(511);expect(ids.at(-1)).toBe(old.id)
 expect((await call('search=1&cursor=bad')).status).toBe(400)
})
it('owner search discards a result if the configured owner changes during lookup',async()=>{
 db=openDb({path:':memory:'});let owner:string|null='before';const store=makeMatterStore(db),service=makeMattersService({store,chat:{ownerChatId:()=>owner,say:async()=>({reply:''}),search:async()=>{owner='after';return [{id:'old',kind:'text',text:'old private result',createdAt:1}]}}})
 expect(await service.searchOwnerChat('private')).toBeNull()
})
