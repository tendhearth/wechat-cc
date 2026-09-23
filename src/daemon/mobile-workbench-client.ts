/** Standalone PWA task interactions. No external scripts or desktop operator credential. */
export const MOBILE_WORKBENCH_JS=String.raw`
var M_STATUS = { open: "进行中", replied: "已答复", done: "已了结", archived: "已归档" }
var M_KIND = { task: "任务", chat: "对话", companion: "陪伴" }
var M_INPUT_STATUS={pending:"补充已保存，等待执行者接收。",sending:"补充正在发送，等待执行者确认。",delivered:"这条补充已送达。",held:"未确认送达，请先查看任务记录。原文已保留。",withdrawn:"这条补充已撤回，原文已保留。"},mInputStates={}
var mCurrent = null, mDetail = null, mPoll = null, mSeq = 0, mActive = false, mBusy = {}, mQuestionKey = "", mObjectUrls = [], mTooLarge = false
var mStorage = "cc.phone.matter.v1:" + (REMOTE ? REMOTE.id : location.host) + ":"
function mRead(key) { try { return JSON.parse(localStorage.getItem(mStorage + key) || "null") } catch (e) { return null } }
function mWrite(key,value) { try { if (value === null) localStorage.removeItem(mStorage + key); else localStorage.setItem(mStorage + key,JSON.stringify(value)) } catch (e) {} }
function mUuid() {
  var bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  var h = Array.from(bytes,function(b){return b.toString(16).padStart(2,"0")}).join("")
  return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)
}
function mNotice(message) { document.getElementById("m-notice").textContent = message }
function mError(code) {
  if (code === "detail_too_large") return "完整内容过长，请到桌面查看。草稿已保留，这里暂时不能提交判断或补充。"
  if (code === "unauthorized") return "这台手机的连接已失效，请从微信重新打开随身 CC。"
  if (/stale|artifact_changed/.test(code || "")) return "内容已变化或已经处理，请查看刷新后的任务。"
  if (/restart_confirmation|external_close_confirmation/.test(code || "")) return "这次续接需要确认恢复方式，请到桌面工作台处理。你的补充仍保留在这里。"
  if (code === "workbench_busy") return "任务还在运行或文件夹正在使用，请刷新后再试。"
  if (code === "invalid_answer") return "请回答每个问题，并按选项要求填写。"
  if (code === "input_conflict") return "这条补充与先前提交不同，请检查任务记录后再编辑发送。"
  if (code === "artifact_checksum") return "文件校验未通过，没有打开或下载。请重试。"
  return "暂时没能完成，请检查连接后重试。草稿已保留。"
}
function mApi(path,opts) {
  var timer
  return Promise.race([api(path,opts).then(function(r){return r.json().then(function(b){if (!r.status || r.status < 400) { if (b.ok) return b }; throw new Error(b.error || "unavailable")})}),new Promise(function(_r,reject){timer=setTimeout(function(){reject(new Error("timeout"))},15000)})]).finally(function(){clearTimeout(timer)})
}
function mClearPreview() { mObjectUrls.forEach(function(u){URL.revokeObjectURL(u)});mObjectUrls=[];document.getElementById("m-artifact-preview").replaceChildren() }
function mSetButtons() {
  document.querySelectorAll("#m-controls button[data-request]").forEach(function(b){b.disabled=!!mBusy[b.dataset.task+":"+b.dataset.request]})
  document.querySelectorAll("#m-questions [data-question-request]").forEach(function(card){var disabled=!!mBusy[mCurrent+":"+card.dataset.questionRequest];card.querySelectorAll('input,textarea').forEach(function(input){input.disabled=disabled})})
  document.getElementById("m-send").disabled=!mDetail||mTooLarge||!!mBusy[mCurrent+":say"]
  document.getElementById("m-say").disabled=mTooLarge
}
function loadMatters() {
  mApi("/m/api/matters?status=open,replied,done").then(function(r){
    document.getElementById("m-list").innerHTML=r.matters.filter(function(m){return m.kind!=="companion"}).map(function(m){return '<button type="button" class="card todo" data-mid="'+esc(m.id)+'"><span class="tx"><b>'+esc(m.title)+'</b><small>'+esc(M_KIND[m.kind]||m.kind)+' · '+esc(M_STATUS[m.status]||m.status)+(m.projectPath?' · '+esc(m.projectPath.split(/[\\/]/).filter(Boolean).pop()||m.projectPath):'')+'</small></span></button>'}).join("") || '<div class="empty">还没有事，微信或桌面上交代一件就会出现在这里</div>'
  }).catch(function(e){document.getElementById("m-list").textContent=mError(e.message)})
}
function mQuestionDraft(request) { return mRead(mCurrent+":question:"+request.id) || {} }
function mObserveInput(id,input,notify) {
  if(!input||input.taskId!==id||!M_INPUT_STATUS[input.status])return
  var known=mCurrent===id&&mDetail&&(mDetail.inputs||[]).find(function(r){return r.taskId===id&&r.id===input.id&&r.runId===input.runId})
  if(known&&['held','withdrawn','delivered'].indexOf(known.status)>=0&&['pending','sending'].indexOf(input.status)>=0)input=known
  var key=id+':'+input.id,changed=mInputStates[key]!==input.status,draft=mRead(id+':say')
  var matches=draft&&draft.requestId===input.id&&(!draft.runId||draft.runId===input.runId)&&draft.text.trim()===input.text
  mInputStates[key]=input.status
  if(matches){
    if(input.status==='delivered'){
      mWrite(id+':say',null)
      if(mCurrent===id&&document.getElementById('m-say').value.trim()===input.text)document.getElementById('m-say').value=''
    }else if(!draft.runId){draft.runId=input.runId;mWrite(id+':say',draft)}
  }
  if(mCurrent===id&&(notify||(matches&&changed)))mNotice(M_INPUT_STATUS[input.status])
}
function mRenderInputs(d) {
  var inputs=(d.inputs||[]).filter(function(input){return input.taskId===d.matter.id&&M_INPUT_STATUS[input.status]})
  inputs.forEach(function(input){mObserveInput(d.matter.id,input,false)})
  document.getElementById('m-inputs').innerHTML=inputs.filter(function(input){return input.status!=='delivered'}).map(function(input){return '<div class="card"><b>'+esc(M_INPUT_STATUS[input.status])+'</b><pre class="m-description">'+esc(input.text)+'</pre><button type="button" class="more" data-restore-input="'+esc(input.id)+'">取回这条补充</button></div>'}).join('')
}
function mRenderQuestions(d) {
  var questions=(d.questions||[]).filter(function(r){return r.taskId===d.matter.id})
  var key=JSON.stringify([d.matter.id,d.runId,questions])
  if (key===mQuestionKey) return
  mQuestionKey=key
  document.getElementById("m-questions").innerHTML=questions.map(function(r){
    var draft=mQuestionDraft(r)
    return '<div class="card" data-question-request="'+esc(r.id)+'"><b>需要你判断</b>'+r.questions.map(function(q){
      var value=draft[q.id]||{},selected=Array.isArray(value.selected)?value.selected:[]
      return '<fieldset><legend>'+esc(q.header)+' · '+esc(q.question)+'</legend>'+q.options.map(function(o,i){
        return '<label class="m-option"><input type="'+(q.multiSelect?'checkbox':'radio')+'" name="'+esc(r.id+":"+q.id)+'" data-answer-choice="'+esc(q.id)+'" value="'+esc(o.label)+'" '+(selected.indexOf(o.label)>=0?'checked':'')+'> '+esc(o.label)+'<small>'+esc(o.description)+'</small></label>'
      }).join("")+(q.allowOther?'<label class="m-option">其他答案<textarea rows="2" data-answer-other="'+esc(q.id)+'">'+esc(value.other||"")+'</textarea></label>':'')+'</fieldset>'
    }).join("")+'<button type="button" class="done-btn" data-control="answer" data-task="'+esc(d.matter.id)+'" data-request="'+esc(r.id)+'">提交回答</button> <button type="button" class="more" data-control="decline" data-task="'+esc(d.matter.id)+'" data-request="'+esc(r.id)+'">暂不回答</button></div>'
  }).join("")
}
function renderMatter(d) {
  mDetail=d;mTooLarge=false
  document.getElementById("m-title").textContent=d.matter.title+" · "+(M_STATUS[d.matter.status]||d.matter.status)
  document.getElementById("m-events").innerHTML=(d.events||[]).filter(function(e){return ["user","text","error","system"].indexOf(e.kind)>=0}).map(function(e){return '<div class="card ev"><div class="k">'+(e.kind==='user'?'你':e.kind==='text'?'CC':'·')+'</div><div class="tx"><p>'+esc(e.text)+'</p><small>'+esc(ago(new Date(e.createdAt).toISOString()))+'</small></div></div>'}).join("")||'<div class="empty">还没有对话记录</div>'
  document.getElementById("m-permissions").innerHTML=(d.permissions||[]).filter(function(p){return p.taskId===d.matter.id}).map(function(p){return '<div class="card"><b>需要你允许这一次</b><p>'+esc(p.tool)+'</p><pre class="m-description">'+esc(p.description)+'</pre><button type="button" class="done-btn" data-control="allow" data-task="'+esc(d.matter.id)+'" data-request="'+esc(p.id)+'">允许这一次</button> <button type="button" class="more" data-control="deny" data-task="'+esc(d.matter.id)+'" data-request="'+esc(p.id)+'">拒绝</button></div>'}).join("")
  mRenderQuestions(d)
  mRenderInputs(d)
  document.getElementById("m-artifacts").innerHTML=(d.artifacts||[]).filter(function(a){return a.taskId===d.matter.id}).map(function(a){return '<div class="card"><b>'+esc(a.name)+'</b><small>已保存 · '+Math.ceil(a.size/1024)+' KB</small><button type="button" class="more" data-artifact="'+esc(a.id)+'">查看 '+esc(a.name)+'</button></div>'}).join("")
  document.getElementById("m-say-box").hidden=d.matter.kind==='companion'||d.matter.status==='archived'
  mSetButtons()
}
function mSchedule() { clearTimeout(mPoll);if(mActive&&mCurrent&&!document.hidden&&!mTooLarge)mPoll=setTimeout(mRefresh,3000) }
function mRefresh() {
  clearTimeout(mPoll);if(!mActive||!mCurrent||document.hidden)return Promise.resolve()
  var id=mCurrent,seq=++mSeq
  return mApi('/m/api/matter?id='+encodeURIComponent(id)).then(function(d){if(mCurrent===id&&seq===mSeq&&d.matter.id===id)renderMatter(d)}).catch(function(e){if(mCurrent===id&&seq===mSeq){
    if(e.message==='detail_too_large'){mTooLarge=true;mDetail=null;mQuestionKey="";['m-permissions','m-questions','m-events','m-artifacts','m-inputs'].forEach(function(key){document.getElementById(key).replaceChildren()});mClearPreview();mSetButtons()}
    mNotice(mError(e.message))
  }}).finally(function(){if(mCurrent===id&&seq===mSeq)mSchedule()})
}
function openMatter(id) {
  if(mCurrent!==id){mSeq++;mDetail=null;mTooLarge=false;mQuestionKey="";mClearPreview();document.getElementById("m-events").replaceChildren();document.getElementById("m-permissions").replaceChildren();document.getElementById("m-questions").replaceChildren();document.getElementById("m-artifacts").replaceChildren();document.getElementById('m-inputs').replaceChildren();mSetButtons();mNotice("");document.getElementById("m-title").textContent="正在读…"}
  mCurrent=id;mActive=true
  var draft=mRead(id+":say");document.getElementById("m-say").value=draft&&typeof draft.text==='string'?draft.text:""
  document.getElementById("m-list").hidden=true;document.getElementById("m-detail").hidden=false
  return mRefresh()
}
function mDecision(control,request) {
  var id=mCurrent,runId=mDetail&&mDetail.runId,key=id+":"+request.id
  if(!id||!runId||request.taskId!==id||mBusy[key])return
  var answers=null
  if(control==='answer'){
    var draft=mQuestionDraft(request);answers={}
    request.questions.forEach(function(q){var v=draft[q.id]||{},selected=Array.isArray(v.selected)?v.selected.slice():[],other=typeof v.other==='string'?v.other.trim():'';if(q.allowOther&&other)selected=q.multiSelect?selected.concat([other]):[other];answers[q.id]=selected})
    if(request.questions.some(function(q){return !answers[q.id].length||(!q.multiSelect&&answers[q.id].length!==1)||answers[q.id].some(function(a){return !a||a.length>4000})})){mNotice(mError('invalid_answer'));return}
  }
  var permission=control==='allow'||control==='deny',body={id:id,runId:runId,requestId:request.id}
  if(permission)body.decision=control;else body.answers=answers
  mBusy[key]=true;mSetButtons();mNotice("正在提交…")
  mApi('/m/api/matter/'+(permission?'permission':'answer'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(){if(!permission)mWrite(id+":question:"+request.id,null);if(mCurrent===id)mNotice("已提交")}).catch(function(e){if(mCurrent===id)mNotice(mError(e.message))}).finally(function(){delete mBusy[key];if(mCurrent===id){mSetButtons();mRefresh()}})
}
document.getElementById("m-controls").addEventListener("click",function(ev){var b=ev.target.closest('[data-control]');if(!b||!mDetail)return;var request=(b.dataset.control==='allow'||b.dataset.control==='deny'?mDetail.permissions:mDetail.questions||[]).find(function(r){return r.id===b.dataset.request&&r.taskId===b.dataset.task});if(request)mDecision(b.dataset.control,request)})
document.getElementById("m-questions").addEventListener("input",function(ev){
  var el=ev.target,card=el.closest('[data-question-request]');if(!card||!mDetail)return
  var request=(mDetail.questions||[]).find(function(r){return r.id===card.dataset.questionRequest}),qid=el.dataset.answerChoice||el.dataset.answerOther;if(!request||!qid)return
  var q=request.questions.find(function(q){return q.id===qid}),draft=mQuestionDraft(request),v=draft[qid]||{selected:[],other:""};if(!q)return
  if(el.dataset.answerOther){v.other=el.value;if(!q.multiSelect&&el.value){v.selected=[];card.querySelectorAll('[data-answer-choice]').forEach(function(i){if(i.dataset.answerChoice===qid)i.checked=false})}}
  else{v.selected=Array.from(card.querySelectorAll('[data-answer-choice]')).filter(function(i){return i.dataset.answerChoice===qid&&i.checked}).map(function(i){return i.value});if(!q.multiSelect){v.other="";card.querySelectorAll('[data-answer-other]').forEach(function(i){if(i.dataset.answerOther===qid)i.value=""})}}
  draft[qid]=v;mWrite(mCurrent+":question:"+request.id,draft)
})
document.getElementById("m-say").addEventListener("input",function(){if(mCurrent)mWrite(mCurrent+":say",{text:this.value})})
document.getElementById("m-send").addEventListener("click",function(){
  var id=mCurrent,text=document.getElementById("m-say").value.trim(),key=id+":say"
  if(!id||!text||!mDetail||mBusy[key])return
  var prior=mRead(id+":say"),draft=prior&&prior.requestId&&prior.text===text?prior:{text:text,requestId:mUuid(),...(mDetail.runId?{runId:mDetail.runId}:{})}
  mWrite(id+":say",draft);mBusy[key]=true;mSetButtons();mNotice("正在发送…")
  mApi('/m/api/matter/say',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,...draft})}).then(function(r){
    if(r.result&&r.result.kind==='task'){
      var input=r.result.input
      if(input){if(input.taskId!==id||input.id!==draft.requestId||(draft.runId&&input.runId!==draft.runId))throw new Error('input_conflict');mObserveInput(id,input,true)}
      else if(mCurrent===id)mNotice('补充已受理，等待执行者确认。')
      return
    }
    if((mRead(id+":say")||{}).requestId===draft.requestId){mWrite(id+":say",null);if(mCurrent===id)document.getElementById("m-say").value=""}
    if(mCurrent===id)mNotice("已送达")
  }).catch(function(e){if(mCurrent===id)mNotice(mError(e.message))}).finally(function(){delete mBusy[key];if(mCurrent===id){mSetButtons();mRefresh()}})
})
document.getElementById('m-inputs').addEventListener('click',function(ev){
  var b=ev.target.closest('[data-restore-input]');if(!b||!mDetail||mTooLarge)return
  var input=(mDetail.inputs||[]).find(function(r){return r.taskId===mCurrent&&r.id===b.dataset.restoreInput})
  if(!input)return
  var ta=document.getElementById('m-say')
  if(ta.value.trim()&&ta.value.trim()!==input.text){mNotice('输入框里还有新的补充。原文保留在这条记录中，清空输入框后可以取回。');return}
  ta.value=input.text;mWrite(mCurrent+':say',{requestId:input.id,runId:input.runId,text:input.text});mNotice(M_INPUT_STATUS[input.status])
})
document.getElementById("m-list").addEventListener("click",function(ev){var c=ev.target.closest('[data-mid]');if(c)openMatter(c.dataset.mid)})
document.getElementById("m-back").addEventListener("click",function(){mSeq++;mCurrent=null;mDetail=null;clearTimeout(mPoll);mClearPreview();document.getElementById("m-detail").hidden=true;document.getElementById("m-list").hidden=false;loadMatters()})
document.querySelectorAll('nav button[data-p]').forEach(function(b){b.addEventListener('click',function(){mActive=b.dataset.p==='matters';clearTimeout(mPoll);if(mActive){if(mCurrent)mRefresh();else loadMatters()}})})
document.addEventListener('visibilitychange',function(){clearTimeout(mPoll);if(!document.hidden&&mActive)mRefresh()})
window.addEventListener('pagehide',function(){clearTimeout(mPoll);mSeq++})
window.addEventListener('pageshow',function(){if(mActive)mRefresh()})
// Web Crypto is unavailable on a LAN HTTP origin. The fallback verifies the same
// SHA-256 bytes there, without loading third-party code or weakening verification.
async function mSha256(bytes) {
  if(crypto.subtle){var digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),function(b){return b.toString(16).padStart(2,'0')}).join('')}
  var k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  var h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],data=new Uint8Array(Math.ceil((bytes.length+9)/64)*64),w=new Int32Array(64)
  data.set(bytes);data[bytes.length]=128;new DataView(data.buffer).setUint32(data.length-4,bytes.length*8)
  function ro(x,n){return(x>>>n)|(x<<(32-n))}
  for(var off=0;off<data.length;off+=64){
    for(var i=0;i<16;i++)w[i]=(data[off+i*4]<<24)|(data[off+i*4+1]<<16)|(data[off+i*4+2]<<8)|data[off+i*4+3]
    for(var i=16;i<64;i++){var x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(ro(x,7)^ro(x,18)^(x>>>3))+w[i-7]+(ro(y,17)^ro(y,19)^(y>>>10)))|0}
    var a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7]
    for(var i=0;i<64;i++){var t1=(hh+(ro(e,6)^ro(e,11)^ro(e,25))+((e&f)^(~e&g))+k[i]+w[i])|0,t2=((ro(a,2)^ro(a,13)^ro(a,22))+((a&b)^(a&c)^(b&c)))|0;hh=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0}
    var v=[a,b,c,d,e,f,g,hh];for(var i=0;i<8;i++)h[i]=(h[i]+v[i])|0
  }
  return h.map(function(x){return(x>>>0).toString(16).padStart(8,'0')}).join('')
}
async function mArtifact(artifact) {
  var id=mCurrent,key=id+":artifact:"+artifact.id
  if(mBusy[key]||artifact.taskId!==id)return
  mBusy[key]=true;mNotice("正在读取成果…")
  try{
    if(!Number.isSafeInteger(artifact.size)||artifact.size<0||artifact.size>8*1024*1024)throw new Error('artifact_checksum')
    var bytes=new Uint8Array(artifact.size),offset=0
    do{
      var p=await mApi('/m/api/matter/artifact?id='+encodeURIComponent(id)+'&artifactId='+encodeURIComponent(artifact.id)+'&sha256='+encodeURIComponent(artifact.sha256)+'&offset='+offset)
      if(mCurrent!==id)return
      var bin=atob(p.contentBase64)
      if(p.taskId!==id||p.artifactId!==artifact.id||p.sha256!==artifact.sha256||p.size!==artifact.size||p.offset!==offset||bin.length>128*1024||p.nextOffset!==offset+bin.length||p.nextOffset>bytes.length||(bin.length===0&&offset<bytes.length))throw new Error('artifact_checksum')
      for(var i=0;i<bin.length;i++)bytes[offset+i]=bin.charCodeAt(i)
      offset=p.nextOffset
    }while(offset<bytes.length)
    if(await mSha256(bytes)!==artifact.sha256)throw new Error('artifact_checksum')
    if(mCurrent!==id)return
    mClearPreview();var preview=document.getElementById('m-artifact-preview'),title=document.createElement('p');title.textContent=artifact.name;preview.appendChild(title)
    var imageMime=['image/png','image/jpeg','image/webp'].indexOf(artifact.mime)>=0
    if(imageMime){var imageUrl=URL.createObjectURL(new Blob([bytes],{type:artifact.mime}));mObjectUrls.push(imageUrl);var img=document.createElement('img');img.src=imageUrl;img.alt=artifact.name;img.style.maxWidth='100%';preview.appendChild(img)}
    else if(/^text\//.test(artifact.mime)||artifact.mime==='application/json'){var pre=document.createElement('pre');pre.className='m-description';pre.textContent=new TextDecoder().decode(bytes.subarray(0,200000))+(bytes.length>200000?'\n（预览已截断，下载可查看完整文件）':'');preview.appendChild(pre)}
    var download=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));mObjectUrls.push(download);var link=document.createElement('a');link.href=download;link.download=artifact.name;link.textContent='下载 '+artifact.name;preview.appendChild(link);mNotice("文件已完整校验")
  }catch(e){if(mCurrent===id)mNotice(mError(e.message))}finally{delete mBusy[key]}
}
document.getElementById('m-artifacts').addEventListener('click',function(ev){var b=ev.target.closest('[data-artifact]');if(!b||!mDetail)return;var a=(mDetail.artifacts||[]).find(function(a){return a.id===b.dataset.artifact&&a.taskId===mCurrent});if(a)mArtifact(a)})
`
