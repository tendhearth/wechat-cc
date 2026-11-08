// Source identity and safe paths, independent of SSH / UI execution.
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { posix } from 'node:path'
export const PUBLIC_CACHE_COMMIT = '486f654796a9b8fc510aa024ff265f1d14a6e1fd'
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const gitObject = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex')
export function sourcePath(value) {
  if(typeof value!=='string'||!value||/[\0\r\n]/.test(value)||posix.isAbsolute(value)||posix.normalize(value)!==value||value.split('/').some(p=>p==='..'||p==='.git'||p==='node_modules'))throw Error('Unsafe source path')
  return value
}
export function manifestTree(files) {
  const root=new Map()
  for(const file of files) {
    const parts=sourcePath(file.path).split('/');let node=root
    if(!['100644','100755'].includes(file.mode)||!/^[a-f0-9]{40}$/.test(file.blob))throw Error('Unsupported source entry')
    for(const part of parts.slice(0,-1)){if(!node.has(part))node.set(part,new Map());node=node.get(part);if(!(node instanceof Map))throw Error('Source path collision')}
    const name=parts.at(-1);if(node.has(name))throw Error('Duplicate source path');node.set(name,file)
  }
  const tree=node=>{
    const entries=[...node].map(([name,value])=>({name,dir:value instanceof Map,value})).sort((a,b)=>Buffer.compare(Buffer.from(a.name+(a.dir?'/':'')),Buffer.from(b.name+(b.dir?'/':''))))
    return gitObject('tree',Buffer.concat(entries.map(e=>Buffer.concat([Buffer.from(`${e.dir?'40000':e.value.mode} ${e.name}\0`),Buffer.from(e.dir?tree(e.value):e.value.blob,'hex')]))))
  }
  return tree(root)
}
export function verifySourceManifest(meta) {
  if(!['before','after'].includes(meta.phase)||meta.cacheCommit!==PUBLIC_CACHE_COMMIT||!/^[a-f0-9]{40}$/.test(meta.commit)||!/^[a-f0-9]{40}$/.test(meta.tree))throw Error('Invalid source identity')
  const commit=Buffer.from(meta.commitObjectBase64,'base64')
  if(gitObject('commit',commit)!==meta.commit||!commit.toString().startsWith(`tree ${meta.tree}\n`)||manifestTree(meta.files)!==meta.tree)throw Error('Source manifest does not match target commit')
  const known=new Set(meta.files.map(f=>f.path))
  for(const path of meta.deltaPaths)if(!known.has(sourcePath(path)))throw Error('Delta path is outside target tree')
  if(!/^[a-f0-9]{64}$/.test(meta.deltaSha256))throw Error('Invalid archive digest')
  return meta
}

/** A signal during activation must wait for rename before deciding whether this root is disposable. */
export async function removeInactiveSnapshot(root, activePath, activation) {
  if(!root)return false
  await activation?.catch(()=>{})
  const active=JSON.parse(await readFile(activePath,'utf8'))
  if([active.root,active.appRoot,active.browserRoot].includes(root))return false
  await rm(root,{recursive:true,force:true});return true
}
