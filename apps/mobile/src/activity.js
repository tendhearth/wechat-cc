// 「CC 做过的事」(B9,2026-10-20,GET /m/api/activity):此刻页底下一行,点开才拉(只给设备令牌);新的在前,
// 「再早一点」按游标往下翻,最多两周。点一行:一起做的事 ⇒ 打开那件;终端会话 ⇒ 到「一起做」并展开那一条。
// 只读;不用颜色区分类型,一句话本身就说清楚了做了什么。
var act = { open:false, items:[], next:null, seq:0 }
function actEl(id){return document.getElementById('activity-'+id)}
function actRow(i){
  var inner='<strong>'+esc(i.title)+'</strong><small>'+esc(tdAgo(i.at))+'</small>'
  if(i.ref&&(i.ref.type==='task'||i.ref.type==='terminal'))return '<button type="button" class="today-row" data-act-type="'+esc(i.ref.type)+'" data-act-id="'+esc(i.ref.id)+'">'+inner+'</button>'
  return '<div class="today-row">'+inner+'</div>'
}
function actPaint(note){
  var list=actEl('list')
  if(note){list.innerHTML='<p class="m-note">'+esc(note)+'</p>';actEl('more').hidden=true;return}
  list.innerHTML=act.items.length?act.items.map(actRow).join(''):'<p class="m-note">这两周 CC 还没替你做过什么。</p>'
  actEl('more').hidden=!act.next
}
function actLoad(more){
  var seq=++act.seq
  var path='/m/api/activity'+(more&&act.next?'?cursor='+encodeURIComponent(act.next):'')
  return api(path).then(function(r){return r.json()}).then(function(body){
    if(seq!==act.seq)return
    if(!body||body.ok!==true||!Array.isArray(body.items)){actPaint('暂时看不到,过一会儿再看。');return}
    act.items=more?act.items.concat(body.items):body.items
    act.next=typeof body.next==='string'?body.next:null
    actEl('partial').hidden=!(Array.isArray(body.degraded)&&body.degraded.length)
    actPaint()
  }).catch(function(){if(seq===act.seq)actPaint('家里的电脑暂时连不上,过一会儿再看。')})
}
actEl('open').addEventListener('click',function(){
  act.open=!act.open
  actEl('body').hidden=!act.open
  actEl('open').setAttribute('aria-expanded',act.open?'true':'false')
  if(act.open){act.items=[];act.next=null;actLoad(false)}
})
actEl('more').addEventListener('click',function(){actLoad(true)})
actEl('list').addEventListener('click',function(ev){
  var t=/** @type {Element} */(ev.target),b=/** @type {HTMLElement|null} */(t.closest('[data-act-id]'))
  if(!b)return
  mobilePane('matters')
  if(b.dataset.actType==='task'&&/^[a-f0-9]{8}$/.test(b.dataset.actId||''))openMatter(b.dataset.actId)
  else if(b.dataset.actType==='terminal'&&typeof tmOpenSession==='function')tmOpenSession(b.dataset.actId)
})
