import {expect,it} from 'vitest'
import {createWorkbenchForkAttempts} from './workbench-fork-attempts.js'
const memory=()=>{const m=new Map();return{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)}}
const input={text:'original',title:'title',providerId:'claude',executionMode:'isolated',target:{kind:'project',projectId:'p-source',isolation:'worktree'}}
it('rejects a different task in a matching receipt then replays the frozen request and accepts normalized identity',async()=>{
 const storage=memory(),requests=[]
 const first=createWorkbenchForkAttempts({storage,invoke:async(m,p,b)=>{if(m==='GET')throw Error('offline');requests.push(b);return{receipt:{requestId:b.requestId,taskId:'aabbccdd'},task:{id:'11223344'}}}})
 await expect(first.send('source','claude',input)).rejects.toThrow('unconfirmed_receipt')
 const next=createWorkbenchForkAttempts({storage,invoke:async(m,p,b)=>{if(m==='GET')return{receipt:{requestId:requests[0].requestId,taskId:'aabbccdd'},task:{id:'11223344'}};requests.push(b);return{receipt:{requestId:b.requestId.toUpperCase(),taskId:'aabbccdd'},task:{id:'aabbccdd'}}}})
 expect(await next.send('source','claude',{...input,text:'edited',target:{kind:'project',projectId:'other'}})).toBe('aabbccdd')
 expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);expect(next.get('source','claude').taskId).toBe('aabbccdd')
})
it('shares the still-running request across remount without another transport submission',async()=>{
 const storage=memory(),requests=[];let release
 const invoke=async(m,p,b)=>{if(m==='GET')throw Error('offline');requests.push(b);return new Promise(r=>{release=()=>r({receipt:{requestId:b.requestId,taskId:'aabbccdd'},task:{id:'aabbccdd'}})})}
 const old=createWorkbenchForkAttempts({storage,invoke}).send('source','claude',input)
 const remounted=createWorkbenchForkAttempts({storage,invoke});const next=remounted.send('source','claude',{...input,text:'edited'})
 release();expect(await old).toBe('aabbccdd');expect(await next).toBe('aabbccdd');expect(requests).toHaveLength(1)
 expect(remounted.get('source','claude').taskId).toBe('aabbccdd')
})
it('definite rejection permits corrected input to use a new identity',async()=>{
 const requests=[],actions=createWorkbenchForkAttempts({storage:memory(),invoke:async(m,p,b)=>{if(m==='GET')throw Error('entry_not_found');requests.push(b);throw Error('invalid_text')}})
 await expect(actions.send('source','claude',input)).rejects.toThrow('invalid_text')
 expect(actions.get('source','claude').uncertain).toBe(false)
 await expect(actions.send('source','claude',{...input,text:'corrected'})).rejects.toThrow('invalid_text')
 expect(requests[1].requestId).not.toBe(requests[0].requestId)
})
it('a late pre-remount response cannot erase another provider request or its selected choice',async()=>{
 const storage=memory();let release
 const invoke=async(m,p,b)=>{if(m==='GET')throw Error('offline');if(b.providerId==='cursor')throw Error('offline');return new Promise(r=>{release=()=>r({receipt:{requestId:b.requestId,taskId:'aabbccdd'},task:{id:'aabbccdd'}})})}
 const old=createWorkbenchForkAttempts({storage,invoke}).send('source','claude',input)
 const remounted=createWorkbenchForkAttempts({storage,invoke})
 await expect(remounted.send('source','cursor',{...input,providerId:'cursor'})).rejects.toThrow('offline')
 const pending=remounted.get('source','cursor').input.requestId
 release();await old
 const again=createWorkbenchForkAttempts({storage,invoke})
 expect(again.get('source','cursor').input.requestId).toBe(pending);expect(again.provider('source')).toBe('cursor')
})
