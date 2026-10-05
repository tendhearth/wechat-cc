import { lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readAnchoredFile } from './anchored-fs'
import { SITE_ARTIFACT_MIME, createSiteSnapshot } from './site-artifact'
import type { WorkbenchStore } from './store'

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
const MIMES: Record<string,string> = {
  '.html':'text/html', '.htm':'text/html', '.txt':'text/plain', '.md':'text/markdown', '.csv':'text/csv', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.pdf':'application/pdf',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
for(const extension of ['ts','tsx','js','jsx','mjs','cjs','py','go','rs','java','c','h','cpp','hpp','css','sql','sh','yaml','yml','toml','xml','diff','patch'])MIMES[`.${extension}`]='text/plain'
export function canonicalProject(path: string): string {
  if (!isAbsolute(path)) throw new Error('invalid_path')
  try { const real = realpathSync(path); if (lstatSync(real).isDirectory()) return real } catch { /* invalid/missing */ }
  throw new Error('invalid_path')
}
function within(root: string, file: string) {
  const rel = relative(root,file)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}
/** Check every component, not only the leaf; an agent may replace a directory. */
function noSymlinks(root: string, file: string) {
  if (!within(root,file)) throw new Error('invalid_artifact_path')
  let cursor = root
  for (const part of relative(root,file).split(/[\\/]/)) {
    cursor = join(cursor,part)
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('invalid_artifact_path')
  }
  if (!within(realpathSync(root),realpathSync(file))) throw new Error('invalid_artifact_path')
}

/**
 * Read a file through a verified root. Every component is checked to be a real
 * directory (never a link) before the open, and checked again after it together
 * with the descriptor's identity — see anchored-fs.ts for why "open, then verify"
 * closes the rename race the old openat chain guarded against.
 */
export function readAnchoredRegular(root: string, relativeName: string, maxBytes = MAX_ARTIFACT_BYTES): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_BYTES) throw new Error('invalid_artifact_size')
  return readAnchoredFile(root,relativeName,maxBytes,{path:'invalid_artifact_path',size:'invalid_artifact_size',changed:'artifact_changed'})
}
export function outputDirectory(project: string, id: string) {
  const base = join(project,'.cc-workbench')
  const output = join(base,id)
  mkdirSync(base,{recursive:true}); noSymlinks(project,base)
  mkdirSync(output,{recursive:true}); noSymlinks(project,output)
  return output
}
function readRegular(root: string, file: string): Buffer {
  if (!within(root,file)) throw new Error('invalid_artifact_path')
  return readAnchoredRegular(root,relative(root,file))
}
export function saveArtifactSnapshot(store: WorkbenchStore, taskId: string, input: { name:string; mime:string; bytes:Buffer }, stateDir:string) {
  const {name,mime,bytes}=input
  if(bytes.length>MAX_ARTIFACT_BYTES)throw new Error('invalid_artifact_size')
  const storageRoot=resolve(stateDir,'workbench-artifacts')
  mkdirSync(storageRoot,{recursive:true,mode:0o700})
  if(lstatSync(storageRoot).isSymbolicLink())throw new Error('invalid_artifact_path')
  const sha256=createHash('sha256').update(bytes).digest('hex'),storagePath=join(storageRoot,sha256)
  try{writeFileSync(storagePath,bytes,{flag:'wx',mode:0o600})}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error
    if(createHash('sha256').update(readRegular(storageRoot,storagePath)).digest('hex')!==sha256)throw new Error('artifact_changed')
  }
  return store.addArtifact({taskId,name,mime,size:bytes.length,sha256,storagePath})
}
/** A readable deliverable and a writable snapshot store are independent guarantees. */
export class ArtifactSnapshotError extends Error {
  constructor(cause:unknown) { super('artifact_snapshot_failed',{cause}); this.name='ArtifactSnapshotError' }
}
export function collectArtifacts(store: WorkbenchStore, taskId: string, project: string, stateDir: string): string[] {
  const output = outputDirectory(project,taskId)
  const warnings: string[] = []
  const known = new Set(store.artifacts(taskId).map(a => `${a.name}\0${a.sha256}`))
  const siteResources = new Set<string>()
  let count=0, visited=0, limited=false
  function walk(dir: string, depth: number, sites: boolean) {
    if(limited)return
    noSymlinks(project,dir)
    if (depth > 5 || visited > 1000) { warnings.push('成果过多，已限制本次收集范围。'); return }
    for (const entry of readdirSync(dir,{withFileTypes:true})) {
      if(limited)break
      if (++visited > 1000) { warnings.push('本轮最多收集 100 件成果。'); break }
      const file = join(dir,entry.name)
      if (entry.isSymbolicLink()) { warnings.push(`已跳过链接：${entry.name}`); continue }
      if (entry.isDirectory()) { walk(file,depth+1,sites); continue }
      if (!entry.isFile()) continue
      let name=relative(output,file)
      const sitePath=name.split(sep).join('/')
      let mime:string
      let bytes:Buffer
      if(/\.site\.json$/i.test(name)) {
        if(!sites)continue
        try {
          const snapshot=createSiteSnapshot(output,sitePath)
          bytes=snapshot.bytes
          for(const path of snapshot.files)siteResources.add(path)
        }
        catch(error) { warnings.push(`网页 ${entry.name} 未能保存：${error instanceof Error?error.message:'请检查入口与文件清单。'}`); continue }
        name=sitePath.replace(/\.site\.json$/i,'.site.zip')
        mime=SITE_ARTIFACT_MIME
      } else {
        if(sites||siteResources.has(sitePath))continue
        mime=MIMES[extname(file).toLowerCase()]!
        if (!mime) { warnings.push(`此文件类型不收集：${entry.name}`); continue }
        try { bytes=readRegular(project,file) }
        catch { warnings.push(`无法收集 ${entry.name}（须为目录内普通文件，且不超过 8 MiB）。`); continue }
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (known.has(`${name}\0${sha256}`)) continue
      if(count>=100) { warnings.push('本轮最多收集 100 件成果。'); limited=true; break }
      try { saveArtifactSnapshot(store,taskId,{name,mime,bytes},stateDir) }
      catch(error) { throw new ArtifactSnapshotError(error) }
      count++
    }
  }
  // Validate sites first so their declared resources do not consume the ordinary
  // output budget or fill the list. Old loose snapshots remain untouched.
  walk(output,0,true)
  visited=0
  walk(output,0,false)
  return [...new Set(warnings)].slice(0,20)
}
export function readArtifactSnapshot(storagePath: string, stateDir: string, sha256: string): Buffer {
  const root = resolve(stateDir,'workbench-artifacts')
  if (lstatSync(root).isSymbolicLink() || dirname(storagePath) !== root) throw new Error('invalid_artifact_path')
  const bytes = readRegular(root,storagePath)
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('artifact_changed')
  return bytes
}
