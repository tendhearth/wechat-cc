// @ts-check
import {unzipSync} from '../vendor/fflate.mjs'
export const SITE_ARTIFACT_MIME='application/vnd.cc.workbench-site+zip'
export const MAX_SITE_BYTES=6*1024*1024
const mimes={html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',json:'application/json',txt:'text/plain',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',svg:'image/svg+xml',ico:'image/x-icon',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf'}
/** @param {unknown} path @returns {path is string} */
export function validSitePath(path){return typeof path==='string'&&path.length>0&&path.length<=512&&!/[\\\x00-\x1f\x7f-\x9f:%?#]/.test(path)&&path.split('/').every(part=>!!part&&part!=='.'&&part!=='..')}
/** @param {string} path @returns {string|null} */
export function siteFileMime(path){const ext=path.split('.').pop()?.toLowerCase()??'';return Object.hasOwn(mimes,ext)?/** @type {Record<string,string>} */(mimes)[ext]??null:null}
/** @param {Uint8Array} bytes */
function base64(bytes){let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary)}
/** Only the explicitly collected, stored ZIP format is a website preview.
 * Validate central metadata before extracting; then check actual decoded sizes.
 * @param {Uint8Array} bytes
 * @returns {{entry:string,source:string,files:Array<{path:string,mime:string,contentBase64:string}>}} */
export function readSiteArchive(bytes){
 try{
  if(bytes.byteLength>8*1024*1024)throw Error('size')
  const seen=new Set();let total=0
  const extracted=/** @type {Record<string,Uint8Array>} */(unzipSync(bytes,{filter:/** @param {import('fflate').UnzipFileInfo} file */file=>{
   if(seen.has(file.name)||seen.size>=101||file.compression!==0||file.size!==file.originalSize)throw Error('entry')
   seen.add(file.name)
   if(file.name==='__cc_preview.json'){if(file.originalSize>4096)throw Error('manifest')}
   else {if(!validSitePath(file.name)||!siteFileMime(file.name))throw Error('path');total+=file.originalSize;if(total>MAX_SITE_BYTES)throw Error('size')}
   return true
  }}))
  const metadata=extracted['__cc_preview.json']
  if(!metadata||metadata.length>4096)throw Error('manifest')
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(metadata))
  if(manifest?.version!==1||!validSitePath(manifest.entry)||siteFileMime(manifest.entry)!=='text/html'||!Object.hasOwn(extracted,manifest.entry))throw Error('entry')
  let actualTotal=0
  const files=Object.entries(extracted).filter(([path])=>path!=='__cc_preview.json').map(([path,data])=>{
   actualTotal+=data.byteLength;if(actualTotal>MAX_SITE_BYTES)throw Error('size')
   return {path,mime:/** @type {string} */(siteFileMime(path)),contentBase64:base64(data)}
  })
  if(!files.length||files.length>100||actualTotal!==total)throw Error('size')
  return {entry:manifest.entry,source:new TextDecoder().decode(extracted[manifest.entry]),files}
 }catch{throw Error('网页成品暂时没能读取。请让 CC 重新交付完整网页，或下载后查看。')}
}
