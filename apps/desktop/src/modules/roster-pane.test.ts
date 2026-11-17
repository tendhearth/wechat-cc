// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest'
import {mountRosterPane,renderRosterHtml} from './roster-pane.js'
const item=(group='working',extra:any={})=>({key:'matter:'+group,id:group,kind:'matter',title:'备份',group,status:'working',agents:[{id:'claude',current:false},{id:'codex',current:true}],quiet:false,updatedAt:1,unseen:false,...extra})
let pane:ReturnType<typeof mountRosterPane>|undefined
afterEach(()=>{pane?.destroy();vi.useRealTimers()})
it('按三组顺序渲染摘要、接力与未看标记',()=>{
 const html=renderRosterHtml([item('back',{unseen:true}),item('working',{relay:{index:2,total:3},quiet:true}),item('waiting',{waiting:{summary:'读文件'}})],{stale:false,staleAt:null})
 expect(html.indexOf('等你')).toBeLessThan(html.indexOf('在做'))
 expect(html.indexOf('在做')).toBeLessThan(html.indexOf('带回来的'))
 for(const word of ['第 2 棒 / 3','可能卡住','读文件','还没看'])expect(html).toContain(word)
 expect(html).toContain('data-current="true"')
})
it('空名单显示都歇着并转义标题',()=>{
 expect(renderRosterHtml([],{stale:false,staleAt:null})).toContain('都歇着')
 expect(renderRosterHtml([item('working',{title:'<script>'})],{stale:false,staleAt:null})).not.toContain('<script>')
})
it('断网保留上一份和时间，304 不重绘，点击返回原始条目',async()=>{
 document.body.innerHTML='<div id="list"></div>'
 let response:any={items:[item()],version:'"one"'}
 const call=vi.fn(async()=>{if(response instanceof Error)throw response;return response}),open=vi.fn()
 pane=mountRosterPane({root:document.getElementById('list')!,call,onOpen:open,now:()=>new Date('2026-11-17T12:34:00').getTime()})
 await pane.refresh()
 const row=document.querySelector('button')!
 row.click();expect(open).toHaveBeenCalledWith(item())
 response={notModified:true};await pane.refresh();expect(document.querySelector('button')).toBe(row)
 expect(call.mock.calls.at(-1)).toEqual(['GET','/v1/roster',undefined,{ifNoneMatch:'"one"'}])
 response=Error('503');await pane.refresh()
 expect(pane.items()).toEqual([item()])
 expect(document.body.textContent).toContain('家里的电脑暂时连不上')
 expect(document.body.textContent).toContain('你看到的是')
 expect(document.body.textContent).toContain('备份')
})
it('隐藏时停止轮询，回到窗口立即刷新',async()=>{
 vi.useFakeTimers();document.body.innerHTML='<div id="list"></div>'
 const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
 const call=vi.fn(async()=>({items:[],version:'1'}))
 pane=mountRosterPane({root:document.getElementById('list')!,call,onOpen:()=>{}})
 await vi.advanceTimersByTimeAsync(6000);expect(call).not.toHaveBeenCalled()
 visibility.mockReturnValue('visible');document.dispatchEvent(new Event('visibilitychange'));await Promise.resolve();expect(call).toHaveBeenCalledTimes(1)
 visibility.mockRestore()
})
