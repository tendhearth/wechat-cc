var cResponseSignature=null,cResponding=false,cResponseUnknown=new Set()
function cResponseHtml(d){
 if(!isDevice||!cReady)return ''
 var id=d.matter.id,run=d.runId,html=''
 if(!run)return '<p>这项响应请在手机 App 或电脑上处理。</p>'
 ;(d.permissions||[]).filter(function(p){return p.taskId===id}).forEach(function(p){html+='<section class="response"><h3>等你决定</h3><p>'+esc(p.tool)+'</p><pre>'+esc(p.description)+'</pre>'+cScriptHtml(p,id)+(p.canDenyWithReason===true?'<label>拒绝理由（选填）<textarea maxlength="2000" data-denial-reason="'+esc(p.id)+'"></textarea></label>':'')+'<small>提出于 '+esc(new Date(p.createdAt).toLocaleString())+' · 仅此请求、当前轮次有效</small><div><button type="button" data-decision="deny" data-request="'+esc(p.id)+'">先不做</button> <button type="button" data-decision="allow" data-request="'+esc(p.id)+'">允许这一步</button>'+(p.canAllowTask?' <button type="button" data-decision="allow_task" data-request="'+esc(p.id)+'">本任务同命令都允许</button>':'')+'</div></section>'})
 ;(d.questions||[]).filter(function(q){return q.taskId===id}).forEach(function(q){html+='<form class="response" data-question="'+esc(q.id)+'"><h3>等你回答</h3>';q.questions.forEach(function(item,index){html+='<fieldset><legend>'+esc(item.header)+' · '+esc(item.question)+'</legend>';item.options.forEach(function(o,i){html+='<label><input type="'+(item.multiSelect?'checkbox':'radio')+'" name="answer-'+index+'" value="'+i+'">'+esc(o.label)+' '+esc(o.description)+'</label>'});if(item.allowOther)html+='<label>补充<input type="text" maxlength="4000" data-other="'+index+'"></label>';html+='</fieldset>'});html+='<button type="submit">提交回答</button></form>'})
 return html||'<p>没有可在网页处理的请求。其他响应请在手机 App 或电脑上处理。</p>'
}
function cResponseButtons(){document.querySelectorAll('#m-response [data-decision],#m-response .response button').forEach(function(/** @type {HTMLButtonElement} */ b){var form=b.closest('form'),request=b.dataset.request||(form&&form.dataset.question);b.disabled=cResponding||!mDetailFresh||mOffline||cResponseUnknown.has(request)})}
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
document.getElementById('m-response').addEventListener('click',function(ev){var b=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('[data-decision]'));if(b)cRespond(b.dataset.request,b.dataset.decision,null)})
document.getElementById('m-response').addEventListener('submit',function(ev){var form=/** @type {HTMLFormElement} */ (ev.target);if(!form.dataset.question)return;ev.preventDefault();var q=(mDetail.questions||[]).find(function(q){return q.id===form.dataset.question});if(!q)return;var answers={},valid=true;q.questions.forEach(function(item,index){var chosen=Array.from(form.querySelectorAll('input[name="answer-'+index+'"]:checked')).map(function(/** @type {HTMLInputElement} */ el){return item.options[Number(el.value)].label});var other=/** @type {HTMLInputElement} */ (form.querySelector('[data-other="'+index+'"]'));if(other&&other.value.trim()){if(!item.multiSelect)chosen=[];chosen.push(other.value.trim())}if(!chosen.length||chosen.length>8)valid=false;answers[item.id]=chosen});if(!valid){mNotice('请回答每个问题。');return}cRespond(form.dataset.question,null,answers)})

function cRenderResponses(d){
 if(!isDevice||!cReady)return
 var signature=JSON.stringify([d.matter.id,d.runId,d.permissions||[],d.questions||[]])
 if(signature!==cResponseSignature){
  var drafts=new Map();document.querySelectorAll('#m-response [data-denial-reason]').forEach(function(/** @type {HTMLTextAreaElement} */ f){drafts.set(f.dataset.denialReason,f.value)})
  cResponseSignature=signature;document.getElementById('m-response').innerHTML=cResponseHtml(d)
  document.querySelectorAll('#m-response [data-denial-reason]').forEach(function(/** @type {HTMLTextAreaElement} */ f){f.value=drafts.get(f.dataset.denialReason)||''})
 }
 document.getElementById('matter-recheck').hidden=false;cResponseButtons()
}
document.getElementById('matter-recheck').addEventListener('click',async function(){var id=mCurrent;await mRefresh();if(id!==mCurrent||!mDetailFresh)return;cResponseUnknown.clear();cResponseButtons();mNotice('已核对当前请求；不在这里的请求已处理或失效。')})

function cResetResponse(){cResponseSignature=null;document.getElementById('m-response').replaceChildren();document.getElementById('matter-recheck').hidden=true}

var cScriptCache=new Map()
function cScriptHtml(p,id){return (p.scripts||[]).map(function(s){var full=cScriptCache.get(JSON.stringify([id,p.id,s.path,s.sha256]));return '<div class="response-script"><p>脚本 · '+esc(s.path)+'</p><pre>'+esc(s.error||(full===undefined?s.content.slice(0,2000):full))+'</pre>'+(s.truncated&&full===undefined?'<button type="button" data-script-full="1" data-task="'+esc(id)+'" data-request="'+esc(p.id)+'" data-path="'+esc(s.path)+'" data-sha="'+esc(s.sha256)+'">展开全文</button>':s.content.length>2000&&full===undefined?'<details><summary>展开全文</summary><pre>'+esc(s.content)+'</pre></details>':'')+'</div>'}).join('')}
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
   var live=Array.from(document.querySelectorAll('#m-response [data-script-full]')).find(function(/** @type {HTMLButtonElement} */ b){return b.dataset.task===id&&b.dataset.request===request&&b.dataset.path===path&&b.dataset.sha===sha})
   if(live){live.closest('.response-script').querySelector('pre').textContent=content;live.remove()}
  }
 }catch(e){button.disabled=false;mNotice('脚本未能读全，请刷新核对后重试。')}
}
document.getElementById('m-response').addEventListener('click',function(ev){var b=/** @type {Element} */ (ev.target).closest('[data-script-full]');if(b)void cExpandScript(b)})
