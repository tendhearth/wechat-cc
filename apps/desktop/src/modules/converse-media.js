// @ts-check
import {V1,v1} from '../daemon-client.js'
import {escapeWorkbenchHtml as escape,renderReadingFile} from './workbench-markdown.js'
import {saveFile} from './save-file.js'
import {renderPdfReader,mountPdfReader} from './pdf-reader.js'
const MAX_BYTES=20*1024*1024
/** @param {(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>} invoke @param {string} id @param {number} i */
export async function readOwnerChatFile(invoke,id,i) {
  let offset=0,size=0,sha256='',name='',mime=''
  /** @type {Uint8Array[]} */ const chunks=[]
  do {
    const result=/** @type {{name:string,mime:string,size:number,sha256:string,offset:number,nextOffset:number,contentBase64:string}} */(await v1(invoke,V1.matter.ownerChatFile,{query:{id,i,offset,...(sha256?{sha256,size}:{})}}))
    if(!Number.isSafeInteger(result.size)||result.size<0||result.size>MAX_BYTES||!Number.isSafeInteger(result.nextOffset)||result.offset!==offset||result.nextOffset>result.size||result.nextOffset<offset||(!result.nextOffset&&result.size)||!/^[a-f0-9]{64}$/.test(result.sha256)||typeof result.name!=='string'||typeof result.mime!=='string')throw Error('invalid_file')
    if(sha256&&(result.sha256!==sha256||result.size!==size||result.name!==name||result.mime!==mime))throw Error('file_changed')
    const bytes=Uint8Array.from(atob(result.contentBase64),c=>c.charCodeAt(0))
    if(bytes.length>128*1024||bytes.length!==result.nextOffset-offset||(result.nextOffset===offset&&offset<result.size))throw Error('invalid_file')
    chunks.push(bytes);offset=result.nextOffset;size=result.size;sha256=result.sha256;name=result.name;mime=result.mime
  }while(offset<size)
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length}
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('')
  if(hash!==sha256)throw Error('file_changed')
  return {bytes,name,mime}
}
/** Opens only a stored attachment by identity; local paths never enter the page.
 * @param {{invoke:(cmd:string,args:Record<string,unknown>)=>Promise<unknown>,invokeWorkbenchApi?:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>}} deps
 * @param {string} id @param {number} index @param {string} name */
export function openOwnerChatFile(deps,id,index,name) {
  return openConversationFile(deps,name,()=>deps.invokeWorkbenchApi?readOwnerChatFile(deps.invokeWorkbenchApi,id,index):Promise.reject(Error('unavailable')))
}
/** Current-session uploads reuse the bytes already explicitly chosen by the user.
 * @param {{invoke:(cmd:string,args:Record<string,unknown>)=>Promise<unknown>}} deps
 * @param {{name:string,mime:string,data_b64:string}} file */
export function openLocalConversationFile(deps,file) {
  return openConversationFile(deps,file.name,async()=>({name:file.name,mime:file.mime,bytes:Uint8Array.from(atob(file.data_b64),c=>c.charCodeAt(0))}))
}
/** @param {{invoke:(cmd:string,args:Record<string,unknown>)=>Promise<unknown>}} deps
 * @param {string} name @param {()=>Promise<{name:string,mime:string,bytes:Uint8Array<ArrayBuffer>}>} read */
function openConversationFile(deps,name,read) {
  const opener=document.activeElement,dialog=document.createElement('dialog');dialog.className='wb-history-dialog wb-input-preview';dialog.setAttribute('aria-label',name)
  dialog.innerHTML=`<header><h2>${escape(name)}</h2><button type="button" class="wb-new" data-close>关闭</button></header><div class="wb-input-preview-body" role="region" aria-label="文件内容"></div><footer><button type="button" class="wb-btn" data-retry hidden>重试</button><button type="button" class="wb-btn" data-zoom hidden>放大图片</button><button type="button" class="wb-btn" data-save disabled>下载</button><span role="status" aria-live="polite"></span></footer>`
  document.body.append(dialog);dialog.showModal()
  const body=/** @type {HTMLElement} */(dialog.querySelector('.wb-input-preview-body')),status=/** @type {HTMLElement} */(dialog.querySelector('[role=status]')),retry=/** @type {HTMLButtonElement} */(dialog.querySelector('[data-retry]')),save=/** @type {HTMLButtonElement} */(dialog.querySelector('[data-save]')),zoom=/** @type {HTMLButtonElement} */(dialog.querySelector('[data-zoom]'))
  let closed=false,url='',generation=0
  /** @type {(()=>void)|undefined} */
  let pdfCleanup
  /** @type {Awaited<ReturnType<typeof readOwnerChatFile>>|null} */let file=null
  const load=async()=>{const request=++generation;retry.hidden=true;save.disabled=true;status.textContent='正在打开…'
    try{const next=await read();if(closed||request!==generation)return;file=next
      if(next.mime.match(/^image\/(png|jpeg|gif|webp)$/)){url=URL.createObjectURL(new Blob([next.bytes],{type:next.mime}));body.innerHTML=`<img src="${url}" alt="${escape(next.name)}">`;zoom.hidden=false;body.querySelector('img')?.addEventListener('error',()=>{status.textContent='图片无法显示，可以下载后查看。'})}
      else if(next.mime==='application/pdf'){body.innerHTML=renderPdfReader('conversation-file:'+name,next.name);pdfCleanup=mountPdfReader(/** @type {HTMLElement} */(body.querySelector('.cc-pdf-reader')),next.bytes,next.name)}
      else if(next.mime.startsWith('text/')||next.mime==='application/json')body.innerHTML=renderReadingFile(next.name,next.mime,new TextDecoder().decode(next.bytes))
      else body.textContent='下载后可在本机应用中查看。'
      save.disabled=false;status.textContent=''
    }catch(error){if(closed||request!==generation)return;const code=String(error);status.textContent=/too_large/.test(code)?'文件超过 20 MB，请在电脑上的原位置查看。':/file_changed/.test(code)?'文件刚刚发生变化，请重新打开。':'这个文件暂时无法读取，可能已移动或删除。';retry.hidden=false}
  }
  dialog.querySelector('[data-close]')?.addEventListener('click',()=>dialog.close());retry.addEventListener('click',()=>{void load()});zoom.addEventListener('click',()=>{const expanded=body.classList.toggle('is-zoomed');zoom.textContent=expanded?'适合窗口':'放大图片'})
  save.addEventListener('click',async()=>{if(!file)return;save.disabled=true;try{await saveFile(deps,file.name,file.mime,file.bytes);status.textContent='已下载'}catch{status.textContent='下载失败，请重试。'}finally{save.disabled=false}})
  dialog.addEventListener('close',()=>{closed=true;generation++;pdfCleanup?.();if(url)URL.revokeObjectURL(url);dialog.remove();if(opener instanceof HTMLElement&&opener.isConnected)opener.focus()},{once:true});void load()
}

/** Current-session upload preview only. Never restore or fetch arbitrary URLs.
 * @param {string} src */
export function openConversationImage(src){
  if(!src.startsWith('blob:'))return
  const opener=document.activeElement,dialog=document.createElement('dialog');dialog.className='wb-history-dialog wb-input-preview';dialog.setAttribute('aria-label','你发的图片')
  dialog.innerHTML=`<header><h2>你发的图片</h2><button type="button" class="wb-new" data-close>关闭</button></header><div class="wb-input-preview-body"><img src="${escape(src)}" alt="你发的图片"></div><footer><button type="button" class="wb-btn" data-zoom>放大图片</button></footer>`
  dialog.querySelector('[data-close]')?.addEventListener('click',()=>dialog.close());dialog.querySelector('[data-zoom]')?.addEventListener('click',event=>{const expanded=dialog.querySelector('.wb-input-preview-body')?.classList.toggle('is-zoomed');if(event.target instanceof HTMLElement)event.target.textContent=expanded?'适合窗口':'放大图片'})
  dialog.addEventListener('close',()=>{dialog.remove();if(opener instanceof HTMLElement&&opener.isConnected)opener.focus()},{once:true});document.body.append(dialog);dialog.showModal()
}
