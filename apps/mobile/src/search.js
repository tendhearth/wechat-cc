var cSearchSeq=0,cSearchCursor=null,cSearchRows=[]
function cSearchOpen(){if(typeof cPushLayer==='function')cPushLayer({kind:'search'});cSearchCursor=null;document.getElementById('chat-search').hidden=false;document.getElementById('chat-query').focus();cSearch()}
async function cSearch(){
 if(!isDevice||!cReady)return
 var seq=++cSearchSeq,q=/** @type {HTMLInputElement} */ (document.getElementById('chat-query')).value.trim()
 var status=/** @type {HTMLSelectElement} */ (document.getElementById('chat-filter')).value
 document.getElementById('chat-search-results').textContent='正在读…'
 try{
    var project=/** @type {HTMLInputElement} */ (document.getElementById('chat-project')).value.trim()
  var kind=/** @type {HTMLSelectElement} */ (document.getElementById('chat-kind')).value
  var r=await /* link-scan: device-only */ api('/v1/matters?search=1&taskState=1&limit=30&kind='+kind+'&q='+encodeURIComponent(q)+'&project='+encodeURIComponent(project)+(status?'&state='+status:'')+(cSearchCursor?'&cursor='+encodeURIComponent(cSearchCursor):''))
  if(r.status===401){onUnauthorized(T);return}if(r.status!==200)throw Error('unavailable');var b=await r.json()
  var hits=[]
  if(q){var messages=await /* link-scan: device-only */ api('/v1/matter/owner-chat/search?q='+encodeURIComponent(q)+'&limit=30');if(messages.status===401){onUnauthorized(T);return}if(messages.status===200){var mb=await messages.json();hits=mb.hits||[]}}
  if(seq!==cSearchSeq||!isDevice)return
  cSearchRows=cSearchCursor?cSearchRows.concat(b.matters):b.matters;cSearchCursor=b.nextCursor
  cSearchRows.forEach(function(m){if(!(mMatters||[]).some(function(row){return row.id===m.id})){if(!mMatters)mMatters=[];mMatters.push(m)}})
  document.getElementById('chat-search-results').innerHTML=(hits.length?'<h3>对话</h3>'+hits.map(function(m){return '<button type="button" data-message="'+esc(m.id)+'" data-at="'+esc(new Date(m.createdAt).toISOString())+'">'+esc(m.text)+'</button>'}).join(''):'')+(cSearchRows.length?'<h3>以前交办的事</h3>'+cSearchRows.map(function(m){return '<button type="button" data-mid="'+esc(m.id)+'">'+esc(ccPlain(m.title))+' · '+esc(m.projectPath||'')+' · '+esc(mStatusKey(m)==='waiting'?'等你决定':CCP.STATUS_WORDS[mStatusKey(m)]||m.state||m.status)+' · '+esc(new Date(m.createdAt).toLocaleString())+'</button>'}).join(''):'')||'<p>没有找到；可以换种说法，或在更多话题里找。</p>'
  document.getElementById('chat-search-more').hidden=!cSearchCursor

 }catch(e){if(seq===cSearchSeq)document.getElementById('chat-search-results').textContent='尚未同步 · 暂时读不到，请重试。'}
}
document.getElementById('chat-search-open').addEventListener('click',cSearchOpen)
document.getElementById('chat-search-close').addEventListener('click',function(){if(typeof cBackLayer==='function'){cBackLayer();return};document.getElementById('chat-search').hidden=true;document.getElementById('chat-search-open').focus()})
document.getElementById('chat-search-form').addEventListener('submit',function(ev){ev.preventDefault();cSearchCursor=null;cSearch()})
document.getElementById('chat-search-results').addEventListener('click',function(ev){var b=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('button'));if(!b)return;if(b.dataset.mid){document.getElementById('chat-search').hidden=true;cRevealMatter(b.dataset.mid);openMatter(b.dataset.mid)}else if(b.dataset.message)cLocateMessage(b.dataset.message,b.dataset.at)})

document.getElementById('chat-search-more').addEventListener('click',cSearch)
