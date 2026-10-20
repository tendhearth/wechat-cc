// 终端里的会话(2026-10-14):主人在 CC 外面开的 Claude Code / Codex,和 CC 自己的事并排放在「一起做」。
// 等你批准且电脑在微信里开了码 ⇒ 点开这一行能允许 / 拒绝(同微信「y/n 码」;列表行上只有「看清楚 ›」);歇着的能接着说一句(同微信「@码」),
// 结果会成为它的「最后一句」。没有推送主题:看得见时每 15 秒拉一次。
// 看着它跑(2026-10-17):展开的那一行另拉最近几步(GET /m/api/cli/activity),每 4 秒一次,只在看得见时。
// 哪家(2026-10-19,同手机 app):行里不写「Claude Code」,状态行尾一个圆头像(mAgents,在 workbench.js),名字给读屏。
var tm = { active:false, rows:[], open:null, reveal:null, busy:{}, note:{}, timer:0, seq:0, act:{}, actTimer:0, actSeq:0, actOpen:{} }
var TM_STATUS = { waiting:'等你决定', running:'在做', idle:'歇着', ended:'结束了' }
var TM_POLL_MS = 15000
var TM_SAY_MAX = 4000
var TM_ACT_MS = 4000
// 最近几步:you 主人说的、said 它说的、step 它做的一步。在跑时最后一步就是「正在做的」。
function tmActivity(r){
  var a=tm.act[r.session_id],running=r.status==='running'&&(!r.stale||tmLastAt(r)>r.last_event_at),last=a.items.length-1
  return '<div class="terminal-activity" id="terminal-act-'+esc(r.session_id)+'" aria-live="polite">'+a.items.map(function(i,n){
    var when=typeof i.at==='number'?'<time>'+esc(tmAgo(i.at))+'</time>':''
    var cls='ta-step'+(running&&n===last?' is-now':'')+(i.error?' is-error':'')
    if(i.kind==='step'&&typeof i.detail==='string'&&i.detail){
      // 点开看:改文件 ⇒ diff(+ / - 行上色);命令 ⇒ 输出尾巴。展开状态按「会话|时间|这一步」记着,4 秒重画不收起。
      var key=r.session_id+'|'+i.at+'|'+i.text,isDiff=/^(改|写|删) /.test(i.text)
      var body=i.detail.split('\n').map(function(l){var c=isDiff&&l.slice(0,2)==='+ '?'ta-add':isDiff&&l.slice(0,2)==='- '?'ta-del':'';return c?'<span class="'+c+'">'+esc(l)+'</span>':esc(l)}).join('\n')
      return '<details class="ta-more" data-ta-key="'+esc(key)+'"'+(tm.actOpen[key]?' open':'')+'><summary class="'+cls+'">'+esc(i.text)+when+'</summary><pre class="ta-detail">'+body+'</pre></details>'
    }
    if(i.kind==='step')return '<p class="'+cls+'">'+esc(i.text)+when+'</p>'
    return '<p class="ta-'+(i.kind==='you'?'you':'said')+'">'+(i.kind==='you'?'<span>你</span>':'')+esc(i.text)+'</p>'
  }).join('')+'</div>'
}
function tmEl(id){return document.getElementById('terminal-'+id)}
function tmAgo(at){var d=Math.max(0,Date.now()-at);if(d<60000)return '刚刚';if(d<3600000)return Math.floor(d/60000)+' 分钟前';if(d<86400000)return Math.floor(d/3600000)+' 小时前';return new Date(at).toLocaleString()}
// 登记处的时间只在 hook 事件(说一句 / 停下 / 等批准)时更新;一轮跑很久时过程里的时间更新 ⇒ 取较新的那个。
function tmLastAt(r){var a=tm.act[r.session_id],t=r.last_event_at;if(a&&a.items)a.items.forEach(function(i){if(typeof i.at==='number'&&i.at>t)t=i.at});return t}
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
  // 过程框:原来就在最底下(或第一次画)⇒ 画完继续贴底;主人往上翻着看 ⇒ 不跳。
  var box=tm.open&&document.getElementById('terminal-act-'+tm.open),stick=!box||box.scrollTop+box.clientHeight>=box.scrollHeight-8,keep=box?box.scrollTop:0
  var root=tmEl('root'),list=tmEl('list')
  root.hidden=tm.rows.length===0
  // 一行只有一个动作:点开 / 收起。能拍的那行写「看清楚 ›」;允许 / 拒绝只在展开后的详情里(看清楚了再拍)。
  list.innerHTML=tm.rows.map(function(r){
    var id=esc(r.session_id),open=tm.open===r.session_id,busy=!!tm.busy[r.session_id],note=tm.note[r.session_id]||'',actionable=tmActionable(r)
    var pending=r.status==='waiting'&&r.pending?(r.pending.summary?r.pending.tool+': '+r.pending.summary:r.pending.tool):''
    var h='<div class="terminal-row" data-tm-row="'+id+'">'
      +'<button type="button" class="terminal-head" data-tm-open="'+id+'" aria-expanded="'+open+'"><strong>'+esc(r.project)+'</strong>'
      +'<small><span class="terminal-dot is-'+esc(r.status)+'" aria-hidden="true"></span>'+esc(TM_STATUS[r.status])+' · '+esc(r.stale&&tmLastAt(r)===r.last_event_at?'有一阵没动静了':tmAgo(tmLastAt(r)))+mAgents.agentAvatarsHtml([r.source])+'</small>'
      // 在跑的带「此刻那一步」⇒ 收起时显示它(比上一轮的最后一句新);否则照旧最后一句。
      +(pending?'<span class="terminal-pending">'+esc(pending)+'</span>':!open&&r.status==='running'&&r.now&&typeof r.now.text==='string'?'<span class="terminal-summary is-now"><span>正在</span> '+esc(r.now.text)+'</span>':r.last_summary&&!open?'<span class="terminal-summary">'+esc(r.last_summary)+'</span>':'')
      +(actionable&&!open?'<span class="terminal-review">看清楚 ›</span>':'')+'</button>'
    if(r.status==='waiting'&&!actionable)h+='<p class="terminal-note">正在终端里问，回电脑上答。</p>'
    if(open){
      var canSay=r.status==='idle'
      h+='<div class="terminal-detail">'
      // 用词表(docs/reference/phone-wording.md):先不做在左、允许这一步在右(主按钮),下面一行「只对这一次请求」。
      if(actionable)h+='<div class="terminal-actions"><button type="button" class="sessions-text-action" data-tm-decide="deny" data-tm-id="'+id+'"'+(busy?' disabled':'')+'>先不做</button><button type="button" class="sessions-primary" data-tm-decide="allow" data-tm-id="'+id+'"'+(busy?' disabled':'')+'>允许这一步</button></div><p class="terminal-note">只对这一次请求</p>'
      // 过程读到了 ⇒ 看过程(最后一句就在里面);还没读到 / 读不了(老电脑、别的电脑)⇒ 照旧给最后一句。
      var act=tm.act[r.session_id],seeAct=!!act&&!act.error&&act.items.length>0
      h+=(seeAct?'<p class="terminal-label">它在做的事</p>'+tmActivity(r):(act&&act.error==='cli_session_remote'?'<p class="terminal-note">这个会话在另一台电脑上，这里看不到过程。</p>':'')+'<p class="terminal-label">最后一句</p><p class="terminal-last">'+esc(r.last_summary||'还没有回复')+'</p>')
        +(canSay?'':'<p class="terminal-note">'+(r.status==='waiting'?'它在等你决定，先拍板再说下一句。':'它还在跑，这一轮做完再说下一句。')+'</p>')
        +'<textarea id="terminal-say-'+id+'" rows="2" maxlength="'+TM_SAY_MAX+'" placeholder="接下来让它做什么…"'+(canSay?'':' disabled')+'></textarea>'
        +'<button type="button" class="sessions-primary" data-tm-say="'+id+'"'+(canSay&&!busy?'':' disabled')+'>发送</button></div>'
    }
    return h+(note?'<p class="terminal-note" role="status">'+esc(note)+'</p>':'')+'</div>'
  }).join('')
  var nb=tm.open&&document.getElementById('terminal-act-'+tm.open);if(nb)nb.scrollTop=stick?nb.scrollHeight:keep
  if(tm.reveal){var want=tm.reveal,row=/** @type {HTMLElement|undefined} */(Array.prototype.find.call(list.querySelectorAll('[data-tm-row]'),function(/** @type {HTMLElement} */ e){return e.dataset.tmRow===want}));if(row){tm.reveal=null;if(row.scrollIntoView)row.scrollIntoView({block:'start'})}}
}
// 别处(此刻)点一条终端会话 ⇒ 到「一起做」并展开那一条。列表还没拉到时先记着,拉到后展开并滚过去。
function tmOpenSession(id){
  if(typeof id!=='string'||!id)return
  // 一件事的详情开着时终端列表是藏起来的 ⇒ 先回到全部。
  var detail=document.getElementById('m-detail'),back=document.getElementById('m-back')
  if(detail&&!detail.hidden&&back)back.click()
  tm.open=id;tm.reveal=id;tmPaint();tmActStart()
}
function tmLoad(){
  if(!tm.active||document.hidden)return Promise.resolve()
  var seq=++tm.seq
  return tmRequest('/m/api/cli/sessions').then(function(body){
    if(seq!==tm.seq||!Array.isArray(body.sessions))return
    // 结束了的不占位置;等你批准的在前(daemon 已排好)。正在写的那条不重画(输入框会丢字)。
    var rows=body.sessions.filter(function(r){return tmValid(r)&&r.status!=='ended'})
    tm.rows=rows;tmRepaint()
  }).catch(function(){/* 老电脑没有这条路由 / 连不上:整段不显示,不打扰一起做 */})
}
// 重画会丢输入框里的字:先记下、画完放回(列表刷新和过程刷新共用)。
function tmRepaint(){
  var typing=tm.open&&/** @type {HTMLTextAreaElement|null} */(document.getElementById('terminal-say-'+tm.open))
  var draft=typing?typing.value:''
  tmPaint()
  var again=tm.open&&/** @type {HTMLTextAreaElement|null} */(document.getElementById('terminal-say-'+tm.open))
  if(again&&draft)again.value=draft
}
function tmActLoad(){
  var id=tm.open
  if(!id||!tm.active||document.hidden)return Promise.resolve()
  var seq=++tm.actSeq
  return tmRequest('/m/api/cli/activity?session_id='+encodeURIComponent(id)).then(function(body){
    if(seq!==tm.actSeq||tm.open!==id||!Array.isArray(body.items))return
    tm.act[id]={items:body.items.filter(function(i){return i&&typeof i.text==='string'&&['you','said','step'].indexOf(i.kind)>=0})};tmRepaint()
  },function(e){
    if(seq!==tm.actSeq||tm.open!==id)return
    // 老电脑没有这条路由(404 method/not_found 以外)⇒ 退回「最后一句」,不报错。
    tm.act[id]={error:e.message||'unavailable',items:[]};tmRepaint()
  })
}
function tmActSchedule(){clearTimeout(tm.actTimer);if(tm.open&&tm.active&&!document.hidden)tm.actTimer=setTimeout(function(){tmActLoad().finally(tmActSchedule)},TM_ACT_MS)}
function tmActStart(){tm.actSeq++;tmActLoad();tmActSchedule()}
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
// <details> 的 toggle 不冒泡 ⇒ 捕获阶段记展开状态。
tmEl('list').addEventListener('toggle',function(ev){
  var d=/** @type {HTMLDetailsElement} */(ev.target)
  if(!d||!d.dataset||!d.dataset.taKey)return
  if(d.open)tm.actOpen[d.dataset.taKey]=true;else delete tm.actOpen[d.dataset.taKey]
},true)
tmEl('list').addEventListener('click',function(ev){
  var t=/** @type {Element} */(ev.target),b=/** @type {HTMLElement|null} */(t.closest('[data-tm-open],[data-tm-decide],[data-tm-say]'))
  if(!b)return
  if(b.dataset.tmOpen){tm.open=tm.open===b.dataset.tmOpen?null:b.dataset.tmOpen;tmPaint();if(tm.open)tmActStart();else clearTimeout(tm.actTimer);return}
  if(b.dataset.tmDecide)tmDecide(b.dataset.tmId,b.dataset.tmDecide)
  if(b.dataset.tmSay)tmSay(b.dataset.tmSay)
})
document.addEventListener('cc:pane',function(event){
  tm.active=/** @type {CustomEvent} */(event).detail.pane==='matters'
  if(tm.active){tmLoad();tmSchedule();if(tm.open)tmActStart()}else{clearTimeout(tm.timer);clearTimeout(tm.actTimer);tm.seq++;tm.actSeq++}
})
document.addEventListener('visibilitychange',function(){if(tm.active&&!document.hidden){tmLoad();tmSchedule();if(tm.open)tmActStart()}else{clearTimeout(tm.timer);clearTimeout(tm.actTimer)}})
window.addEventListener('online',function(){if(tm.active){tmLoad();tmSchedule()}})
