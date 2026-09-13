import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { dlopen, ptr } from 'bun:ffi'
import type { WorkbenchStore } from './store'

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
const MIMES: Record<string,string> = {
  '.txt':'text/plain', '.md':'text/markdown', '.csv':'text/csv', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.pdf':'application/pdf',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
for(const extension of ['ts','tsx','js','jsx','mjs','cjs','py','go','rs','java','c','h','cpp','hpp','css','html','sql','sh','yaml','yml','toml','xml','diff','patch'])MIMES[`.${extension}`]='text/plain'
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

type OpenAt = (dirfd: number, path: ReturnType<typeof ptr>, flags: number) => number
let openAt: OpenAt | undefined

function nativeOpenAt(): OpenAt {
  if (openAt) return openAt
  const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib'
    : process.platform === 'linux' ? 'libc.so.6'
    : null
  if (!library) throw new Error('artifact_platform_unsupported')
  const handle = dlopen(library, {
    openat: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
  })
  openAt = handle.symbols.openat as OpenAt
  return openAt
}

function requiredFlag(name: 'O_NOFOLLOW' | 'O_DIRECTORY'): number {
  const value = (constants as unknown as Record<string, number | undefined>)[name]
  if (value === undefined) throw new Error('artifact_platform_unsupported')
  return value
}

function openRelative(dirfd: number, name: string, flags: number): number {
  const bytes = Buffer.from(`${name}\0`)
  const fd = nativeOpenAt()(dirfd, ptr(bytes), flags)
  if (fd < 0) throw new Error('invalid_artifact_path')
  return fd
}

/**
 * Read a file through an opened root directory. Every parent component is
 * opened relative to the previous directory descriptor with O_NOFOLLOW, so
 * renaming/replacing a pathname after a check cannot redirect the final open.
 * Bun exposes openat through FFI on macOS and Linux; unsupported platforms
 * fail closed instead of falling back to pathname validation with a race.
 */
export function readAnchoredRegular(root: string, relativeName: string, maxBytes = MAX_ARTIFACT_BYTES): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_BYTES) throw new Error('invalid_artifact_size')
  if (!isAbsolute(root) || isAbsolute(relativeName)) throw new Error('invalid_artifact_path')
  const parts = relativeName.split(/[\\/]/)
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..')) throw new Error('invalid_artifact_path')
  const noFollow = requiredFlag('O_NOFOLLOW')
  const directory = requiredFlag('O_DIRECTORY')
  const cloexec = (constants as unknown as Record<string, number | undefined>).O_CLOEXEC ?? 0
  let current = openSync(root, constants.O_RDONLY | noFollow | directory | cloexec)
  try {
    for (const part of parts.slice(0, -1)) {
      const next = openRelative(current, part, constants.O_RDONLY | noFollow | directory | cloexec)
      closeSync(current)
      current = next
    }
    const fd = openRelative(current, parts.at(-1)!, constants.O_RDONLY | noFollow | cloexec | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > maxBytes) throw new Error('invalid_artifact_size')
      const bytes = Buffer.allocUnsafe(maxBytes + 1)
      let length = 0
      while (length < bytes.length) {
        const n = readSync(fd, bytes, length, bytes.length - length, null)
        if (n === 0) break
        length += n
      }
      if (length > maxBytes) throw new Error('invalid_artifact_size')
      const after = fstatSync(fd)
      if (after.size !== stat.size || length !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('artifact_changed')
      return bytes.subarray(0, length)
    } finally { closeSync(fd) }
  } finally { closeSync(current) }
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
export function collectArtifacts(store: WorkbenchStore, taskId: string, project: string, stateDir: string): string[] {
  const output = outputDirectory(project,taskId)
  const warnings: string[] = []
  const known = new Set(store.artifacts(taskId).map(a => `${a.name}\0${a.sha256}`))
  let count=0, visited=0
  function walk(dir: string, depth: number) {
    noSymlinks(project,dir)
    if (depth > 5 || visited > 1000 || count >= 100) { warnings.push('成果过多，已限制本次收集范围。'); return }
    for (const entry of readdirSync(dir,{withFileTypes:true})) {
      if (++visited > 1000 || count >= 100) { warnings.push('本轮最多收集 100 件成果。'); break }
      const file = join(dir,entry.name)
      if (entry.isSymbolicLink()) { warnings.push(`已跳过链接：${entry.name}`); continue }
      if (entry.isDirectory()) { walk(file,depth+1); continue }
      if (!entry.isFile()) continue
      const mime = MIMES[extname(file).toLowerCase()]
      if (!mime) { warnings.push(`此文件类型不收集：${entry.name}`); continue }
      try {
        const bytes = readRegular(project,file)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const name=relative(output,file)
        if (known.has(`${name}\0${sha256}`)) continue
        saveArtifactSnapshot(store,taskId,{name,mime,bytes},stateDir)
        count++
      } catch { warnings.push(`无法收集 ${entry.name}（须为目录内普通文件，且不超过 8 MiB）。`) }
    }
  }
  walk(output,0)
  return [...new Set(warnings)].slice(0,20)
}
export function readArtifactSnapshot(storagePath: string, stateDir: string, sha256: string): Buffer {
  const root = resolve(stateDir,'workbench-artifacts')
  if (lstatSync(root).isSymbolicLink() || dirname(storagePath) !== root) throw new Error('invalid_artifact_path')
  const bytes = readRegular(root,storagePath)
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('artifact_changed')
  return bytes
}
