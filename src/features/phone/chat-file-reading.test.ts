import {afterEach,describe,expect,it,vi} from 'vitest'
import {mkdtempSync,writeFileSync,rmSync,renameSync,symlinkSync,statSync,utimesSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const hooks=vi.hoisted(()=>({opened:null as null|(()=>void),read:null as null|(()=>void)}))
vi.mock('node:fs',async importOriginal=>{const fs=await importOriginal<typeof import('node:fs')>();return {...fs,openSync:(...args:Parameters<typeof fs.openSync>)=>{const fd=fs.openSync(...args);const f=hooks.opened;hooks.opened=null;f?.();return fd},readSync:(...args:any[])=>{const n=(fs.readSync as any)(...args);const f=hooks.read;hooks.read=null;f?.();return n}}})
import {fileChunkResponse} from './mobile-chat'
const dirs:string[]=[]
afterEach(()=>{hooks.opened=null;hooks.read=null;dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}))})
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cc-file-race-'));dirs.push(dir);const path=join(dir,'a.txt');writeFileSync(path,'first');return {dir,path}}
describe('descriptor-backed chat attachment reads',()=>{
 it('supports canonical and OS temporary aliases while rejecting final symlinks',async()=>{const {dir,path}=fixture();expect(fileChunkResponse(path,'a.txt',0).status).toBe(200);expect(fileChunkResponse(realpathSync(path),'a.txt',0).status).toBe(200);const link=join(dir,'link');symlinkSync(path,link);expect(fileChunkResponse(link,'a.txt',0).status).toBe(404)})
 it('invalidates cached replacements even with identical size and modification time',async()=>{const {dir,path}=fixture(),before=statSync(path);expect((await fileChunkResponse(path,'a.txt',0).json()).contentBase64).toBe(Buffer.from('first').toString('base64'));const replacement=join(dir,'b.txt');writeFileSync(replacement,'other');utimesSync(replacement,before.atime,before.mtime);renameSync(replacement,path);expect((await fileChunkResponse(path,'a.txt',0).json()).contentBase64).toBe(Buffer.from('other').toString('base64'))})
 it('rejects a swap between opening and reading and an in-place mutation during reading',()=>{const {dir,path}=fixture();hooks.opened=()=>{renameSync(path,join(dir,'old'));writeFileSync(path,'other')};expect(fileChunkResponse(path,'a.txt',0).status).toBe(404);hooks.read=()=>writeFileSync(path,'changed-length');expect(fileChunkResponse(path,'a.txt',0).status).toBe(404)})
})
