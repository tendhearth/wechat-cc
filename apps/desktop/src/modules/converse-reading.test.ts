import {afterEach,expect,it,vi} from 'vitest'
import {Window} from 'happy-dom'
import {paintConversation,showConversationLatest,syncConversationLatest} from './converse-reading.js'
import type {Message} from './converse-reading.js'
import {renderWorkbenchMarkdown,renderWorkbenchUserText} from './workbench-markdown.js'
const windows:Window[]=[]
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(windows.splice(0).map(w=>w.happyDOM.abort()))})
function fixture(){
 const window=new Window();windows.push(window)
 const document=window.document,scroll=document.createElement('div'),latest=document.createElement('button')
 document.body.append(scroll,latest)
 let top=0
 Object.defineProperties(scroll,{scrollHeight:{get:()=>600+scroll.childElementCount*200},clientHeight:{value:300},scrollTop:{get:()=>top,set:(value:number)=>{top=Math.max(0,Math.min(value,scroll.scrollHeight-300))}}})
 scroll.scrollTop=700
 vi.stubGlobal('requestAnimationFrame',(f:Function)=>f())
 const render=(m:{id:number;role:string;text:string;pending?:boolean})=>`<article>${m.role==='user'?renderWorkbenchUserText(m.text,'c:'+m.id):m.pending?m.text:renderWorkbenchMarkdown(m.text)}</article>`
 const first:Message={id:1,role:'user',text:'**完整要求**\n\n```txt\nlong code\n```'},reply:Message={id:2,role:'cc',text:'已有 [文档](https://example.test) 与正文'}
 const paint=(messages:Message[],follow=false)=>paintConversation(scroll as any,messages,render,'<p>空白</p>',{follow,latest:latest as any})
 paint([first,reply])
 return {window,document,scroll,latest,first,reply,paint}
}
it('keeps old message nodes, source, code position, keyboard focus and selected text while pending changes',()=>{
 const h=fixture(),first=h.scroll.firstElementChild!,source=first.querySelector('details')!,pre=first.querySelector('pre')!,link=h.scroll.querySelector('a')!
 source.open=true;pre.scrollLeft=120;link.focus();h.scroll.scrollTop=100
 const selected=first.querySelector('strong')!.firstChild!,range=h.document.createRange();range.selectNodeContents(selected);h.window.getSelection().addRange(range)
 h.paint([h.first,h.reply,{id:3,role:'cc',text:'还在等待回复',pending:true}])
 h.paint([h.first,h.reply,{id:3,role:'cc',text:'仍未收到回复',pending:true}])
 expect(h.scroll.firstElementChild).toBe(first)
 expect(source.open).toBe(true);expect(pre.scrollLeft).toBe(120)
 expect(h.document.activeElement).toBe(link)
 expect(h.window.getSelection().toString()).toBe('完整要求')
 expect(h.scroll.scrollTop).toBe(100)
 expect(h.latest.hidden).toBe(true)
})
it('leaves the reader in place and offers new replies until explicitly returning to the latest',()=>{
 const h=fixture();h.scroll.scrollTop=100
 h.paint([h.first,h.reply,{id:3,role:'cc',text:'新的回复'}])
 expect(h.scroll.scrollTop).toBe(100);expect(h.latest.hidden).toBe(false)
 showConversationLatest(h.scroll as any,h.latest as any)
 expect(h.scroll.scrollTop).toBe(900);expect(h.latest.hidden).toBe(true)
 h.paint([h.first,h.reply,{id:3,role:'cc',text:'新的回复'},{id:4,role:'cc',text:'又一条'}])
 expect(h.scroll.scrollTop).toBe(1100);expect(h.latest.hidden).toBe(true)
})
it('follows updates near the bottom, but protects a reader interacting there',()=>{
 const h=fixture(),link=h.scroll.querySelector('a')!
 h.scroll.scrollTop=700;link.focus()
 h.paint([h.first,h.reply,{id:3,role:'cc',text:'收到回复'}])
 expect(h.scroll.scrollTop).toBe(700);expect(h.latest.hidden).toBe(false)
 link.blur();h.scroll.scrollTop=900;syncConversationLatest(h.scroll as any,h.latest as any)
 expect(h.latest.hidden).toBe(true)
})
it('does not yank a reader who scrolls between DOM update and the following animation frame',()=>{
 const h=fixture();h.scroll.scrollTop=700
 let frame:Function|undefined;vi.stubGlobal('requestAnimationFrame',(f:Function)=>{frame=f})
 h.paint([h.first,h.reply,{id:3,role:'cc',text:'新的回复'}]);h.scroll.scrollTop=100;frame!()
 expect(h.scroll.scrollTop).toBe(100);expect(h.latest.hidden).toBe(false)
})
it('honors a small upward scroll even while geometrically close to the bottom',()=>{
 const h=fixture();h.scroll.scrollTop=670
 syncConversationLatest(h.scroll as any,h.latest as any)
 h.paint([h.first,h.reply,{id:3,role:'cc',text:'更新'}])
 expect(h.scroll.scrollTop).toBe(670);expect(h.latest.hidden).toBe(false)
})
