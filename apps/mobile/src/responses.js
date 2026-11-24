var cResponse=document.getElementById('m-response')
var cResponseSignature=null,cResponding=false,cResponseUnknown=new Set()
function cResponseHtml(d){
 if(!isDevice||!cReady)return ''
 var id=d.matter.id,run=d.runId,html=''
 if(!run)return '<p>这项响应请在手机 App 或电脑上处理。</p>'
 ;(d.permissions||[]).filter(function(p){return p.taskId===id}).forEach(function(p){
  var extra=Object.entries(p.display?.extra||{}),lines=[],marked=false
  // 与 packages/protocol/src/permission-presentation.ts 的不可见字符范围同步修改。
  function visible(text){return esc(text.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g,function(c){
   marked=true
   var hex=c.charCodeAt(0).toString(16)
   return c==='\r'?'\\r':'\\u{'+hex.toUpperCase()+'}'
  }))}
  if(p.cwd)lines.push('在 '+p.cwd)
  for(var [key,value] of extra.slice(0,8))lines.push(key+'：'+(typeof value==='string'?value:JSON.stringify(value)))
  if(extra.length>8)lines.push('还有 '+(extra.length-8)+' 项，到手机 App 或电脑上看')
  html+='<section class="response"><h3>等你决定</h3><p>'+esc(p.tool)+'</p><pre>'+visible(p.description)+'</pre>'+
   (lines.length?'<pre>'+visible(lines.join('\n'))+'</pre>':'')+(marked?'<p>这里有看不见的字符，已经标出来了。</p>':'')+
   cScriptHtml(p)+(p.canDenyWithReason===true?'<label>拒绝理由（选填）<textarea maxlength="2000" data-denial-reason="'+esc(p.id)+'"></textarea></label>':'')+
   '<small>提出于 '+esc(mobileTime(p.createdAt))+' · 仅此请求、当前轮次有效</small><div>'+cPermissionActions(p)+'</div></section>'
 })
 ;(d.questions||[]).filter(function(q){return q.taskId===id}).forEach(function(q){html+='<form class="response" data-question="'+esc(q.id)+'"><h3>等你回答</h3>';q.questions.forEach(function(item,index){html+='<fieldset><legend>'+esc(item.header)+' · '+esc(item.question)+'</legend>';item.options.forEach(function(o,i){html+='<label><input type="'+(item.multiSelect?'checkbox':'radio')+'" name="answer-'+index+'" value="'+i+'">'+esc(o.label)+' '+esc(o.description)+'</label>'});if(item.allowOther)html+='<label>补充<input type="text" maxlength="4000" data-other="'+index+'"></label>';html+='</fieldset>'});html+='<button type="submit">提交回答</button></form>'})
 return html||'<p>没有可在网页处理的请求。其他响应请在手机 App 或电脑上处理。</p>'
}
function cPermissionActions(p){
 var blocked=p.display?.truncated||Object.keys(p.display?.extra||{}).length>8||
  (!p.cwd&&(p.display?.body?.kind==='command'||/^(bash|shell)$/i.test(p.tool)))||
  p.scripts?.some(s=>s.error||s.truncated&&cScriptFull(p,s)===undefined)
 function button(decision,label){return '<button type="button" data-decision="'+decision+'" data-request="'+esc(p.id)+'">'+label+'</button>'}
 if(blocked)return '<p>这条在网页上看不全，请到手机 App 或电脑上看全再定</p>'+button('deny','拒绝')
 return button('deny','先不做')+' '+button('allow','允许这一步')+(p.canAllowTask?' '+button('allow_task','本任务同命令都允许'):'')
}
function cResponseButtons(){cResponse.querySelectorAll('[data-decision],.response button').forEach(function(/** @type {HTMLButtonElement} */ b){var form=b.closest('form'),request=b.dataset.request||(form&&form.dataset.question);b.disabled=cResponding||!mDetailFresh||mOffline||cResponseUnknown.has(request)})}
async function cRespond(request,decision,answers){
 if(!isDevice||!cReady||!mDetailFresh||mOffline||cResponding||cResponseUnknown.has(request)||!mDetail)return
 var id=mCurrent,run=mDetail.runId,known=(decision?mDetail.permissions:mDetail.questions)||[]
 if(!known.some(function(p){return p.id===request&&p.taskId===id}))return
 var reasonField=/** @type {HTMLTextAreaElement|null} */ (document.querySelector('[data-denial-reason="'+request+'"]'))
 var reason=decision==='deny'?reasonField?.value.trim():''
 cResponding=true;cResponseButtons();mNotice('正在提交…')
 try{
  var opts={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,runId:run,requestId:request,...(decision?{decision:decision,...(reason?{reason:reason}:{})}:{answers:answers})})}
  var r
  if(decision){r=await /* link-scan: device-only */ mPostOnce('/v1/matter/permission',{method:'POST',headers:opts.headers,body:opts.body})}else{r=await /* link-scan: device-only */ mPostOnce('/v1/matter/answer',{method:'POST',headers:opts.headers,body:opts.body})}
  if(r.status===401){onUnauthorized(T);return}var b=await r.json()
  if(mCurrent!==id)return
  if(r.status>=200&&r.status<300&&b.ok)mNotice('已处理。')
  else{cResponseUnknown.add(request);mNotice('请求已变化或暂时无法处理，请刷新核对。')}
 }catch(e){cResponseUnknown.add(request);if(mCurrent===id)mNotice('结果待核对 · 请刷新查看；不会自动重复提交。')}
 finally{cResponding=false;if(mCurrent===id){await mRefresh();cResponseButtons()}}
}
cResponse.addEventListener('click',function(ev){var b=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('[data-decision]'));if(b)cRespond(b.dataset.request,b.dataset.decision,null)})
cResponse.addEventListener('submit',function(ev){var form=/** @type {HTMLFormElement} */ (ev.target);if(!form.dataset.question)return;ev.preventDefault();var q=(mDetail.questions||[]).find(function(q){return q.id===form.dataset.question});if(!q)return;var answers={},valid=true;q.questions.forEach(function(item,index){var chosen=Array.from(form.querySelectorAll('input[name="answer-'+index+'"]:checked')).map(function(/** @type {HTMLInputElement} */ el){return item.options[Number(el.value)].label});var other=/** @type {HTMLInputElement} */ (form.querySelector('[data-other="'+index+'"]'));if(other&&other.value.trim()){if(!item.multiSelect)chosen=[];chosen.push(other.value.trim())}if(!chosen.length||chosen.length>8)valid=false;answers[item.id]=chosen});if(!valid){mNotice('请回答每个问题。');return}cRespond(form.dataset.question,null,answers)})

function cRenderResponses(d){
 if(!isDevice||!cReady)return
 var signature=JSON.stringify([d.matter.id,d.runId,d.permissions||[],d.questions||[]])
 if(signature!==cResponseSignature){
  var drafts=new Map();cResponse.querySelectorAll('[data-denial-reason]').forEach(function(/** @type {HTMLTextAreaElement} */ f){drafts.set(f.dataset.denialReason,f.value)})
  cResponseSignature=signature;cResponse.innerHTML=cResponseHtml(d)
  cResponse.querySelectorAll('[data-denial-reason]').forEach(function(/** @type {HTMLTextAreaElement} */ f){f.value=drafts.get(f.dataset.denialReason)||''})
 }
 document.getElementById('matter-recheck').hidden=false;cResponseButtons()
}
document.getElementById('matter-recheck').addEventListener('click',async function(){var id=mCurrent;await mRefresh();if(id!==mCurrent||!mDetailFresh)return;cResponseUnknown.clear();cResponseButtons();mNotice('已核对当前请求；不在这里的请求已处理或失效。')})

function cResetResponse(){cResponseSignature=null;cResponse.replaceChildren();document.getElementById('matter-recheck').hidden=true}

var cScriptCache=new Map()
function cScriptFull(p,s){return cScriptCache.get(JSON.stringify([p.taskId,p.id,s.path,s.sha256]))}
function cScriptHtml(p){return (p.scripts||[]).map(function(s){
 var full=cScriptFull(p,s)
 return '<div class="response-script"><p>脚本 · '+esc(s.path)+'</p><pre>'+esc(s.error||(full??s.content.slice(0,2000)))+'</pre>'+
  (full!==undefined?'':s.truncated?'<button type="button" data-script-full="1" data-task="'+esc(p.taskId)+'" data-request="'+esc(p.id)+'" data-path="'+esc(s.path)+'" data-sha="'+esc(s.sha256)+'">展开全文</button>':
   s.content.length>2000?'<details><summary>展开全文</summary><pre>'+esc(s.content)+'</pre></details>':'')+'</div>'
}).join('')}
async function cExpandScript(button){
 if(!isDevice||!cReady||mOffline||button.disabled||mCurrent!==button.dataset.task)return
 var id=mCurrent,request=button.dataset.request,path=button.dataset.path,sha=button.dataset.sha,offset=0,content=''
 button.disabled=true
 try{
  for(var i=0;i<32;i++){
   var part=await /* link-scan: device-only */ mApi('/v1/matter/permission-script?id='+encodeURIComponent(id)+'&requestId='+encodeURIComponent(request)+'&path='+encodeURIComponent(path)+'&sha256='+encodeURIComponent(sha)+'&offset='+offset)
   content+=part.content
   if(part.nextOffset===null)break
   if(!Number.isSafeInteger(part.nextOffset)||part.nextOffset<=offset)throw Error('permission_stale')
   offset=part.nextOffset
  }
  if(i===32)throw Error('permission_stale')
  cScriptCache.set(JSON.stringify([id,request,path,sha]),content)
  if(mCurrent===id){
   var live=Array.from(cResponse.querySelectorAll('[data-script-full]')).find(function(/** @type {HTMLButtonElement} */ b){return b.dataset.task===id&&b.dataset.request===request&&b.dataset.path===path&&b.dataset.sha===sha})
   if(live){
    live.closest('.response-script').querySelector('pre').textContent=content
    var p=mDetail?.permissions?.find(p=>p.id===request&&p.taskId===id)
    if(p){
     live.closest('.response').lastElementChild.innerHTML=cPermissionActions(p)
     cResponseButtons()
    }
    live.remove()
   }
  }
 }catch(e){button.disabled=false;mNotice('脚本未能读全，请刷新核对后重试。')}
}
cResponse.addEventListener('click',function(ev){var b=/** @type {Element} */ (ev.target).closest('[data-script-full]');if(b)void cExpandScript(b)})
