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
 const render=(m:Message)=>`<article>${m.role==='user'?renderWorkbenchUserText(m.text,'c:'+m.id):m.pending?m.text:renderWorkbenchMarkdown(m.text)}</article>`
 const first:Message={id:1,role:'user',text:'**完整要求**\n\n```txt\nlong code\n```'},reply:Message={id:2,role:'cc',text:'已有 [文档](https://example.test) 与正文'}
 const paint=(messages:Message[],follow=false,options:{prepend?:boolean,preserve?:boolean}={})=>paintConversation(scroll as any,messages,render,'<p>空白</p>',{...options,follow,latest:latest as any})
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

it('labels the first dated row and each new local day through incremental paints', () => {
 const h = fixture()
 const before = h.scroll.firstElementChild
 const first = {...h.first, at: new Date(2026, 10, 18, 23, 59).getTime()}
 const reply = {...h.reply, at: new Date(2026, 10, 19, 0, 1).getTime()}
 h.paint([first, reply])
 const dates = () => [...h.scroll.querySelectorAll('.desk-message-date')]
 expect(dates().map(node => node.textContent)).toEqual(['十一月十八日 周三', '十一月十九日 周四'])
 const [initial, divider] = dates()
 expect(h.scroll.firstElementChild).toBe(initial)
 expect(initial?.nextElementSibling).toBe(before)
 expect(divider?.nextElementSibling?.getAttribute('data-converse-message')).toBe('2')
 const undated: Message = {id: 3, role: 'system', text: '没有时间'}
 const sameDay = {...reply, id: 4, at: reply.at + 1000}
 h.paint([first, undated, reply, sameDay])
 expect(dates()).toEqual([initial, divider])
 h.paint([{...first, id: 5, at: first.at - 86_400_000}, first, reply, sameDay])
 expect(dates().map(node => node.nextElementSibling?.getAttribute('data-converse-message'))).toEqual(['5', '1', '2'])
 h.paint([first, reply, sameDay])
 expect(dates().map(node => node.nextElementSibling?.getAttribute('data-converse-message'))).toEqual(['1', '2'])
 expect(initial?.isConnected).toBe(true)
 expect(h.scroll.querySelector('[data-converse-message="1"]')).toBe(before)
})

it('keeps supplemental references out of message markers and new-reply notices without moving the reader', () => {
 const h = fixture()
 h.scroll.scrollTop = 100
 const card: Message = {id: 0, role: 'cc', text: '补卡', placeCardKey: 'matter:one'}
 h.paint([card, h.first, h.reply], false, {preserve: true})
 expect(h.scroll.querySelector('[data-converse-place-card]')?.textContent?.trim()).toBe('补卡')
 expect(h.scroll.querySelectorAll('[data-converse-message]')).toHaveLength(2)
 expect(h.latest.hidden).toBe(true)
 expect(h.scroll.scrollTop).toBe(100)
 h.paint([h.first, h.reply], false, {preserve: true})
 expect(h.scroll.querySelector('[data-converse-place-card]')).toBeNull()
})


it('preserves the first visible message when an earlier page is prepended', () => {
 const h = fixture()
 h.scroll.scrollTop = 100
 const first = h.scroll.firstElementChild!
 const rect = () => {
   const top = [...h.scroll.children].indexOf(first) * 200 - h.scroll.scrollTop
   return {top, bottom: top + 200}
 }
 Object.defineProperty(first, 'getBoundingClientRect', {value: rect})
 const y = rect().top
 h.paint([{id: 9, role: 'cc', text: '较早的消息'}, h.first, h.reply], false, {prepend: true})
 expect(rect().top).toBe(y)
 expect(h.scroll.children[1]).toBe(first)
 expect(h.latest.hidden).toBe(true)
})

it('lands on the latest message even when other repaints arrive before the first frame', () => {
 const window = new Window(); windows.push(window)
 const document = window.document, scroll = document.createElement('div'), latest = document.createElement('button')
 document.body.append(scroll, latest)
 let top = 0
 Object.defineProperties(scroll, {scrollHeight: {get: () => 600 + scroll.childElementCount * 200}, clientHeight: {value: 300}, scrollTop: {get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, scroll.scrollHeight - 300)) }}})
 const frames: Function[] = []
 vi.stubGlobal('requestAnimationFrame', (frame: Function) => { frames.push(frame) })
 const render = (m: Message) => `<article>${m.text}</article>`
 const asked: Message = {id: 1, role: 'user', text: '问'}, answered: Message = {id: 2, role: 'cc', text: '答'}
 const late: Message = {id: 3, role: 'cc', text: '另一路数据晚一步到'}
 const paint = (messages: Message[], options: {prepend?: boolean, preserve?: boolean} = {}) =>
   paintConversation(scroll as any, messages, render, '<p>空白</p>', {...options, latest: latest as any})
 paint([asked, answered])
 paint([asked, answered, late])
 paint([asked, answered, late], {preserve: true})
 expect(scroll.scrollTop).toBe(0)
 for (const frame of frames.splice(0)) frame()
 expect(scroll.scrollTop).toBe(scroll.scrollHeight - 300)
 expect(latest.hidden).toBe(true)
 // 往上翻一页是主人自己要看旧的:欠着的「跟到最新」作废,位置留在原处。
 scroll.scrollTop = 0
 paint([asked, answered, late, {id: 4, role: 'cc', text: '新的一条'}])
 paint([{id: 5, role: 'cc', text: '更早的一条'}, asked, answered, late, {id: 4, role: 'cc', text: '新的一条'}], {prepend: true})
 for (const frame of frames.splice(0)) frame()
 expect(scroll.scrollTop).toBe(0)
})

it('keeps the earlier-conversation control first in the stream through repaints and the empty state', () => {
 const h = fixture()
 const lead = h.document.createElement('button')
 lead.setAttribute('data-converse-lead', '')
 h.scroll.prepend(lead)
 const dated = {...h.first, at: new Date(2026, 10, 18, 12).getTime()}
 h.paint([dated, h.reply])
 expect(h.scroll.firstElementChild).toBe(lead)
 expect(lead.nextElementSibling?.className).toBe('desk-message-date')
 h.paint([])
 expect(h.scroll.firstElementChild).toBe(lead)
 expect(h.scroll.textContent).toContain('空白')
 h.paint([])
 expect(h.scroll.querySelectorAll('p')).toHaveLength(1)
 h.paint([dated, h.reply])
 expect(h.scroll.firstElementChild).toBe(lead)
 expect(h.scroll.querySelectorAll('[data-converse-message]')).toHaveLength(2)
 expect(h.scroll.textContent).not.toContain('空白')
})

it('waits for the pane to get a height before landing on the latest message', () => {
 const window = new Window(); windows.push(window)
 const document = window.document, scroll = document.createElement('div'), latest = document.createElement('button')
 document.body.append(scroll, latest)
 let top = 0, height = 0
 Object.defineProperties(scroll, {scrollHeight: {get: () => height && 600 + scroll.childElementCount * 200}, clientHeight: {get: () => height}, scrollTop: {get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, scroll.scrollHeight - height)) }}})
 const resized: Function[] = []
 vi.stubGlobal('ResizeObserver', class { constructor(private readonly changed: Function) {} observe() { resized.push(this.changed) } })
 vi.stubGlobal('requestAnimationFrame', (frame: Function) => frame())
 const render = (m: Message) => `<article>${m.text}</article>`
 paintConversation(scroll as any, [{id: 1, role: 'user', text: '问'}, {id: 2, role: 'cc', text: '答'}], render, '<p>空白</p>', {latest: latest as any})
 expect(scroll.scrollTop).toBe(0)
 height = 300
 for (const changed of resized) changed()
 expect(scroll.scrollTop).toBe(scroll.scrollHeight - 300)
 // 已经补过一次:之后尺寸再变不再把读到一半的人拉回底部。
 scroll.scrollTop = 100
 for (const changed of resized) changed()
 expect(scroll.scrollTop).toBe(100)
})
