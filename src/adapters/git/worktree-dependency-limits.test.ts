import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installDependencies } from './worktree-dependency-installer'
import { Preparation } from './worktree-preparation'
import { InstallQuota, extractPackage } from './worktree-dependency-archive'
import { removeTempDir } from '../../lib/test-temp'
const network = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: network.request }))
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(removeTempDir) })
function archive(entries: { name: string; data: string; type?: string }[]) {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data), h = Buffer.alloc(512)
    h.write(entry.name); h.write('0000644\0',100); h.write('0000000\0',108); h.write('0000000\0',116)
    h.write(data.length.toString(8).padStart(11,'0') + '\0',124); h.write('00000000000\0',136); h.fill(32,148,156); h.write(entry.type ?? '0',156)
    h.write('ustar\0',257); h.write(h.reduce((a,b) => a+b,0).toString(8).padStart(6,'0') + '\0 ',148)
    blocks.push(h,data,Buffer.alloc((512-data.length%512)%512))
  }
  blocks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(blocks))
}
function fixture(extra: Record<string, number | undefined> = {}, manifest: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'cc-install-limit-'))); roots.push(root)
  for (const key of Object.keys(process.env)) if (/^(https?_proxy|all_proxy)$/i.test(key)) vi.stubEnv(key,'')
  const data = archive([{name:'package/package.json',data:JSON.stringify({name:'tool',version:'1.0.0',...manifest})},{name:'package/index.js',data:'trusted'}])
  const integrity = 'sha512-' + createHash('sha512').update(data).digest('base64')
  const files = new Map([['package.json',Buffer.from('{}')],['bun.lock',Buffer.from(JSON.stringify({lockfileVersion:1,packages:{tool:['tool@1.0.0','',extra,integrity]}}))]])
  network.lookup.mockReset().mockResolvedValue([{address:'93.184.216.34',family:4}])
  network.request.mockReset().mockImplementation((_url: URL, _opts: unknown, callback: (res: unknown) => void) => {
    const req = new EventEmitter() as any; req.destroy = vi.fn(); req.end = () => {
      const res = new PassThrough() as any; res.statusCode = 200; res.headers = {}
      callback(res); res.end(data)
    }; return req
  })
  return {root,files,data,budget:new Preparation()}
}
it('downloads with fixed public DNS and no owner credentials, installs verified bytes without subprocesses',async()=>{
  const f=fixture(); vi.stubEnv('SSH_AUTH_SOCK','FAKE'); vi.stubEnv('GIT_SSH_COMMAND','ssh FAKE'); vi.stubEnv('NPM_CONFIG_USERCONFIG','/FAKE/npmrc'); vi.stubEnv('NODE_OPTIONS','--require=/FAKE/preload')
  await installDependencies(f.root,f.budget,f.files)
  expect(await fs.readFile(join(f.root,'node_modules/tool/index.js'),'utf8')).toBe('trusted')
  const [url,opts]=network.request.mock.calls[0]!
  expect(url.href).toBe('https://registry.npmjs.org/tool/-/tool-1.0.0.tgz'); expect(opts).toMatchObject({agent:false,family:4,headers:{'Accept-Encoding':'identity'}})
  const cb=vi.fn();opts.lookup('ignored',{},cb);expect(cb).toHaveBeenCalledWith(null,'93.184.216.34',4)
  expect(Object.keys(opts)).not.toContain('auth')
})
it.each([{unpackedSize:999999},{fileCount:999999}])('preflights lock size/count before even DNS: %s',async extra=>{
  const f=fixture(extra);await expect(installDependencies(f.root,f.budget,f.files,{maxBytes:4096,maxEntries:20})).rejects.toThrow(/budget/)
  expect(network.lookup).not.toHaveBeenCalled();expect(network.request).not.toHaveBeenCalled()
})
it.each(['127.0.0.1','10.0.0.1','169.254.169.254'])('refuses DNS rebinding to %s before request',async address=>{
  const f=fixture();network.lookup.mockResolvedValue([{address,family:4}])
  await expect(installDependencies(f.root,f.budget,f.files)).rejects.toThrow('dependency_registry_address');expect(network.request).not.toHaveBeenCalled()
})
it('refuses redirects rather than forwarding requests or credentials',async()=>{
  const f=fixture();network.request.mockImplementation((_url,_opts,cb)=>{const req=new EventEmitter() as any;req.destroy=vi.fn();req.end=()=>{const res=new PassThrough() as any;res.statusCode=302;res.headers={location:'https://127.0.0.1/private'};cb(res)};return req})
  await expect(installDependencies(f.root,f.budget,f.files)).rejects.toThrow('dependency_registry_response');expect(network.request).toHaveBeenCalledOnce()
})
it('checks integrity before extraction',async()=>{
  const f=fixture();const lock=JSON.parse(f.files.get('bun.lock')!.toString());lock.packages.tool[3]='sha512-'+'A'.repeat(86)+'==';f.files.set('bun.lock',Buffer.from(JSON.stringify(lock)))
  await expect(installDependencies(f.root,f.budget,f.files)).rejects.toThrow('dependency_integrity');expect(existsSync(join(f.root,'node_modules'))).toBe(false)
})
it('counts response chunks before buffering and stops at the download budget',async()=>{
  const f=fixture();network.request.mockImplementation((_url,_opts,cb)=>{const req=new EventEmitter() as any;req.destroy=vi.fn();req.end=()=>{const res=new PassThrough() as any;res.statusCode=200;res.headers={};cb(res);res.write(Buffer.alloc(3000));res.end(Buffer.alloc(3000))};return req})
  await expect(installDependencies(f.root,f.budget,f.files,{maxBytes:4096})).rejects.toThrow('dependency_download_budget');expect(existsSync(join(f.root,'node_modules'))).toBe(false)
})
it('rejects expansion bombs and excessive entries before creating package files',async()=>{
  const f=fixture(),quota=new InstallQuota(f.root,f.budget,{maxBytes:64,maxEntries:4},4096)
  await expect(extractPackage(archive([{name:'package/huge',data:'x'.repeat(10000)}]),join(f.root,'pkg'),quota)).rejects.toThrow(/budget/)
  expect(existsSync(join(f.root,'pkg'))).toBe(false)
  await expect(extractPackage(archive(Array.from({length:8},(_,i)=>({name:`package/${i}`,data:''}))),join(f.root,'pkg'),quota)).rejects.toThrow(/budget/)
  expect(existsSync(join(f.root,'pkg'))).toBe(false)
})
it('checks free space before every write block and stops before the next 64 KiB block',async()=>{
  const f=fixture(),quota=new InstallQuota(f.root,f.budget,{maxBytes:200000,minFreeBytes:0},1000000)
  const real=fs.statfs;let checks=0
  vi.spyOn(fs,'statfs').mockImplementation(async path=>++checks<=2?real(path):({bavail:0,bsize:4096} as any))
  await expect(quota.file(join(f.root,'partial'),Buffer.alloc(130000),false)).rejects.toThrow('dependency_space_budget')
  expect((await fs.stat(join(f.root,'partial'))).size).toBe(65536)
})
it.each(['package/../../escape','package/link'])('rejects traversal and symlinks: %s',async name=>{
  const f=fixture(),quota=new InstallQuota(f.root,f.budget,{},1000000)
  await expect(extractPackage(archive([{name,data:'x',type:name.endsWith('link')?'2':'0'}]),join(f.root,'pkg'),quota)).rejects.toThrow()
  expect(existsSync(join(f.root,'pkg'))).toBe(false)
})
it('applies the deadline and cancellation while DNS is still pending',async()=>{
  const f=fixture();network.lookup.mockImplementation(()=>new Promise(()=>{}))
  await expect(installDependencies(f.root,new Preparation({timeoutMs:5}),f.files)).rejects.toThrow('worktree_preparation_timeout')
  const controller=new AbortController(),pending=installDependencies(f.root,new Preparation({signal:controller.signal}),f.files)
  controller.abort();await expect(pending).rejects.toThrow('worktree_preparation_cancelled')
  expect(network.request).not.toHaveBeenCalled()
})
it('counts implicit parent directories before making deeply nested package paths',async()=>{
  const f=fixture(),quota=new InstallQuota(f.root,f.budget,{maxEntries:6},1000000)
  await expect(quota.directory(join(f.root,'a/b/c/d/e'))).rejects.toThrow('dependency_entry_budget')
  expect(quota.entries).toBe(3);expect(existsSync(join(f.root,'a/b/c/d'))).toBe(false)
})

it('puts bins beside the lock location for an npm alias rather than the resolved package scope',async()=>{
  const f=fixture({}, {bin:{tool:'index.js'}}),lock=JSON.parse(f.files.get('bun.lock')!.toString())
  lock.packages['@alias/tool']=lock.packages.tool;delete lock.packages.tool;f.files.set('bun.lock',Buffer.from(JSON.stringify(lock)))
  await installDependencies(f.root,f.budget,f.files)
  expect(await fs.realpath(join(f.root,'node_modules/.bin/tool'))).toBe(await fs.realpath(join(f.root,'node_modules/@alias/tool/index.js')))
})
it('creates quota-counted logical endpoints for committed workspace bins',async()=>{
  const f=fixture();f.files.set('package.json',Buffer.from(JSON.stringify({workspaces:['pkg']})))
  f.files.set('pkg/package.json',Buffer.from(JSON.stringify({name:'local',bin:{local:'cli.js'}})))
  f.files.set('bun.lock',Buffer.from(JSON.stringify({lockfileVersion:1,packages:{local:['local@workspace:pkg']}})))
  await fs.mkdir(join(f.root,'pkg'));await fs.writeFile(join(f.root,'pkg/package.json'),f.files.get('pkg/package.json')!)
  await installDependencies(f.root,f.budget,f.files)
  expect(await fs.realpath(join(f.root,'node_modules/.bin/local'))).toBe(await fs.realpath(join(f.root,'pkg/cli.js')))
  expect((await fs.stat(join(f.root,'pkg/cli.js'))).size).toBe(0);expect(network.request).not.toHaveBeenCalled()
})

it.each(['package/.. /.. /escape','package/dir./file','package/NUL','package/file:stream','package/CON.txt'])('rejects portable Windows path aliases before writing: %s',async name=>{
  const f=fixture(),quota=new InstallQuota(f.root,f.budget,{},1000000)
  await expect(extractPackage(archive([{name,data:'x'}]),join(f.root,'pkg'),quota)).rejects.toThrow('dependency_archive_path')
  expect(existsSync(join(f.root,'pkg'))).toBe(false)
})
it('checks reserve before creating zero-byte files with existing parent directories',async()=>{
  const f=fixture(),quota=new InstallQuota(f.root,f.budget,{minFreeBytes:100},1000000)
  vi.spyOn(fs,'statfs').mockResolvedValue({bavail:0,bsize:4096} as any)
  await expect(quota.file(join(f.root,'empty'),Buffer.alloc(0),false)).rejects.toThrow('dependency_space_budget')
  expect(existsSync(join(f.root,'empty'))).toBe(false)
})

it('installs nested workspace packages into their real workspace node_modules before linking the workspace',async()=>{
  const f=fixture(),lock=JSON.parse(f.files.get('bun.lock')!.toString())
  lock.packages['ws/tool']=lock.packages.tool;delete lock.packages.tool;lock.packages.ws=['ws@workspace:pkg']
  lock.workspaces={pkg:{name:'ws',dependencies:{tool:'1.0.0'}}}
  f.files.set('package.json',Buffer.from(JSON.stringify({workspaces:['pkg']})))
  f.files.set('pkg/package.json',Buffer.from(JSON.stringify(lock.workspaces.pkg)))
  f.files.set('bun.lock',Buffer.from(JSON.stringify(lock)))
  await fs.mkdir(join(f.root,'pkg'));await fs.writeFile(join(f.root,'pkg/package.json'),f.files.get('pkg/package.json')!)
  await installDependencies(f.root,f.budget,f.files)
  expect(await fs.realpath(join(f.root,'node_modules/ws/node_modules/tool/index.js'))).toBe(await fs.realpath(join(f.root,'pkg/node_modules/tool/index.js')))
  expect(await fs.readFile(join(f.root,'node_modules/ws/node_modules/tool/index.js'),'utf8')).toBe('trusted')
})
