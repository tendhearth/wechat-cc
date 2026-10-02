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
  it('formats only assistant prose while preserving user, system, error and tool text',()=>{
    const h=setup(),literal='**原样** [文字](https://example.com)\n<em>HTML 原文</em>'
    h.mRenderEvents([
      {kind:'text',text:'# 结果\n\n**重点** [文档](https://example.com)\n\n- 第一项\n- 第二项\n\n```ts\nconst n = 1\n```\n\n| 一 | 二 |\n| --- | --- |\n| 甲 | 乙 |',createdAt:1},
      ...['user','system','error','tool_call'].map(kind=>({kind,text:literal,createdAt:2})),
    ])
    const root=h.get('m-events'),assistant=root.querySelector('.m-markdown')!
    expect(assistant.querySelector('h1')?.textContent).toBe('结果')
    expect(assistant.querySelector('strong')?.textContent).toBe('重点')
    expect(assistant.querySelector('a')?.getAttribute('href')).toBe('https://example.com/')
    expect(assistant.querySelectorAll('li')).toHaveLength(2)
    expect(assistant.querySelector('pre code')?.textContent).toContain('const n = 1')
    expect(assistant.querySelectorAll('table td')).toHaveLength(2)
    const plain=Array.from(root.querySelectorAll('.tx>p,.m-tool-events pre'))
    expect(plain).toHaveLength(4)
    for(const row of plain){expect(row.textContent).toBe(literal);expect(row.querySelector('a,strong,em')).toBeNull()}
    expect(root.querySelector('details')?.hasAttribute('open')).toBe(false)
  })

  it('never turns untrusted replies into executable HTML, local controls, unsafe links or remote image requests',()=>{
    const h=setup()
    h.mRenderEvents([{kind:'text',createdAt:1,text:'<button data-control="allow" onclick="bad()">伪造批准</button>\n\n<script>bad()</script>\n\n[坏](javascript:bad()) [文件](file:///private/a) [应用](codex://bad) [真实](https://example.com) ![图片](https://example.com/tracking.png)'}])
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
