// @ts-check
import { V1, v1 } from '../daemon-client.js'
/** Re-find the live control: progress updates may replace the clicked node while reading.
 * @param {HTMLElement} root @param {{id:string,requestId:string,path:string,sha256:string}} query @param {string} content */
export function presentPermissionScript(root,query,content){
  const button=Array.from(root.querySelectorAll('button[data-action="expand-permission-script"]')).find(node=>{
    const b=/** @type {HTMLButtonElement} */(node)
    return b.dataset.ownerTask===query.id&&b.dataset.requestId===query.requestId&&b.dataset.scriptPath===query.path&&b.dataset.scriptSha===query.sha256
  })
  const pre=button?.closest('.wb-permission-script')?.querySelector('pre')
  if(pre)pre.textContent=content
  button?.remove()
}
/** @param {(method:any,path:string,body?:any,opts?:any)=>Promise<any>} invoke @param {{id:string,requestId:string,path:string,sha256:string}} query */
export async function readPermissionScript(invoke, query) {
  let content='',offset=0
  for(let i=0;i<32;i++){
    const part=await v1(invoke,V1.matter.permissionScript,{query:{...query,offset}})
    if(typeof part?.content!=='string')throw Error('permission_stale')
    content+=part.content
    if(part.nextOffset===null)return content
    if(!Number.isSafeInteger(part.nextOffset)||part.nextOffset<=offset)throw Error('permission_stale')
    offset=part.nextOffset
  }
  throw Error('permission_stale')
}
