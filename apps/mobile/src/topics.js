function tNotice(text){document.getElementById('topic-notice').textContent=text;document.getElementById('topic-retry').hidden=!text}
var tOpenFailed=false,tSearchTimer=null,tUnsubscribe=null,tListSeq={recent:0,all:0},tReady=false,tRecent=[],tAll=[],tCursor=null,tSelected=null,tDetail=null,tReadSeq=0,tRevision=null,tPolling=false
async function tList(all,more){
 if(!isDevice||!tReady)return
 var lane=all?'all':'recent',listSeq=++tListSeq[lane],identity=T
 try{
  var r=await /* link-scan: device-only */ api('/v1/memory/topics?view='+(all?'all':'recent')+'&limit='+(all?'20':'6')+(more&&tCursor?'&cursor='+encodeURIComponent(tCursor):'')+(all&&/** @type {HTMLInputElement} */ (document.getElementById('topic-query')).value.trim()?'&q='+encodeURIComponent(/** @type {HTMLInputElement} */ (document.getElementById('topic-query')).value.trim()):''))
  if(r.status===401){onUnauthorized(identity);return}if(r.status!==200)throw Error('unavailable')
  var b=await r.json();if(!isDevice||identity!==T||listSeq!==tListSeq[lane])return
  if(all){tAll=more?tAll.concat(b.topics):b.topics;tCursor=b.nextCursor;tRenderAll();tNotice('')}else{tRecent=b.topics;var row=document.getElementById('topic-row');row.hidden=!tRecent.length;row.innerHTML=tRecent.map(function(t){return '<button type="button" data-topic="'+esc(t.id)+'" aria-pressed="'+(t.id===tSelected)+'">'+esc(t.title)+'</button>'}).join('')+(tRecent.length?'<button type="button" data-topic-more>更多话题</button>':'')}
 }catch(e){tNotice('暂时读不到，重试')}
}
function tRenderAll(){var query=/** @type {HTMLInputElement} */ (document.getElementById('topic-query')).value.toLowerCase();document.getElementById('topic-list').innerHTML=tAll.map(function(t){return '<button type="button" data-topic="'+esc(t.id)+'">'+esc(t.title)+'</button>'}).join('');document.getElementById('topic-list-more').hidden=!tCursor}
async function tOpen(id){
 if(typeof cPushLayer==='function')cPushLayer({kind:'topic',id:id})
 if(!isDevice||!tReady)return
 document.body.classList.add('topic-open');tOpenFailed=false;tSelected=id;tDetail=null;var seq=++tReadSeq
 document.getElementById('topic-panel').hidden=false;document.getElementById('topic-all').hidden=true;document.getElementById('topic-body').textContent='正在读…';document.getElementById('topic-close').focus()
 try{
  var r=await /* link-scan: device-only */ mPostOnce('/v1/memory/topics/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,requestId:crypto.randomUUID()})})
  if(r.status===401){onUnauthorized(T);return}if(r.status!==200)throw Error('unavailable')
  if(seq!==tReadSeq)return;await tRead();tList(false,false)
 }catch(e){if(seq===tReadSeq){tOpenFailed=true;document.getElementById('topic-body').replaceChildren();tNotice('暂时读不到，重试')}}
}
async function tRead(section,cursor){
 if(!isDevice||!tSelected)return
 var id=tSelected,seq=++tReadSeq,identity=T
 try{
  var r=await /* link-scan: device-only */ api('/v1/memory/topics/detail?id='+encodeURIComponent(id)+(section?'&section='+section+'&cursor='+encodeURIComponent(cursor):''))
  if(r.status===401){onUnauthorized(identity);return}
  if(id!==tSelected||seq!==tReadSeq||identity!==T||!isDevice||!tReady)return
  if(r.status===404){tDetail=null;tRecent=[];tAll=[];document.getElementById('topic-body').replaceChildren();document.getElementById('topic-list').replaceChildren();document.getElementById('topic-row').replaceChildren();tClose();tList(false,false);return}if(r.status!==200)throw Error('unavailable')
  var b=await r.json();if(id!==tSelected||seq!==tReadSeq||identity!==T||!isDevice||!tReady)return
  if(b.topic.mergedInto&&b.topic.id===b.topic.mergedInto&&b.topic.mergedInto!==id){tSelected=b.topic.mergedInto;tDetail=null;await tRead();tList(false,false);return}
  if(b.topic.id!==id)throw Error('unavailable')
  if(b.topic.bubbleState==='closed'){tDetail=null;document.getElementById('topic-body').replaceChildren();tClose();tList(false,false);return}
  if(section&&tDetail){tDetail[section]=tDetail[section].concat(b[section]);tDetail.pages[section]=b.pages[section]}else tDetail=b
  tRenderDetail();tNotice('')
 }catch(e){if(seq===tReadSeq)tNotice('尚未同步 · 暂时读不到，重试')}
}
function tRenderDetail(){
 var d=tDetail,t=d.topic,html='<h2 id="topic-title">'+esc(t.title)+'</h2>'+(t.description?'<p>'+esc(t.description)+'</p>':'')+(t.summary?'<p>'+esc(t.summary)+'</p>':'')
 if(d.matters.length)html+='<h3>相关事项</h3>'+d.matters.map(function(m){return '<button type="button" data-mid="'+esc(m.id)+'">'+esc(m.title)+' · '+esc(CCP.STATUS_WORDS[m.state==='open'?'working':m.state==='cancelled'?'stopped':m.state]||m.state)+'</button>'}).join('')
 if(d.entries.length)html+='<h3>CC 记得</h3>'+d.entries.map(function(e){return '<details><summary>'+esc(e.line)+(e.status==='superseded'?' · 不再采用':'')+(e.recalled?' · 这次想起':'')+'</summary><p>'+esc(e.body)+'</p><small>'+esc(e.source)+' · '+esc(e.createdTs)+'</small>'+(e.status==='live'?'<button type="button" data-topic-wrong="'+esc(e.id)+'">这条不对</button>':'')+'</details>'}).join('')
 if(d.messages.length)html+='<h3>最近聊到</h3>'+d.messages.map(function(m){return '<button type="button" data-message="'+esc(m.id)+'" data-at="'+esc(m.ts)+'">'+(m.speaker==='owner'?'你':'CC')+' · '+esc(m.excerpt)+' · '+esc(m.ts)+(m.source==='episode'?' · 相关记录':'')+' · 回看</button>'}).join('')
 ;['matters','entries','messages'].forEach(function(section){var p=d.pages[section];if(p.nextCursor)html+='<button type="button" data-topic-section="'+section+'" data-cursor="'+esc(p.nextCursor)+'">更多'+({matters:'相关事项',entries:'记忆',messages:'消息'}[section])+' · 共 '+p.total+'</button>'})
 if(!d.entries.length&&!d.matters.length&&!d.messages.length)html+='<p>还没有记下内容</p>'
 document.getElementById('topic-body').innerHTML=html+'<details><summary>管理话题</summary><label>话题名称<input id="topic-name" maxlength="120" value="'+esc(t.title)+'"></label><button type="button" data-topic-edit="rename">改名</button><label>并到…<select id="topic-target"><option value="">选择话题</option></select></label><button type="button" data-topic-edit="merge">并到…</button><details><summary>删话题</summary><p>删除这个话题和记下的内容？</p><button type="button" data-topic-edit="delete">确认删除</button></details></details>'
 tLoadTargets(t.id)
}
function tClose(){if(typeof cBackLayer==='function'&&!cHandlingPop&&history.state&&history.state.ccLayer&&history.state.ccLayer.kind==='topic'){cBackLayer();return};document.body.classList.remove('topic-open');tSelected=null;tDetail=null;tReadSeq++;document.getElementById('topic-panel').hidden=true;document.getElementById('topic-body').replaceChildren();document.getElementById('chat-input').focus();tList(false,false)}
function tStart(){if(tReady)return;tReady=true;tList(false,false);tWatch()}
async function tWatch(){
 if(tPolling||!isDevice||!tReady)return;
 if(preferTunnel&&REMOTE){if(!tUnsubscribe)tUnsubscribe=tunnel().subscribe('topics',function(data){var b=/** @type {any} */ (data);if(b.revision!==tRevision){tRevision=b.revision;tList(false,false);if(!document.getElementById('topic-all').hidden)tList(true,false);if(tSelected)tRead()}});return}
 tPolling=true
 try{
  var r=await /* link-scan: device-only */ api('/v1/subscribe/topics?wait_ms=0'+(tRevision?'&since='+encodeURIComponent(tRevision):''))
  if(r.status===401){onUnauthorized(T);return}if(r.status!==200)throw Error('unavailable')
  var b=await r.json();if(b.revision!==tRevision){if(!document.getElementById('topic-all').hidden){tAll=[];await tList(true,false)};tRevision=b.revision;await tList(false,false);if(tSelected)await tRead()}
 }catch(e){tNotice('尚未同步')}
 finally{tPolling=false;if(isDevice&&tReady)setTimeout(tWatch,document.hidden?15000:3000)}
}
document.getElementById('topic-row').addEventListener('click',tClick)
document.getElementById('topic-list').addEventListener('click',tClick)
document.getElementById('topic-body').addEventListener('click',tClick)
function tClick(ev){var b=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('button'));if(!b)return;if(b.dataset.topicEdit||b.dataset.topicWrong){tEdit(b.dataset.topicWrong?'wrong':b.dataset.topicEdit,b.dataset.topicWrong);return}if(b.dataset.topic)tOpen(b.dataset.topic);else if(b.hasAttribute('data-topic-more')){if(typeof cPushLayer==='function')cPushLayer({kind:'topic'});document.body.classList.add('topic-open');document.getElementById('topic-panel').hidden=false;document.getElementById('topic-all').hidden=false;document.getElementById('topic-body').replaceChildren();tList(true,false)}else if(b.dataset.mid){openMatter(b.dataset.mid)}else if(b.dataset.topicSection)tRead(b.dataset.topicSection,b.dataset.cursor);else if(b.dataset.message)cLocateMessage(b.dataset.message,b.dataset.at)}
document.getElementById('topic-close').addEventListener('click',tClose)
document.getElementById('topic-retry').addEventListener('click',function(){if(tOpenFailed&&tSelected)tOpen(tSelected);else if(tSelected)tRead();else tList(true,false)})
document.getElementById('topic-query').addEventListener('input',function(){clearTimeout(tSearchTimer);tSearchTimer=setTimeout(function(){tCursor=null;tList(true,false)},250)})
document.getElementById('topic-list-more').addEventListener('click',function(){tList(true,true)})
async function cLocateMessage(id,at){
 if(!isDevice||!cReady)return
 var identity=T,privacy=typeof cPrivacyRevision==='undefined'?0:cPrivacyRevision
 // Fetch the actual source page around the timestamp; never invent a message from an excerpt.
 if(!cMessages.has(id)){
  try{
   var r=await /* link-scan: device-only */ api('/v1/matter/owner-chat/page?limit=40&before='+encodeURIComponent(new Date(Date.parse(at)+1).toISOString()))
   if(identity!==T||!isDevice||!cReady||privacy!==(typeof cPrivacyRevision==='undefined'?0:cPrivacyRevision))return
   if(r.status===401){onUnauthorized(identity);return}var b=await r.json();if(identity!==T||!isDevice||!cReady||privacy!==(typeof cPrivacyRevision==='undefined'?0:cPrivacyRevision))return;if(!b.ok)throw Error('unavailable');(b.messages||[]).forEach(function(m){cMessages.set(m.id,m)})
  }catch(e){cNotice('原消息暂时读不到，请重试。');return}
 }
 if(typeof tClose==='function'&&tSelected)tClose()
 var search=document.getElementById('chat-search');if(search)search.hidden=true;cRender()
 var node=document.getElementById('message-'+id);if(node){node.tabIndex=-1;node.scrollIntoView({block:'center'});node.focus({preventScroll:true})}else cNotice('找不到原消息了，请返回对话。')
}

function tClear(){tOpenFailed=false;tNotice('');if(tUnsubscribe)tUnsubscribe();tUnsubscribe=null;clearTimeout(tSearchTimer);tListSeq.recent++;tListSeq.all++;tReady=false;tSelected=null;tDetail=null;tRecent=[];tAll=[];tRevision=null;tReadSeq++;document.getElementById('topic-row').replaceChildren();document.getElementById('topic-row').hidden=true;document.getElementById('topic-panel').hidden=true;document.getElementById('topic-body').replaceChildren();document.getElementById('topic-list').replaceChildren();document.body.classList.remove('topic-open')}

async function tLoadTargets(id){
 var cursor=null,identity=T
 try{
  do{
   var r=await /* link-scan: device-only */ api('/v1/memory/topics?view=all&limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''))
   if(r.status!==200)throw Error('unavailable');var b=await r.json()
   if(!isDevice||identity!==T||id!==tSelected)return
   var select=document.getElementById('topic-target');if(!select)return
   b.topics.forEach(function(t){if(t.id!==id){var o=document.createElement('option');o.value=t.id;o.textContent=t.title;select.appendChild(o)}})
   cursor=b.nextCursor
  }while(cursor)
 }catch(e){tNotice('暂时读不到，重试')}
}
var tEditing=false
async function tEdit(action,entry){
 if(!isDevice||!tReady||!tSelected||tEditing)return
 var id=tSelected,identity=T,p={id:entry||id},r
 if(action==='rename'){p.title=/** @type {HTMLInputElement} */(document.getElementById('topic-name')).value.trim();if(!p.title){tNotice('请写一个话题名称。');return}}
 if(action==='merge'){p.into=/** @type {HTMLSelectElement} */(document.getElementById('topic-target')).value;if(!p.into)return}
 tEditing=true
 try{
  var opts={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)}
  if(action==='rename')r=await /* link-scan: device-only */ mPostOnce('/v1/memory/topics/rename',{method:'POST',headers:opts.headers,body:opts.body})
  else if(action==='merge')r=await /* link-scan: device-only */ mPostOnce('/v1/memory/topics/merge',{method:'POST',headers:opts.headers,body:opts.body})
  else if(action==='delete')r=await /* link-scan: device-only */ mPostOnce('/v1/memory/topics/delete',{method:'POST',headers:opts.headers,body:opts.body})
  else r=await /* link-scan: device-only */ mPostOnce('/v1/memory/topics/entry/wrong',{method:'POST',headers:opts.headers,body:opts.body})
  if(identity!==T||!isDevice||!tReady)return
  if(r.status===401){onUnauthorized(identity);return}if(r.status!==200)throw Error('unavailable')
  if(id!==tSelected)return
  if(action==='delete'||action==='merge')tClose();else await tRead()
  await tList(false,false);tNotice(action==='wrong'?'记下了，这条不再当作事实。':'已处理。')
 }catch(e){tNotice('结果待核对，请刷新查看。')}
 finally{tEditing=false}
}
