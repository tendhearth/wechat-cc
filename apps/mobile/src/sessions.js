// Computer-native sessions are read-only until one explicit continuation confirmation.
var ss = { active:false, provider:'claude', query:'', key:null, row:null, window:'recent', rows:[], cursor:null, messages:[], readCursor:null,
  listFresh:false, rowFresh:false, previewFresh:false, preview:null, confirm:null, generation:0, listSeq:0, readSeq:0, previewSeq:0,
  listLoading:false, readLoading:false, previewLoading:false, recentUnavailable:false, listAt:null, readAt:null, notice:'', busy:{}, lists:new Map(), pages:new Map() }
var SS_CONTINUE_STATES=['ready','managed','busy_session','busy_folder','provider_missing','folder_missing','quota','empty']
function ssElement(id){return document.getElementById('sessions-'+id)}
function ssOnline(){return navigator.onLine!==false}
function ssClock(at){return at==null?'时间未报告':new Date(at).toLocaleString()}
function ssProvider(provider){return provider==='claude'?'Claude':'Codex'}
function ssValidRow(row,provider){return row&&typeof row.key==='string'&&!!row.key&&row.provider===provider&&typeof row.title==='string'&&(row.project===null||typeof row.project==='string')&&(row.updatedAt===null||typeof row.updatedAt==='number'&&Number.isFinite(row.updatedAt))&&typeof row.active==='boolean'}
function ssProject(project){return typeof project==='string'?project.split(/[\\/]/).filter(Boolean).pop()||'项目名称未报告':'项目名称未报告'}
function ssStatus(row,fresh){return (fresh?'':'上次看到：')+(row.active?'原工具报告正在执行':'原工具未报告正在执行')}
function ssListKey(){return JSON.stringify([ss.provider,ss.query])}
function ssPageKey(){return JSON.stringify([ss.key,ss.window])}
function ssRemember(cache,key,value){cache.delete(key);cache.set(key,value);if(cache.size>20)cache.delete(cache.keys().next().value)}
function ssRequest(path,opts){
  var timer
  var request=api(path,opts).then(function(response){return response.json().then(function(body){
    if(body&&body.ok&&response.status<400)return body
    throw Object.assign(new Error(body&&body.error||'unavailable'),{status:response.status})
  })})
  return Promise.race([request,new Promise(function(_resolve,reject){timer=setTimeout(function(){reject(new Error('timeout'))},15000)})]).finally(function(){clearTimeout(timer)})
}
function ssCurrent(generation,key){return ss.active&&ss.generation===generation&&ss.key===key}
function ssFailure(error){
  if(error.message==='unsupported'||error.message==='sessions_not_wired')return '这台电脑暂时不能读取这些会话。请确认电脑上的 CC 已更新。'
  if(error.message==='invalid')return '这次读取没有被接受，请刷新列表后重试。'
  return '暂时联系不上电脑上的 CC，请检查连接后重试。'
}
function ssPaintList(message){
  ssElement('list-notice').textContent=message||''
  ssElement('list').innerHTML=ss.rows.map(function(row){
    return '<button type="button" class="sessions-row" data-session-key="'+esc(row.key)+'"><strong>'+esc(CCM.markdownPlainText(row.title||'未命名会话'))+'</strong><small>'+esc(ssProject(row.project))+' · '+esc(ssClock(row.updatedAt))+'</small><span class="sessions-status'+(ss.listFresh&&row.active?' is-current':'')+'"><span class="sessions-dot" aria-hidden="true"></span>'+esc(ssStatus(row,ss.listFresh))+'</span></button>'
  }).join('')||(!ss.listLoading?'<p class="sessions-meta">'+(ss.listFresh?'没有找到会话，可以换个名称或执行者再找。':'暂时没有可显示的会话。')+'</p>':'')
  var more=/** @type {HTMLButtonElement} */(ssElement('more'));more.hidden=!ss.cursor;more.disabled=ss.listLoading||!ssOnline()
  var refresh=/** @type {HTMLButtonElement} */(ssElement('refresh'));refresh.disabled=ss.listLoading
}
function ssLoadList(more){
  if(!ss.active||ss.key||more&&ss.listLoading)return Promise.resolve()
  var generation=ss.generation,seq=++ss.listSeq,provider=ss.provider,query=ss.query,cursor=more?ss.cursor:null,cache=ss.lists.get(ssListKey())
  if(!more&&cache){ss.rows=cache.rows;ss.cursor=cache.cursor;ss.listAt=cache.at}
  ss.listFresh=false;ss.listLoading=true
  ssPaintList(ss.rows.length?'正在刷新；上次看到 '+ssClock(ss.listAt)+'。':'正在读取电脑上的会话…')
  if(!ssOnline()){ss.listLoading=false;ssPaintList('手机已离线。'+(ss.rows.length?'上次看到 '+ssClock(ss.listAt)+'，状态可能已变化。':'连接恢复后可以重新读取。'));return Promise.resolve()}
  var path='/m/api/sessions?provider='+provider+'&q='+encodeURIComponent(query)+(cursor?'&cursor='+encodeURIComponent(cursor):'')
  return ssRequest(path).then(function(result){
    if(!ssCurrent(generation,null)||seq!==ss.listSeq||provider!==ss.provider||query!==ss.query)return
    if(!Array.isArray(result.items)||result.items.some(function(row){return !ssValidRow(row,provider)}))throw new Error('invalid_response')
    var seen=new Set(),rows=(more?ss.rows:[]).concat(result.items).filter(function(row){if(seen.has(row.key))return false;seen.add(row.key);return true})
    ss.rows=rows;ss.cursor=typeof result.nextCursor==='string'&&result.nextCursor!==cursor?result.nextCursor:null;ss.listFresh=true;ss.listAt=Date.now()
    ssRemember(ss.lists,ssListKey(),{rows:rows,cursor:ss.cursor,at:ss.listAt});ssPaintList('')
  }).catch(function(error){if(ssCurrent(generation,null)&&seq===ss.listSeq)ssPaintList(ssFailure(error)+(ss.rows.length?' 上次看到 '+ssClock(ss.listAt)+'，状态可能已变化。':''))})
    .finally(function(){if(ssCurrent(generation,null)&&seq===ss.listSeq){ss.listLoading=false;/** @type {HTMLButtonElement} */(ssElement('refresh')).disabled=false;/** @type {HTMLButtonElement} */(ssElement('more')).disabled=!ssOnline()}})
}
function ssPaintMeta(){
  if(!ss.row)return
  ssElement('title').textContent=CCM.markdownPlainText(ss.row.title||'未命名会话')
  ssElement('meta').innerHTML='<span>'+esc(ssProvider(ss.row.provider))+' · '+esc(ssProject(ss.row.project))+'</span><span class="sessions-status'+(ss.rowFresh&&ss.row.active?' is-current':'')+'"><span class="sessions-dot" aria-hidden="true"></span>'+esc(ssStatus(ss.row,ss.rowFresh))+'</span>'
}
function ssPaintMessages(){
  var root=ssElement('messages'),expanded=new Set(Array.from(root.querySelectorAll('details[open]')).map(function(node){return node.id}))
  root.innerHTML=ss.messages.map(function(message){
    var formatted=CCM.hasMarkdownFormatting(message.text),sourceId='ss-source-'+Array.from(JSON.stringify([ss.key,message.id])).map(function(c){return c.codePointAt(0).toString(16)}).join('-')
    var body=message.role==='assistant'||formatted?'<div class="m-markdown">'+CCM.renderMarkdown(message.text)+'</div>':'<div class="sessions-plain">'+esc(message.text).replace(/\r/g,'&#13;')+'</div>'
    if(message.role==='user'&&formatted)body+='<details id="'+sourceId+'" class="m-message-source"'+(expanded.has(sourceId)?' open':'')+'><summary>查看原文</summary><pre><code>'+esc(message.text).replace(/\r/g,'&#13;')+'</code></pre></details>'
    return '<article class="sessions-message"><p class="sessions-author">'+(message.role==='user'?'你':ssProvider(ss.row.provider))+'</p>'+body+(message.truncated?'<p class="sessions-truncated">这段记录已截短；完整内容仍保留在原工具中。</p>':'')+'</article>'
  }).join('')
  ssElement('source').textContent=ss.messages.length?(ss.window==='recent'?'最近 '+ss.messages.length+' 段可读记录。':'已从头读取 '+ss.messages.length+' 段记录。')+' 原工具的记录可能不完整；这里只显示已读取的文字。':''
  ssElement('recent').setAttribute('aria-pressed',String(ss.window==='recent'));ssElement('start').setAttribute('aria-pressed',String(ss.window==='start'))
  var more=/** @type {HTMLButtonElement} */(ssElement('read-more'));more.hidden=ss.window!=='start'||!ss.readCursor;more.disabled=ss.readLoading||!ssOnline()
}
function ssLoadRead(more){
  if(!ss.active||!ss.key||more&&(ss.readLoading||ss.window!=='start'))return Promise.resolve()
  var generation=ss.generation,seq=++ss.readSeq,key=ss.key,windowName=ss.window,cursor=more?ss.readCursor:null
  ss.readLoading=true;ss.rowFresh=false;ssPaintMeta();/** @type {HTMLButtonElement} */(ssElement('read-refresh')).disabled=true
  ssElement('read-notice').textContent=ss.messages.length?'正在刷新记录；上次读取 '+ssClock(ss.readAt)+'。':'正在读取记录…'
  if(!ssOnline()){ss.readLoading=false;ssElement('read-notice').textContent='手机已离线。'+(ss.messages.length?'上次读取 '+ssClock(ss.readAt)+'，这些记录仍可查看。':'连接恢复后可以重新读取。');/** @type {HTMLButtonElement} */(ssElement('read-refresh')).disabled=false;return Promise.resolve()}
  var path='/m/api/session?key='+encodeURIComponent(key)+'&window='+windowName+(cursor?'&cursor='+encodeURIComponent(cursor):'')
  return ssRequest(path).then(function(result){
    if(!ssCurrent(generation,key)||seq!==ss.readSeq||ss.window!==windowName)return
    if(windowName==='recent'&&result.window!=='recent'){
      ss.recentUnavailable=true;ss.messages=[];ss.readCursor=null;ssPaintMessages();ssElement('read-notice').textContent='这台电脑暂不支持最近记录。可以点「从头查看」读取原记录。';return
    }
    if(!ssValidRow(result.session,ss.row.provider)||result.session.key!==key||!Array.isArray(result.messages)||result.messages.some(function(m){return !['user','assistant'].includes(m.role)||typeof m.text!=='string'||typeof m.id!=='string'||typeof m.truncated!=='boolean'})||windowName==='start'&&result.window&&result.window!=='start')throw new Error('invalid_response')
    var seen=new Set(),messages=(more?ss.messages:[]).concat(result.messages).filter(function(message){if(seen.has(message.id))return false;seen.add(message.id);return true})
    ss.row=result.session;ss.rowFresh=true;ss.messages=messages;ss.readCursor=windowName==='start'&&typeof result.nextCursor==='string'&&result.nextCursor!==cursor?result.nextCursor:null;ss.readAt=Date.now();ss.recentUnavailable=false
    ssRemember(ss.pages,ssPageKey(),{row:ss.row,messages:messages,cursor:ss.readCursor,at:ss.readAt});ssPaintMeta();ssPaintMessages();ssElement('read-notice').textContent=messages.length?'':'这里暂时没有可读的文字记录。'
  }).catch(function(error){if(ssCurrent(generation,key)&&seq===ss.readSeq){if(windowName==='recent'&&['invalid','unsupported'].includes(error.message)){ss.recentUnavailable=true;ssElement('read-notice').textContent='这台电脑暂时不能读取最近记录。可以点「从头查看」试试。'}else ssElement('read-notice').textContent=ssFailure(error)+(ss.messages.length?' 上次读取 '+ssClock(ss.readAt)+'，这些记录仍可查看。':'')}})
    .finally(function(){if(ssCurrent(generation,key)&&seq===ss.readSeq){ss.readLoading=false;/** @type {HTMLButtonElement} */(ssElement('read-refresh')).disabled=false;/** @type {HTMLButtonElement} */(ssElement('read-more')).disabled=!ssOnline()}})
}
function ssPreviewMessage(preview){
  var messages={ready:'可以接着做。接入本身不会启动任务。',managed:'这个会话已经加入「一起做」，可以打开原来的事。',busy_session:'原工具报告正在执行。请先在电脑停止，再重新检查；这里不会接管正在执行的这一轮。',busy_folder:'同一项目还有任务占用。请先在电脑结束它，再重新检查。',provider_missing:'电脑上的执行者暂不可用。请先在电脑连接它，再重新检查。',folder_missing:'原项目文件夹暂不可用，请先在电脑确认工作位置。',quota:'这位执行者的额度暂不可用，恢复后可以重新检查。',empty:'原会话没有可接续的文字记录，可以回「一起做」另交办一件事。'}
  return messages[preview.state]||'暂时无法确认能否接着做。'
}
function ssPaintContinue(){
  var actions=ssElement('continue-actions'),busy=!!ss.busy[ss.key],available=ss.previewFresh&&ssOnline()&&!ss.previewLoading&&!busy
  ssElement('continue-notice').textContent=ss.notice||(ss.previewLoading?'正在检查能否接着做…':ss.preview?(ss.previewFresh?'':'上次看到：')+ssPreviewMessage(ss.preview):'暂时无法确认能否接着做，请重新检查。')
  actions.replaceChildren()
  if(ss.confirm&&available&&ss.confirm.preview===ss.preview){
    actions.innerHTML='<div class="sessions-confirm"><h4>接着做这个会话</h4><p>请先确认电脑上的原工具已经停止执行。</p><p>'+(ss.preview.mode==='native_resume'?'会沿用原会话上下文。':'会带原会话的可用文字新开一轮，可能无法保留全部上下文。')+'</p><p>接入后先打开这件事。发送第一句才会开始，并使用 '+ssProvider(ss.preview.provider)+' 的额度或费用。</p><div class="sessions-confirm-actions"><button type="button" class="sessions-primary" data-ss-action="confirm">原工具已停，接着做</button><button type="button" class="sessions-text-action" data-ss-action="cancel">取消</button></div></div>'
  }else if(available&&ss.preview.state==='ready'&&['native_resume','fresh_context'].includes(ss.preview.mode))actions.innerHTML='<button type="button" class="sessions-primary" data-ss-action="continue">接着做</button>'
  else if(available&&ss.preview.state==='managed'&&typeof ss.preview.matterId==='string'&&ss.preview.matterId)actions.innerHTML='<button type="button" class="sessions-primary" data-ss-action="managed">打开这件事</button>'
  var check=/** @type {HTMLButtonElement} */(ssElement('check'));check.disabled=ss.previewLoading||busy||!ssOnline()
}
function ssCheck(){
  if(!ss.active||!ss.key||ss.busy[ss.key])return Promise.resolve()
  var generation=ss.generation,seq=++ss.previewSeq,key=ss.key
  ss.previewFresh=false;ss.confirm=null;ss.previewLoading=true;ss.rowFresh=false;ss.notice='';ssPaintMeta();ssPaintContinue()
  if(!ssOnline()){ss.previewLoading=false;ss.notice='手机已离线，暂时不能确认原工具是否停止。'+(ss.preview?' 上次看到：'+ssPreviewMessage(ss.preview):'');ssPaintContinue();return Promise.resolve()}
  return ssRequest('/m/api/session/continue?key='+encodeURIComponent(key)).then(function(preview){
    if(!ssCurrent(generation,key)||seq!==ss.previewSeq)return
    if(!SS_CONTINUE_STATES.includes(preview.state)||preview.provider!==ss.row.provider||preview.state==='ready'&&!['native_resume','fresh_context'].includes(preview.mode)||preview.state==='managed'&&!(typeof preview.matterId==='string'&&preview.matterId))throw new Error('invalid_response')
    ss.preview=preview;ss.previewFresh=true
  }).catch(function(error){if(ssCurrent(generation,key)&&seq===ss.previewSeq){ss.rowFresh=false;ssPaintMeta();ss.notice=ssFailure(error)+' 暂时无法确认能否接着做。'+(ss.preview?' 上次看到：'+ssPreviewMessage(ss.preview):'')}})
    .finally(function(){if(ssCurrent(generation,key)&&seq===ss.previewSeq){ss.previewLoading=false;ssPaintContinue()}})
}
function ssOpenMatter(id){ss.confirm=null;ccMobilePane('matters');return openMatter(id)}
function ssAdopt(){
  var confirmation=ss.confirm,key=ss.key,generation=ss.generation
  if(!confirmation||confirmation.key!==key||confirmation.preview!==ss.preview||confirmation.generation!==generation||!ss.previewFresh||ss.preview.state!=='ready'||!ssOnline()||ss.busy[key])return Promise.resolve()
  ss.busy[key]=true;ss.confirm=null;ss.notice='正在接入，请稍候…';ssPaintContinue()
  return ssRequest('/m/api/session/continue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:key})}).then(function(result){
    if(typeof result.matterId!=='string'||!result.matterId||typeof result.created!=='boolean')throw new Error('invalid_response')
    if(ssCurrent(generation,key)&&!document.hidden)return ssOpenMatter(result.matterId)
  }).catch(function(error){
    if(!ssCurrent(generation,key))return
    var known={native_session_busy:'原工具报告正在执行，未能接着做。请先在电脑停止后重新检查。',native_folder_busy:'同一项目还有任务占用，未能接着做。请先在电脑结束它。',native_history_changed:'原会话记录变了，请重新检查后再确认。',native_history_empty:'原会话没有可接续的文字记录。',invalid_path:'原项目文件夹暂不可用，请先在电脑确认。',unavailable_provider:'电脑上的执行者暂不可用，请先连接它。',provider_quota_exhausted:'这位执行者的额度暂不可用，恢复后可以重新检查。',unsupported:'这台电脑暂不支持继续这个会话。',invalid:'这次接入请求没有被接受，请刷新列表后重试。'}
    ss.previewFresh=false;ss.notice=known[error.message]||'暂时无法确认接入是否完成。可以重新检查；若已加入「一起做」，会显示打开入口。不会自动重试。'
  }).finally(function(){delete ss.busy[key];if(ss.active&&ss.key===key){ssPaintContinue();if(generation!==ss.generation)ssCheck()}})
}
function ssChangeWindow(name){
  ss.window=name;ss.readSeq++;ss.readLoading=false;ss.messages=[];ss.readCursor=null;ss.recentUnavailable=false;ss.rowFresh=false
  var cache=ss.pages.get(ssPageKey());if(cache){ss.row=cache.row;ss.messages=cache.messages;ss.readCursor=cache.cursor;ss.readAt=cache.at}
  ssPaintMeta();ssPaintMessages();return ssLoadRead(false)
}
function ssOpenSession(key){
  var row=ss.rows.find(function(item){return item.key===key});if(!row)return Promise.resolve()
  ss.generation++;ss.listSeq++;ss.key=key;ss.row=row;ss.rowFresh=false;ss.preview=null;ss.previewFresh=false;ss.previewLoading=false;ss.confirm=null;ss.notice=''
  ssElement('list-view').hidden=true;ssElement('detail').hidden=false
  return Promise.all([ssChangeWindow('recent'),ssCheck()])
}
function ssBackToList(){
  ss.generation++;ss.readSeq++;ss.previewSeq++;ss.key=null;ss.confirm=null;ss.previewFresh=false;ssElement('detail').hidden=true;ssElement('list-view').hidden=false
  return ssLoadList(false)
}
function openPhoneSessions(){
  ss.generation++;ss.key=null;ss.confirm=null;ss.previewFresh=false;ss.active=true;ccMobilePane('sessions');ssElement('detail').hidden=true;ssElement('list-view').hidden=false
  return ssLoadList(false)
}
ssElement('open').addEventListener('click',openPhoneSessions)
ssElement('back').addEventListener('click',function(){ccMobilePane('matters')})
ssElement('list-back').addEventListener('click',ssBackToList)
ssElement('search-form').addEventListener('submit',function(event){
  event.preventDefault();var query=/** @type {HTMLInputElement} */(ssElement('query')).value.trim()
  if(query.length>200){ssElement('list-notice').textContent='搜索最多 200 个字，原输入仍保留。';return}
  ss.generation++;ss.query=query;ss.rows=[];ss.cursor=null;ssLoadList(false)
})
ssElement('provider').addEventListener('change',function(){ss.generation++;ss.provider=/** @type {HTMLSelectElement} */(ssElement('provider')).value;ss.rows=[];ss.cursor=null;ssLoadList(false)})
ssElement('refresh').addEventListener('click',function(){ssLoadList(false)})
ssElement('more').addEventListener('click',function(){ssLoadList(true)})
ssElement('list').addEventListener('click',function(event){var row=/** @type {Element} */(event.target).closest('[data-session-key]');if(row)ssOpenSession(/** @type {HTMLElement} */(row).dataset.sessionKey)})
ssElement('recent').addEventListener('click',function(){ssChangeWindow('recent')})
ssElement('start').addEventListener('click',function(){ssChangeWindow('start')})
ssElement('read-more').addEventListener('click',function(){ssLoadRead(true)})
ssElement('read-refresh').addEventListener('click',function(){ssLoadRead(false)})
ssElement('check').addEventListener('click',ssCheck)
ssElement('continue-actions').addEventListener('click',function(event){
  var button=/** @type {Element} */(event.target).closest('[data-ss-action]');if(!button)return
  var action=/** @type {HTMLElement} */(button).dataset.ssAction
  if(action==='continue'&&ss.previewFresh&&ss.preview&&ss.preview.state==='ready'){ss.confirm={key:ss.key,preview:ss.preview,generation:ss.generation};ssPaintContinue()}
  if(action==='cancel'){ss.confirm=null;ssPaintContinue()}
  if(action==='confirm')ssAdopt()
  if(action==='managed'&&ss.previewFresh&&ss.preview&&ss.preview.state==='managed')ssOpenMatter(ss.preview.matterId)
})
document.addEventListener('cc:pane',function(event){
  ss.active=/** @type {CustomEvent} */(event).detail.pane==='sessions'
  if(!ss.active){ss.generation++;ss.listSeq++;ss.readSeq++;ss.previewSeq++;ss.confirm=null;ss.previewFresh=false;ss.listLoading=false;ss.readLoading=false;ss.previewLoading=false}
})
function ssRefreshVisible(){if(!ss.active||document.hidden)return;if(ss.key)ssCheck();else ssLoadList(false)}
document.addEventListener('visibilitychange',function(){ss.previewSeq++;ss.previewFresh=false;ss.previewLoading=false;ss.confirm=null;if(ss.active&&ss.key)ssPaintContinue();ssRefreshVisible()})
window.addEventListener('online',ssRefreshVisible)
window.addEventListener('offline',function(){
  ss.generation++;ss.listSeq++;ss.readSeq++;ss.previewSeq++;ss.confirm=null;ss.listFresh=false;ss.rowFresh=false;ss.previewFresh=false;ss.listLoading=false;ss.readLoading=false;ss.previewLoading=false
  if(!ss.active)return
  if(ss.key){ss.notice='手机已离线，暂时不能确认原工具是否停止。'+(ss.preview?' 上次看到：'+ssPreviewMessage(ss.preview):'');ssPaintMeta();ssPaintContinue();ssElement('read-notice').textContent='手机已离线。'+(ss.messages.length?'上次读取 '+ssClock(ss.readAt)+'，这些记录仍可查看。':'连接恢复后可以重新读取。');/** @type {HTMLButtonElement} */(ssElement('read-refresh')).disabled=false}
  else ssPaintList('手机已离线。'+(ss.rows.length?'上次看到 '+ssClock(ss.listAt)+'，状态可能已变化。':'连接恢复后可以重新读取。'))
})
