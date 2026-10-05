import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {mkdirSync,mkdtempSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {renameSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {unzipSync} from 'fflate'
import {openTestDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {ArtifactSnapshotError,collectArtifacts,outputDirectory,readArtifactSnapshot,saveArtifactSnapshot} from './artifacts'
import {makeWorkbenchStore} from './store'
import {snapshotSite,SITE_ARTIFACT_MIME} from './site-artifact'

let root:string
const dbs:Db[]=[]
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-site-artifact-')))})
afterEach(()=>{for(const db of dbs.splice(0))db.close();removeTempDir(root)})

function put(path:string,bytes:string|Buffer) {
  mkdirSync(dirname(join(root,path)),{recursive:true})
  writeFileSync(join(root,path),bytes)
}
function declare(entry:unknown,files:unknown,name='garden.site.json') {
  put(name,JSON.stringify({entry,files}))
}
function unpack(bytes:Buffer) {
  expect(bytes.subarray(0,4)).toEqual(Buffer.from([0x50,0x4b,0x03,0x04]))
  return unzipSync(bytes)
}
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhZkAAAAASUVORK5CYII=','base64')
const website={
  '花园 版本/index.html':'<!doctype html><link rel="stylesheet" href="assets/style.css"><img src="assets/leaf.png"><button id="counter">0</button><script type="module" src="assets/app.js"></script>',
  '花园 版本/assets/style.css':'body{color:rgb(31,60,31);background-image:url("./leaf.png")}',
  '花园 版本/assets/app.js':'import {next} from "./counter.mjs";document.querySelector("#counter").onclick=next',
  '花园 版本/assets/counter.mjs':'export const next=()=>document.querySelector("#counter").textContent="1"',
  '花园 版本/assets/leaf.png':image,
}
function seedWebsite() {
  for(const [path,bytes] of Object.entries(website))put(path,bytes)
  declare('花园 版本/index.html',Object.keys(website))
}

describe('snapshotSite',()=>{
  it('freezes a real HTML site with linked CSS, module scripts and exact image bytes',()=>{
    seedWebsite()
    const zip=snapshotSite(root,'garden.site.json'),files=unpack(zip)
    expect(Object.keys(files).sort()).toEqual(['__cc_preview.json',...Object.keys(website)].sort())
    expect(JSON.parse(Buffer.from(files['__cc_preview.json']!).toString())).toEqual({version:1,entry:'花园 版本/index.html'})
    for(const [path,bytes] of Object.entries(website))expect(Buffer.from(files[path]!)).toEqual(Buffer.from(bytes))
    expect(zip.readUInt16LE(8)).toBe(0)
    expect(zip.readUInt16LE(10)).toBe(0)
    expect(zip.readUInt16LE(12)).toBe(33)
  })

  it('creates identical ZIP bytes when only declaration order or file timestamps change',()=>{
    seedWebsite()
    const first=snapshotSite(root,'garden.site.json')
    unpack(first)
    declare('花园 版本/index.html',Object.keys(website).reverse())
    put('花园 版本/assets/app.js',website['花园 版本/assets/app.js'])
    expect(snapshotSite(root,'garden.site.json')).toEqual(first)
  })

  it('accepts only the supported static website file formats',()=>{
    const extensions=['html','htm','css','js','mjs','json','txt','png','jpg','jpeg','webp','gif','svg','ico','woff','woff2','ttf']
    const paths=extensions.map(extension=>'files/example.'+extension)
    for(const path of paths)put(path,'fixture')
    declare(paths[0],paths)
    expect(Object.keys(unpack(snapshotSite(root,'garden.site.json'))).sort()).toEqual(['__cc_preview.json',...paths].sort())
  })

  it.each(['../outside.js','./script.js','/script.js','C:/script.js','C:script.js','site\\script.js','site//script.js','site/../script.js','site/./script.js','site/','script.js?version=1','script.js#part','%2e%2e/script.js','script%20name.js','script\u0000.js','script\n.js','script\u0085.js',''])('rejects unsafe declared path %j before reading it',path=>{
    put('index.html','page');declare('index.html',['index.html',path])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/路径/)
  })

  it.each(['../garden.site.json','./garden.site.json','/garden.site.json','garden.site.json?x=1','garden%20.site.json','garden\\site.json'])('rejects unsafe descriptor path %j',name=>{
    expect(()=>snapshotSite(root,name)).toThrow(/路径/)
  })

  it.each([null,[],{}, {entry:1,files:['index.html']},{entry:'index.html',files:'index.html'},{entry:'index.html',files:[null]}].map(value=>[value]))('rejects malformed declarations %j',value=>{
    put('garden.site.json',JSON.stringify(value))
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/清单|路径/)
  })

  it('rejects invalid JSON without publishing a partial site',()=>{
    put('garden.site.json','{bad')
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/清单/)
  })
  it('requires an HTML entry explicitly included in the file list',()=>{
    put('index.html','page');declare('index.html',['other.html'])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/入口/)
    put('app.js','script');declare('app.js',['app.js'])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/入口/)
  })
  it('rejects duplicate resource paths',()=>{
    put('index.html','page');declare('index.html',['index.html','index.html'])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/重复/)
  })
  it('reserves the root preview metadata name',()=>{
    put('index.html','page');put('__cc_preview.json','{}');declare('index.html',['index.html','__cc_preview.json'])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/保留/)
  })
  it('refuses unknown resource formats',()=>{
    put('index.html','page');put('plugin.wasm','binary');declare('index.html',['index.html','plugin.wasm'])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/文件类型/)
  })
  it('rejects a missing resource instead of emitting an incomplete ZIP',()=>{
    put('index.html','page');declare('index.html',['index.html','missing.css'])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/无法读取/)
  })
  it('refuses a directory pretending to be an HTML resource',()=>{
    mkdirSync(join(root,'index.html'));declare('index.html',['index.html'])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/普通文件/)
  })
  it('never follows a linked descriptor',()=>{
    put('real.json',JSON.stringify({entry:'index.html',files:['index.html']}));put('index.html','page')
    symlinkSync(join(root,'real.json'),join(root,'garden.site.json'))
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/清单/)
  })
  it('never follows linked resources or a linked parent directory',()=>{
    put('real/index.html','outside');symlinkSync(join(root,'real/index.html'),join(root,'index.html'));declare('index.html',['index.html'])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/无法读取/)
    symlinkSync(join(root,'real'),join(root,'linked'));declare('linked/index.html',['linked/index.html'])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/无法读取/)
  })
  it('accepts exactly 100 declared files and refuses a 101st',()=>{
    const paths=['index.html',...Array.from({length:99},(_,index)=>'data/'+index+'.txt')]
    for(const path of paths)put(path,'a')
    declare('index.html',paths)
    expect(Object.keys(unpack(snapshotSite(root,'garden.site.json')))).toHaveLength(101)
    put('extra.txt','extra');declare('index.html',[...paths,'extra.txt'])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/100/)
  })
  it('accepts exactly 6 MiB of raw resources and keeps the ZIP within 8 MiB',()=>{
    put('index.html','a');put('asset.txt',Buffer.alloc(6*1024*1024-1,97));declare('index.html',['index.html','asset.txt'])
    const zip=snapshotSite(root,'garden.site.json')
    expect(unpack(zip)['asset.txt']!.byteLength).toBe(6*1024*1024-1)
    expect(zip.byteLength).toBeLessThanOrEqual(8*1024*1024)
  })
  it('refuses aggregate resources larger than 6 MiB',()=>{
    put('index.html','a');put('asset.txt',Buffer.alloc(6*1024*1024,97));declare('index.html',['index.html','asset.txt'])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/6 MiB/)
  })
  it('refuses a single resource larger than 6 MiB',()=>{
    put('index.html',Buffer.alloc(6*1024*1024+1,97));declare('index.html',['index.html'])
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/6 MiB/)
  })
  it('bounds descriptor bytes to 64 KiB while accepting the exact boundary',()=>{
    put('index.html','page')
    const text=JSON.stringify({entry:'index.html',files:['index.html']})
    put('garden.site.json',' '.repeat(64*1024-text.length)+text)
    expect(unpack(snapshotSite(root,'garden.site.json'))['index.html']).toBeDefined()
    put('garden.site.json',' '.repeat(64*1024-text.length+1)+text)
    expect(()=>snapshotSite(root,'garden.site.json')).toThrow(/清单/)
  })
})

function storedSite() {
  const db=openTestDb();dbs.push(db)
  const store=makeWorkbenchStore(db),task=store.create({title:'网页',path:root,providerId:'codex',ownerChatId:'owner'})
  const output=outputDirectory(root,task.id)
  writeFileSync(join(output,'index.html'),'<link rel="stylesheet" href="style.css"><script src="app.js"></script>')
  writeFileSync(join(output,'style.css'),'body{color:green}')
  writeFileSync(join(output,'app.js'),'window.ready=true')
  writeFileSync(join(output,'garden.site.json'),JSON.stringify({entry:'index.html',files:['index.html','style.css','app.js']}))
  return {db,store,task,output}
}
describe('declared website collection',()=>{
  it('stores a standard ZIP under the custom MIME and omits the raw declaration',()=>{
    const {store,task}=storedSite()
    expect(collectArtifacts(store,task.id,root,join(root,'state'))).toEqual([])
    const artifacts=store.artifacts(task.id),site=artifacts.find(artifact=>artifact.name==='garden.site.zip')
    expect(site).toBeDefined()
    expect(site!.mime).toBe('application/vnd.cc.workbench-site+zip')
    expect(site!.mime).toBe(SITE_ARTIFACT_MIME)
    expect(artifacts.map(artifact=>artifact.name)).not.toContain('garden.site.json')
    expect(artifacts.map(artifact=>artifact.name)).toEqual(['garden.site.zip'])
    expect(unpack(readArtifactSnapshot(site!.storagePath,join(root,'state'),site!.sha256))['style.css']).toBeDefined()
  })
  it('preserves the exact old ZIP after changing a resource and deduplicates unchanged versions',()=>{
    const {store,task,output}=storedSite(),state=join(root,'state')
    collectArtifacts(store,task.id,root,state)
    const first=store.artifacts(task.id).find(artifact=>artifact.name==='garden.site.zip')
    expect(first).toBeDefined()
    const firstBytes=readArtifactSnapshot(first!.storagePath,state,first!.sha256)
    writeFileSync(join(output,'style.css'),'body{color:blue}')
    collectArtifacts(store,task.id,root,state);collectArtifacts(store,task.id,root,state)
    const sites=store.artifacts(task.id).filter(artifact=>artifact.name==='garden.site.zip')
    expect(sites).toHaveLength(2)
    expect(readArtifactSnapshot(first!.storagePath,state,first!.sha256)).toEqual(firstBytes)
    expect(Buffer.from(unpack(firstBytes)['style.css']!).toString()).toBe('body{color:green}')
    expect(Buffer.from(unpack(readArtifactSnapshot(sites[0]!.storagePath,state,sites[0]!.sha256))['style.css']!).toString()).toBe('body{color:blue}')
  })
  it('surfaces invalid sites without storing their declaration or losing ordinary outputs',()=>{
    const {store,task,output}=storedSite()
    writeFileSync(join(output,'garden.site.json'),JSON.stringify({entry:'index.html',files:['index.html','missing.css']}))
    const warnings=collectArtifacts(store,task.id,root,join(root,'state'))
    expect(warnings.some(warning=>/网页.*未能保存/.test(warning))).toBe(true)
    expect(warnings.join(' ')).toContain('missing.css')
    const names=store.artifacts(task.id).map(artifact=>artifact.name)
    expect(names).not.toContain('garden.site.zip');expect(names).not.toContain('garden.site.json');expect(names).toContain('index.html')
  })
  it('propagates snapshot storage failure instead of misreporting a malformed website',()=>{
    const {db,store,task}=storedSite()
    db.exec("CREATE TRIGGER reject_site BEFORE INSERT ON workbench_artifacts WHEN NEW.mime='application/vnd.cc.workbench-site+zip' BEGIN SELECT RAISE(FAIL,'storage offline'); END")
    expect(()=>collectArtifacts(store,task.id,root,join(root,'state'))).toThrow(ArtifactSnapshotError)
  })
  it.each(['zzz.site.json','zzsite/garden.site.json'])('collects a complete 100-resource website declared in %s as one deliverable',name=>{
    const {store,task,output}=storedSite()
    const extra=Array.from({length:97},(_,index)=>String(index).padStart(3,'0')+'.txt')
    for(const path of extra)writeFileSync(join(output,path),'resource')
    mkdirSync(dirname(join(output,name)),{recursive:true})
    renameSync(join(output,'garden.site.json'),join(output,name))
    writeFileSync(join(output,name),JSON.stringify({entry:'index.html',files:['index.html','style.css','app.js',...extra]}))
    expect(collectArtifacts(store,task.id,root,join(root,'state'))).toEqual([])
    const artifacts=store.artifacts(task.id)
    expect(artifacts.map(artifact=>artifact.name)).toEqual([name.replace(/\.json$/,'.zip')])
    expect(Object.keys(unpack(readArtifactSnapshot(artifacts[0]!.storagePath,join(root,'state'),artifacts[0]!.sha256)))).toHaveLength(101)
  })
  it('collects a website and an extra report without filling the list with its resources',()=>{
    const {store,task,output}=storedSite()
    writeFileSync(join(output,'notes.md'),'# 网站说明')
    expect(collectArtifacts(store,task.id,root,join(root,'state'))).toEqual([])
    expect(store.artifacts(task.id).map(artifact=>artifact.name).sort()).toEqual(['garden.site.zip','notes.md'])
  })
  it('retains previously saved loose resources without creating new loose versions for a valid site',()=>{
    const {store,task,output}=storedSite(),state=join(root,'state')
    saveArtifactSnapshot(store,task.id,{name:'style.css',mime:'text/plain',bytes:Buffer.from('body{color:red}')},state)
    const old=store.artifacts(task.id)[0]!
    writeFileSync(join(output,'style.css'),'body{color:blue}')
    collectArtifacts(store,task.id,root,state)
    expect(store.artifacts(task.id).map(artifact=>artifact.name).sort()).toEqual(['garden.site.zip','style.css'])
    expect(readArtifactSnapshot(old.storagePath,state,old.sha256).toString()).toBe('body{color:red}')
  })
  it('does not spend the 100-new-output budget on a known website or its declared resources',()=>{
    const {store,task,output}=storedSite(),state=join(root,'state')
    collectArtifacts(store,task.id,root,state)
    const paths=Array.from({length:100},(_,index)=>'new-'+String(index).padStart(3,'0')+'.txt')
    for(const path of paths)writeFileSync(join(output,path),'new')
    expect(collectArtifacts(store,task.id,root,state)).toEqual([])
    expect(store.artifacts(task.id)).toHaveLength(101)
    expect(store.artifacts(task.id).filter(artifact=>artifact.name==='garden.site.zip')).toHaveLength(1)
    expect(store.artifacts(task.id).filter(artifact=>paths.includes(artifact.name))).toHaveLength(100)
  })
  it('saves both explicit websites when they declare shared resources',()=>{
    const {store,task,output}=storedSite()
    writeFileSync(join(output,'other.site.json'),JSON.stringify({entry:'index.html',files:['index.html','style.css','app.js']}))
    expect(collectArtifacts(store,task.id,root,join(root,'state'))).toEqual([])
    expect(store.artifacts(task.id).map(artifact=>artifact.name).sort()).toEqual(['garden.site.zip','other.site.zip'])
  })
})
