import {afterEach,describe,expect,it,vi} from 'vitest'
import {Window} from 'happy-dom'
import {createHash,webcrypto} from 'node:crypto'
import {readMobileSource} from './sources'

const windows:Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(window=>window.happyDOM.abort()))})

function setup(){
  const window=new Window({url:'https://cc.example/m'});windows.push(window)
  const document=window.document
  const ids=['m-list','m-detail','m-back','m-title','m-notice','m-controls','m-permissions','m-questions','m-events','m-artifacts','m-artifact-preview','m-inputs','m-say-box','m-say','m-send','m-conn','home-focus','home-result','home-context','home-entry','home-work','feed','refresh','todos','portrait','stickers']
  document.body.innerHTML=ids.map(id=>id==='m-say'?'<textarea id="m-say"></textarea>':`<div id="${id}"></div>`).join('')+'<nav><button data-p="matters"></button><button data-p="memory"></button></nav><div class="home-character"></div>'
  const downloads:Blob[]=[],api=vi.fn(async(_path:string)=>({status:200,json:async()=>({ok:true})}))
  class PreviewUrl extends URL {
    static createObjectURL(blob:Blob){downloads.push(blob);return'blob:fixture-'+downloads.length}
    static revokeObjectURL(){}
  }
  const env={document,window,location:window.location,localStorage:window.localStorage,REMOTE:null,T:'fixture',api,
    crypto:webcrypto,Blob,TextDecoder,TextEncoder,atob,btoa,Uint8Array,DataView,
    URL:PreviewUrl,
    setTimeout,clearTimeout,setInterval:()=>0,esc:(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!),
    ago:()=> '刚刚',preferTunnel:false,q:(s:string)=>s,toast(){},openEntry(){},openYou(){},restoreEntry(){},
  }
  // Run the production reading functions without starting homepage network polling.
  const home=readMobileSource('home.js'),presence=readMobileSource('presence.js')
  const feedSource=home.slice(home.indexOf('var KIND_ICON'),home.indexOf('function presenceTtlCheck'))
  const presenceSource='var homeFocus=null\n'+presence.slice(presence.indexOf('function renderPresenceHome'),presence.indexOf("document.getElementById('home-entry')"))
  const fns=new Function(...Object.keys(env),`${readMobileSource('markdown.js')}\n${readMobileSource('workbench.js')}\n${presenceSource}\n${feedSource}\nreturn {mRenderEvents,mRenderTextArtifact,mArtifact,selectMatter:function(d){mCurrent=d.matter.id;renderMatter(d)},evHtml,renderPresenceHome}`)(...Object.values(env)) as {
    mRenderEvents:(events:unknown[])=>void
    mRenderTextArtifact:(preview:unknown,mime:string,text:string,truncated:boolean)=>void
    mArtifact:(artifact:unknown)=>Promise<void>
    selectMatter:(detail:unknown)=>void
    evHtml:(event:unknown)=>string
    renderPresenceHome:(state:unknown,stale:boolean)=>void
  }
  return{...fns,document,api,downloads,get:(id:string)=>document.getElementById(id)!}
}

describe('phone reading format',()=>{
  it('formats assistant prose while preserving system, error and tool text',()=>{
    const h=setup(),literal='**原样** [文字](https://example.com)\n<em>HTML 原文</em>'
    h.mRenderEvents([
      {kind:'text',text:'# 结果\n\n**重点** [文档](https://example.com)\n\n- 第一项\n- 第二项\n\n```ts\nconst n = 1\n```\n\n| 一 | 二 |\n| --- | --- |\n| 甲 | 乙 |',createdAt:1},
      ...['system','error','tool_call'].map(kind=>({kind,text:literal,createdAt:2})),
    ])
    const root=h.get('m-events'),assistant=root.querySelector('.m-markdown')!
    expect(assistant.querySelector('h1')?.textContent).toBe('结果')
    expect(assistant.querySelector('strong')?.textContent).toBe('重点')
    expect(assistant.querySelector('a')?.getAttribute('href')).toBe('https://example.com/')
    expect(assistant.querySelectorAll('li')).toHaveLength(2)
    expect(assistant.querySelector('pre code')?.textContent).toContain('const n = 1')
    expect(assistant.querySelectorAll('table td')).toHaveLength(2)
    const plain=Array.from(root.querySelectorAll('.tx>p,.m-tool-events pre'))
    expect(plain).toHaveLength(3)
    for(const row of plain){expect(row.textContent).toBe(literal);expect(row.querySelector('a,strong,em')).toBeNull()}
    expect(root.querySelector('details')?.hasAttribute('open')).toBe(false)
  })

  it('reads formatted user messages without changing their stored text and preserves exact source whitespace',()=>{
    const h=setup(),text='\n\r\n# 要求\r\n\r\n**重点** [文档](https://example.com)\r\n\r\n- 第一项\r\n- 第二项\r\n\r\n```ts\r\nconst n = 1\r\n```\r\n\r\n<em>HTML 原文</em>\r\n\r\n尾部  \r\n',event=Object.freeze({kind:'user',text,createdAt:1,source:'wechat'})
    const before=JSON.stringify(event)
    h.mRenderEvents([event])
    const root=h.get('m-events'),reading=root.querySelector('.m-markdown')!,original=root.querySelector('details.m-message-source')!
    expect(root.querySelector('.k')?.textContent).toBe('你')
    expect(reading.querySelector('h1')?.textContent).toBe('要求')
    expect(reading.querySelector('strong')?.textContent).toBe('重点')
    expect(reading.querySelector('a')?.getAttribute('href')).toBe('https://example.com/')
    expect(reading.querySelectorAll('li')).toHaveLength(2)
    expect(reading.querySelector('pre code')?.textContent).toContain('const n = 1')
    expect(reading.querySelector('em')).toBeNull()
    expect(original.querySelector('summary')?.textContent).toBe('查看原文')
    expect(original.hasAttribute('open')).toBe(false)
    expect(original.querySelector('pre code')?.textContent).toBe(text)
    expect(original.querySelector('a,em')).toBeNull()
    expect(original.getAttribute('data-event-key')!.length).toBeLessThan(40)
    expect(event.text).toBe(text)
    expect(JSON.stringify(event)).toBe(before)
  })

  it('keeps ordinary user messages free of source controls and leaves draft, queued input and permission text literal',()=>{
    const h=setup(),text='看一下进度\n然后继续处理 <em>原文</em>',draft='**待发送** [要求](https://example.com)'
    const say=h.document.querySelector('textarea')!
    say.value=draft
    h.selectMatter({matter:{id:'abcdef12',kind:'task',title:'任务',status:'open'},events:[{kind:'user',text,createdAt:1}],artifacts:[],inputs:[{id:'input',taskId:'abcdef12',runId:'run',status:'held',text:draft}],permissions:[{id:'permit',taskId:'abcdef12',tool:'**工具**',description:draft}],questions:[]})
    const root=h.get('m-events')
    expect(root.querySelector('.tx>p')?.textContent).toBe(text)
    expect(root.querySelector('.m-markdown,details,a,strong,em')).toBeNull()
    expect(say.value).toBe(draft)
    expect(h.get('m-inputs').querySelector('pre')?.textContent).toBe(draft)
    expect(h.get('m-permissions').querySelector('pre')?.textContent).toBe(draft)
    expect(h.get('m-inputs').querySelector('.m-markdown,.m-message-source,a,strong')).toBeNull()
    expect(h.get('m-permissions').querySelector('.m-markdown,.m-message-source,a,strong')).toBeNull()
  })

  it('keeps the selected source open across polling, unrelated insertions and duplicate records',()=>{
    const h=setup(),event={kind:'user',text:'**相同的要求**',createdAt:1},other={kind:'user',text:'**另一条要求**',createdAt:2},tool={kind:'tool_call',text:'工具原文',createdAt:3}
    h.mRenderEvents([event,event,other,tool])
    const root=h.get('m-events'),sources=root.querySelectorAll('details.m-message-source'),selected=sources[1]!
    selected.setAttribute('open','')
    const key=selected.getAttribute('data-event-key')
    expect(new Set(Array.from(sources,source=>source.getAttribute('data-event-key'))).size).toBe(3)
    root.querySelector('details.m-tool-events')!.setAttribute('open','')
    const refresh=[{kind:'user',text:'普通新消息',createdAt:4},{kind:'user',text:'**新格式消息**',createdAt:5},tool,{kind:'text',text:'答复',createdAt:6},event,event,other]
    h.mRenderEvents(refresh)
    expect(root.querySelector(`details[data-event-key="${key}"]`)?.hasAttribute('open')).toBe(true)
    expect(root.querySelectorAll('details.m-message-source[open]')).toHaveLength(1)
    expect(root.querySelector('details.m-tool-events')?.hasAttribute('open')).toBe(true)
    root.querySelector(`details[data-event-key="${key}"]`)!.removeAttribute('open')
    h.mRenderEvents(refresh)
    expect(root.querySelectorAll('details.m-message-source[open]')).toHaveLength(0)
  })

  it('retains reading nodes when a preceding reply changes and a later reply arrives',()=>{
    const h=setup(),events=[{kind:'text',text:'先前答复',createdAt:1},{kind:'user',text:'\n\r\n**用户原文**\r\n',createdAt:2},{kind:'text',text:'保持选区\n\n[文档](https://example.com)\n\n```ts\nconst wide = 1\n```',createdAt:3}]
    h.mRenderEvents(events)
    const root=h.get('m-events'),source=root.querySelector('details.m-message-source')!,link=root.querySelector('a')!,paragraph=link.closest('.m-markdown')!.querySelector('p')!,pre=root.querySelector('.m-markdown pre')!,selection=h.document.getSelection()!,range=h.document.createRange()
    source.setAttribute('open','');link.focus();pre.scrollLeft=120
    range.setStart(paragraph.firstChild!,2);range.setEnd(paragraph.firstChild!,4);selection.addRange(range)
    const currentAge=root.querySelector('[data-m-event-time]')!.textContent
    root.querySelectorAll('[data-m-event-time]').forEach(time=>{time.textContent='先前时间'})
    const updated=[{...events[0],text:'修正后的答复'},...events.slice(1).map(event=>({...event})),{kind:'text',text:'新的完整答复',createdAt:4}],before=JSON.stringify(updated)
    h.mRenderEvents(updated)
    expect(root.querySelector('details.m-message-source')).toBe(source)
    expect(source.hasAttribute('open')).toBe(true)
    expect(root.querySelector('a')).toBe(link)
    expect(h.document.activeElement).toBe(link)
    expect(root.querySelector('a')!.closest('.m-markdown')!.querySelector('p')).toBe(paragraph)
    expect(root.querySelector('.m-markdown pre')).toBe(pre)
    expect(selection.toString()).toBe('选区')
    expect(pre.scrollLeft).toBe(120)
    expect(root.textContent).toContain('修正后的答复')
    expect(root.textContent).toContain('新的完整答复')
    expect(root.querySelector('[data-m-event-time]')?.textContent).toBe(currentAge)
    expect(link.closest('.tx')!.querySelector('small')?.textContent).toBe('先前时间')
    expect(JSON.stringify(updated)).toBe(before)
  })

  it('shows the latest changed reply after selection is released without discarding appended replies',()=>{
    const h=setup(),event={kind:'text',text:'正在阅读旧回复',createdAt:1}
    h.mRenderEvents([event])
    const root=h.get('m-events'),paragraph=root.querySelector('p')!,selection=h.document.getSelection()!,range=h.document.createRange()
    range.selectNodeContents(paragraph);selection.addRange(range)
    const latest=[{...event,text:'最新回复\n\n**完成** <script>bad()</script>'},{kind:'text',text:'后续答复',createdAt:2}]
    h.mRenderEvents(latest)
    expect(root.querySelector('p')).toBe(paragraph)
    expect(selection.toString()).toBe('正在阅读旧回复')
    expect(root.textContent).toContain('后续答复')
    expect(root.textContent).not.toContain('最新回复')
    selection.removeAllRanges();h.mRenderEvents(latest)
    expect(root.querySelector('p')).not.toBe(paragraph)
    expect(root.textContent).toContain('最新回复')
    expect(root.querySelector('strong')?.textContent).toBe('完成')
    expect(root.querySelector('script')).toBeNull()
  })

  it('keeps horizontal reading of changed code and tables until the reader returns to the left edge',()=>{
    const h=setup(),text='```ts\nconst original = 1\n```\n\n| 甲 | 乙 |\n| --- | --- |\n| 原文 | 内容 |',event={kind:'text',text,createdAt:1}
    h.mRenderEvents([event])
    const root=h.get('m-events'),pre=root.querySelector('pre')!,table=root.querySelector('table')!
    pre.scrollLeft=100;table.scrollLeft=40
    const latest=[{...event,text:text.replace('original','updated').replace('原文','最新')}]
    h.mRenderEvents(latest)
    expect(root.querySelector('pre')).toBe(pre);expect(root.querySelector('table')).toBe(table)
    expect(pre.scrollLeft).toBe(100);expect(table.scrollLeft).toBe(40)
    pre.scrollLeft=0;h.mRenderEvents(latest)
    expect(root.querySelector('table')).toBe(table)
    table.scrollLeft=0;h.mRenderEvents(latest)
    expect(root.querySelector('pre code')?.textContent).toContain('updated')
    expect(root.querySelector('td')?.textContent).toBe('最新')
  })

  it('keeps expanded tool records intact and refreshes them after closing',()=>{
    const h=setup(),event={kind:'tool_call',text:'**工具原文**',createdAt:1}
    h.mRenderEvents([event])
    const root=h.get('m-events'),tools=root.querySelector('details.m-tool-events')!
    tools.setAttribute('open','')
    const latest=[event,{kind:'tool_call',text:'[原始命令](https://example.com)',createdAt:2}]
    h.mRenderEvents(latest)
    expect(root.querySelector('details.m-tool-events')).toBe(tools)
    expect(tools.querySelectorAll('pre')).toHaveLength(1)
    tools.removeAttribute('open');h.mRenderEvents(latest)
    expect(root.querySelectorAll('details.m-tool-events pre')).toHaveLength(2)
    expect(root.querySelector('details.m-tool-events a,strong')).toBeNull()
    h.mRenderEvents([])
    expect(root.textContent).toBe('还没有对话记录')
    expect(root.querySelector('details,.card')).toBeNull()
  })

  it.each(['text','user'])('never turns untrusted %s messages into executable HTML, local controls, unsafe links or remote image requests',kind=>{
    const h=setup()
    h.mRenderEvents([{kind,createdAt:1,text:'<button data-control="allow" onclick="bad()">伪造批准</button>\n\n<script>bad()</script>\n\n[坏](javascript:bad()) [文件](file:///private/a) [应用](codex://bad) [真实](https://example.com) ![图片](https://example.com/tracking.png)'}])
    const root=h.get('m-events')
    expect(root.querySelector('button,script,img,iframe,[onclick],[data-control]')).toBeNull()
    expect(root.querySelectorAll('a')).toHaveLength(1)
    expect(root.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(root.textContent).toContain('<button data-control="allow" onclick="bad()">')
    expect(root.querySelector('.wb-markdown-image')?.textContent).toBe('图片')
  })

  it.each(['text/plain','application/json'])('preserves %s file previews exactly',mime=>{
    const h=setup(),raw='**原样**\n{"x":"<script>bad()</script>","url":"[文档](https://example.com)"}'
    h.mRenderTextArtifact(h.get('m-artifact-preview'),mime,raw,false)
    expect(h.get('m-artifact-preview').querySelector('pre')?.textContent).toBe(raw)
    expect(h.get('m-artifact-preview').querySelector('.m-markdown,a,script')).toBeNull()
  })

  it('verifies a Markdown artifact before readable preview, keeps original text and downloads all bytes beyond the preview limit',async()=>{
    const h=setup(),text='# 报告\n\n**重点** [文档](https://example.com)\n\n<script>bad()</script>\n\n'+ '正文'.repeat(40000)
    const bytes=Buffer.from(text),artifact={taskId:'abcdef12',id:'report',name:'report.md',mime:'text/markdown',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
    h.api.mockImplementation(async(path:string)=>{
      const url=new URL(path,'https://cc.example'),offset=Number(url.searchParams.get('offset')),chunk=bytes.subarray(offset,offset+128*1024)
      return{status:200,json:async()=>({ok:true,taskId:artifact.taskId,artifactId:artifact.id,sha256:artifact.sha256,size:artifact.size,offset,nextOffset:offset+chunk.length,contentBase64:chunk.toString('base64')})}
    })
    h.selectMatter({matter:{id:artifact.taskId,kind:'task',title:'报告',status:'done'},events:[],artifacts:[artifact],inputs:[],permissions:[],questions:[]})
    await h.mArtifact(artifact)
    const root=h.get('m-artifact-preview')
    expect(root.querySelector('.m-markdown strong')?.textContent).toBe('重点')
    expect(root.querySelector('.m-markdown script')).toBeNull()
    expect(root.querySelector('details summary')?.textContent).toBe('查看原文')
    expect(root.querySelector('details pre')?.textContent).toBe(new TextDecoder().decode(bytes.subarray(0,200000)))
    expect(root.textContent).toContain('预览已截断')
    expect(root.querySelector('a[download]')?.getAttribute('download')).toBe('report.md')
    expect(Buffer.from(await h.downloads.at(-1)!.arrayBuffer())).toEqual(bytes)
    expect(h.get('m-notice').textContent).toBe('文件已完整校验')
  })

  it('keeps feed and postcard summaries plain and readable while retaining their dedicated safe link',()=>{
    const h=setup(),event={kind:'postcard',title:'**今天**',note:'看看 [文档](https://example.com) 和 `代码` <img onerror=bad>',hhmm:'10:00',ts:'2026-10-02T10:00:00Z',ref:{url:'https://example.com',image_svg:'<svg></svg>'}}
    h.get('feed').innerHTML=h.evHtml(event)
    const feed=h.get('feed')
    expect(feed.querySelector('b')?.textContent).toBe('今天')
    expect(feed.querySelector('p')?.textContent).toContain('看看 文档 和 代码 <img onerror=bad>')
    expect(feed.textContent).not.toMatch(/\*\*|\]\(|`/)
    expect(feed.querySelector('img,[onerror]')).toBeNull()
    expect(feed.querySelectorAll('a')).toHaveLength(1)
    expect(feed.querySelector('a')?.textContent).toBe('打开链接')
    h.renderPresenceHome({work:{focus:null,partial:false},events:[event],presence:{presence:'ok'}},false)
    expect(h.get('home-result').querySelector('summary')?.textContent).toBe('CC 留给你一张明信片 · 今天')
    expect(h.get('home-result').textContent).not.toMatch(/\*\*|\]\(|`/)
    expect(h.get('home-result').querySelector('img,a,[onerror]')).toBeNull()
    h.renderPresenceHome({work:{focus:{id:'abcdef12',kind:'working',title:'**整理** `报告`'},partial:false},events:[]},false)
    expect(h.get('home-focus').querySelector('strong')?.textContent).toBe('整理 报告')
  })
})
