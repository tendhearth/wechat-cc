// Stable references do not copy or rewrite old CC messages.
var cMatterSeen=new Map(),cExpanded=new Set(),cReferences=new Map(),cOpenedAt=Date.now(),cWaitingIndex=0
function cReference(m,historical){return '<article class="cc-reference" id="reference-'+esc(m.id)+'" data-reference="'+esc(m.id)+'"><small>CC · '+(historical?'以前交办的事 · ':'')+esc(new Date(m.createdAt).toLocaleString())+'</small><details'+(cExpanded.has(m.id)?' open':'')+'><summary>'+esc(ccPlain(m.title))+' · '+esc(CCP.STATUS_WORDS[mStatusKey(m)]||m.state||'尚未同步')+'</summary><p>'+esc((m.agents||[]).map(mNameOf(m.agentNames)).join('、'))+' · '+esc(new Date(m.updatedAt).toLocaleString())+'</p><button type="button" data-mid="'+esc(m.id)+'">看过程、成果与等你决定</button></details></article>'}
function cMatterUpdates(){
 if(!isDevice||!mMatters)return
 mMatters.forEach(function(m){if(cReferences.has(m.id)||m.originMessageId&&cMessages.has(m.originMessageId)||m.kind==='task'&&(m.createdAt>=cOpenedAt||cMatterSeen.has(m.id)&&cMatterSeen.get(m.id)!==JSON.stringify([m.updatedAt,mStatusKey(m)])))cReferences.set(m.id,m);cMatterSeen.set(m.id,JSON.stringify([m.updatedAt,mStatusKey(m)]))})
 var waiting=typeof cReady!=='undefined'&&cReady?cWaitingMatters():mMatters.filter(function(m){return mStatusKey(m)==='waiting'})
 var locator=document.getElementById('chat-waiting');locator.hidden=!waiting.length;locator.textContent=waiting.length+' 件事等你'
 cRender();if(typeof cReady!=='undefined'&&cReady)cLoadWaiting()
}
function cRevealMatter(id){
 var m=(mMatters||[]).find(function(m){return m.id===id})||cReferences.get(id)||(cWaitingRows||[]).find(function(m){return m.id===id})||(typeof cSearchRows!=='undefined'?cSearchRows.find(function(m){return m.id===id}):null)
 if(!m)return openMatter(id)
 cReferences.set(id,m);cRender();var node=document.getElementById('reference-'+id);if(node){node.scrollIntoView({block:'center'});node.querySelector('summary').focus()}
}
document.getElementById('chat-waiting').addEventListener('click',function(){var waiting=cWaitingMatters();if(waiting.length)cRevealMatter(waiting[cWaitingIndex++%waiting.length].id)})
document.getElementById('chat-messages').addEventListener('click',function(ev){var b=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('[data-mid]'));if(b)openMatter(b.dataset.mid)})

function cMatterWork(d){
 if(!isDevice||!cReady)return ''
 var events=d.events||[],html='<details class="matter-process"><summary>过程 · '+events.length+' 条记录</summary>'
 html+=events.slice(-40).map(function(e){return '<p>'+esc(e.activity&&e.activity.label||e.text||e.kind)+'</p>'}).join('')||'<p>还没有过程记录</p>'
 html+='</details>'
 var results=events.filter(function(e){return e.kind==='assistant'||e.kind==='text'||e.kind==='result'})
 if(results.length)html+='<details class="matter-results"><summary>CC 带回来的结果</summary><p>'+esc(results[results.length-1].text||'')+'</p></details>'
 return html
}
document.getElementById('chat-messages').addEventListener('toggle',function(ev){var el=/** @type {HTMLDetailsElement} */ (ev.target);if(el.tagName!=='DETAILS')return;var article=/** @type {HTMLElement} */ (el.closest('[data-reference]'));if(article){if(el.open)cExpanded.add(article.dataset.reference);else cExpanded.delete(article.dataset.reference)}},true)

function cCaptureMatter(d){
 if(!isDevice||!cReady)return
 var m=Object.assign({},d.matter)
 if(d.task)m.taskState={status:d.task.status,phase:d.task.phase,pending:(d.permissions||[]).concat(d.questions||[]).filter(function(p){return p.taskId===m.id}).length}
 cReferences.set(m.id,m);cRender()
}
var cWaitingRows=null,cWaitingLoading=false
function cWaitingMatters(){var rows=cWaitingRows||(mMatters||[]).filter(function(m){return mStatusKey(m)==='waiting'});if(typeof homeFocus!=='undefined'&&homeFocus&&homeFocus.kind==='decision'&&!rows.some(function(m){return m.id===homeFocus.id}))rows=rows.concat([homeFocus]);return rows}
async function cLoadWaiting(){
 if(!isDevice||!cReady||cWaitingLoading)return;cWaitingLoading=true
 var identity=T,rows=[],cursor=null
 try{
  do{
   var r=await /* link-scan: device-only */ api('/v1/matters?search=1&kind=task&state=waiting&taskState=1&limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''))
   if(r.status===401){onUnauthorized(identity);return}if(r.status!==200)throw Error('unavailable');var b=await r.json();if(!isDevice||identity!==T)return;if(!Array.isArray(b.matters))throw Error('unavailable');rows=rows.concat(b.matters);cursor=b.nextCursor
  }while(cursor)
  cWaitingRows=rows;var locator=document.getElementById('chat-waiting'),waiting=cWaitingMatters();locator.hidden=!waiting.length;locator.textContent=waiting.length+' 件事等你'
 }catch(e){var locator=document.getElementById('chat-waiting');if(!locator.hidden)locator.textContent+=' · 尚未同步'}
 finally{cWaitingLoading=false}
}
