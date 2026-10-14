
var homeFocus = null
// 「此刻」形象画不再内联进页面(手机协议包 v2 Task 4 fix round 1,2026-09-29:
// 两张 PNG base64 加起来 ~257KB,是页面撑爆中继 512KB 帧预算的大头,比这次同
// 一批塞进来的协议 IIFE(~44KB)还重得多)—— 走 api() 按需拉取,跟 you.js 的
// youLoadFrames() 同一个套路(经隧道也能拿到,直接 <img src="/m/api/…"> 拿不到)。
// 拉不到就留空,不抛——首屏不能因为这一张图卡住。
function loadPresenceArt() {
  return api("/m/api/art/presence").then(function(r) { return r.json() }).then(function(f) {
    if (!f || !f.ok) return
    var dark = /** @type {HTMLImageElement} */ (document.querySelector(".home-dark")), light = /** @type {HTMLImageElement} */ (document.querySelector(".home-light"))
    if (dark) dark.src = "data:" + f.mime + ";base64," + f.unlit
    if (light) light.src = "data:" + f.mime + ";base64," + f.lit
  }).catch(function() {})
}
loadPresenceArt()
function mobilePane(name) {
  ccMobilePane(name)
}
function renderPresenceHome(s,stale) {
  var slot=document.getElementById('home-focus'),work=s.work||{focus:null,partial:true}
  homeFocus=stale?null:work.focus
  var focus=work.focus
  slot.replaceChildren()
  // 此刻只放要你管的:等你决定、带回了成果。正在做的事住在「一起做」(2026-10-05),这里不重复。
  if(focus&&focus.kind!=='working'&&/^[a-f0-9]{8}$/.test(focus.id)){
    var b=document.createElement('button');b.type='button';b.className='home-action';b.disabled=stale
    var labels={decision:['有件事等你决定','打开并决定'],result:['带回了成果','查看成果'],working:['一起做的事','查看进展']}
    var label=labels[focus.kind]||labels.working
    b.innerHTML='<small>'+label[0]+'</small><strong>'+esc(CCM.markdownPlainText(focus.title))+'</strong><span>'+label[1]+' ↗</span>'
    b.addEventListener('click',function(){if(!homeFocus||homeFocus.id!==focus.id)return;mobilePane('matters');openMatter(focus.id)})
    slot.appendChild(b)
  }
  if(work.partial){var note=document.createElement('p');note.className='home-source-note';note.textContent='任务概览可能不完整，可到「一起做」查看。';slot.appendChild(note)}
  var result=document.getElementById('home-result');result.replaceChildren()
  // Older work stays in Memories. Only show a fresh unread postcard on arrival.
  var postcard=(s.events||[]).find(function(e){return e.kind==='postcard'&&e.ref&&e.ref.image_svg&&(!s.seen_until||e.ts>s.seen_until)})
  if(postcard&&(!focus||focus.kind==='working')){
    var card=document.createElement('details');card.className='home-postcard'
    card.innerHTML='<summary>CC 留给你一张明信片 · '+esc(CCM.markdownPlainText(postcard.title))+'</summary><div>'+postcard.ref.image_svg+'</div><p>'+esc(CCM.markdownPlainText(postcard.note||''))+'</p>'
    result.appendChild(card)
  }
  document.getElementById('home-context').textContent=stale?'这是上次留下的画面，当前活动尚未确认。':s.presence&&s.presence.presence==='ok'?'你可以在这里陪它一会儿。':'有些连接状态还需要确认。'
}
document.getElementById('home-entry').addEventListener('click',function(){void openEntry()})
var homeCharacter = document.querySelector(".home-character")
homeCharacter.addEventListener("click", function(){ openYou() })
homeCharacter.addEventListener("keydown", function(/** @type {KeyboardEvent} */ ev){ if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openYou() } })
// Arrival is a local attention event, not a network status or theme switch.
setTimeout(function(){document.querySelector('.home-scene').classList.add('home-arrived')},800)
