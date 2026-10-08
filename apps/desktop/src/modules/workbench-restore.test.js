import {expect,it} from 'vitest'
import {createRestoreActions} from './workbench-restore.js'
const memory=()=>{const m=new Map();return{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)}}
const selection={id:'aabbccdd',artifactId:'artifact',path:'a.txt',changeId:'change'}
const operation=(body,state='reverted')=>({...body,taskId:body.id,operationId:'op',workspaceId:'ws',state})
it('persists original requestId after timeout and reload, and accepts only matched reverted receipt',async()=>{
 const storage=memory(),sent=[]
 const first=createRestoreActions({storage,invoke:async(_m,_p,b)=>{sent.push(b);throw Error('timeout')}})
 expect((await first.revert(selection)).state).toBe('uncertain')
 const second=createRestoreActions({storage,invoke:async(_m,_p,b)=>{sent.push(b);return{operation:operation(b)}}})
 expect((await second.revert(selection)).state).toBe('reverted');expect(sent[1]).toEqual(sent[0])
 const invalid=createRestoreActions({storage:memory(),invoke:async(_m,_p,b)=>({operation:{...operation(b),taskId:'different'}})})
 expect((await invalid.revert(selection)).state).toBe('uncertain')
})
it('keeps needs_recovery and stale resolve distinct from success, and late responses scoped to their original task',async()=>{
 let release;const storage=memory()
 const actions=createRestoreActions({storage,invoke:async(_m,p,b)=>p.endsWith('resolve')?Promise.reject(Error('restore_observation_stale')):new Promise(r=>{release=()=>r({operation:{...operation(b,'needs_recovery'),observedFingerprint:'fp'}})})})
 const pending=actions.revert(selection)
 expect(actions.get({...selection,id:'another'})).toBe(null)
 release();expect((await pending).state).toBe('needs_recovery')
 expect(actions.get({...selection,id:'another'})).toBe(null)
 const result=await actions.resolve({id:selection.id,operationId:'op',observedFingerprint:'fp'})
 expect(result.state).toBe('failed');expect(result.error).toBe('restore_observation_stale')
 expect(actions.get(selection).state).toBe('needs_recovery')
})
it('rejects receipts bound to a different workspace or resolve file identity',async()=>{
 const actions=createRestoreActions({storage:memory(),invoke:async(_m,p,b)=>({operation:operation(b,p.endsWith('resolve')?'resolved_keep_current':'reverted')})})
 expect((await actions.revert(selection,'another-workspace')).state).toBe('uncertain')
 expect((await actions.resolve({id:selection.id,operationId:'op',observedFingerprint:'fp'},{artifactId:selection.artifactId,path:selection.path,changeId:selection.changeId})).state).toBe('failed')
})
