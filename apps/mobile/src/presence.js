
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
