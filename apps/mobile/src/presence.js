var homeFocus = null
// 「此刻」形象画不再内联进页面(手机协议包 v2 Task 4 fix round 1,2026-09-29:
// 两张 PNG base64 加起来 ~257KB,是页面撑爆中继 512KB 帧预算的大头)—— 走 api() 按需拉取
// (经隧道也能拿到,直接 <img src="/m/api/…"> 拿不到)。拉不到就留空,不抛——首屏不能因为这一张图卡住。
function loadPresenceArt() {
  return api("/m/api/art/presence").then(function(r) { return r.json() }).then(function(f) {
    if (!f || !f.ok) return
    var dark = /** @type {HTMLImageElement} */ (document.querySelector(".home-dark")), light = /** @type {HTMLImageElement} */ (document.querySelector(".home-light"))
    if (dark) dark.src = "data:" + f.mime + ";base64," + f.unlit
    if (light) light.src = "data:" + f.mime + ";base64," + f.lit
  }).catch(function() {})
}
loadPresenceArt()
// 等你的那一件(收敛 5b,2026-10-21:只看):写清是哪件事、什么状态,卡上不带任何动作按钮;
// 拍板、看成果都去手机 App 或电脑。点卡片本身只是去「一起做」看这件事的状态。
var HOME_FOCUS = { decision: ['有件事等你决定', '到手机 App 或电脑上拍板'], result: ['带回了成果', '成果在手机 App 或电脑上看'] }
function renderPresenceHome(s,stale) {
  var slot=document.getElementById('home-focus'),work=s.work||{focus:null,partial:true}
  homeFocus=stale?null:work.focus
  var focus=work.focus
  slot.replaceChildren()
  // 此刻只放要你管的:等你决定、带回了成果。正在做的事住在「一起做」(2026-10-05),这里不重复。
  if(focus&&HOME_FOCUS[focus.kind]&&/^[a-f0-9]{8}$/.test(focus.id)){
    var b=document.createElement('button');b.type='button';b.className='home-action';b.disabled=stale
    var label=HOME_FOCUS[focus.kind]
    b.innerHTML='<small>'+label[0]+'</small><strong>'+esc(ccPlain(focus.title))+'</strong><span>'+label[1]+'</span>'
    b.addEventListener('click',function(){if(!homeFocus||homeFocus.id!==focus.id)return;ccShowMatter(focus.id)})
    slot.appendChild(b)
  }
  if(work.partial){var note=document.createElement('p');note.className='home-source-note';note.textContent='任务概览可能不完整，可到「一起做」查看。';slot.appendChild(note)}
  setPresenceLit(!stale&&!!s.presence&&s.presence.presence==='ok')
  document.getElementById('home-context').textContent=stale?'你看到的是上次的样子，现在在做什么还没确认。':s.presence&&s.presence.presence==='ok'?'':'有些连接状态还需要确认。'
}
// CC 亮 = 真的在身边(设计原则规矩 9):只在拿到新鲜、presence=ok 的状态时点亮;旧画面 / 断线 / 不对劲 ⇒ 暗。
// 以前这里 800ms 后不看连接就点亮(手机端盘点 10-20);渐亮仍走 CSS 的 0.8s 过渡。
function setPresenceLit(on) {
  var scene = document.querySelector('.home-scene')
  if (!scene) return
  if (on) scene.classList.add('home-arrived'); else scene.classList.remove('home-arrived')
}
