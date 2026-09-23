import art from './mobile-presence-art.json'

export const MOBILE_PRESENCE_HTML=`
<section class="home-scene" aria-label="CC 此刻">
  <p class="home-eyebrow">此刻</p><h2 id="pres-txt">正在看看 CC…</h2>
  <p id="home-context">你可以在这里陪它一会儿。</p>
  <div class="home-character" role="img" aria-label="CC">
    <img class="home-dark" src="data:image/png;base64,${art.unlit.base64}" alt="">
    <img class="home-light" src="data:image/png;base64,${art.lit.base64}" alt="">
  </div>
  <p class="home-greeting">你来啦。</p>
</section>
<div id="home-focus" aria-live="polite"></div>
<div id="home-result"></div>
<button id="home-work" class="home-quiet" type="button">去看看一起做的事 ↗</button>`

export const MOBILE_PRESENCE_CSS=`
:root{--ink:#483f35;--soft:#7e7365;--accent:#735b3e;--paper:#f9f7f1;--card:#fffefa;--line:#e5dfd3}
body{max-width:680px;margin:auto;padding-bottom:calc(80px + env(safe-area-inset-bottom));line-height:1.65}
body>header{display:flex;align-items:center;justify-content:space-between;padding:24px 22px 12px}
body>header h1{font-size:21px;letter-spacing:-.04em}body>header .sub{display:none}
#nav-set,#refresh{border:0;background:none;color:var(--soft);font:inherit;font-size:12px;min-height:44px;padding:8px 12px}
.pane{padding:8px 22px 24px}.card{border-width:1px;border-radius:15px;box-shadow:none}
nav{max-width:680px;margin:auto;background:var(--paper);border-width:1px;z-index:10}nav button{min-height:58px;font-size:13px}nav button.on{color:var(--ink)}
button{cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}button:focus-visible,summary:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:3px}[hidden]{display:none!important}
.home-scene{position:relative;height:385px;padding:24px 4px 0;overflow:hidden;background:radial-gradient(ellipse at 50% 75%,#eee6d5,transparent 65%)}
.home-eyebrow{font-size:11px;color:var(--soft);margin:0 0 12px}.home-scene h2{font-size:25px;font-weight:500;line-height:1.5;max-width:95%;margin:0;overflow-wrap:anywhere}
#home-context{font-size:12px;color:var(--soft);margin:10px 0}.home-character{position:absolute;width:220px;height:220px;bottom:20px;left:calc(50% - 110px)}.home-character img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transition:opacity .8s ease}.home-light{opacity:0}.home-arrived .home-light{opacity:1}.home-arrived .home-dark{opacity:0}.home-greeting{position:absolute;bottom:0;font-size:12px;color:var(--soft)}
#home-focus{margin:18px 0}.home-action{display:block;width:100%;text-align:left;border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--ink);padding:18px;font:inherit}.home-action strong{display:block;font-weight:550;font-size:17px;margin:4px 0}.home-action small{font-size:12px;color:var(--soft)}.home-action span{display:block;font-size:12px;margin-top:12px;color:var(--accent)}
.home-quiet{display:block;width:100%;text-align:left;font:inherit;font-size:12px;background:none;color:var(--soft);border:0;border-top:1px solid var(--line);padding:16px 0}.home-postcard{margin:20px 0}.home-postcard summary{cursor:pointer;color:var(--soft);font-size:12px}.home-postcard svg{display:block;width:100%;height:auto}.home-postcard p{white-space:pre-wrap;font-size:13px}.home-source-note{font-size:11px;color:var(--soft)}
#p-memory>.grp{font-size:20px;color:var(--ink);font-weight:500}.memory-pocket{margin-top:26px}.memory-pocket>summary{cursor:pointer;padding:12px 0;border-top:1px solid var(--line)}#m-detail>details{margin:20px 0}#m-detail>details>summary{cursor:pointer;color:var(--soft);font-size:13px;padding:10px 0}#m-artifact-preview img{display:block;margin:12px auto;max-height:60vh;object-fit:contain}.home-toolbar{display:flex;justify-content:flex-end}
@media(prefers-reduced-motion:reduce){.home-character img{transition:none}}
`

export const MOBILE_PRESENCE_JS=String.raw`
var homeFocus = null
function mobilePane(name) {
  var button=document.querySelector('nav button[data-p="'+name+'"]')
  if(button)button.click()
}
function renderPresenceHome(s,stale) {
  var slot=document.getElementById('home-focus'),work=s.work||{focus:null,partial:true}
  homeFocus=stale?null:work.focus
  var focus=work.focus
  slot.replaceChildren()
  if(focus&&/^[a-f0-9]{8}$/.test(focus.id)){
    var b=document.createElement('button');b.type='button';b.className='home-action';b.disabled=stale
    var labels={decision:['有件事等你决定','打开并决定'],result:['带回了成果','查看成果'],working:['一起做的事','查看进展']}
    var label=labels[focus.kind]||labels.working
    b.innerHTML='<small>'+label[0]+'</small><strong>'+esc(focus.title)+'</strong><span>'+label[1]+' ↗</span>'
    b.addEventListener('click',function(){if(!homeFocus||homeFocus.id!==focus.id)return;mobilePane('matters');openMatter(focus.id)})
    slot.appendChild(b)
  }
  if(work.partial){var note=document.createElement('p');note.className='home-source-note';note.textContent='任务概览可能不完整，可到「一起做」查看。';slot.appendChild(note)}
  var result=document.getElementById('home-result');result.replaceChildren()
  // Older work stays in Memories. Only show a fresh unread postcard on arrival.
  var postcard=(s.events||[]).find(function(e){return e.kind==='postcard'&&e.ref&&e.ref.image_svg&&(!s.seen_until||e.ts>s.seen_until)})
  if(postcard&&(!focus||focus.kind==='working')){
    var card=document.createElement('details');card.className='home-postcard'
    card.innerHTML='<summary>CC 留给你一张明信片 · '+esc(postcard.title)+'</summary><div>'+postcard.ref.image_svg+'</div><p>'+esc(postcard.note||'')+'</p>'
    result.appendChild(card)
  }
  document.getElementById('home-context').textContent=stale?'这是上次留下的画面，当前活动尚未确认。':s.presence&&s.presence.presence==='ok'?'你可以在这里陪它一会儿。':'有些连接状态还需要确认。'
}
document.getElementById('home-work').addEventListener('click',function(){mobilePane('matters')})
// Arrival is a local attention event, not a network status or theme switch.
setTimeout(function(){document.querySelector('.home-scene').classList.add('home-arrived')},800)
`
