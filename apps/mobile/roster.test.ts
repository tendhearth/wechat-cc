import { expect,it } from 'vitest'
import { Window } from 'happy-dom'
import { readMobileSource } from './sources'
// 正面上半「现在」的网页版(src/roster.js):地方一行一行,点行筛说话,「›」打开那一件。
function fixture(device=false){
 const w=new Window();w.document.body.innerHTML='<nav id="roster-strip" hidden></nav>'
 const timers:Function[]=[];let response:any={status:200,json:async()=>({places:[]}),headers:{get:()=> 'v1'}};const calls:any[]=[];const opened:any[]=[];let rendered=0
 const env={document:w.document,isDevice:device,esc:(s:any)=>String(s).replace(/</g,'&lt;'),setTimeout:(f:Function)=>{timers.push(f);return 1},clearTimeout:()=>{},onUnauthorized:()=>{},T:'d',api:async(p:any,o:any)=>{calls.push([p,o]);return response},openMatter:(id:string)=>opened.push(id),mRosterTarget:null,cRender:()=>{rendered++}}
 const f=new Function(...Object.keys(env),readMobileSource('time.js')+'\n'+readMobileSource('roster.js')+';return {renderPlacesStrip,startRoster,rTime,rLine,rTarget,cInPlace,cRefInPlace,place:function(){return cPlace}}')(...Object.values(env))
 return {w,calls,timers,opened,rendered:()=>rendered,...f,respond(r:any){response=r}}
}
const NOW=new Date('2026-11-18T16:10:00').getTime()
const place=(name:string,extra:any={})=>({key:'p:'+name,name,line:name+' 的事',status:'done',waiting:null,moving:false,unseen:false,updatedAt:NOW-30*60000,matterIds:[name+'-m'],messageIds:[name+'-msg'],sessionIds:[],...extra})

it('时间与现状不用状态词',()=>{
 const h=fixture()
 expect(h.rTime(place('a',{moving:true}),NOW)).toBe('现在')
 expect(h.rTime(place('a'),NOW)).toBe('30 分钟前')
 expect(h.rTime(place('a',{updatedAt:new Date('2026-11-17T22:00:00').getTime()}),NOW)).toBe('昨天 22:00')
 expect(h.rLine(place('a',{status:'working'}))).toBe('a 的事…')
 expect(h.rLine(place('a',{status:'failed'}))).toBe('a 的事（没做成）')
 expect(h.rLine(place('a',{alsoChanged:2}))).toBe('a 的事，另有 2 件也动过')
})
it('一行一个地方;在等你的有点;连不上时说一句、不亮点;名字转义',()=>{
 const h=fixture()
 const html=h.renderPlacesStrip([place('rici',{waiting:{kind:'question',matterId:'w1',summary:'?',count:1}}),place('<x>')],{selected:null,now:NOW})
 h.w.document.body.innerHTML=html
 expect(h.w.document.querySelectorAll('.place')).toHaveLength(2)
 expect(h.w.document.querySelectorAll('.place.waiting')).toHaveLength(1)
 expect(html).not.toContain('<x>')
 const stale=h.renderPlacesStrip([place('rici',{waiting:{kind:'question',matterId:'w1',summary:'?',count:1}})],{selected:null,stale:true,now:NOW})
 expect(stale).toContain('暂时连不上');expect(stale).not.toContain('place waiting')
})
it('「›」打开:等你的那件 > 最近的事 > 最近的会话',()=>{
 const h=fixture()
 expect(h.rTarget(place('a',{waiting:{kind:'terminal',sessionId:'s1',summary:'s',count:1}}))).toEqual({kind:'terminal',id:'s1'})
 expect(h.rTarget(place('a'))).toEqual({kind:'matter',id:'a-m'})
 expect(h.rTarget(place('a',{matterIds:[],sessionIds:['s2']}))).toEqual({kind:'terminal',id:'s2'})
 expect(h.rTarget(place('a',{matterIds:[]}))).toBeNull()
})
it('链接身份从不读',()=>{const h=fixture();h.startRoster({isDevice:false,onSelect:()=>{}});expect(h.calls).toEqual([]);expect(h.timers).toEqual([])})
it('设备:读 /v1/places;点一行筛说话再点回全部;「›」开那一件;304 不重画;503 保留上一份',async()=>{
 const h=fixture(true);await new Promise(r=>setTimeout(r,0))
 h.respond({status:200,json:async()=>({places:[place('rici'),place('bx',{matterIds:[],sessionIds:['sess-1']})]}),headers:{get:()=> 'v2'}});await h.timers.pop()!()
 expect(h.calls[0][0]).toBe('/v1/places')
 const root=h.w.document.getElementById('roster-strip')!
 ;(root.querySelector('[data-place="p:rici"]') as any).click()
 expect(h.place()?.name).toBe('rici');expect(h.rendered()).toBeGreaterThan(0)
 // 坐回来:点开这一行 = 看过它,记一次;同一时刻不重复记
 const seen=()=>h.calls.filter((c:any)=>c[0]==='/v1/places/seen').map((c:any)=>JSON.parse(c[1].body).key)
 expect(seen()).toEqual(['p:rici'])
 expect(h.cInPlace({id:'rici-msg'})).toBe(true);expect(h.cInPlace({id:'other'})).toBe(false);expect(h.cInPlace({id:'r',matterId:'rici-m'})).toBe(true)
 expect(h.cRefInPlace({id:'rici-m'})).toBe(true);expect(h.cRefInPlace({id:'zz'})).toBe(false)
 ;(root.querySelector('[data-place="p:rici"]') as any).click()
 expect(h.place()).toBeNull()
 ;(root.querySelector('[data-place-open="p:bx"]') as any).click()
 expect(h.opened).toEqual(['terminal:sess-1'])
 expect(seen()).toEqual(['p:rici','p:bx'])
 const node=root.firstChild
 h.respond({status:304});await h.timers.pop()!()
 expect(root.firstChild).toBe(node);expect(h.calls.at(-1)[1].headers).toEqual({'If-None-Match':'v2'})
 h.respond({status:503});await h.timers.pop()!()
 expect(root.textContent).toContain('rici');expect(root.textContent).toContain('暂时连不上')
})
