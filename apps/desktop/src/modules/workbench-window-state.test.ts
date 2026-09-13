import {expect,it} from 'vitest'
import {createWorkbenchDraftStore,loadWorkbenchView,saveWorkbenchView} from './workbench-window-state.js'
const memory=()=>{const values=new Map<string,string>();return{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}}
const draft=(text:string)=>({path:'',text:'',title:'',providerId:'',followup:text})
it('restores separate task and new-project drafts in a fresh page instance',()=>{
 const storage=memory(),first=createWorkbenchDraftStore(storage)
 first.set('task:a',draft('A 未发送'));first.set('task:b',draft('B 未发送'))
 first.set('new:/work',{...draft(''),path:'/work',text:'新任务',providerId:'claude'})
 const restored=createWorkbenchDraftStore(storage)
 expect(restored.get('task:a').followup).toBe('A 未发送');expect(restored.get('task:b').followup).toBe('B 未发送')
 expect(restored.get('new:/work')).toMatchObject({path:'/work',text:'新任务',providerId:'claude'})
 expect(createWorkbenchDraftStore(memory()).get('task:a').followup).toBe('')
})
it('does not bring back a sent or deleted draft after reload',()=>{
 const storage=memory(),first=createWorkbenchDraftStore(storage)
 first.set('task:a',draft('sent'));first.set('task:a',draft(''))
 first.set('new:/work',draft('deleted'));first.delete('new:/work')
 const restored=createWorkbenchDraftStore(storage)
 expect(restored.get('task:a').followup).toBe('');expect(restored.has('new:/work')).toBe(false)
})
it('ignores corrupt storage and retains current-page drafts if storage is blocked',()=>{
 const blocked={getItem(){throw Error('blocked')},setItem(){throw Error('quota')},removeItem(){throw Error('blocked')}}
 const values=createWorkbenchDraftStore(blocked);values.set('task:a',draft('keep'))
 expect(values.get('task:a').followup).toBe('keep');expect(()=>values.delete('task:a')).not.toThrow()
 for(const raw of ['{','null','{"followup":42}','{"path":"","text":"","title":"","providerId":"","followup":{},"token":"secret"}']){
  const store=createWorkbenchDraftStore({getItem:()=>raw,setItem(){},removeItem(){}})
  expect(store.get('task:a')).toEqual(draft(''))
 }
})
it('saves only draft fields, never borrowed permission or continuation tokens',()=>{
 const storage=memory(),first=createWorkbenchDraftStore(storage)
 first.set('task:a',{...draft('keep'),restartToken:'secret'} as any)
 expect(createWorkbenchDraftStore(storage).get('task:a')).toEqual(draft('keep'))
})
it('restores navigation and validates it independently of task text',()=>{
 const storage=memory()
 saveWorkbenchView(storage,{scope:'task:deadbeef',query:{q:'project',archived:'only'},search:'not submitted'})
 expect(loadWorkbenchView(storage)).toEqual({scope:'task:deadbeef',query:{q:'project',archived:'only'},search:'not submitted'})
 expect(loadWorkbenchView({getItem:()=>'{"scope":"task:deadbeef","query":{"q":{},"archived":"bad"}}'})).toEqual({scope:null,query:{q:'',archived:'exclude'},search:''})
})
