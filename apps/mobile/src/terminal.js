// 终端里的会话(2026-10-14):主人在 CC 外面开的 Claude Code / Codex,和 CC 自己的事并排放在「一起做」。
// 等你批准且电脑在微信里开了码 ⇒ 这里能允许 / 拒绝(同微信「y/n 码」);歇着的能接着说一句(同微信「@码」),
// 结果会成为它的「最后一句」。没有推送主题:看得见时每 15 秒拉一次。
var tm = { active:false, rows:[], open:null, busy:{}, note:{}, timer:0, seq:0 }
var TM_STATUS = { waiting:'等你批准', running:'在跑', idle:'歇着', ended:'结束了' }
var TM_POLL_MS = 15000
var TM_SAY_MAX = 4000
function tmEl(id){return document.getElementById('terminal-'+id)}
function tmSource(s){return s==='codex'?'Codex':s==='cursor'?'Cursor':'Claude Code'}
function tmAgo(at){var d=Math.max(0,Date.now()-at);if(d<60000)return '刚刚';if(d<3600000)return Math.floor(d/60000)+' 分钟前';if(d<86400000)return Math.floor(d/3600000)+' 小时前';return new Date(at).toLocaleString()}
function tmActionable(r){return r.status==='waiting'&&!!r.pending&&r.pending.actionable===true&&typeof r.pending.hash==='string'}
function tmValid(r){return r&&typeof r.session_id==='string'&&typeof r.project==='string'&&['claude','codex','cursor'].indexOf(r.source)>=0&&!!TM_STATUS[r.status]&&typeof r.last_event_at==='number'}
function tmError(code){
  var m={cli_permission_stale:'这一项已经处理过或过期了。',cli_not_actionable:'正在终端里问，回电脑上答。',cli_session_busy:'它还在跑，这一轮做完再说下一句。',cli_session_ended:'这个会话已经结束了。',cli_session_remote:'这个会话在另一台电脑上，暂时请在微信里回它。',not_found:'电脑上的列表里已经没有这个会话了。',invalid:'这句话没有被接受（空的或太长）。',timeout:'不确定送到没有，稍后再看一眼。'}
  return m[code]||'没送到电脑上，请稍后再试。'
}
function tmRequest(path,opts){
  var timer
  var request=api(path,opts).then(function(response){return response.json().then(function(body){
    if(body&&body.ok&&response.status<400)return body
    throw Object.assign(new Error(body&&body.error||'unavailable'),{status:response.status})
  })})
  return Promise.race([request,new Promise(function(_resolve,reject){timer=setTimeout(function(){reject(new Error('timeout'))},15000)})]).finally(function(){clearTimeout(timer)})
}
function tmPaint(){
  var root=tmEl('root'),list=tmEl('list')
  root.hidden=tm.rows.length===0
  list.innerHTML=tm.rows.map(function(r){
    var id=esc(r.session_id),open=tm.open===r.session_id,busy=!!tm.busy[r.session_id],note=tm.note[r.session_id]||''
    var pending=r.status==='waiting'&&r.pending?(r.pending.summary?r.pending.tool+': '+r.pending.summary:r.pending.tool):''
    var h='<div class="terminal-row" data-tm-row="'+id+'">'
      +'<button type="button" class="terminal-head" data-tm-open="'+id+'" aria-expanded="'+open+'"><strong>'+esc(r.project)+'</strong>'
      +'<small><span class="terminal-dot is-'+esc(r.status)+'" aria-hidden="true"></span>'+esc(TM_STATUS[r.status])+' · '+esc(tmSource(r.source))+' · '+esc(r.stale?'有一阵没动静了':tmAgo(r.last_event_at))+'</small>'
      +(pending?'<span class="terminal-pending">'+esc(pending)+'</span>':r.last_summary&&!open?'<span class="terminal-summary">'+esc(r.last_summary)+'</span>':'')+'</button>'
    if(tmActionable(r))h+='<div class="terminal-actions"><button type="button" class="sessions-primary" data-tm-decide="allow" data-tm-id="'+id+'"'+(busy?' disabled':'')+'>允许</button><button type="button" class="sessions-text-action" data-tm-decide="deny" data-tm-id="'+id+'"'+(busy?' disabled':'')+'>拒绝</button></div>'
    else if(r.status==='waiting')h+='<p class="terminal-note">正在终端里问，回电脑上答。</p>'
    if(open){
      var canSay=r.status==='idle'
      h+='<div class="terminal-detail"><p class="terminal-label">最后一句</p><p class="terminal-last">'+esc(r.last_summary||'还没有回复')+'</p>'
        +(canSay?'':'<p class="terminal-note">它还在跑，这一轮做完再说下一句。</p>')
        +'<textarea id="terminal-say-'+id+'" rows="2" maxlength="'+TM_SAY_MAX+'" placeholder="接下来让它做什么…"'+(canSay?'':' disabled')+'></textarea>'
        +'<button type="button" class="sessions-primary" data-tm-say="'+id+'"'+(canSay&&!busy?'':' disabled')+'>发送</button></div>'
    }
    return h+(note?'<p class="terminal-note" role="status">'+esc(note)+'</p>':'')+'</div>'
  }).join('')
}
function tmLoad(){
  if(!tm.active||document.hidden)return Promise.resolve()
  var seq=++tm.seq
  return tmRequest('/m/api/cli/sessions').then(function(body){
    if(seq!==tm.seq||!Array.isArray(body.sessions))return
    // 结束了的不占位置;等你批准的在前(daemon 已排好)。正在写的那条不重画(输入框会丢字)。
    var rows=body.sessions.filter(function(r){return tmValid(r)&&r.status!=='ended'})
    var typing=tm.open&&/** @type {HTMLTextAreaElement|null} */(document.getElementById('terminal-say-'+tm.open))
    var draft=typing?typing.value:''
    tm.rows=rows;tmPaint()
    var again=tm.open&&/** @type {HTMLTextAreaElement|null} */(document.getElementById('terminal-say-'+tm.open))
    if(again&&draft)again.value=draft
  }).catch(function(){/* 老电脑没有这条路由 / 连不上:整段不显示,不打扰一起做 */})
}
function tmSchedule(){clearTimeout(tm.timer);if(tm.active&&!document.hidden)tm.timer=setTimeout(function(){tmLoad().finally(tmSchedule)},TM_POLL_MS)}
function tmPost(id,path,body,onOk){
  if(tm.busy[id])return
  tm.busy[id]=true;tm.note[id]='';tmPaint()
  tmRequest(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    .then(function(){onOk()},function(e){tm.note[id]=tmError(e.message)})
    .finally(function(){delete tm.busy[id];tmPaint();tmLoad()})
}
function tmDecide(id,decision){
  var r=tm.rows.find(function(x){return x.session_id===id})
  if(!r||!tmActionable(r))return
  tmPost(id,'/m/api/cli/permission',{session_id:id,hash:r.pending.hash,decision:decision},function(){tm.note[id]=decision==='allow'?'好了，它在终端里接着做。':'已拒绝。'})
}
function tmSay(id){
  var box=/** @type {HTMLTextAreaElement|null} */(document.getElementById('terminal-say-'+id)),text=box?box.value.trim():''
  if(!text||text.length>TM_SAY_MAX)return
  tmPost(id,'/m/api/cli/say',{session_id:id,text:text},function(){tm.note[id]='收到，它接着跑了，回复会出现在这里。'})
}
tmEl('list').addEventListener('click',function(ev){
  var t=/** @type {Element} */(ev.target),b=/** @type {HTMLElement|null} */(t.closest('[data-tm-open],[data-tm-decide],[data-tm-say]'))
  if(!b)return
  if(b.dataset.tmOpen){tm.open=tm.open===b.dataset.tmOpen?null:b.dataset.tmOpen;tmPaint();return}
  if(b.dataset.tmDecide)tmDecide(b.dataset.tmId,b.dataset.tmDecide)
  if(b.dataset.tmSay)tmSay(b.dataset.tmSay)
})
document.addEventListener('cc:pane',function(event){
  tm.active=/** @type {CustomEvent} */(event).detail.pane==='matters'
  if(tm.active){tmLoad();tmSchedule()}else{clearTimeout(tm.timer);tm.seq++}
})
document.addEventListener('visibilitychange',function(){if(tm.active&&!document.hidden){tmLoad();tmSchedule()}else clearTimeout(tm.timer)})
window.addEventListener('online',function(){if(tm.active){tmLoad();tmSchedule()}})
