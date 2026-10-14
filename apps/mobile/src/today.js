// 「今天」(2026-10-14,GET /m/api/today):CC 统管的所有执行者过去 24 小时的几个数 + 最近做完的三件,
// 与微信「日报」同一份数据。只在「此刻」看得见时拉,每 15 秒再拉一次;只读,不让电脑主动发任何东西。
// 点一行:一起做的事 ⇒ 打开那件;终端会话 ⇒ 到「一起做」里的终端列表。老电脑没有这条路由 ⇒ 整段不显示。
var td = { active:true, timer:0, seq:0, data:null }
var TD_POLL_MS = 15000
var TD_DONE_ROWS = 3
function tdEl(id){return document.getElementById('today-'+id)}
function tdAgo(at){var d=Math.max(0,Date.now()-at);if(d<60000)return '刚刚';if(d<3600000)return Math.floor(d/60000)+' 分钟前';if(d<86400000)return Math.floor(d/3600000)+' 小时前';return new Date(at).toLocaleString()}
function tdValid(t){return t&&t.counts&&typeof t.counts.done==='number'&&Array.isArray(t.done)&&Array.isArray(t.unavailable)}
function tdPaint(){
  var root=tdEl('root'),t=td.data
  if(!root)return
  var c=t&&t.counts,total=c?c.needsYou+c.done+c.running+c.stuck:0
  if(!t||(total===0&&!t.unavailable.length)){root.hidden=true;return}
  root.hidden=false
  var counts=[c.needsYou+' 件等你',c.done+' 件做完',c.running+' 件在跑'].concat(c.stuck?[c.stuck+' 件可能卡住']:[]).join(' · ')
  tdEl('counts').textContent=counts
  tdEl('partial').hidden=!t.unavailable.length
  tdEl('list').innerHTML=t.done.slice(0,TD_DONE_ROWS).map(function(i){
    var title=(i.source==='together'?(i.title||i.project):i.project)||i.agent
    return '<button type="button" class="today-row" data-td-source="'+esc(i.source)+'" data-td-id="'+esc(i.id)+'"><strong>'+esc(title)+'</strong>'
      +'<small>'+esc(i.agent)+(i.summary?' · '+esc(i.summary):'')+' · '+esc(tdAgo(i.at))+'</small></button>'
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
tdEl('list').addEventListener('click',function(ev){
  var t=/** @type {Element} */(ev.target),b=/** @type {HTMLElement|null} */(t.closest('[data-td-id]'))
  if(!b)return
  mobilePane('matters')
  if(b.dataset.tdSource==='together'&&/^[a-f0-9]{8}$/.test(b.dataset.tdId||''))openMatter(b.dataset.tdId)
})
document.addEventListener('cc:pane',function(event){
  td.active=/** @type {CustomEvent} */(event).detail.pane==='today'
  if(td.active){tdLoad();tdSchedule()}else{clearTimeout(td.timer);td.seq++}
})
document.addEventListener('visibilitychange',function(){if(td.active&&!document.hidden){tdLoad();tdSchedule()}else clearTimeout(td.timer)})
window.addEventListener('online',function(){if(td.active){tdLoad();tdSchedule()}})
tdLoad();tdSchedule()
