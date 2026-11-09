import {afterEach,expect,it} from 'vitest'
import {Window} from 'happy-dom'
import {readMobileSource} from './sources'
import {assembleMobilePage} from './assemble'
const windows:Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(w=>w.happyDOM.abort()))})
function fixture(device=true,fail=false,scriptReader?:(path:string)=>Promise<{content:string;nextOffset:number|null}>){
 const w=new Window({url:'https://fixture.test/m'});windows.push(w);w.document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 const request='11111111-1111-4111-8111-111111111111',run='22222222-2222-4222-8222-222222222222',posts:any[]=[],reads:string[]=[]
 const detail={matter:{id:'deadbeef'},runId:run,permissions:[{id:request,taskId:'deadbeef',tool:'read',description:'<script>unsafe</script>',createdAt:1}],questions:[{id:'33333333-3333-4333-8333-333333333333',taskId:'deadbeef',questions:[{id:'q',header:'方案',question:'选哪个',multiSelect:false,allowOther:true,options:[{label:'A',description:'第一个'}]}]}]}
 const env={document:w.document,isDevice:device,cReady:true,mDetail:detail,mCurrent:'deadbeef',mDetailFresh:true,mOffline:false,esc:(s:any)=>String(s).replace(/</g,'&lt;').replace(/"/g,'&quot;'),mNotice:()=>{},mRefresh:async()=>{},onUnauthorized:()=>{},T:'dTEST',mApi:async(path:string)=>{reads.push(path);if(scriptReader)return await scriptReader(path);return {content:'full snapshot <script>literal</script>',nextOffset:null}},mPostOnce:async(p:string,o:any)=>{posts.push({p,body:JSON.parse(o.body)});if(fail)throw Error('lost reply');return {status:200,json:async()=>({ok:true})}}}
 const f=new Function(...Object.keys(env),readMobileSource('responses.js')+'\nreturn {cRenderResponses,cRespond,cExpandScript}')(...Object.values(env));f.cRenderResponses(detail)
 return {w,posts,reads,detail,request,run,...f}
}
it('permission is safe text and uses the exact matter, run and request; lost reply never retries itself',async()=>{
 const h=fixture(true,true);expect(h.w.document.querySelector('#m-response script')).toBeNull();await h.cRespond(h.request,'allow',null);expect(h.posts).toEqual([{p:'/v1/matter/permission',body:{id:'deadbeef',runId:h.run,requestId:h.request,decision:'allow'}}]);await h.cRespond(h.request,'allow',null);expect(h.posts).toHaveLength(1)
})
it('background progress refresh preserves a question draft; link identity has no action',async()=>{
 const h=fixture();const input=h.w.document.querySelector('[data-other]') as unknown as HTMLInputElement;input.value='保留回答';h.cRenderResponses({...h.detail,events:[{text:'new progress'}]});expect((h.w.document.querySelector('[data-other]') as unknown as HTMLInputElement).value).toBe('保留回答')
 const l=fixture(false);await l.cRespond(l.request,'allow',null);expect(l.posts).toEqual([]);expect(l.w.document.getElementById('m-response')?.textContent).toBe('')
})
it('offers task permission only when eligible and renders a bounded script preview with an escaped full disclosure',async()=>{
 const h=fixture();expect(h.w.document.querySelector('[data-decision="allow_task"]')).toBeNull()
 const script={path:'check.py',content:'<script>alert(1)</script>\n'+'x'.repeat(2500)}
 h.cRenderResponses({...h.detail,permissions:[{...h.detail.permissions[0],canAllowTask:true,scripts:[script]}]})
 expect(h.w.document.querySelector('[data-decision="allow_task"]')?.textContent).toBe('本任务同命令都允许')
 expect(h.w.document.querySelector('#m-response script')).toBeNull()
 expect(h.w.document.querySelector('#m-response details pre')?.textContent).toBe(script.content)
 await h.cRespond(h.request,'allow_task',null)
 expect(h.posts[0].body).toEqual({id:'deadbeef',runId:h.run,requestId:h.request,decision:'allow_task'})
})

it('loads a truncated script from its pending snapshot without inserting HTML',async()=>{
 const h=fixture();h.cRenderResponses({...h.detail,permissions:[{...h.detail.permissions[0],scripts:[{path:'folder/check.py',content:'preview',sha256:'a'.repeat(64),truncated:true}]}]})
 const button=h.w.document.querySelector('[data-script-full]');expect(button).not.toBeNull();await h.cExpandScript(button)
 expect(h.reads).toHaveLength(1);expect(h.reads[0]).toContain('path=folder%2Fcheck.py');expect(h.reads[0]).toContain('requestId='+h.request)
 expect(h.w.document.querySelector('.response-script pre')?.textContent).toBe('full snapshot <script>literal</script>')
 expect(h.w.document.querySelector('#m-response script')).toBeNull()
})

it('keeps a completed script visible when another pending request redraws the same task',async()=>{
 let complete!:(part:{content:string;nextOffset:null})=>void
 const h=fixture(true,false,async()=>await new Promise(resolve=>{complete=resolve}))
 const script={path:'check.py',content:'preview',sha256:'a'.repeat(64),truncated:true}
 const detail={...h.detail,permissions:[{...h.detail.permissions[0],scripts:[script]}]}
 h.cRenderResponses(detail)
 const old=h.w.document.querySelector('[data-script-full]'),pending=h.cExpandScript(old)
 h.cRenderResponses({...detail,permissions:[...detail.permissions,{...h.detail.permissions[0],id:'another',description:'another request'}]})
 expect(h.w.document.querySelector('[data-script-full]')).not.toBe(old)
 complete({content:'complete after redraw',nextOffset:null});await pending
 expect(h.w.document.querySelector('.response-script pre')?.textContent).toBe('complete after redraw')
 expect(h.w.document.querySelector('[data-script-full]')).toBeNull()
})
