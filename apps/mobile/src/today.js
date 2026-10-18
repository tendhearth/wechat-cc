// 「今天」(2026-10-14,GET /m/api/today):CC 统管的所有执行者过去 24 小时的几个数 + 最近做完的三件,
// 与微信「日报」同一份数据。只在「此刻」看得见时拉,每 15 秒再拉一次;只读,不让电脑主动发任何东西。
// 点一行:一起做的事 ⇒ 打开那件;终端会话 ⇒ 到「一起做」并展开那一条。老电脑没有这条路由 ⇒ 整段不显示。
// 等你的不在「过去 24 小时」里数(同一个数不出现两次):终端里等你批准、手机拍得了的那几条(有码 = replyRef)
// 直接列在此刻的等你的事下面,和手机 app 一样;一起做里等你的由上面那张卡(presence.js)管。
var td = { active:true, timer:0, seq:0, data:null }
var TD_POLL_MS = 15000
var TD_DONE_ROWS = 3
// 「你不在的这 N 小时」(2026-10-17,同手机 app):页面藏起来时记一下时间(只存本机),离开 ≥ 1 小时、这期间有做完的 ⇒ 只数只列这段。
var TD_AWAY_MIN_MS = 3600000, TD_LEFT_KEY = 'cc.lastLeft'
function tdLeftAt(){try{var n=Number(localStorage.getItem(TD_LEFT_KEY));return n>0?n:null}catch(e){return null}}
td.away=tdLeftAt()
function tdEl(id){return document.getElementById('today-'+id)}
function tdAgo(at){var d=Math.max(0,Date.now()-at);if(d<60000)return '刚刚';if(d<3600000)return Math.floor(d/60000)+' 分钟前';if(d<86400000)return Math.floor(d/3600000)+' 小时前';return new Date(at).toLocaleString()}
function tdValid(t){return t&&t.counts&&typeof t.counts.done==='number'&&Array.isArray(t.done)&&Array.isArray(t.unavailable)}
function tdPaint(){
  var root=tdEl('root'),t=td.data
  if(!root)return
  tdPaintWaiting(t)
  var c=t&&t.counts,total=c?c.done+c.running+c.stuck:0
  if(!t||(total===0&&!t.unavailable.length)){root.hidden=true;return}
  root.hidden=false
  // 是 0 的不写;等你的不在这里数。
  var away=td.away,now=Date.now()
  var since=away&&now-away>=TD_AWAY_MIN_MS&&away>=t.since?t.done.filter(function(i){return i.at>away}):[]
  var done=since.length?since:t.done,nDone=since.length||c.done
  tdEl('title').textContent=since.length?'你不在的这 '+Math.round((now-away)/3600000)+' 小时':'过去 24 小时'
  var counts=[].concat(nDone?[nDone+' 件做完']:[],c.running?[c.running+' 件在跑']:[],c.stuck?[c.stuck+' 件可能卡住']:[]).join(' · ')
  tdEl('counts').textContent=counts
  tdEl('counts').hidden=!counts
  tdEl('partial').hidden=!t.unavailable.length
  tdEl('list').innerHTML=done.slice(0,TD_DONE_ROWS).map(function(i){
    var title=(i.source==='together'?(i.title||i.project):i.project)||i.agent
    return '<button type="button" class="today-row" data-td-source="'+esc(i.source)+'" data-td-id="'+esc(i.id)+'"><strong>'+esc(title)+'</strong>'
      +'<small>'+esc(i.agent)+(i.summary?' · '+esc(i.summary):'')+' · '+esc(tdAgo(i.at))+'</small></button>'
  }).join('')
}
function tdPaintWaiting(t){
  var slot=tdEl('waiting')
  if(!slot)return
  var needs=t&&Array.isArray(t.needsYou)?t.needsYou.filter(function(n){return n&&n.source==='terminal'&&typeof n.id==='string'&&typeof n.replyRef==='string'}):[]
  slot.hidden=needs.length===0
  slot.innerHTML=needs.map(function(n){
    return '<button type="button" class="today-row today-need" data-td-source="terminal" data-td-id="'+esc(n.id)+'"><span class="today-need-text"><strong>'+esc(n.summary||n.project||n.agent)+'</strong>'
      +'<small>等你批准 · '+esc(n.project||'')+' · '+esc(n.agent)+'</small></span><span class="today-need-go">看清楚 ›</span></button>'
  }).join('')
}
function tdLoad(){
  if(!td.active||document.hidden)return Promise.resolve()
  var seq=++td.seq
  return api('/m/api/today').then(function(r){return r.json()}).then(function(body){
    if(seq!==td.seq)return
    td.data=body&&body.ok&&tdValid(body.today)?body.today:null
    tdPaint()
  }).catch(function(){/* 连不上 / 老电脑:保留上一次的画面,不打扰此刻 */})
}
function tdSchedule(){clearTimeout(td.timer);if(td.active&&!document.hidden)td.timer=setTimeout(function(){tdLoad().finally(tdSchedule)},TD_POLL_MS)}
tdEl('counts-open').addEventListener('click',function(){mobilePane('matters')})
function tdOpenRow(ev){
  var t=/** @type {Element} */(ev.target),b=/** @type {HTMLElement|null} */(t.closest('[data-td-id]'))
  if(!b)return
  mobilePane('matters')
  if(b.dataset.tdSource==='together'&&/^[a-f0-9]{8}$/.test(b.dataset.tdId||''))openMatter(b.dataset.tdId)
  else if(b.dataset.tdSource==='terminal'&&typeof tmOpenSession==='function')tmOpenSession(b.dataset.tdId)
}
tdEl('list').addEventListener('click',tdOpenRow)
tdEl('waiting').addEventListener('click',tdOpenRow)
document.addEventListener('cc:pane',function(event){
  td.active=/** @type {CustomEvent} */(event).detail.pane==='today'
  if(td.active){tdLoad();tdSchedule()}else{clearTimeout(td.timer);td.seq++}
})
document.addEventListener('visibilitychange',function(){
  if(document.hidden){try{localStorage.setItem(TD_LEFT_KEY,String(Date.now()))}catch(e){/* 存不了就照旧看 24 小时 */}}
  else td.away=tdLeftAt()
  if(td.active&&!document.hidden){tdLoad();tdSchedule()}else clearTimeout(td.timer)
})
window.addEventListener('online',function(){if(td.active){tdLoad();tdSchedule()}})
tdLoad();tdSchedule()
