// 正面上半「现在」(设计稿 2026-11-18-cc-two-sides-design.md §3–4):一个地方一行,点行筛说话,「›」打开那一件。只给配对设备。
var rPlaces=[],rStop=null,rSelected=null,cPlace=null
function rTime(p,now){
 if(p.moving)return '现在'
 if(p.updatedAt==null)return ''
 var d=now-p.updatedAt,a=new Date(p.updatedAt),n=new Date(now),day=function(x){return new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime()},days=Math.round((day(n)-day(a))/864e5)
 if(d<6e4)return '刚刚'
 if(d<36e5)return Math.floor(d/6e4)+' 分钟前'
 if(!days)return String(a.getHours()).padStart(2,'0')+':'+String(a.getMinutes()).padStart(2,'0')
 if(days===1)return '昨天'
 return days<7?'周'+'日一二三四五六'[a.getDay()]:(a.getMonth()+1)+' 月 '+a.getDate()+' 日'
}
function rLine(p){var l=(p.line||'').trim();return !l||p.waiting?l:p.status==='working'?(/…$/.test(l)?l:l+'…'):p.status==='failed'?l+'(没做成)':p.status==='stopped'?l+'(停了)':l}
function rTarget(p){var w=p.waiting||{};return w.matterId?{kind:'matter',id:w.matterId}:w.sessionId?{kind:'terminal',id:w.sessionId}:p.matterIds[0]?{kind:'matter',id:p.matterIds[0]}:p.sessionIds[0]?{kind:'terminal',id:p.sessionIds[0]}:null}
function renderPlacesStrip(places,o){
 var stale=!!o.stale
 return (stale?'<small role="status">家里的电脑暂时连不上,下面是上一次的样子</small>':'')+places.map(function(p){
  var on=p.key===o.selected,w=!!p.waiting&&!stale,l=rLine(p),k=esc(p.key)
  return '<div class="place'+(w?' waiting':'')+(p.unseen?' unseen':'')+(p.moving?' moving':'')+(on?' selected':'')+'"><button type="button" data-place="'+k+'" aria-pressed="'+on+'" aria-label="'+esc(p.name+(w?',在等你':'')+(l?','+l:''))+'"><i></i><b>'+esc(p.name)+'</b><span>'+esc(l)+'</span><small>'+esc(rTime(p,o.now||Date.now()))+'</small></button>'+(rTarget(p)?'<button type="button" data-place-open="'+k+'" aria-label="打开 '+esc(p.name)+' 那一件">›</button>':'')+'</div>'
 }).join('')
}
function cInPlace(m){return !cPlace||cPlace.messageIds.indexOf(m.id)>=0||!!m.matterId&&cPlace.matterIds.indexOf(m.matterId)>=0}
function cRefInPlace(r){return !cPlace||cPlace.matterIds.indexOf(r.id)>=0||!!r.originMessageId&&cPlace.messageIds.indexOf(r.originMessageId)>=0}
function startRoster(opts){
 if(!opts.isDevice)return function(){}
 var root=document.getElementById('roster-strip'),etag=null,timer=null,stopped=false,busy=false,stale=false
 function draw(){root.innerHTML=renderPlacesStrip(rPlaces,{selected:rSelected,stale:stale});root.hidden=!rPlaces.length&&!stale}
 function clear(){stopped=true;clearTimeout(timer);root.hidden=true;rPlaces=[];rSelected=null;opts.onSelect(null);root.replaceChildren();document.removeEventListener('visibilitychange',visible)}
 function live(){return !stopped&&isDevice}
 root.addEventListener('click',function(ev){
  var b=/** @type {HTMLElement} */ (ev.target).closest('button'),key=b&&(b.dataset.place||b.dataset.placeOpen),p=key&&rPlaces.find(function(x){return x.key===key});if(!p)return
  if(b.dataset.placeOpen){opts.onOpen(rTarget(p));return}
  rSelected=rSelected===p.key?null:p.key;draw();opts.onSelect(rSelected?p:null)
 })
 async function poll(){
  if(!live()){clear();return}if(document.hidden||busy)return;busy=true
  try{
   var r=await opts.call(etag);if(!live())return
   if(r.status===401){onUnauthorized(T);clear();return}
   if(r.status===304){if(stale){stale=false;draw()}return}
   if(r.status!==200)throw Error('unavailable')
   var b=await r.json();if(!live())return
   rPlaces=b.places;etag=r.headers&&r.headers.get('etag');stale=false
   var cur=rSelected&&rPlaces.find(function(x){return x.key===rSelected})
   if(rSelected&&!cur)rSelected=null;opts.onSelect(cur||null);draw()
  }catch(e){if(live()){stale=true;draw()}}
  finally{busy=false;if(live()&&!document.hidden)timer=setTimeout(poll,5000)}
 }
 function visible(){clearTimeout(timer);if(!document.hidden)poll()}
 document.addEventListener('visibilitychange',visible);poll();return clear
}
function rOpen(t){mRosterTarget=t.kind==='terminal'?{agents:[],terminal:{sessionId:t.id}}:null;openMatter(t.kind==='terminal'?'terminal:'+t.id:t.id)}
function rSelect(p){var sig=function(x){return x?x.key+JSON.stringify([x.matterIds,x.messageIds]):''};if(sig(p)===sig(cPlace))return;cPlace=p;if(typeof cRender==='function')cRender()}
function rStart(){if(!isDevice||rStop)return;rStop=startRoster({isDevice:true,call:function(etag){return /* link-scan: device-only */ api('/v1/places',{headers:etag?{'If-None-Match':etag}:{}})},onOpen:rOpen,onSelect:rSelect})}
rStart()
