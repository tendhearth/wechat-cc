var rItems=[],rStop=null
function rAvatar(item){var agents=item.agents||[],current=agents.find(function(a){return a.current})||agents[0],previous=agents.find(function(a){return a!==current}),ordered=previous?[previous,current]:current?[current]:[];return '<span class="roster-avatar'+(previous?' relay':'')+'">'+ordered.map(function(a){return mAgents.agentAvatarsHtml([a.id],{nameOf:function(){return a.name||a.id}})}).join('')+'</span>'}
function renderRosterStrip(items,opts){return items.filter(function(i){return i.group==='waiting'||i.group==='working'}).slice(0,5).map(function(i){return '<button type="button" data-roster="'+esc(i.key)+'" class="roster-person '+i.group+'" aria-label="'+esc(i.title)+'">'+rAvatar(i)+'</button>'}).join('')+(items.length?'<button type="button" data-roster-all>在做 '+items.length+' ›</button>':'')}
function startRoster(opts){
 if(!opts.isDevice)return function(){}
 var root=document.getElementById('roster-strip'),sheet=document.getElementById('roster-sheet'),etag=null,timer=null,stopped=false,busy=false
 function clear(){stopped=true;clearTimeout(timer);root.hidden=true;sheet.hidden=true;rItems=[];root.replaceChildren();sheet.replaceChildren();document.removeEventListener('visibilitychange',visible)}
 function live(){return !stopped&&isDevice}
 function list(){sheet.hidden=false;sheet.innerHTML='<button type="button" data-roster-close>收起</button>'+['waiting','working','back'].map(function(g){var rows=rItems.filter(function(i){return i.group===g});return rows.length?'<h2>'+esc(CCP.HOME_GROUP_WORDS[g])+'</h2>'+rows.map(function(i){return '<button type="button" data-roster="'+esc(i.key)+'">'+rAvatar(i)+esc(i.title)+'<small>'+esc([i.project,CCP.STATUS_WORDS[i.status]].filter(Boolean).join(' · '))+'</small></button>'}).join(''):''}).join('')}
 function click(ev){var b=ev.target.closest('button');if(!b)return;if(b.hasAttribute('data-roster-all'))list();else if(b.hasAttribute('data-roster-close'))sheet.hidden=true;else if(b.dataset.roster){var item=rItems.find(function(i){return i.key===b.dataset.roster});if(item){sheet.hidden=true;opts.onOpen(item)}}}
 root.addEventListener('click',click);sheet.addEventListener('click',click)
 async function poll(){
  if(!live()){clear();return}if(document.hidden||busy)return;busy=true
  try{var r=await opts.call(etag);if(!live())return;if(r.status===401){onUnauthorized(T);clear();return}if(r.status===304)return;if(r.status!==200)throw Error('unavailable');var b=await r.json();if(!live())return;rItems=b.items;etag=r.headers&&r.headers.get('etag');root.innerHTML=renderRosterStrip(rItems,{});root.hidden=!rItems.length;if(!sheet.hidden)list()}
  catch(e){if(live()){root.hidden=false;var note=root.querySelector('[role="status"]');if(!note){note=document.createElement('small');note.setAttribute('role','status');root.appendChild(note)}note.textContent='家里的电脑暂时连不上'}}
  finally{busy=false;if(live()&&!document.hidden)timer=setTimeout(poll,5000)}
 }
 function visible(){clearTimeout(timer);if(!document.hidden)poll()}
 document.addEventListener('visibilitychange',visible);poll();return clear
}
function rOpen(item){mRosterTarget=item;openMatter(item.kind==='terminal'?'terminal:'+item.id:item.id)}
function rStart(){if(!isDevice||rStop)return;rStop=startRoster({isDevice:true,call:function(etag){return /* link-scan: device-only */ api('/v1/roster',{headers:etag?{'If-None-Match':etag}:{}})},onOpen:rOpen})}
rStart()
