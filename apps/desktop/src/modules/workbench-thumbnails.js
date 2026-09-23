// @ts-check
export const isThumbnailImage=(/** @type {string} */mime)=>['image/png','image/jpeg','image/webp','image/gif'].includes(mime)
/** Per-mounted-page URLs; never persist image bytes in draft/session storage.
 * @param {{invoke:(method:'GET',path:string)=>Promise<unknown>}} deps */
export function createWorkbenchThumbnails(deps){
  /** @type {Map<string,string>} */const urls=new Map()
  /** @type {Map<string,Promise<string>>} */const pending=new Map()
  let alive=true
  /** @type {IntersectionObserver|null} */let observer=null
  const put=(/** @type {string} */key,/** @type {Blob} */blob)=>{
    const old=urls.get(key);if(old)URL.revokeObjectURL(old)
    const url=URL.createObjectURL(blob);urls.set(key,url)
    const remote=[...urls.keys()].filter(key=>!key.startsWith('draft:'))
    for(const expired of remote.slice(0,-32)){URL.revokeObjectURL(/** @type {string} */(urls.get(expired)));urls.delete(expired)}
    return url
  }
  const load=async(/** @type {string} */taskId,/** @type {string} */id,artifact=false)=>{
    const key=`${artifact?'artifact':'attachment'}:${taskId}:${id}`
    if(urls.has(key))return /** @type {string} */(urls.get(key))
    if(pending.has(key))return /** @type {Promise<string>} */(pending.get(key))
    const request=(async()=>{
      const path=artifact?`/v1/workbench/artifact?id=${encodeURIComponent(taskId)}&artifactId=${encodeURIComponent(id)}`:`/v1/workbench/attachment?taskId=${encodeURIComponent(taskId)}&id=${encodeURIComponent(id)}`
      const response=/** @type {{attachment?:{id:string,mime:string},mime?:string,base64?:string,contentBase64?:string}} */(await deps.invoke('GET',path))
      const mime=artifact?response.mime:response.attachment?.mime,base64=artifact?response.contentBase64:response.base64
      if(!alive)throw Error('disposed')
      if(!mime||!isThumbnailImage(mime)||(!artifact&&response.attachment?.id!==id)||typeof base64!=='string'||base64.length>12*1024*1024)throw Error('invalid_image')
      const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0))
      return put(key,new Blob([bytes],{type:mime}))
    })();pending.set(key,request)
    try{return await request}finally{pending.delete(key)}
  }
  const hydrate=async(/** @type {HTMLElement} */button)=>{
    const id=button.dataset.thumbnailId,taskId=button.dataset.ownerTask
    if(!id||!taskId||button.dataset.thumbnailLoading)return
    button.dataset.thumbnailLoading='true'
    try{
      const url=await load(taskId,id,button.dataset.thumbnailKind==='artifact')
      if(!alive||!button.isConnected)return
      const img=button.querySelector('img');if(!img)return
      img.onerror=()=>{const key=`${button.dataset.thumbnailKind==='artifact'?'artifact':'attachment'}:${taskId}:${id}`;URL.revokeObjectURL(url);urls.delete(key);img.hidden=true;button.dataset.thumbnailLoading='';const status=button.querySelector('small');if(status)status.textContent='图片未能显示 · 点击重试'}
      img.onload=()=>{img.hidden=false;const status=button.querySelector('small');if(status)status.textContent='点击放大'}
      img.src=url
    }catch{
      if(!alive||!button.isConnected)return
      button.dataset.thumbnailLoading='';const status=button.querySelector('small');if(status)status.textContent='图片未能加载 · 点击重试'
    }
  }
  return{
    load,
    local:(/** @type {string} */id,/** @type {File} */file)=>{if(isThumbnailImage(file.type))put(`draft:${id}`,file)},
    remove:(/** @type {string} */id)=>{const key=`draft:${id}`,url=urls.get(key);if(url)URL.revokeObjectURL(url);urls.delete(key)},
    mount(/** @type {HTMLElement} */root){
      observer?.disconnect()
      for(const img of root.querySelectorAll?.('img[data-draft-thumbnail]')??[]){const image=/** @type {HTMLImageElement} */(img),url=urls.get(`draft:${image.dataset.draftThumbnail}`);if(url){image.src=url;image.hidden=false}}
      const nodes=root.querySelectorAll?.('[data-thumbnail-id]')??[]
      if(typeof IntersectionObserver==='undefined'){for(const node of nodes)void hydrate(/** @type {HTMLElement} */(node));return}
      observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer?.unobserve(entry.target);void hydrate(/** @type {HTMLElement} */(entry.target))}},{rootMargin:'200px'})
      for(const node of nodes)observer.observe(node)
    },
    retry:(/** @type {HTMLElement} */button)=>{button.dataset.thumbnailLoading='';void hydrate(button)},
    destroy(){alive=false;observer?.disconnect();for(const url of urls.values())URL.revokeObjectURL(url);urls.clear()},
  }
}
