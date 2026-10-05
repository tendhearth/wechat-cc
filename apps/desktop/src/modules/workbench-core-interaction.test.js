// @vitest-environment happy-dom
import {afterEach,describe,expect,it,vi} from 'vitest'
import {patchLiveTimeline,clearLiveTimelinePatches,hasLiveTimelineInteraction} from './workbench-live.js'
import {renderWorkbenchMarkdown} from './workbench-markdown.js'
import {permissionControlId} from './workbench-permission-focus.js'
import {workbenchTimelineEventId} from './workbench-timeline.js'

const event=text=>({id:'1',taskId:'A',kind:'text',text,createdAt:1})
const render={eventId:e=>`wb-event-${e.id}`,message:e=>`<article id="wb-event-${e.id}" class="wb-message"><div class="wb-message-body wb-markdown">${renderWorkbenchMarkdown(e.text)}</div></article>`,operation:()=>''}
let cleanup=()=>{}
afterEach(()=>{cleanup();cleanup=()=>{};document.getSelection()?.removeAllRanges();document.body.innerHTML='';sessionStorage.clear();vi.restoreAllMocks();vi.resetModules()})
function rowFixture(text){
 document.body.innerHTML=`<div id="fixture"><div class="wb-dialogue">${render.message(event(text))}</div></div>`
 const root=document.getElementById('fixture');cleanup=()=>clearLiveTimelinePatches(root)
 return{root,row:root.querySelector('article'),patch:text=>patchLiveTimeline(root,[event(text)],render)}
}
function select(node,start,end){const range=document.createRange();range.setStart(node,start);range.setEnd(node,end);const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);return selection}
const settle=()=>new Promise(resolve=>setTimeout(resolve,5))

describe('live rows in a real DOM',()=>{
 it('keeps unchanged message/link/code nodes, selected text, focus and horizontal reading while more text arrives',()=>{
  const text='保持选区文本\n\n[查看网页](https://example.test/read)\n\n```ts\nconst wide_line = 1\n```',f=rowFixture(text)
  const paragraph=f.row.querySelector('p'),link=f.row.querySelector('a'),pre=f.row.querySelector('pre')
  link.focus();const selection=select(paragraph.firstChild,2,4);pre.scrollLeft=93
  expect(hasLiveTimelineInteraction(f.root)).toBe(true)
  expect(f.patch(`${text}\n\n新回复到达`)).toEqual({patched:1,appended:0,missing:0})
  expect(f.root.querySelector('article')).toBe(f.row);expect(f.row.querySelector('p')).toBe(paragraph)
  expect(f.row.querySelector('a')).toBe(link);expect(document.activeElement).toBe(link)
  expect(f.row.querySelector('pre')).toBe(pre);expect(pre.scrollLeft).toBe(93)
  expect(selection.toString()).toBe('选区');expect(selection.anchorOffset).toBe(2);expect(selection.focusOffset).toBe(4)
  expect(f.row.textContent).toContain('新回复到达')
 })
 it('appends to the same selected text node without extending or clearing the selection',()=>{
  const f=rowFixture('流文字'),node=f.row.querySelector('p').firstChild,selection=select(node,1,3)
  f.patch('流文字继续到达')
  expect(f.row.querySelector('p').firstChild).toBe(node);expect(selection.toString()).toBe('文字')
  expect(selection.focusOffset).toBe(3);expect(node.textContent).toBe('流文字继续到达')
 })
 it('defers disruptive formatting until selection releases and then uses the newest received reply',async()=>{
  const f=rowFixture('开头 **选中文字'),node=f.row.querySelector('p').firstChild,selection=select(node,5,9)
  expect(f.patch('开头 **选中文字** 第一版').deferred).toBe(1)
  expect(f.patch('开头 **选中文字** 最新版').deferred).toBe(1)
  expect(f.row.querySelector('strong')).toBeNull();expect(selection.toString()).toBe('选中文字')
  selection.removeAllRanges();document.dispatchEvent(new Event('selectionchange'));await settle()
  expect(f.row.querySelector('strong')?.textContent).toBe('选中文字');expect(f.row.textContent).toContain('最新版')
  expect(f.row.textContent).not.toContain('第一版')
 })
 it('defers a focused link replacement until blur and never replays stale rows after full paint',async()=>{
  const f=rowFixture('[查看](https://example.test/old)'),link=f.row.querySelector('a');link.focus()
  expect(f.patch('[查看](https://example.test/new)').deferred).toBe(1);expect(link.href).toContain('/old')
  link.blur();await settle();expect(f.row.querySelector('a')?.href).toContain('/new')
  const node=f.row.querySelector('p').firstChild
  // A selected link would disappear when its formatting becomes plain text.
  select(node.firstChild,0,2);f.patch('已替换')
  f.root.querySelector('.wb-dialogue').innerHTML=render.message(event('全量重画的更新'))
  document.getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));await settle()
  expect(f.root.querySelector('p').textContent).toBe('全量重画的更新')
 })
 it('protects a horizontally scrolled code block from a format change and flushes when it returns to the left',async()=>{
  const f=rowFixture('```ts\nwide code\n```'),pre=f.row.querySelector('pre');pre.scrollLeft=80
  expect(f.patch('普通段落').deferred).toBe(1);expect(f.row.querySelector('pre')).toBe(pre);expect(pre.scrollLeft).toBe(80)
  pre.scrollLeft=0;pre.dispatchEvent(new Event('scroll'));await settle()
  expect(f.row.querySelector('pre')).toBeNull();expect(f.row.querySelector('p').textContent).toBe('普通段落')
 })
})

async function pageFixture(){
 document.body.innerHTML='<div id="workbench-root"></div>'
 const module=await import('./workbench.js'),task={id:'A',title:'合成工作台',path:'/fixture',providerId:'codex',status:'running',createdAt:1,updatedAt:1,error:null}
 const permission=id=>({id,taskId:'A',tool:'command',description:`申请 ${id}`,createdAt:1})
 let detail={task,version:1,events:[event('初始回复')],artifacts:[{id:'file',taskId:'A',name:'fixture.md',mime:'text/plain',size:5,sha256:'a'.repeat(64),createdAt:1,approvedAt:null}],permissions:['p1','p2','p3'].map(permission)}
 let release=null
 const invokeWorkbenchApi=vi.fn(async(method,path)=>{
  if(path.startsWith('/v1/workbench/task?'))return path.includes('since=')?new Promise(resolve=>{release=resolve}):detail
  if(path.startsWith('/v1/workbench/review?'))return{reviews:[]}
  if(path.startsWith('/v1/matters?'))return{matters:[]}
  return{tasks:[task],providers:[],defaultProvider:'codex',canWechat:false}
 })
 const controller=module.initWorkbenchPage({invokeWorkbenchApi,pollMs:60000})
 cleanup=()=>module.stopWorkbenchPolling()
 await vi.waitFor(()=>expect(controller.state.detail?.task.id).toBe('A'))
 const root=document.getElementById('workbench-root')
 const content=()=>root.querySelector('.wb-content')
 const geometry=()=>{Object.defineProperties(content(),{clientHeight:{configurable:true,value:100},scrollHeight:{configurable:true,value:1000}})}
 geometry()
 return{root,controller,invokeWorkbenchApi,content,geometry,permission,push:async events=>{await vi.waitFor(()=>expect(release).toBeTypeOf('function'));const resolve=release;release=null;detail={...detail,version:detail.version+1,events};resolve(detail);await settle()}}
}
describe('workbench page interaction through actual controls',()=>{
 it('retains read nodes, source disclosure, selection and link focus through a permission/status full paint',async()=>{
  const f=await pageFixture(),text='保持选区文本\n\n[查看网页](https://example.test/read)\n\n```ts\nwide code\n```'
  f.controller.state.detail.events=[event(text),{...event('**用户要求**'),id:'2',kind:'user'}];f.controller.paint(true);f.geometry()
  const row=f.root.querySelector('#'+workbenchTimelineEventId(event(text))),paragraph=row.querySelector('p'),link=row.querySelector('a'),pre=row.querySelector('pre'),source=f.root.querySelector('[data-user-source]')
  source.open=true;link.focus();const selection=select(paragraph.firstChild,2,4);pre.scrollLeft=120;f.content().scrollTop=250
  f.controller.state.detail.permissions=[];f.controller.state.detail.task={...f.controller.state.detail.task,status:'completed'}
  f.controller.paint(true)
  expect(f.root.querySelector('#'+row.id)).toBe(row);expect(row.querySelector('p')).toBe(paragraph)
  expect(document.activeElement).toBe(link);expect(pre.scrollLeft).toBe(120);expect(source.open).toBe(true)
  expect(selection.toString()).toBe('选区');expect(selection.anchorOffset).toBe(2);expect(selection.focusOffset).toBe(4)
  expect(f.content().scrollTop).toBe(250)
 })
 it('defers a destructive message format change during full paint until the reader releases selection',async()=>{
  const f=await pageFixture();f.controller.state.detail.events=[event('开头 **选中文字')];f.controller.paint(true)
  const id=workbenchTimelineEventId(event('')),node=f.root.querySelector('#'+id+' p').firstChild,selection=select(node,5,9)
  f.controller.state.detail.events=[event('开头 **选中文字** 最新版')];f.controller.paint(true)
  expect(f.root.querySelector('#'+id+' strong')).toBeNull();expect(selection.toString()).toBe('选中文字')
  selection.removeAllRanges();document.dispatchEvent(new Event('selectionchange'));await settle()
  expect(f.root.querySelector('#'+id+' strong')?.textContent).toBe('选中文字');expect(f.root.textContent).toContain('最新版')
 })
 it('restores selection extending from a message into the operation group summary after full paint',async()=>{
  const f=await pageFixture();f.controller.state.detail.task={...f.controller.state.detail.task,status:'completed'}
  f.controller.state.detail.events=[event('正文选区文本'),{...event('ls'),id:'2',kind:'tool_call',runId:'run'}];f.controller.paint(true)
  const paragraph=f.root.querySelector('.wb-message p').firstChild,summary=f.root.querySelector('[data-timeline-group] > summary span').firstChild,selection=document.getSelection()
  selection.setBaseAndExtent(paragraph,2,summary,2);const before=selection.toString()
  f.controller.paint(true)
  expect(selection.toString()).toBe(before);expect(selection.anchorNode).toBe(paragraph);expect(selection.focusNode.isConnected).toBe(true)
  expect(selection.anchorOffset).toBe(2);expect(selection.focusOffset).toBe(2)
 })
 it('gives distinct stable control identities to ambiguous task/request boundaries',()=>{
  expect(permissionControlId('a','bc','allow-permission')).not.toBe(permissionControlId('ab','c','allow-permission'))
 })
 it.each(['allow-permission','deny-permission'])('restores %s by task/request, then the next request, then the followup without authorizing anything',async action=>{
  const f=await pageFixture(),button=id=>f.root.querySelector(`[data-action="${action}"][data-request-id="${id}"]`)
  button('p2').focus();const stableId=document.activeElement.id
  f.controller.paint(true);expect(document.activeElement.id).toBe(stableId)
  f.controller.state.detail.permissions=['p1','p3'].map(f.permission);f.controller.paint(true)
  expect(document.activeElement.dataset.requestId).toBe('p3');expect(document.activeElement.dataset.action).toBe(action)
  f.controller.state.detail.permissions=[];f.controller.paint(true)
  expect(document.activeElement.id).toBe('wb-followup-text')
  expect(f.invokeWorkbenchApi.mock.calls.every(([method])=>method==='GET')).toBe(true)
 })
 it('keeps the original next permission when several earlier requests disappear together',async()=>{
  const f=await pageFixture()
  f.controller.state.detail.permissions=['p1','p2','p3','p4'].map(f.permission);f.controller.paint(true)
  f.root.querySelector('[data-action="allow-permission"][data-request-id="p2"]').focus()
  f.controller.state.detail.permissions=['p3','p4'].map(f.permission);f.controller.paint(true)
  expect(document.activeElement.dataset.requestId).toBe('p3')
 })
 it('returns from artifacts to the original location, closes the results, preserves the preview and follows new content again',async()=>{
  const f=await pageFixture(),preview={artifactId:'file',html:'<pre>cached preview</pre>'}
  f.controller.state.selectedArtifactId='file';f.controller.state.preview=preview;f.controller.state.previewOpen=false;f.controller.paint(true);f.geometry()
  f.content().scrollTop=317;f.content().dispatchEvent(new Event('scroll'))
  f.root.querySelector('[data-action="show-artifacts"]').click()
  expect(f.root.querySelector('.wb-artifact-panel')).not.toBeNull()
  f.content().scrollTop=900;f.root.querySelector('[data-action="back-to-dialogue"]').click()
  expect(f.root.querySelector('#wb-artifacts').open).toBe(false);expect(f.content().scrollTop).toBe(317)
  expect(f.controller.state.selectedArtifactId).toBe('file');expect(f.controller.state.preview).toBe(preview)
  f.geometry();f.content().scrollTop=900;f.content().dispatchEvent(new Event('scroll'))
  await f.push([event('初始回复\n\n继续流入')])
  expect(f.content().scrollTop).toBe(1000);expect(f.root.querySelector('.wb-reading-bar').hidden).toBe(true)
  expect(f.root.textContent).toContain('继续流入')
 })
 it('also remembers the return position when artifacts are opened by their own summary',async()=>{
  const f=await pageFixture();f.content().scrollTop=285
  f.root.querySelector('#wb-artifacts > summary').click();expect(f.root.querySelector('#wb-artifacts').open).toBe(true)
  f.content().scrollTop=700;f.root.querySelector('[data-action="back-to-dialogue"]').click()
  expect(f.content().scrollTop).toBe(285);expect(f.root.querySelector('#wb-artifacts').open).toBe(false)
 })
 it('returns from an open preview to latest content and keeps following later replies',async()=>{
  vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockReturnValue(1000)
  const f=await pageFixture(),preview={artifactId:'file',html:'<pre>cached preview</pre>'}
  f.controller.state.selectedArtifactId='file';f.controller.state.preview=preview;f.controller.state.previewOpen=true
  f.controller.paint(true);f.geometry();f.content().scrollTop=300;f.content().dispatchEvent(new Event('scroll'))
  await f.push([event('初始回复\n\n第二条内容')])
  f.root.querySelector('[data-action="latest-content"]').click();f.geometry()
  expect(f.root.querySelector('.wb-artifact-panel')).toBeNull()
  await f.push([event('初始回复\n\n第二条内容\n\n之后仍继续跟随')])
  expect(f.content().scrollTop).toBe(1000);expect(f.root.querySelector('.wb-reading-bar').hidden).toBe(true)
 })
})
