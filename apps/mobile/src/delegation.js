// Stable references do not copy or rewrite old CC messages.
var cExpanded=new Set(),cReferences=new Map(),cOpenedAt=Date.now(),cWaitingIndex=0
function cReference(m,historical){return '<article class="cc-reference" id="reference-'+esc(m.id)+'" data-reference="'+esc(m.id)+'"><small>CC · '+(historical?'以前交办的事 · ':'')+esc(new Date(m.createdAt).toLocaleString())+'</small><details'+(cExpanded.has(m.id)?' open':'')+'><summary>'+esc(ccPlain(m.title))+' · '+esc(CCP.STATUS_WORDS[mStatusKey(m)]||m.state||'尚未同步')+'</summary><p>'+esc((m.agents||[]).map(mNameOf(m.agentNames)).join('、'))+' · '+esc(new Date(m.updatedAt).toLocaleString())+'</p><button type="button" data-mid="'+esc(m.id)+'">看过程、成果与等你决定</button></details></article>'}
function cMatterUpdates(){
 if(!isDevice||!mMatters)return
 mMatters.forEach(function(m){if(cReferences.has(m.id)||m.originMessageId&&cMessages.has(m.originMessageId)||m.kind==='task'&&m.createdAt>=cOpenedAt)cReferences.set(m.id,m)})
 var waiting=mMatters.filter(function(m){return mStatusKey(m)==='waiting'})
 var locator=document.getElementById('chat-waiting');locator.hidden=!waiting.length;locator.textContent=waiting.length+' 件事等你'
 cRender()
}
function cRevealMatter(id){
 var m=(mMatters||[]).find(function(m){return m.id===id})
 if(!m)return openMatter(id)
 cReferences.set(id,m);cRender();var node=document.getElementById('reference-'+id);if(node){node.scrollIntoView({block:'center'});node.querySelector('summary').focus()}
}
document.getElementById('chat-waiting').addEventListener('click',function(){var waiting=(mMatters||[]).filter(function(m){return mStatusKey(m)==='waiting'});if(waiting.length)cRevealMatter(waiting[cWaitingIndex++%waiting.length].id)})
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
