// Private UI never calls a private route under a link identity. No transcript cache on disk.
var cOwnerMatterId=null,cPrivacyRevision=0
var cMessages = new Map(), cBefore = null, cLoading = false, cReady = false, cPending = null, cDraftKey = null, cSending = false
function cNotice(text) { document.getElementById('chat-notice').textContent = text }
function cRender() {
  var root = document.getElementById('chat-messages')
  var rows = Array.from(cMessages.values()).sort(function(a,b){return a.at-b.at||a.id.localeCompare(b.id)})
  var html = rows.map(function(m){return '<article class="chat-message" id="message-'+esc(m.id)+'"><small>'+ (m.role==='me'?'你':'CC')+' · '+esc(new Date(m.at).toLocaleString())+'</small><div>'+esc(m.text)+'</div>'+(typeof cAttachmentHtml==='function'?cAttachmentHtml(m):'')+'</article>'}).join('') || '<p class="empty">跟 CC 说一句吧。</p>'
  if(typeof cReference==='function'){var added=new Set();html=rows.map(function(m){var text='<article class="chat-message" id="message-'+esc(m.id)+'"><small>'+(m.role==='me'?'你':'CC')+' · '+esc(new Date(m.at).toLocaleString())+'</small><div>'+esc(m.text)+'</div>'+(typeof cAttachmentHtml==='function'?cAttachmentHtml(m):'')+'</article>';cReferences.forEach(function(ref){if(ref.originMessageId===m.id){text+=cReference(ref,false);added.add(ref.id)}});return text}).join('');cReferences.forEach(function(ref){if(!added.has(ref.id))html+=cReference(ref,true)});if(!html)html='<p class="empty">跟 CC 说一句吧。</p>'}
  cPatchMessages(root,html)
}
async function cRead(older) {
  if(!isDevice||cLoading)return
  cLoading=true
  var identity=T
  try {
    var r=await /* link-scan: device-only */ api('/v1/matter/owner-chat/page?limit=40'+(older&&cBefore?'&before='+encodeURIComponent(cBefore):'')+(cPending?'&requestId='+encodeURIComponent(cPending.requestId):''))
    if(r.status===401){onUnauthorized(identity);return}
    var b=await r.json()
    if(identity!==T||!isDevice)return
    if(!b.ok){if(cReady&&(r.status===403||b.error==='no_owner_chat'||b.error==='owner_chat_not_configured')){cClearPrivate();document.getElementById('conversation').hidden=false};cNotice(b.error==='no_owner_chat'?'还没设好主人对话，请在电脑上检查。':'对话暂时读不到，请刷新重试。');return}
    if(b.conversation!=='v1'){cNotice('电脑版本暂不支持网页对话，请在 App 或电脑上继续。');return}
    if(b.topics==='v1'&&typeof tStart==='function')tStart()
    if(cOwnerMatterId&&cOwnerMatterId!==b.matterId){cClearPrivate();location.reload();return}
    cOwnerMatterId=b.matterId
    cReady=true;document.body.classList.add('conversation-ready');document.getElementById('conversation').hidden=false
    if(!cDraftKey){cDraftKey='cc.conversation.draft:'+ (REMOTE?REMOTE.id:location.host)+':'+T.slice(-16)+':'+b.matterId;try{/** @type {HTMLTextAreaElement} */ (document.getElementById('chat-input')).value=sessionStorage.getItem(cDraftKey)||'';cPending=JSON.parse(sessionStorage.getItem(cDraftKey+':pending')||'null')}catch(e){}}
    ;(b.messages||[]).forEach(function(m){cMessages.set(m.id,m)})
    if(older||!cBefore)cBefore=b.nextBefore
    if(older||cMessages.size===(b.messages||[]).length)document.getElementById('chat-older').hidden=!b.hasMore
    if(typeof cMatterUpdates==='function')cMatterUpdates();else cRender();if(typeof cRestoreEntry==='function')cRestoreEntry();cNotice(b.pending?'CC 正在回复…':b.failed?'上一句没做成，请核对后再说。':'')
    if(cPending&&b.receipt&&b.receipt.requestId===cPending.requestId){var recovered=/** @type {HTMLTextAreaElement} */ (document.getElementById('chat-input'));if(b.receipt.status!=='failed'&&recovered.value===cPending.text){recovered.value='';try{sessionStorage.removeItem(cDraftKey)}catch(e){}};cNotice(b.receipt.status==='pending'?'这句已收下，结果待核对。':b.receipt.status==='failed'?'这句没做成，请核对后再说。':'CC 已回复。');cPending=null;cSavePending()}
    if(cPending&&(b.pending&&b.pending.requestId===cPending.requestId||b.failed&&b.failed.requestId===cPending.requestId)){var input=/** @type {HTMLTextAreaElement} */ (document.getElementById('chat-input'));if(b.pending&&input.value===cPending.text){input.value='';try{sessionStorage.removeItem(cDraftKey)}catch(e){}};cPending=null;cSavePending()}
  } catch(e){cNotice('尚未同步 · 请检查连接后刷新。')}
  finally{cLoading=false}
}
function cSavePending(){try{if(cDraftKey)sessionStorage.setItem(cDraftKey+':pending',JSON.stringify(cPending))}catch(e){}}
async function cSend(ev) {
  ev.preventDefault();if(!isDevice||!cReady||cSending)return
  var input=/** @type {HTMLTextAreaElement} */ (document.getElementById('chat-input')),text=input.value.trim()
  if(!text)return
  if(!cPending)cPending={requestId:crypto.randomUUID(),text:text}
  if(cPending.text!==text){cNotice('上一句结果待核对，请先刷新；保留了当前输入。');return}
  cSavePending();cSending=true;var identity=T,privacy=cPrivacyRevision,sentDraft=input.value,submission={requestId:cPending.requestId,text:cPending.text};/** @type {HTMLButtonElement} */ (document.getElementById('chat-send')).disabled=true
  try{
    var r=await /* link-scan: device-only */ mPostOnce('/v1/matter/owner-chat/say',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(submission)})
    if(r.status===401){onUnauthorized(identity);return}
    var b=await r.json();if(identity!==T||privacy!==cPrivacyRevision||!isDevice)return
    if(!b.ok){if(['chat_busy','no_owner_chat','invalid','input_conflict'].includes(b.error)){cPending=null;cSavePending()};cNotice(b.error==='chat_busy'?'CC 还在回复，稍后再试。':'没发出去，请刷新核对后重试。');return}
    cPending=null;cSavePending();if(input.value===sentDraft){input.value='';try{sessionStorage.removeItem(cDraftKey)}catch(e){}};await cRead(false)
  }catch(e){cNotice('结果待核对 · 刷新后再试会使用同一回执，不重复发送。')}
  finally{cSending=false;/** @type {HTMLButtonElement} */ (document.getElementById('chat-send')).disabled=false}
}
document.getElementById('chat-form').addEventListener('submit',cSend)
document.getElementById('chat-input').addEventListener('input',function(ev){try{if(cDraftKey)sessionStorage.setItem(cDraftKey,/** @type {HTMLTextAreaElement} */ (ev.target).value)}catch(e){}})
document.getElementById('chat-refresh').addEventListener('click',function(){cRead(false)})
document.getElementById('chat-older').addEventListener('click',function(){cRead(true)})
if(isDevice){document.getElementById('conversation').hidden=false;cRead(false)}
setInterval(function(){if(isDevice&&!document.hidden&&!mCurrent)cRead(false)},3000)

function cClearPrivate(){cOwnerMatterId=null;cBefore=null;document.getElementById('chat-waiting').hidden=true;if(typeof history!=='undefined')history.replaceState(null,'');['chat-query','chat-project','topic-query'].forEach(function(id){var field=/** @type {HTMLInputElement} */ (document.getElementById(id));if(field)field.value=''});document.body.classList.remove('matter-open');cPrivacyRevision++;if(typeof cSearchRows!=='undefined'){cSearchRows=[];cSearchSeq++};if(typeof cResponseUnknown!=='undefined')cResponseUnknown.clear();if(typeof homeSeq!=='undefined'){homeSeq++;homeState=null;presenceAt=null;try{localStorage.removeItem(HOME_KEY)}catch(e){};document.getElementById('home-focus').replaceChildren();document.getElementById('pres-txt').textContent='尚未同步';setPresenceLit(false);if(typeof cConnectionText==='function')cConnectionText()};isDevice=false;if(typeof cWaitingRows!=='undefined')cWaitingRows=null;if(typeof cMatterSeen!=='undefined')cMatterSeen.clear();if(typeof cExpanded!=='undefined')cExpanded.clear();if(typeof cResetResponse==='function')cResetResponse();if(typeof mSeq!=='undefined'){mSeq++;mConnectionEpoch++;mMatters=null;document.getElementById('m-list').replaceChildren();document.getElementById('m-all').hidden=true;mCurrent=null;mDetail=null;clearTimeout(mPoll);document.getElementById('m-status').replaceChildren();document.getElementById('m-notice').textContent='';document.getElementById('m-title').textContent='';document.getElementById('m-agents').replaceChildren();document.getElementById('m-detail').hidden=true;document.getElementById('m-home').hidden=false;}if(typeof tClear==='function')tClear();if(typeof cReferences!=='undefined')cReferences.clear();cMessages.clear();cReady=false;cPending=null;try{if(cDraftKey){sessionStorage.removeItem(cDraftKey);sessionStorage.removeItem(cDraftKey+':pending')}}catch(e){};cDraftKey=null;document.getElementById('chat-messages').replaceChildren();var search=document.getElementById('chat-search');if(search){search.hidden=true;document.getElementById('chat-search-results').replaceChildren()};/** @type {HTMLTextAreaElement} */ (document.getElementById('chat-input')).value='';document.getElementById('conversation').hidden=true;document.body.classList.remove('conversation-ready')}

/** @param {HTMLElement} root @param {string} html */
function cPatchMessages(root,html){
 var visible=!mCurrent,nearBottom=document.documentElement.scrollHeight-window.scrollY-window.innerHeight<80
 var anchor=visible?Array.from(root.children).find(function(el){return el.id&&el.getBoundingClientRect().bottom>80}):null,anchorId=anchor&&anchor.id,anchorTop=anchor&&anchor.getBoundingClientRect().top
 var focus=document.activeElement,focusRef=focus&&root.contains(focus)?focus.closest('[data-reference]'):null,focusId=focusRef&&focusRef.id,focusButton=focus&&focus.tagName==='BUTTON'
 var template=document.createElement('template');template.innerHTML=html
 var desired=Array.from(template.content.children),keep=new Set(),cursor=root.firstElementChild
 desired.forEach(function(next){
  var old=next.id?document.getElementById(next.id):null;if(old&&old.parentElement!==root)old=null
  var node=old||next
  if(old&&old.outerHTML!==next.outerHTML){old.replaceWith(next);node=next;if(cursor===old)cursor=next}
  if(node!==cursor)root.insertBefore(node,cursor)
  keep.add(node);cursor=node.nextElementSibling
 })
 Array.from(root.children).forEach(function(el){if(!keep.has(el))el.remove()})
 if(focusId&&focus&&!focus.isConnected){var ref=document.getElementById(focusId),target=/** @type {HTMLElement} */ (ref&&ref.querySelector(focusButton?'button':'summary'));if(target)target.focus({preventScroll:true})}
 if(visible){var nextAnchor=anchorId&&document.getElementById(anchorId);if(nearBottom)window.scrollTo(0,document.documentElement.scrollHeight);else if(nextAnchor)window.scrollBy(0,nextAnchor.getBoundingClientRect().top-anchorTop)}
}
