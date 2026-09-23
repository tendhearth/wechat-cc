import {it,expect,vi} from 'vitest'
import {runTroubleshoot,runBrainDial,renderNoBrain} from './dashboard.js'
it('keeps network details collapsed and never claims a reply from reachability',async()=>{
 const steps={innerHTML:''};const el={hidden:true,innerHTML:'',querySelector:()=>steps}
 vi.stubGlobal('document',{getElementById:()=>el})
 try{
 const invokeApi=vi.fn(async(..._args:any[])=>({ok:true,verdict:'ok',results:[{label:'OpenAI',ok:true,latency_ms:25}]}))
 await runTroubleshoot({invokeApi})
 expect(steps.innerHTML).toContain('<details')
 expect(steps.innerHTML).toContain('尚未验证回复')
 expect(steps.innerHTML).not.toContain('逐个叫醒')
 }finally{vi.unstubAllGlobals()}
})
it('tests only the current service and does not report an untested service as healthy',async()=>{
 const steps={innerHTML:''};vi.stubGlobal('document',{getElementById:()=>({querySelector:()=>steps})})
 try{
 const invokeApi=vi.fn(async(..._args:any[])=>({ok:true,default_provider:'claude',registered:['claude','cursor'],results:[{provider:'claude',ok:null}]}))
 await runBrainDial({invokeApi})
 expect(invokeApi.mock.calls[0]?.[1]).toContain('scope=current')
 expect(steps.innerHTML).toContain('尚未验证回复')
 expect(steps.innerHTML).not.toContain('一切正常')
 }finally{vi.unstubAllGlobals()}
})
it('onboarding uses account and service-key language',()=>{
 const el={innerHTML:'',hidden:true};vi.stubGlobal('document',{getElementById:()=>el})
 try{renderNoBrain({});expect(el.innerHTML).toContain('连接 AI 服务');expect(el.innerHTML).toContain('登录已有账号');expect(el.innerHTML).not.toContain('API Key');expect(el.innerHTML).not.toContain('🔑')}finally{vi.unstubAllGlobals()}
})
it('does not invent selectable services when the registry cannot be read',async()=>{
 const {toggleProviderMenu,__resetDashboardState}=await import('./dashboard.js')
 __resetDashboardState()
 const menu={innerHTML:'',style:{},hidden:true,querySelectorAll:()=>[]}
 vi.stubGlobal('document',{getElementById:()=>menu,querySelector:()=>({getBoundingClientRect:()=>({bottom:10,left:10})}),addEventListener:()=>{}})
 try{
 await toggleProviderMenu({invokeApi:vi.fn().mockRejectedValue(new Error('offline'))},{checks:{provider:{provider:'claude'}}})
 expect(menu.innerHTML).not.toContain('data-provider=')
 expect(menu.innerHTML).toContain('连接其他 AI 服务')
 }finally{__resetDashboardState();vi.unstubAllGlobals()}
})
it('menu connection action opens a form that survives health polling',async()=>{
 const {toggleProviderMenu,loadBrainHealth,__resetDashboardState}=await import('./dashboard.js')
 __resetDashboardState()
 let add:any
 const panel={innerHTML:'',hidden:true}
 const menu={innerHTML:'',style:{},hidden:true,querySelector:()=>({addEventListener:(_n:string,f:any)=>{add=f}}),querySelectorAll:()=>[]}
 vi.stubGlobal('document',{getElementById:(id:string)=>id==='provider-menu'?menu:panel,querySelector:()=>({getBoundingClientRect:()=>({bottom:10,left:10})}),addEventListener:()=>{},removeEventListener:()=>{}})
 try{
 const deps={invokeApi:vi.fn(async()=>({ok:true,registered:['claude'],default_provider:'claude',results:[]}))}
 await toggleProviderMenu(deps,{checks:{provider:{provider:'claude'}}})
 add()
 expect(panel.innerHTML).toContain('连接 AI 服务')
 expect(menu.hidden).toBe(true)
 const form=panel.innerHTML
 await loadBrainHealth(deps,false)
 expect(panel.hidden).toBe(false)
 expect(panel.innerHTML).toBe(form)
 }finally{__resetDashboardState();vi.unstubAllGlobals()}
})
