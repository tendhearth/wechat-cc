import {extname} from 'node:path'
import {zipSync} from 'fflate'
import {readAnchoredFile} from './anchored-fs'

export const SITE_ARTIFACT_MIME='application/vnd.cc.workbench-site+zip'
const MAX_SITE_FILES=100
const MAX_SITE_BYTES=6*1024*1024
const MAX_SITE_ARCHIVE_BYTES=8*1024*1024
const MAX_DESCRIPTOR_BYTES=64*1024
const META_NAME='__cc_preview.json'
const EXTENSIONS=new Set(['.html','.htm','.css','.js','.mjs','.json','.txt','.png','.jpg','.jpeg','.webp','.gif','.svg','.ico','.woff','.woff2','.ttf'])

function sitePath(value:unknown):string {
  if(typeof value!=='string'||!value||value.length>512||/[\\:?#%\p{Cc}]/u.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..')) {
    throw new Error('网页文件路径不正确，请使用成果目录内的相对路径。')
  }
  return value
}

function readRegular(root:string,path:string,maxBytes:number,descriptor=false):Buffer {
  try {
    return readAnchoredFile(root,path,maxBytes,{path:'invalid_artifact_path',size:'invalid_artifact_size',changed:'artifact_changed'})
  } catch {
    throw new Error(descriptor
      ?'网页清单无法读取；须为成果目录内无链接的普通文件，且不超过 64 KiB。'
      :'无法读取网页文件 '+path+'；须为成果目录内无链接的普通文件，资源总计不能超过 6 MiB。')
  }
}

/** Freeze only explicitly declared resources. The caller supplies a verified output root. */
export function createSiteSnapshot(outputRoot:string,descriptorName:string):{bytes:Buffer;files:string[]} {
  const descriptor=sitePath(descriptorName)
  let value:unknown
  try {
    const text=new TextDecoder('utf-8',{fatal:true}).decode(readRegular(outputRoot,descriptor,MAX_DESCRIPTOR_BYTES,true))
    value=JSON.parse(text)
  } catch(error) {
    if(error instanceof Error&&error.message.startsWith('网页清单'))throw error
    throw new Error('网页清单不是有效的 UTF-8 JSON，请声明 entry 和 files。')
  }
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('网页清单格式不正确，请声明 entry 和 files。')
  const {entry:rawEntry,files:rawFiles}=value as {entry?:unknown;files?:unknown}
  if(typeof rawEntry!=='string'||!Array.isArray(rawFiles))throw new Error('网页清单格式不正确，请声明 entry 和 files。')
  const entry=sitePath(rawEntry)
  if(!/\.html?$/i.test(entry))throw new Error('网页入口必须是 HTML 文件。')
  if(rawFiles.length<1||rawFiles.length>MAX_SITE_FILES)throw new Error('网页清单须声明 1 至 100 个文件。')
  const paths=rawFiles.map(sitePath)
  if(new Set(paths).size!==paths.length)throw new Error('网页清单含重复的文件路径，请每个文件只声明一次。')
  if(!paths.includes(entry))throw new Error('网页入口必须列在文件清单中。')
  for(const path of paths) {
    if(path.toLowerCase()===META_NAME)throw new Error('__cc_preview.json 是 CC 保留的网页元数据名称。')
    if(!EXTENSIONS.has(extname(path).toLowerCase()))throw new Error('网页文件类型暂不支持：'+path)
  }
  const files:Record<string,Uint8Array>=Object.create(null)
  files[META_NAME]=new TextEncoder().encode(JSON.stringify({version:1,entry}))
  let total=0
  for(const path of paths.sort()) {
    const bytes=readRegular(outputRoot,path,Math.min(MAX_SITE_BYTES,MAX_SITE_BYTES-total+1))
    total+=bytes.length
    if(total>MAX_SITE_BYTES)throw new Error('网页资源总计不能超过 6 MiB。')
    // Anchored reads return a view of their bounded buffer; retain only actual bytes.
    files[path]=Uint8Array.from(bytes)
  }
  const archive=Buffer.from(zipSync(files,{level:0,mtime:new Date(1980,0,1)}))
  if(archive.length>MAX_SITE_ARCHIVE_BYTES)throw new Error('网页 ZIP 不能超过 8 MiB。')
  return {bytes:archive,files:paths}
}

export function snapshotSite(outputRoot:string,descriptorName:string):Buffer {
  return createSiteSnapshot(outputRoot,descriptorName).bytes
}
