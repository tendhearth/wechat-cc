function cDownloadNotice(text){if(mCurrent)mNotice(text);else cNotice(text)}
function cAttachmentHtml(m){return (m.attachments||[]).map(function(a,i){return ['file','image','sticker'].includes(a.kind)?'<button type="button" data-chat-file="'+esc(m.id)+'" data-index="'+i+'">读取附件 · '+esc(a.name||'图片')+'</button>':a.kind==='voice'?'<small>语音请在手机 App 或电脑上听。</small>':''}).join('')}
function cArtifactHtml(d){if(!isDevice||!cReady)return '';return (d.artifacts||[]).length?'<details class="matter-artifacts"><summary>成果文件</summary>'+d.artifacts.map(function(a){return '<button type="button" data-artifact="'+esc(a.id)+'">下载 · '+esc(a.name)+'</button>'}).join('')+'</details>':''}
async function cDownload(read){
 if(!isDevice||!cReady)return
 var identity=T,offset=0,chunks=[],size=null,hash=null,name=null,mime=null
 cDownloadNotice('正在读取授权附件…')
 try{
  do{
   var r=await read(offset,hash,size)
   if(r.status===401){onUnauthorized(identity);return}if(r.status!==200)throw Error('unavailable')
   var b=await r.json();if(identity!==T||!isDevice||!cReady)return
   if(!b.ok||!Number.isSafeInteger(b.size)||b.size<0||b.size>20*1024*1024||b.offset!==offset||!Number.isSafeInteger(b.nextOffset)||b.nextOffset<offset||b.nextOffset>b.size||b.nextOffset===offset&&offset!==b.size||!/^\w{64}$/.test(b.sha256)||typeof b.contentBase64!=='string'||b.contentBase64.length>180000)throw Error('invalid_chunk')
   if(size!==null&&(size!==b.size||hash!==b.sha256))throw Error('changed')
   size=b.size;hash=b.sha256;name=b.name;mime=b.mime
   var binary=atob(b.contentBase64),bytes=Uint8Array.from(binary,function(c){return c.charCodeAt(0)})
   if(bytes.length!==b.nextOffset-offset)throw Error('invalid_chunk')
   chunks.push(bytes);offset=b.nextOffset
  }while(offset<size)
  var all=new Uint8Array(size),at=0;chunks.forEach(function(bytes){all.set(bytes,at);at+=bytes.length})
  var digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',all))).map(function(n){return n.toString(16).padStart(2,'0')}).join('')
  if(digest!==hash||identity!==T||!isDevice||!cReady)throw Error('changed')
  var url=URL.createObjectURL(new Blob([all],{type:mime||'application/octet-stream'})),a=document.createElement('a');a.href=url;a.download=String(name||'附件').replace(/[\/\\:]/g,'_');a.click();setTimeout(function(){URL.revokeObjectURL(url)},1000);cDownloadNotice('附件已读取。')
 }catch(e){cNotice('附件暂时读不到或已改变，请刷新后重试；也可在 App 或电脑上查看。')}
}
document.getElementById('chat-messages').addEventListener('click',function(ev){var b=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('[data-chat-file]'));if(!b||!isDevice)return;var id=b.dataset.chatFile,index=b.dataset.index;cDownload(function(offset,hash,size){return /* link-scan: device-only */ api('/v1/matter/owner-chat/file?id='+encodeURIComponent(id)+'&i='+index+'&offset='+offset+(hash?'&sha256='+hash+'&size='+size:''))})})
document.getElementById('m-status').addEventListener('click',function(ev){var b=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('[data-artifact]'));if(!b||!isDevice||!mDetail)return;var id=mCurrent,a=(mDetail.artifacts||[]).find(function(a){return a.id===b.dataset.artifact});if(!a)return;cDownload(function(offset){return /* link-scan: device-only */ api('/v1/matter/artifact?id='+encodeURIComponent(id)+'&artifactId='+encodeURIComponent(a.id)+'&sha256='+encodeURIComponent(a.sha256)+'&offset='+offset)})})
