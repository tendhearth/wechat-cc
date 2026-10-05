/** Browser development counterpart of the cc-preview Tauri protocol.
 * IDs identify entries, not credentials. Only the existing guarded /__invoke
 * creates previews, and this route refuses cross-site reads. No disk IO.
 */
import {MAX_SITE_BYTES,validSitePath,siteFileMime} from './src/modules/site-preview.js'
export const MAX_HTML_BYTES = 8 * 1024 * 1024
export const MAX_PREVIEWS = 4
export const PREVIEW_PREFIX = '/__workbench_preview/'
export const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts"
export const PREVIEW_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': PREVIEW_CSP,
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)
let nextId = 0n

/** Adds only this shim's preview path; script-src and every other directive stay unchanged. */
export function htmlPreviewParentCsp(csp: string, origin: string): string {
  const source = new URL(PREVIEW_PREFIX, origin).href
  let found = false
  const parts = csp.split(';').map(part => {
    if (!/^\s*frame-src(?:\s|$)/.test(part)) return part
    found = true
    return part.split(/\s+/).includes(source) ? part : `${part} ${source}`
  })
  if (!found) parts.push(` frame-src ${source}`)
  return parts.join(';')
}

export function createHtmlPreviewHost() {
  const entries = new Map<string, {files:Map<string,{bytes:Uint8Array,mime:string}>,site:boolean}>()
  const encoder = new TextEncoder()
  const response = (body: string | Uint8Array, status: number, headers:Record<string,string>=PREVIEW_HEADERS) => new Response(typeof body === 'string' ? body : Uint8Array.from(body), { status, headers })
  const add=(files:Map<string,{bytes:Uint8Array,mime:string}>,site:boolean,entry:string,origin:string)=>{
    const id=((BigInt(Date.now())<<64n)|++nextId).toString(16).padStart(32,'0')
    while(entries.size>=MAX_PREVIEWS)entries.delete(entries.keys().next().value!)
    entries.set(id,{files,site})
    return new URL(`${PREVIEW_PREFIX}${id}/${entry.split('/').map(encodeURIComponent).join('/')}`,origin).href
  }
  return {
    prepare(html: unknown, origin: string): string {
      if (typeof html !== 'string') throw Error('invalid_html_preview')
      const bytes = encoder.encode(html)
      if (bytes.byteLength > MAX_HTML_BYTES) throw Error('html_preview_too_large')
      return add(new Map([['index.html',{bytes,mime:'text/html; charset=utf-8'}]]),false,'index.html',origin)
    },
    prepareSite(entry:unknown, input:unknown, origin:string):string {
      if(!validSitePath(entry)||siteFileMime(entry)!=='text/html'||!Array.isArray(input)||!input.length||input.length>100)throw Error('invalid_site_preview')
      const files=new Map<string,{bytes:Uint8Array,mime:string}>();let total=0
      for(const file of input){
        if(!validSitePath(file?.path)||files.has(file.path)||!siteFileMime(file.path)||file.mime!==siteFileMime(file.path)||typeof file.contentBase64!=='string'||file.contentBase64.length>MAX_SITE_BYTES*4/3+4||file.contentBase64.length%4!==0||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64))throw Error('invalid_site_preview')
        const decoded=Buffer.from(file.contentBase64,'base64')
        if(decoded.toString('base64')!==file.contentBase64)throw Error('invalid_site_preview')
        const bytes=Uint8Array.from(decoded);total+=bytes.byteLength
        if(total>MAX_SITE_BYTES)throw Error('site_preview_too_large')
        files.set(file.path,{bytes,mime:(file.mime.startsWith('text/')||file.mime==='application/json')?`${file.mime}; charset=utf-8`:file.mime})
      }
      if(!files.has(entry))throw Error('invalid_site_preview')
      return add(files,true,entry,origin)
    },
    release(id: unknown): boolean {
      if (!validId(id)) throw Error('invalid_html_preview_id')
      return entries.delete(id)
    },
    handle(req: Request): Response | null {
      const url = new URL(req.url)
      if (!url.pathname.startsWith(PREVIEW_PREFIX)) return null
      const match=/^\/__workbench_preview\/([0-9a-f]{32})\/(.+)$/.exec(url.pathname)
      const entry=match?entries.get(match[1]!):undefined
      const origin=req.headers.get('origin'),site=req.headers.get('sec-fetch-site')
      const opaqueResource=entry?.site&&(!origin||origin==='null')
      if(!opaqueResource&&((origin&&origin!==url.origin)||(site&&!['same-origin','none'].includes(site))))return response('Forbidden',403)
      if(req.method!=='GET')return response('Method not allowed',405)
      if(url.search&&entry&&!entry.site)return response('Invalid preview path',400)
      let path=''
      try{if(/%2f|%5c/i.test(match?.[2]??''))throw Error('path');path=decodeURIComponent(match?.[2]??'')}catch{return response('Preview not found',404)}
      const resource=validSitePath(path)?entry?.files.get(path):undefined
      if(!resource)return response('Preview not found',404)
      if(!entry?.site)return response(resource.bytes,200)
      const prefix=new URL(`${PREVIEW_PREFIX}${match![1]}/`,url.origin).href
      const csp=`default-src 'none'; script-src 'unsafe-inline' ${prefix}; style-src 'unsafe-inline' ${prefix}; img-src data: blob: ${prefix}; font-src data: ${prefix}; connect-src ${prefix}; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`
      return response(resource.bytes,200,{...PREVIEW_HEADERS,'content-type':resource.mime,'content-security-policy':csp,'access-control-allow-origin':'*'})
    },
  }
}
