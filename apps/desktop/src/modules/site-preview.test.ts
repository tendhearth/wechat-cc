import {describe,expect,it} from 'vitest'
import {zipSync} from 'fflate'
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {snapshotSite} from '../../../../src/core/workbench/site-artifact'
import {readSiteArchive,MAX_SITE_BYTES} from './site-preview.js'
const bytes=(s:string)=>new TextEncoder().encode(s)
const zip=(files:Record<string,Uint8Array>,entry='网站/index.html')=>zipSync({'__cc_preview.json':bytes(JSON.stringify({version:1,entry})),...files},{level:0})
const page={'网站/index.html':bytes('<link rel="stylesheet" href="style.css"><h1>网站</h1>'),'网站/style.css':bytes('h1{color:green}'),'网站/app.mjs':bytes('import "./util.mjs"')}
describe('frozen website ZIP reader',()=>{
 it('reads the actual collector archive with the same entry, resources and version bytes',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-site-reader-')))
  try{
   mkdirSync(join(root,'网站'))
   for(const [name,content] of Object.entries(page))writeFileSync(join(root,name),content)
   writeFileSync(join(root,'site.site.json'),JSON.stringify({entry:'网站/index.html',files:Object.keys(page)}))
   const old=snapshotSite(root,'site.site.json')
   writeFileSync(join(root,'网站/style.css'),'h1{color:blue}')
   const result=readSiteArchive(old)
   expect(result.entry).toBe('网站/index.html')
   expect(Buffer.from(result.files.find(f=>f.path==='网站/style.css')!.contentBase64,'base64').toString()).toBe('h1{color:green}')
   expect(readSiteArchive(snapshotSite(root,'site.site.json')).files.find(f=>f.path==='网站/style.css')!.contentBase64).not.toBe(result.files.find(f=>f.path==='网站/style.css')!.contentBase64)
  }finally{rmSync(root,{recursive:true,force:true})}
 })
 it('opens exact saved resources and entry source without touching project paths',()=>{
  const result=readSiteArchive(zip(page))
  expect(result.entry).toBe('网站/index.html')
  expect(result.source).toContain('style.css')
  expect(result.files.find(f=>f.path==='网站/app.mjs')).toEqual({path:'网站/app.mjs',mime:'text/javascript',contentBase64:Buffer.from(page['网站/app.mjs']).toString('base64')})
  expect(result.files).toHaveLength(3)
 })
 it('rejects missing or malformed metadata and incomplete sites',()=>{
  for(const value of [bytes('bad'),zipSync(page,{level:0}),zip(page,'missing.html'),zip({'__cc_preview.json':bytes('{bad'),'index.html':bytes('hi')}),zip({'note.txt':bytes('hi')},'note.txt')])expect(()=>readSiteArchive(value)).toThrow('网页成品')
 })
 it('rejects unsafe paths, unsupported types and resource excess before extracting',()=>{
  for(const name of ['../leak.html','/leak.html','foo/../leak.html','bad\\leak.html','bad%2fleak.html','secret.env','file.constructor','file.html?x','file.html#x'])expect(()=>readSiteArchive(zip({...page,[name]:bytes('hi')}))).toThrow('网页成品')
  expect(()=>readSiteArchive(zip({...page,'large.txt':new Uint8Array(MAX_SITE_BYTES)}))).toThrow('网页成品')
  expect(()=>readSiteArchive(zip({...page,...Object.fromEntries(Array.from({length:100},(_,i)=>[`${i}.txt`,bytes('')]))}))).toThrow('网页成品')
  // This delivery format uses stored ZIP entries: compressed files cannot hide an expansion bomb.
  expect(()=>readSiteArchive(zipSync({'__cc_preview.json':bytes('{"version":1,"entry":"index.html"}'),'index.html':bytes('hello'.repeat(100))},{level:9}))).toThrow('网页成品')
 })
})
