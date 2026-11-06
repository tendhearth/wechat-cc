import {randomUUID} from 'node:crypto'
import {afterEach,expect,it,vi} from 'vitest'
import {openDb,type Db} from '../../lib/db'
import {makeMatterStore} from '../../adapters/store/matters-store'
import {makeSayReceipts} from '../../adapters/store/say-receipts'
import {makePhoneChat} from './phone-chat'
let db:Db|undefined
afterEach(()=>db?.close())
it('a device request survives rebuilding phone chat; uncertainty never dispatches twice, reply and conflict are verifiable',async()=>{
 db=openDb({path:':memory:'});const matter=makeMatterStore(db).ensureChat('owner'),receipts=makeSayReceipts(db)
 let finish!:(r:{reply:string})=>void
 const converse=vi.fn(()=>new Promise<{reply:string}>(r=>{finish=r})),deps={converse,receipts,ownerMatterId:()=>matter.id}
 const first=makePhoneChat(deps),requestId=randomUUID();first.say(requestId,'check backup');await Promise.resolve()
 const restarted=makePhoneChat(deps);expect(restarted.say(requestId,'check backup').status).toBe('pending');expect(converse).toHaveBeenCalledTimes(1)
 expect(restarted.receipt!(requestId)?.status).toBe('pending');expect(()=>restarted.say(requestId,'do something else')).toThrow('input_conflict')
 finish({reply:'checked'});await new Promise(r=>setTimeout(r,0));expect(restarted.receipt!(requestId)?.status).toBe('replied');expect(restarted.say(requestId,'check backup').status).toBe('replied');expect(converse).toHaveBeenCalledTimes(1)
 const stranger=makePhoneChat({...deps,ownerMatterId:()=>null});expect(stranger.receipt!(requestId)).toBeNull()
})
