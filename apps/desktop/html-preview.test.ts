import { describe, expect, it as test } from 'vitest'
import { createHtmlPreviewHost, htmlPreviewParentCsp, MAX_HTML_BYTES, PREVIEW_CSP } from './html-preview'
const origin = 'http://127.0.0.1:43123'
const idOf = (url: string) => /\/([0-9a-f]{32})\/index\.html$/.exec(url)![1]!
describe('isolated HTML preview shim', () => {
  test('serves a complete saved website with relative assets, UTF8 paths and cache-busting queries',async()=>{
    const host=createHtmlPreviewHost()
    const files=[{path:'网站/index.html',mime:'text/html',contentBase64:Buffer.from('<script type="module" src="app.mjs"></script>').toString('base64')},{path:'网站/app.mjs',mime:'text/javascript',contentBase64:Buffer.from('export const value=3').toString('base64')}]
    const url=host.prepareSite('网站/index.html',files,origin)
    expect(await host.handle(new Request(url))!.text()).toContain('app.mjs')
    const asset=new URL('app.mjs?v=1',url).href
    const response=host.handle(new Request(asset,{headers:{origin:'null','sec-fetch-site':'cross-site'}}))!
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.text()).toBe('export const value=3')
    const csp=response.headers.get('content-security-policy')!
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).toContain(new URL('../',url).href)
    const id=url.match(/\/([0-9a-f]{32})\//)![1]!
    host.release(id)
    expect(host.handle(new Request(asset))!.status).toBe(404)
  })
  test('rejects incomplete, unsafe or oversized bundles before storing them',()=>{
    const host=createHtmlPreviewHost()
    const file={path:'index.html',mime:'text/html',contentBase64:'aGk='}
    for(const files of [[],[file,file],[{...file,path:'../index.html'}],[{...file,mime:'application/octet-stream'}],[{...file,contentBase64:'!?'}],[{...file,contentBase64:Buffer.alloc(6*1024*1024+1).toString('base64')}],Array.from({length:101},(_,i)=>({...file,path:`${i}.html`}))])expect(()=>host.prepareSite('index.html',files,origin)).toThrow()
    expect(()=>host.prepareSite('missing.html',[file],origin)).toThrow()
    const url=host.prepareSite('index.html',[file],origin)
    expect(host.handle(new Request(url.replace('index.html','%2e%2e%2findex.html')))!.status).toBe(404)
  })
  test('returns exact HTML and its own response CSP, then releases idempotently', async () => {
    const host = createHtmlPreviewHost(), html = '<script>window.test="中文"</script>'
    const url = host.prepare(html, origin), res = host.handle(new Request(url))!
    expect(await res.text()).toBe(html)
    expect(res.headers.get('content-security-policy')).toBe(PREVIEW_CSP)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(host.release(idOf(url))).toBe(true)
    expect(host.release(idOf(url))).toBe(false)
    expect(host.handle(new Request(url))!.status).toBe(404)
  })
  test('bounds UTF-8 bytes and keeps at most four previews', () => {
    const host = createHtmlPreviewHost()
    host.prepare('x'.repeat(MAX_HTML_BYTES), origin)
    expect(() => host.prepare('x'.repeat(MAX_HTML_BYTES + 1), origin)).toThrow('html_preview_too_large')
    expect(() => host.prepare('你'.repeat(Math.floor(MAX_HTML_BYTES / 3) + 1), origin)).toThrow('html_preview_too_large')
    const urls = Array.from({length:5}, (_, i) => host.prepare(String(i), origin))
    expect(host.handle(new Request(urls[0]!))!.status).toBe(404)
    for (const url of urls.slice(1)) expect(host.handle(new Request(url))!.status).toBe(200)
  })
  test('rejects cross-site reads, methods, query strings and invalid paths', () => {
    const host = createHtmlPreviewHost(), url = host.prepare('document', origin)
    expect(host.handle(new Request(url, {headers:{origin:'https://example.com'}}))!.status).toBe(403)
    expect(host.handle(new Request(url, {headers:{'sec-fetch-site':'cross-site'}}))!.status).toBe(403)
    expect(host.handle(new Request(url, {method:'POST'}))!.status).toBe(405)
    expect(host.handle(new Request(url+'?bad=1'))!.status).toBe(400)
    expect(host.handle(new Request(origin+'/__workbench_preview/%2e/index.html'))!.status).toBe(404)
    expect(host.handle(new Request(origin+'/index.html'))).toBeNull()
  })
  test('adds only the shim preview frame path and retains parent script-src', () => {
    const parent = "default-src 'self'; script-src 'self'; frame-src blob: cc-preview: http://cc-preview.localhost"
    const result = htmlPreviewParentCsp(parent, origin)
    expect(result).toBe(parent+' '+origin+'/__workbench_preview/')
    expect(result.split(';').find(part => part.trim().startsWith('script-src'))?.trim()).toBe("script-src 'self'")
    expect(htmlPreviewParentCsp(result, origin)).toBe(result)
  })
})
