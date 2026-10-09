import {expect,it} from 'vitest'
import {createWorkbenchCreateAttempts} from './workbench-create-attempts.js'
const memory=()=>{const m=new Map();return{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)}}
it('freezes legacy text/title/provider/location through timeout reload and only changes id after definitive rejection',async()=>{
 const storage=memory(),posts=[],input={path:'/project',text:'original',title:'title',providerId:'codex',executionMode:'auto'}
 const invoke=async(method,path,b)=>{if(method==='GET')throw Error('entry_not_found');posts.push(b);throw Error('timeout')}
 const first=createWorkbenchCreateAttempts({storage,invoke})
 await expect(first.send('new:/project',input)).rejects.toThrow('timeout')
 const next=createWorkbenchCreateAttempts({storage,invoke})
 await expect(next.send('new:/project',{...input,text:'edited',executionMode:'project'})).rejects.toThrow('timeout')
 expect(posts[1]).toEqual(posts[0])
 const accepted=createWorkbenchCreateAttempts({storage,invoke:async(method,_path,b)=>method==='GET'?{receipt:{requestId:posts[0].requestId},task:{id:'aabbccdd'}}:({task:{id:'aabbccdd'}})})
 expect((await accepted.send('new:/project',{...input,text:'edited'})).input.text).toBe('original')
 const rejected=createWorkbenchCreateAttempts({storage:memory(),invoke:async(method,_path,b)=>{if(method==='GET')throw Error('entry_not_found');posts.push(b);throw Error('invalid_path')}})
 await expect(rejected.send('new',input)).rejects.toThrow('invalid_path')
 await expect(rejected.send('new',{...input,executionMode:'project'})).rejects.toThrow('invalid_path')
 expect(posts.at(-1).requestId).not.toBe(posts.at(-2).requestId)
})
it('expired legacy reservations allocate a fresh identity even if the requirement is unchanged',async()=>{
 const sent=[],actions=createWorkbenchCreateAttempts({storage:memory(),invoke:async(m,_p,b)=>{if(m==='GET')throw Error('entry_not_found');sent.push(b);throw Error('entry_expired')}})
 await expect(actions.send('new',{text:'unchanged'})).rejects.toThrow('entry_expired')
 await expect(actions.send('new',{text:'unchanged'})).rejects.toThrow('entry_expired')
 expect(sent[1].requestId).not.toBe(sent[0].requestId)
})
