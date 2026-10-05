import {describe,expect,it} from 'vitest'
import {isHtmlArtifact,localPreviewUrl,readWebPreview,renderArtifactFrame,renderArtifactPanel} from './workbench-artifact-preview.js'

describe('workbench artifact previews',()=>{
  it('recognizes legacy HTML snapshots and the current HTML MIME',()=>{
    expect(isHtmlArtifact('page.HTML','text/plain')).toBe(true)
    expect(isHtmlArtifact('page.htm','application/octet-stream')).toBe(true)
    expect(isHtmlArtifact('page','text/html; charset=utf-8')).toBe(true)
    expect(isHtmlArtifact('page.html.txt','text/plain')).toBe(false)
  })
  it('accepts explicit loopback previews and excludes credentials, external hosts and the app origin',()=>{
    expect(localPreviewUrl('http://localhost:3000/about?q=1')).toBe('http://localhost:3000/about?q=1')
    expect(localPreviewUrl('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173/')
    expect(localPreviewUrl('http://127.0.0.1:5173/','null')).toBe('http://127.0.0.1:5173/')
    expect(localPreviewUrl('http://127.0.0.1:5173/','tauri://localhost')).toBe('http://127.0.0.1:5173/')
    for(const value of ['javascript:alert(1)','file:///tmp/page.html','https://example.com:3000','http://localhost.evil:3000','http://user:pass@localhost:3000','http://localhost','http://127.0.0.1:4193/__invoke','http://localhost:4193/index.html']) {
      expect(localPreviewUrl(value,'http://127.0.0.1:4193')).toBeNull()
    }
  })
  it('does not turn an arbitrary JSON report into a live webpage',()=>{
    expect(readWebPreview('report.json','{"url":"http://localhost:3000"}')).toBeNull()
    expect(readWebPreview('site.preview.json','{"url":"http://localhost:3000"}')).toBe('http://localhost:3000/')
    expect(()=>readWebPreview('site.preview.json','{"url":"https://example.com"}')).toThrow('这台电脑')
    expect(()=>readWebPreview('site.preview.json','bad')).toThrow('更新这份成果')
  })
  it('isolates saved HTML from app privileges while preserving separate-origin web applications',()=>{
    expect(renderArtifactFrame('blob:example','<page>','html')).toContain('sandbox="allow-scripts"')
    expect(renderArtifactFrame('blob:example','<page>','html')).not.toContain('allow-same-origin')
    expect(renderArtifactFrame('http://localhost:3000','site','web')).toContain('sandbox="allow-scripts allow-same-origin allow-forms"')
    expect(renderArtifactFrame('blob:example','<page>','pdf')).toContain('title="&lt;page&gt;"')
  })
  it('distinguishes live output from saved versions and escapes source text',()=>{
    const artifact={id:'a',name:'site.html',size:2,approvedAt:null}
    const live=renderArtifactPanel([artifact],artifact,{artifactId:'a',html:'frame',kind:'web',url:'http://localhost:3000'})
    expect(live).toContain('运行中的网页')
    expect(live).not.toContain('确认这份成果')
    const source=renderArtifactPanel([artifact],artifact,{artifactId:'a',html:'frame',source:'<script>alert(1)</script>',mode:'source'})
    expect(source).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(source).toContain('确认这份成果')
    expect(renderArtifactPanel([artifact],undefined,null)).toBe('')
  })
})
