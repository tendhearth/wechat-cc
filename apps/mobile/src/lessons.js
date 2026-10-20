// 项目经验:见 docs/superpowers/specs/2026-10-20-project-lessons-design.md
var les = { open:false, seq:0, armed:null }
function lesEl(id){return document.getElementById('lessons-'+id)}
var LES_REFUSED = { duplicate:'这条已经记着了。', full:'这个项目已经有 10 条了,先删一条再加。', invalid:'每条一行、200 字以内,不要带尖括号。', project_not_found:'这个项目找不到了,刷新一下。' }
function lesNote(t){lesEl('note').textContent=t||''}
function lesPaint(body){
  var list=lesEl('list')
  list.innerHTML=body.projects.length?body.projects.map(function(p){
    return '<div class="lessons-project"><small>'+esc(p.name)+'</small>'+p.lessons.map(function(l){
      return '<div class="today-row lessons-row"><span>'+esc(l.text)+'</span><button type="button" class="home-quiet lessons-del" data-project="'+esc(p.id)+'" data-lesson-id="'+esc(l.id)+'">删</button></div>'
    }).join('')+'</div>'
  }).join(''):'<p class="m-note">还没有项目经验。写一句,以后不管哪家执行者做这个项目都会照着做。</p>'
  var pick=/** @type {HTMLSelectElement} */(lesEl('project')),keep=pick.value
  pick.innerHTML=body.choices.map(function(c){return '<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>'}).join('')
  if(keep&&body.choices.some(function(c){return c.id===keep}))pick.value=keep
  lesEl('form').hidden=!body.choices.length
}
function lesLoad(){
  var seq=++les.seq;les.armed=null
  return api('/m/api/lessons').then(function(r){return r.json()}).then(function(body){
    if(seq!==les.seq)return
    if(!body||body.ok!==true||!Array.isArray(body.projects)||!Array.isArray(body.choices)){lesEl('list').innerHTML='<p class="m-note">暂时看不到,过一会儿再看。</p>';return}
    lesPaint(body)
  }).catch(function(){if(seq===les.seq)lesEl('list').innerHTML='<p class="m-note">家里的电脑暂时连不上,过一会儿再看。</p>'})
}
function lesPost(path,payload){
  return api(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}).then(function(r){return r.json()})
}
lesEl('open').addEventListener('click',function(){
  les.open=!les.open
  lesEl('body').hidden=!les.open
  lesEl('open').setAttribute('aria-expanded',les.open?'true':'false')
  if(les.open){lesNote('');lesLoad()}
})
lesEl('form').addEventListener('submit',function(ev){
  ev.preventDefault()
  var tx=/** @type {HTMLInputElement} */(lesEl('text')),text=tx.value.trim(),project=/** @type {HTMLSelectElement} */(lesEl('project')).value
  if(!text||!project)return
  lesPost('/m/api/lessons/add',{project:project,text:text}).then(function(r){
    if(r&&r.ok===true){tx.value='';lesNote('记下了。');return lesLoad()}
    lesNote(LES_REFUSED[r&&r.error]||'没记上,过一会儿再试。')
  }).catch(function(){lesNote('家里的电脑暂时连不上,过一会儿再试。')})
})
lesEl('list').addEventListener('click',function(ev){
  var t=/** @type {Element} */(ev.target),b=/** @type {HTMLElement|null} */(t.closest('[data-lesson-id]'))
  if(!b)return
  var id=b.dataset.lessonId||'',project=b.dataset.project||''
  if(les.armed!==id){les.armed=id;b.textContent='确定删?';return}
  les.armed=null
  lesPost('/m/api/lessons/remove',{project:project,id:id}).then(function(r){
    lesNote(r&&r.ok===true?'删了。':'没删成,刷新一下再看。');return lesLoad()
  }).catch(function(){lesNote('家里的电脑暂时连不上,过一会儿再试。')})
})
