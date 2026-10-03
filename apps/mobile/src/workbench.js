
var M_STATUS = { open: "进行中", replied: "已答复", done: "已了结", archived: "已归档" }
var M_KIND = { task: "任务", chat: "对话", companion: "陪伴" }
var M_INPUT_STATUS={pending:"补充已保存，等待执行者接收。",sending:"补充正在发送，等待执行者确认。",delivered:"这条补充已送达。",held:"未确认送达，请先查看任务记录。原文已保留。",withdrawn:"这条补充已撤回，原文已保留。"},mInputStates={}
var mCurrent = null, mDetail = null, mPoll = null, mSeq = 0, mActive = false, mBusy = {}, mQuestionKey = "", mObjectUrls = [], mTooLarge = false
var mDetailFresh = false, mConnectionEpoch = 0, mOffline = false
var mAutoPreview = ''
// A round trip may finish after leaving and returning to the same task.
var mHandoffViewEpoch = 0
/** 最后一次真正联系上 daemon 的时刻。断网时它会停住变旧 —— 这正是"你看到的是几点的样子"要报的那个数。 */
var mLastOkAt = null
/** 连续几次没联系上才浮提示:一次抖动不打扰人。按"次数"而不是"过了多久"判 ——
 * 重算只发生在有请求的时候,按时长判会出现"门槛到了却没人算"的空窗。 */
var M_STALE_MISSES = 2, mMisses = 0
/** 提交失败、生死不明的请求,按任务保存到下一次读到详情,不落盘。
 * 重连后只报告请求是否仍在等待,消失不代表本次提交成功;绝不自动重发:
 * 权限这种事不该在人走开之后被静默重发。(「接着说」不走这条:它有自己的
 * pending/sending/delivered/held 状态在报。) */
var mUnsure = {}
var mStorage = "cc.phone.matter.v1:" + (REMOTE ? REMOTE.id : location.host) + ":"
function mRead(key) { try { return JSON.parse(localStorage.getItem(mStorage + key) || "null") } catch (e) { return null } }
function mWrite(key,value) { try { if (value === null) localStorage.removeItem(mStorage + key); else localStorage.setItem(mStorage + key,JSON.stringify(value));return true } catch (e) {return false} }
// One visible upload control; submitted snapshots survive independently of the editable draft.
var mMaterials = null
function mMaterialSignature(items) { return JSON.stringify((items||[]).map(function(a){return[a.id,a.sha256,a.size]})) }
function mMaterialViews(items) { return (items||[]).map(function(a){return{id:a.id,name:a.name,mime:a.mime,size:a.size,sha256:a.sha256}}) }
function mMaterialCards(items) { return (items||[]).map(function(a){return '<p class="m-material">'+esc(a.name)+' <small>'+Math.ceil(a.size/1024)+' KB</small></p>'}).join('') }
function mPending(id) {
  var rows=mRead(id+':say-pending')||[],legacy=mRead(id+':say')
  if(legacy&&legacy.requestId&&!rows.some(function(r){return r.requestId===legacy.requestId}))rows=rows.concat([legacy])
  return rows
}
function mSavePending(id,draft) { var rows=mPending(id).filter(function(r){return r.requestId!==draft.requestId});rows.push(draft);return mWrite(id+':say-pending',rows) }
function mDisposeMaterials() { if(mMaterials){mMaterials.control.dispose();document.getElementById('m-say-materials').replaceChildren()};mMaterials=null }
function mMountMaterials(id) {
  if(typeof createPhoneAttachments!=='function'||mCurrent!==id||!mDetail||mDetail.matter.kind!=='task')return
  var draft=mRead(id+':say')||{text:/** @type {HTMLTextAreaElement} */ (document.getElementById('m-say')).value}
  if(!draft.draftId){draft.draftId=mUuid();mWrite(id+':say',draft)}
  if(mMaterials&&mMaterials.taskId===id&&mMaterials.draftId===draft.draftId)return
  mDisposeMaterials()
  var draftId=draft.draftId,control=createPhoneAttachments({draftId:draftId,taskId:id,onChange:function(){
    var current=mRead(id+':say')
    if(!current||current.draftId!==draftId)return
    current.attachments=mMaterialViews(control.items());mWrite(id+':say',current)
    if(mCurrent===id)mSetButtons()
  }})
  mMaterials={taskId:id,draftId:draftId,control:control}
  control.mount(document.getElementById('m-say-materials'))
}
function mAcknowledgeMaterials(id,draft) {
  if(!draft.draftId||typeof createPhoneAttachments!=='function')return
  var visible=mMaterials&&mMaterials.taskId===id&&mMaterials.draftId===draft.draftId
  var control=visible?mMaterials.control:createPhoneAttachments({draftId:draft.draftId,taskId:id})
  control.acknowledge((draft.attachments||[]).map(function(a){return a.id}))
  if(!visible)control.dispose()
}
function mMatchesInput(id,draft,input) {
  return !!draft&&input.taskId===id&&input.id===draft.requestId&&typeof input.runId==='string'&&!!input.runId&&(!draft.runId||draft.runId===input.runId)&&draft.text.trim()===input.text&&mMaterialSignature(draft.attachments)===mMaterialSignature(input.attachments)
}
function mMatchesDraft(current,snapshot) {
  return !!current&&!!snapshot&&current.requestId===snapshot.requestId&&current.draftId===snapshot.draftId&&current.text.trim()===snapshot.text.trim()&&mMaterialSignature(current.attachments)===mMaterialSignature(snapshot.attachments)
}
function mUuid() {
  var bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  var h = Array.from(bytes,function(b){return b.toString(16).padStart(2,"0")}).join("")
  return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)
}
function mNotice(message) { document.getElementById("m-notice").textContent = message }
function mClock(ts) { var d = new Date(ts); return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0") }
/** 平时不在;超过门槛没联系上才浮出来,恢复后自己消失(列表页与详情页共用这一行)。 */
function mConn() {
  var el = document.getElementById("m-conn"), stale = mMisses >= M_STALE_MISSES
  el.hidden = !stale
  el.textContent = stale ? (mLastOkAt===null?"还没有连上 CC，请检查电脑连接。":"连不上 CC —— 你看到的是 " + mClock(mLastOkAt) + " 的样子") : ""
}
function mError(code) {
  if (code === "provider_quota_exhausted") return "这位执行者的额度暂时用完了。你的补充已保留，可以查看任务中的接手选择，或等额度恢复后再继续。"
  if (code === "execution_model_unsupported") return "请在桌面为这件事选择账号可用的模型后继续。你的补充已保留。"
  if (code === "quota_handoff_changed") return "接手者刚变了，请查看当前选择，再重新确认。"
  if (code === "quota_handoff_not_needed") return "这件事现在不需要额度接手，请查看当前进展。"
  if (code === "quota_handoff_unavailable") return "目前没有可用的接手者，可以等额度恢复后再继续。"
  if (code === "invalid_entry_owner") return "这件事的主人身份未确认，请到桌面检查后再继续。"
  if (code === "creation_conflict") return "这次接手确认与已有请求不一致，请查看任务记录或到桌面处理。"
  if (code === "native_session_busy" || code === "native_folder_busy") return "电脑上的会话或文件夹正在使用，请先在电脑结束它，再查看当前任务。"
  if (code === "invalid_path") return "电脑上找不到这个任务的文件夹了，请到桌面检查后继续。"
  if (code === "unavailable_provider") return "电脑上的执行者暂不可用，请到桌面检查连接后继续。"
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
function mApi(path,opts,sender) {
  var timer, epoch=mConnectionEpoch, pageId=mCurrent, pageEpoch=mHandoffViewEpoch
  return Promise.race([(sender||api)(path,opts).then(function(r){return r.json().then(function(b){if (!r.status || r.status < 400) { if (b.ok) return b }; throw Object.assign(new Error(b.error || "unavailable"),{status:r.status})})}),new Promise(function(_r,reject){timer=setTimeout(function(){reject(new Error("timeout"))},15000)})])
    .then(function(b){
      // 只在"从断线里回来"这一下清提示:断线期间那条错误不清就会赖到下一次操作,
      // 让人以为刚才的动作失败了。平时成功不动它 —— 否则会把"已提交""补充已送达"
      // 这些该留着的话一起抹掉。
      if(epoch!==mConnectionEpoch||mOffline)return b
      var recovered = mMisses > 0
      mLastOkAt=Date.now();mMisses=0;mConn();if(recovered&&mCurrent===pageId&&mHandoffViewEpoch===pageEpoch)mNotice("")
      return b
    },function(e){if(epoch===mConnectionEpoch){if(e.status>=400){mLastOkAt=Date.now();mMisses=0}else mMisses++;if(mCurrent===pageId&&mHandoffViewEpoch===pageEpoch)mDetailFresh=false;mConn();mSetButtons()}throw e})
    .finally(function(){clearTimeout(timer)})
}
function mClearPreview() { mObjectUrls.forEach(function(u){URL.revokeObjectURL(u)});mObjectUrls=[];document.getElementById("m-artifact-preview").replaceChildren() }
function mSetButtons() {
  document.querySelectorAll('#m-task-status [data-handoff]').forEach(function(/** @type {HTMLButtonElement} */ b){b.disabled=!mDetailFresh||mTooLarge||mOffline||!!mBusy[mCurrent+':handoff']})
  document.querySelectorAll("#m-controls button[data-request]").forEach(function(/** @type {HTMLButtonElement} */ b){b.disabled=!mDetailFresh||!!mBusy[b.dataset.task+":"+b.dataset.request]})
  document.querySelectorAll("#m-questions [data-question-request]").forEach(function(/** @type {HTMLElement} */ card){var disabled=!!mBusy[mCurrent+":"+card.dataset.questionRequest];card.querySelectorAll('input,textarea').forEach(function(/** @type {HTMLInputElement} */ input){input.disabled=disabled})})
  var send=/** @type {HTMLButtonElement} */ (document.getElementById("m-send")),say=/** @type {HTMLTextAreaElement} */ (document.getElementById("m-say"))
  send.disabled=!mDetailFresh||!mDetail||mTooLarge||!!mBusy[mCurrent+":say"]||!!(mMaterials&&!mMaterials.control.isReady())
  say.disabled=mTooLarge
}
function loadMatters() {
  mApi("/m/api/matters?status=open,replied,done").then(function(r){
    document.getElementById("m-list").innerHTML=r.matters.filter(function(m){return m.kind!=="companion"}).map(function(m){return '<button type="button" class="card todo" data-mid="'+esc(m.id)+'"><span class="tx"><b>'+esc(m.title)+'</b><small>'+esc(M_KIND[m.kind]||m.kind)+' · '+esc(M_STATUS[m.status]||m.status)+(m.projectPath?' · '+esc(m.projectPath.split(/[\\/]/).filter(Boolean).pop()||m.projectPath):'')+'</small></span></button>'}).join("") || '<div class="empty">还没有事，微信或桌面上交代一件就会出现在这里</div>'
  }).catch(function(e){document.getElementById("m-list").textContent=mError(e.message)})
}
function mQuestionDraft(request) { return mRead(mCurrent+":question:"+request.id) || {} }
function mObserveInput(id,input,notify) {
  if(!input||input.taskId!==id||!M_INPUT_STATUS[input.status])return false
  var known=mCurrent===id&&mDetail&&(mDetail.inputs||[]).find(function(r){return r.taskId===id&&r.id===input.id&&r.runId===input.runId})
  if(known&&['held','withdrawn','delivered'].indexOf(known.status)>=0&&['pending','sending'].indexOf(input.status)>=0)input=known
  var key=id+':'+input.id,changed=mInputStates[key]!==input.status,snapshot=mPending(id).find(function(r){return r.requestId===input.id})
  if(!mMatchesInput(id,snapshot,input))return false
  var current=mRead(id+':say'),matches=mMatchesDraft(current,snapshot)
  mInputStates[key]=input.status;snapshot.runId=input.runId;snapshot.status=input.status
  if(input.status==='delivered'){
    if(matches)mWrite(id+':say',null)
    mWrite(id+':say-pending',mPending(id).filter(function(r){return r.requestId!==input.id}))
    mAcknowledgeMaterials(id,snapshot)
    if(matches&&mCurrent===id){
      var field=/** @type {HTMLTextAreaElement} */ (document.getElementById('m-say'))
      if(field.value.trim()===input.text)field.value=''
      mDisposeMaterials();mMountMaterials(id)
    }
  }else{
    mSavePending(id,snapshot)
    if(matches)mWrite(id+':say',snapshot)
  }
  if(mCurrent===id&&(notify||(matches&&changed)))mNotice(M_INPUT_STATUS[input.status])
  return true
}
function mRenderInputs(d) {
  var inputs=(d.inputs||[]).filter(function(input){return input.taskId===d.matter.id&&M_INPUT_STATUS[input.status]})
  inputs.forEach(function(input){mObserveInput(d.matter.id,input,false)})
  var local=mPending(d.matter.id).filter(function(p){return !inputs.some(function(input){return input.id===p.requestId})}).map(function(p){return '<div class="card"><b>'+esc(M_INPUT_STATUS[p.status]||'正在确认是否收到，原文和材料已保留。')+'</b><pre class="m-description">'+esc(p.text)+'</pre>'+mMaterialCards(p.attachments)+'<button type="button" class="more" data-restore-input="'+esc(p.requestId)+'">取回这条补充</button></div>'}).join('')
  document.getElementById('m-inputs').innerHTML=local+inputs.filter(function(input){return input.status!=='delivered'}).map(function(input){return '<div class="card"><b>'+esc(M_INPUT_STATUS[input.status])+'</b><pre class="m-description">'+esc(input.text)+'</pre>'+mMaterialCards(input.attachments)+'<button type="button" class="more" data-restore-input="'+esc(input.id)+'">取回这条补充</button></div>'}).join('')
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
/** A disappearing request is not a receipt: another device or expiry may have removed it. */
function mSettleUnsure(d) {
  var unsure=mUnsure[d.matter.id];if(!unsure)return
  var pending=d.runId===unsure.runId&&(d.permissions||[]).concat(d.questions||[]).some(function(r){return r.taskId===d.matter.id&&r.id===unsure.requestId})
  delete mUnsure[d.matter.id]
  mNotice(pending?"这项请求仍在等待。请确认当前内容，再决定是否提交。":"这项请求已结束或被其他设备处理，无法确认刚才的提交是否生效。请查看任务记录。")
}
function mProviderName(id) { return ({claude:'Claude Code',codex:'Codex',cursor:'Cursor',agy:'Antigravity'})[id]||id }
function mHandoffView(value) {
  if(!value||typeof value.from!=='string'||!/^[a-z][a-z0-9._-]{0,63}$/.test(value.from))return null
  if(value.state==='handed')return typeof value.to==='string'&&/^[a-z][a-z0-9._-]{0,63}$/.test(value.to)&&typeof value.matterId==='string'&&/^[a-f0-9]{8}$/.test(value.matterId)?value:null
  if((value.state!=='offer'&&value.state!=='none')||['quota','rate_limit'].indexOf(value.kind)<0||!Number.isFinite(value.resetAt))return null
  return value.state==='none'||typeof value.to==='string'&&/^[a-z][a-z0-9._-]{0,63}$/.test(value.to)?value:null
}
function mHandoffSignature(view) { return JSON.stringify([view.from,view.to,view.kind]) }
function mHandoffCurrentSignature(view) { return view?mHandoffSignature(view):'none' }
function mHandoffPending(id) {
  var record=mRead(id+':quota-handoff')
  if(!record)return null
  return typeof record.requestId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.requestId)&&mHandoffView(record.offer)&&record.offer.state==='offer'&&record.providerId===record.offer.to?record:{invalid:true}
}
function mQuotaText(view) {
  var wait=Math.max(1,Math.ceil((view.resetAt-Date.now())/60000))
  return mProviderName(view.from)+(view.kind==='rate_limit'?' 暂时受限，请求太频繁了。':' 的额度已用完。')+'预计约 '+wait+' 分钟后可再试。'
}
function mRenderHandoff(d) {
  var root=document.getElementById('m-task-status'),view=mHandoffView(d.quotaHandoff),pending=mHandoffPending(d.matter.id),html=''
  if(d.task&&d.task.error==='execution_model_unsupported')html='<p class="m-task-note">请在桌面为这件事选择账号可用的模型后继续。</p>'
  if(d.matter.kind==='task'&&(view||pending)){
    if(view&&view.state==='handed')html+='<div class="m-handoff"><p>已经交给 '+esc(mProviderName(view.to))+' 继续。</p><button type="button" class="done-btn" data-handoff="open" data-task="'+esc(d.matter.id)+'">打开接手的任务</button></div>'
    else{
      html+='<div class="m-handoff"><p>'+esc(view?mQuotaText(view):'当前任务已不再显示额度接手选择。')+'</p>'
      if(view&&view.state==='none')html+='<p>目前没有可用的接手者，可以等额度恢复后再继续。</p>'
      if(pending)html+='<p>'+(pending.invalid?'这台手机保存的接手确认不完整，无法安全重试。请刷新查看结果，或到桌面处理。':'上次交给 '+esc(mProviderName(pending.providerId))+' 继续的结果还未确认。原确认已保留；先核对当前情况，再由你决定是否重试。')+'</p>'
      if(view&&view.state==='offer')html+='<p>可以让 '+esc(mProviderName(view.to))+' 在电脑上同一个文件夹里新开一件事接着做。确认前会再核对一次。</p>'
      if((view&&view.state==='offer'||pending)&&!(pending&&pending.invalid))html+='<button type="button" class="done-btn" data-handoff="confirm" data-task="'+esc(d.matter.id)+'" data-handoff-offer="'+esc(mHandoffCurrentSignature(view))+'">'+(pending?view&&view.state==='offer'&&mHandoffSignature(pending.offer)===mHandoffSignature(view)?'核对并重试交给 '+esc(mProviderName(pending.providerId))+' 继续':'核对上次交给 '+esc(mProviderName(pending.providerId))+' 的结果':'交给 '+esc(mProviderName(view.to))+' 继续')+'</button>'
      else html+='<button type="button" class="more" data-handoff="refresh" data-task="'+esc(d.matter.id)+'">刷新查看</button>'
      html+='</div>'
    }
  }
  if(root.innerHTML!==html)root.innerHTML=html
}
function mHandoffVisible(id,epoch) { return mCurrent===id&&mHandoffViewEpoch===epoch&&mActive&&!document.hidden&&!mOffline }
/** A POST selects one transport once. A lost LAN reply must never send it again through the tunnel. */
function mHandoffSend(path,opts) {
  if(preferTunnel&&REMOTE)return tunnel().then(function(send){return send(path,opts)})
  var ctrl=new AbortController(),timer=setTimeout(function(){ctrl.abort()},2500)
  return fetch(q(path),Object.assign({signal:ctrl.signal},opts)).catch(function(e){if(REMOTE)preferTunnel=true;throw e}).finally(function(){clearTimeout(timer)})
}
async function mHandoff(action,shown) {
  var id=mCurrent,epoch=mHandoffViewEpoch,key=id+':handoff',post=false
  if(!id||!mDetail||mDetail.matter.id!==id||!mDetailFresh||mTooLarge||mOffline||mBusy[key])return
  mBusy[key]=true;clearTimeout(mPoll);++mSeq;mSetButtons();mNotice('正在核对接手情况…')
  try{
    var d=await mApi('/m/api/matter?id='+encodeURIComponent(id))
    if(!mHandoffVisible(id,epoch))return
    if(!d.matter||d.matter.id!==id||d.matter.kind!=='task')throw new Error('handoff_detail_mismatch')
    renderMatter(d)
    var view=mHandoffView(d.quotaHandoff)
    if(view&&view.state==='handed'){if(view.matterId===id)throw new Error('handoff_detail_mismatch');mWrite(id+':quota-handoff',null);await openMatter(view.matterId);return}
    if(action==='refresh'){mNotice('已核对当前情况。');return}
    var pending=mHandoffPending(id)
    if(pending&&pending.invalid){mNotice('原接手确认不完整，无法安全重试。请刷新查看结果，或到桌面处理。');return}
    if(!pending&&(!view||view.state!=='offer')){mNotice(mError(view&&view.state==='none'?'quota_handoff_unavailable':'quota_handoff_not_needed'));return}
    if(action!=='confirm'||shown!==mHandoffCurrentSignature(view)){mNotice('接手者或额度情况刚变了，请查看当前选择，再重新确认。');return}
    var confirmed=pending?pending.offer:view,to=mProviderName(confirmed.to),from=mProviderName(confirmed.from),changed=pending&&(!view||view.state!=='offer'||mHandoffSignature(pending.offer)!==mHandoffSignature(view))
    var message=(view?mQuotaText(view):'当前任务已不再显示额度接手选择。')+'\n\n会在你电脑上同一个文件夹里，让 '+to+' 新开一件事接着做；原来这件留着。\n\n'+to+' 看不到 '+from+' 之前的对话，只拿到这件事的标题和“接着原来的要求做”。\n\n会用掉 '+to+' 的额度。'+(pending?'\n\n这次重试沿用上次确认；如果已经交出，会打开已有的接手任务。':'')+(changed?'\n\n'+(view&&view.state==='offer'?'当前可接手者已变为 '+mProviderName(view.to)+'。':'当前情况已改变。')+'这次先核对上次交给 '+to+' 的结果，原确认不会改成新的接手者。':'')+'\n\n'+(changed?'确认核对上次接手结果？':'确认交给 '+to+' 继续？')
    if(!window.confirm(message)){if(mHandoffVisible(id,epoch))mNotice('尚未交给 '+to+' 继续。');return}
    if(!mHandoffVisible(id,epoch))return
    var record=pending||{requestId:mUuid(),providerId:view.to,offer:view}
    if(!mWrite(id+':quota-handoff',record)){mNotice('这台手机暂时无法保存接手确认，请恢复存储后再试。');return}
    post=true;mNotice('正在交给 '+to+' 继续…')
    var result=await mApi('/m/api/matter/handoff',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,requestId:record.requestId,providerId:record.providerId})},mHandoffSend)
    if(typeof result.matterId!=='string'||!/^[a-f0-9]{8}$/.test(result.matterId)||result.matterId===id||typeof result.created!=='boolean')throw new Error('handoff_receipt_mismatch')
    mWrite(id+':quota-handoff',null)
    if(mHandoffVisible(id,epoch))await openMatter(result.matterId)
  }catch(e){
    if(!mHandoffVisible(id,epoch))return
    // Only named, definitive rejections end this confirmation. Unknown responses keep its exact identity.
    var rejected=['quota_handoff_changed','quota_handoff_not_needed','quota_handoff_unavailable','provider_quota_exhausted','workbench_busy','native_session_busy','native_folder_busy','invalid_path','unavailable_provider','invalid_entry_owner','creation_conflict','matter_not_found','invalid_request','invalid_provider'].indexOf(e.message)>=0&&e.status>=400
    if(post&&rejected)mWrite(id+':quota-handoff',null)
    var message=post&&!rejected?'接手结果还未确认。原确认已保留，请刷新查看；只有你再次确认才会用同一请求重试。':mError(e.message)
    if(post){await mRefresh();if(!mHandoffVisible(id,epoch))return}
    if(mDetail)mRenderHandoff(mDetail)
    mNotice(message)
  }finally{delete mBusy[key];if(mHandoffVisible(id,epoch)){mSetButtons();mSchedule()}}
}
document.getElementById('m-task-status').addEventListener('click',function(ev){var b=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('[data-handoff]'));if(b&&b.dataset.task===mCurrent)return mHandoff(b.dataset.handoff,b.dataset.handoffOffer)})
/** A compact, non-control identity for keeping source sections open during polling. */
function mEventSourceKey(event) {
  var signature=JSON.stringify([event.createdAt,event.source||'',event.text]),hash=2166136261
  for(var i=0;i<signature.length;i++)hash=Math.imul(hash^signature.charCodeAt(i),16777619)
  return signature.length+':'+(hash>>>0).toString(36)
}
function mEventReading(node) {
  var document=node.ownerDocument,selection=document.getSelection(),active=document.activeElement
  if(active&&active!==document.body&&node.contains(active))return true
  if(selection&&!selection.isCollapsed)for(var i=0;i<selection.rangeCount;i++)try{if(selection.getRangeAt(i).intersectsNode(node))return true}catch(e){}
  if(node.matches('details[open]')||node.querySelector('details[open]'))return true
  return Array.from(node.querySelectorAll('pre,table')).some(function(reader){return reader.scrollLeft>0||reader.scrollTop>0})
}
function mPatchEventRows(root,html) {
  // Some contract tests supply a text-only host; the webview always has an ownerDocument.
  if(!root.ownerDocument){root.innerHTML=html;return}
  var template=root.ownerDocument.createElement('template');template.innerHTML=html
  var previous=new Map(Array.from(root.children).map(function(/** @type {HTMLElement} */ node){return[node.dataset.mRowKey,node]})),keep=new Set()
  var rows=Array.from(template.content.children).map(function(/** @type {HTMLElement} */ next){
    var old=previous.get(next.dataset.mRowKey),node=next
    if(old){
      var oldTimes=Array.from(old.querySelectorAll('[data-m-event-time]')),newTimes=Array.from(next.querySelectorAll('[data-m-event-time]')),times=newTimes.map(function(time){return time.textContent})
      // Relative age may change every poll; it must not replace the message being read.
      if(oldTimes.length===newTimes.length)newTimes.forEach(function(time,index){time.textContent=oldTimes[index].textContent})
      var unchanged=old.isEqualNode(next),reading=mEventReading(old)
      if(unchanged||reading){node=old;if(unchanged&&!reading)oldTimes.forEach(function(time,index){time.textContent=times[index]})}
      else newTimes.forEach(function(time,index){time.textContent=times[index]})
      // A changed message being used stays in place. The next normal poll retries using mDetail's latest events.
    }
    keep.add(node)
    return node
  })
  // Remove replaced rows before ordering: a changed earlier reply must not move later reading nodes.
  Array.from(root.childNodes).forEach(function(node){if(!keep.has(node))root.removeChild(node)})
  var cursor=root.firstChild
  rows.forEach(function(node){if(node===cursor)cursor=cursor.nextSibling;else root.insertBefore(node,cursor)})
}
function mRenderEvents(events) {
  var root=document.getElementById('m-events'),expanded=root.querySelectorAll('details.m-tool-events[open]').length>0
  var expandedSources=new Set(),sourceKeys={},rowKeys={}
  root.querySelectorAll('details.m-message-source[open]').forEach(function(/** @type {HTMLElement} */ source){expandedSources.add(source.dataset.eventKey)})
  var dialogue=events.filter(function(e){return ['user','text','error','system'].indexOf(e.kind)>=0}).map(function(e){
    var rowIdentity=mEventSourceKey({createdAt:e.createdAt,source:e.source,text:e.kind+':'+(e.id||'')}),rowOccurrence=rowKeys[rowIdentity]||0
    rowKeys[rowIdentity]=rowOccurrence+1
    var body=e.kind==='text'?'<div class="m-markdown">'+CCM.renderMarkdown(e.text)+'</div>':'<p>'+esc(e.text)+'</p>'
    if(e.kind==='error'&&typeof e.diagnostic==='string'&&e.diagnostic)body+='<details class="m-error-diagnostic"><summary>查看原始错误</summary><pre class="m-description"><code>'+esc(e.diagnostic).replace(/\r/g,'&#13;')+'</code></pre></details>'
    if(e.kind==='user'&&CCM.hasMarkdownFormatting(e.text)){
      // Matter events have no id; equal records use their occurrence to stay distinct.
      var identity=mEventSourceKey(e),occurrence=sourceKeys[identity]||0
      sourceKeys[identity]=occurrence+1
      var key=identity+':'+occurrence
      // A code child prevents HTML's pre-leading-LF rule; a CR entity keeps CRLF exact.
      body='<div class="m-markdown">'+CCM.renderMarkdown(e.text)+'</div><details class="m-message-source" data-event-key="'+esc(key)+'"'+(expandedSources.has(key)?' open':'')+'><summary>查看原文</summary><pre class="m-description"><code>'+esc(e.text).replace(/\r/g,'&#13;')+'</code></pre></details>'
    }
    return '<div class="card ev" data-m-row-key="'+rowIdentity+':'+rowOccurrence+'"><div class="k">'+(e.kind==='user'?'你':e.kind==='text'?'CC':'·')+'</div><div class="tx">'+body+mMaterialCards(e.attachments)+'<small data-m-event-time>'+esc(ago(new Date(e.createdAt).toISOString()))+'</small></div></div>'
  }).join('')
  var tools=events.filter(function(e){return e.kind==='tool_call'})
  var folded=tools.length?'<details class="m-tool-events" data-m-row-key="tools"'+(expanded?' open':'')+'><summary>工具记录（'+tools.length+'）</summary>'+tools.map(function(e){return '<div class="card"><pre class="m-description">'+esc(e.text)+'</pre><small data-m-event-time>'+esc(ago(new Date(e.createdAt).toISOString()))+'</small></div>'}).join('')+'</details>':''
  mPatchEventRows(root,dialogue+folded||'<div class="empty" data-m-row-key="empty">还没有对话记录</div>')
}
function renderMatter(d) {
  mDetail=d;mTooLarge=false;mDetailFresh=true
  document.getElementById("m-title").textContent=d.matter.title+" · "+(M_STATUS[d.matter.status]||d.matter.status)
  mRenderEvents(d.events||[])
  document.getElementById("m-permissions").innerHTML=(d.permissions||[]).filter(function(p){return p.taskId===d.matter.id}).map(function(p){return '<div class="card"><b>需要你允许这一次</b><p>'+esc(p.tool)+'</p><pre class="m-description">'+esc(p.description)+'</pre><button type="button" class="done-btn" data-control="allow" data-task="'+esc(d.matter.id)+'" data-request="'+esc(p.id)+'">允许这一次</button> <button type="button" class="more" data-control="deny" data-task="'+esc(d.matter.id)+'" data-request="'+esc(p.id)+'">拒绝</button></div>'}).join("")
  mRenderQuestions(d)
  mRenderInputs(d)
  mSettleUnsure(d)
  mRenderHandoff(d)
  document.getElementById("m-artifacts").innerHTML=(d.artifacts||[]).filter(function(a){return a.taskId===d.matter.id}).map(function(a){return '<div class="card"><b>'+esc(a.name)+'</b><small>已保存 · '+Math.ceil(a.size/1024)+' KB</small><button type="button" class="more" data-artifact="'+esc(a.id)+'">查看 '+esc(a.name)+'</button></div>'}).join("")
  document.getElementById("m-say-box").hidden=d.matter.kind==='companion'||d.matter.status==='archived'
  mMountMaterials(d.matter.id)
  mSetButtons()
  var preview=(d.artifacts||[]).find(function(a){return a.taskId===d.matter.id&&['image/png','image/jpeg','image/webp'].indexOf(a.mime)>=0&&a.size<=8*1024*1024})
  if(preview&&!(d.permissions||[]).length&&!(d.questions||[]).length){
    var previewKey=d.matter.id+':'+preview.id+':'+preview.sha256
    if(mAutoPreview!==previewKey){mAutoPreview=previewKey;mArtifact(preview)}
  }
}
function mSchedule() { clearTimeout(mPoll);if(mActive&&mCurrent&&!document.hidden&&!mTooLarge&&!mBusy[mCurrent+':handoff'])mPoll=setTimeout(mRefresh,3000) }
function mRefresh() {
  clearTimeout(mPoll);if(!mActive||!mCurrent||document.hidden||mOffline)return Promise.resolve()
  var id=mCurrent,seq=++mSeq
  return mApi('/m/api/matter?id='+encodeURIComponent(id)).then(function(d){if(mCurrent===id&&seq===mSeq&&d.matter.id===id)renderMatter(d)}).catch(function(e){if(mCurrent===id&&seq===mSeq){
    if(e.message==='detail_too_large'){mTooLarge=true;mDetail=null;mQuestionKey="";['m-permissions','m-questions','m-events','m-artifacts','m-inputs','m-task-status'].forEach(function(key){document.getElementById(key).replaceChildren()});mClearPreview();mSetButtons()}
    mNotice(mError(e.message))
  }}).finally(function(){if(mCurrent===id&&seq===mSeq)mSchedule()})
}
function openMatter(id) {
  mHandoffViewEpoch++
  mDetailFresh=false
  if(mCurrent!==id)mAutoPreview=''
  if(mCurrent!==id){mDisposeMaterials();mSeq++;mDetail=null;mTooLarge=false;mQuestionKey="";mClearPreview();document.getElementById("m-events").replaceChildren();document.getElementById("m-permissions").replaceChildren();document.getElementById("m-questions").replaceChildren();document.getElementById("m-artifacts").replaceChildren();document.getElementById('m-inputs').replaceChildren();document.getElementById('m-task-status').replaceChildren();mSetButtons();mNotice("");document.getElementById("m-title").textContent="正在读…"}
  mCurrent=id;mActive=true
  var draft=mRead(id+":say");/** @type {HTMLTextAreaElement} */ (document.getElementById("m-say")).value=draft&&typeof draft.text==='string'?draft.text:""
  document.getElementById("m-list").hidden=true;document.getElementById("m-detail").hidden=false
  return mRefresh()
}
function mDecision(control,request) {
  var id=mCurrent,runId=mDetail&&mDetail.runId,key=id+":"+request.id
  if(!id||!runId||!mDetailFresh||request.taskId!==id||mBusy[key])return
  var answers=null
  if(control==='answer'){
    var draft=mQuestionDraft(request);answers={}
    request.questions.forEach(function(q){var v=draft[q.id]||{},selected=Array.isArray(v.selected)?v.selected.slice():[],other=typeof v.other==='string'?v.other.trim():'';if(q.allowOther&&other)selected=q.multiSelect?selected.concat([other]):[other];answers[q.id]=selected})
    if(request.questions.some(function(q){return !answers[q.id].length||(!q.multiSelect&&answers[q.id].length!==1)||answers[q.id].some(function(a){return !a||a.length>4000})})){mNotice(mError('invalid_answer'));return}
  }
  var permission=control==='allow'||control==='deny',body={id:id,runId:runId,requestId:request.id}
  if(permission)body.decision=control;else body.answers=answers
  mBusy[key]=true;mSetButtons();mNotice("正在提交…")
  mApi('/m/api/matter/'+(permission?'permission':'answer'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(){if(!permission)mWrite(id+":question:"+request.id,null);if(mCurrent===id)mNotice("已提交")}).catch(function(e){mUnsure[id]={runId:runId,requestId:request.id};if(mCurrent===id)mNotice(mError(e.message))}).finally(function(){delete mBusy[key];if(mCurrent===id){mDetailFresh=false;mSetButtons();mRefresh()}})
}
document.getElementById("m-controls").addEventListener("click",function(ev){var b=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('[data-control]'));if(!b||!mDetail)return;var request=(b.dataset.control==='allow'||b.dataset.control==='deny'?mDetail.permissions:mDetail.questions||[]).find(function(r){return r.id===b.dataset.request&&r.taskId===b.dataset.task});if(request)mDecision(b.dataset.control,request)})
document.getElementById("m-questions").addEventListener("input",function(ev){
  var el=/** @type {HTMLInputElement} */ (ev.target),card=/** @type {HTMLElement} */ (el.closest('[data-question-request]'));if(!card||!mDetail)return
  var request=(mDetail.questions||[]).find(function(r){return r.id===card.dataset.questionRequest}),qid=el.dataset.answerChoice||el.dataset.answerOther;if(!request||!qid)return
  var q=request.questions.find(function(q){return q.id===qid}),draft=mQuestionDraft(request),v=draft[qid]||{selected:[],other:""};if(!q)return
  if(el.dataset.answerOther){v.other=el.value;if(!q.multiSelect&&el.value){v.selected=[];card.querySelectorAll('[data-answer-choice]').forEach(function(/** @type {HTMLInputElement} */ i){if(i.dataset.answerChoice===qid)i.checked=false})}}
  else{v.selected=Array.from(card.querySelectorAll('[data-answer-choice]')).filter(function(/** @type {HTMLInputElement} */ i){return i.dataset.answerChoice===qid&&i.checked}).map(function(/** @type {HTMLInputElement} */ i){return i.value});if(!q.multiSelect){v.other="";card.querySelectorAll('[data-answer-other]').forEach(function(/** @type {HTMLInputElement} */ i){if(i.dataset.answerOther===qid)i.value=""})}}
  draft[qid]=v;mWrite(mCurrent+":question:"+request.id,draft)
})
document.getElementById("m-say").addEventListener("input",function(){
  if(!mCurrent)return
  var prior=mRead(mCurrent+':say')||{},text=/** @type {HTMLTextAreaElement} */ (this).value
  if(prior.requestId){
    mSavePending(mCurrent,prior)
    mWrite(mCurrent+':say',{text:text,...(prior.draftId?{draftId:mUuid(),attachments:[]}: {})})
    mDisposeMaterials();mMountMaterials(mCurrent)
    if(prior.attachments&&prior.attachments.length)mNotice('当前文字是新草稿；已提交的材料留在上一条补充中。')
  }else mWrite(mCurrent+':say',Object.assign({},prior,{text:text}))
  mSetButtons()
})
document.getElementById("m-send").addEventListener("click",function(){
  var id=mCurrent,text=/** @type {HTMLTextAreaElement} */ (document.getElementById('m-say')).value.trim(),key=id+':say'
  if(!id||!mDetail||!mDetailFresh||mBusy[key]||mTooLarge)return
  var materials=mMaterials&&mMaterials.taskId===id?mMaterials.control:null
  if(materials&&!materials.isReady()){mNotice('材料还没准备好，请等上传完成后再发送。');return}
  var items=materials?mMaterialViews(materials.items()):[],prior=mRead(id+':say')||{}
  if(!text&&!items.length)return
  var draft=prior.requestId&&prior.text.trim()===text&&mMaterialSignature(prior.attachments)===mMaterialSignature(items)?prior:{text:text,requestId:mUuid(),...(mDetail.runId?{runId:mDetail.runId}:{}),...(materials?{draftId:mMaterials.draftId,attachments:items}:{})}
  var failure=''
  if(!mWrite(id+':say',draft)||!mSavePending(id,draft)){mNotice('这台手机暂时无法保存补充，原文和材料仍在，请恢复存储后重试。');return}
  try{if(materials)materials.freeze(items.map(function(a){return a.id}))}catch(e){mNotice('暂时无法保存材料状态，请保留草稿后重试。');return}
  mBusy[key]=true;mSetButtons();mNotice('正在发送…')
  var body={id:id,text:draft.text,requestId:draft.requestId,...(draft.runId?{runId:draft.runId}:{}),...(draft.draftId?{draftId:draft.draftId}:{}),...(draft.attachments&&draft.attachments.length?{attachmentIds:draft.attachments.map(function(a){return a.id})}:{})}
  mApi('/m/api/matter/say',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){
    if(r.result&&r.result.kind==='task'){
      var input=r.result.input
      if(input){if(!mMatchesInput(id,draft,input)||!mObserveInput(id,input,true))throw new Error('input_conflict')}
      else if(mCurrent===id)mNotice('补充已受理，等待执行者确认。')
      return
    }
    if(draft.attachments&&draft.attachments.length)throw new Error('input_conflict')
    if(mMatchesDraft(mRead(id+':say'),draft)){mWrite(id+':say',null);if(mCurrent===id)/** @type {HTMLTextAreaElement} */ (document.getElementById('m-say')).value=''}
    mWrite(id+':say-pending',mPending(id).filter(function(p){return p.requestId!==draft.requestId}))
    if(mCurrent===id)mNotice('已送达')
  }).catch(function(e){failure=mError(e.message);if(mCurrent===id)mNotice(failure)}).finally(function(){delete mBusy[key];if(mCurrent===id){mSetButtons();return mRefresh().then(function(){if(failure&&mCurrent===id)mNotice(failure)})}})
})
document.getElementById('m-inputs').addEventListener('click',function(ev){
  var b=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('[data-restore-input]'));if(!b||!mDetail||mTooLarge)return
  var local=mPending(mCurrent).find(function(p){return p.requestId===b.dataset.restoreInput})
  var input=(mDetail.inputs||[]).find(function(r){return r.taskId===mCurrent&&r.id===b.dataset.restoreInput})||local&&{id:local.requestId,taskId:mCurrent,runId:local.runId,text:local.text,status:local.status,attachments:local.attachments}
  if(!input)return
  var ta=/** @type {HTMLTextAreaElement} */ (document.getElementById('m-say'))
  if(ta.value.trim()&&ta.value.trim()!==input.text){mNotice('输入框里还有新的补充。原文保留在这条记录中，清空输入框后可以取回。');return}
  var current=mRead(mCurrent+':say'),snapshot=local||mPending(mCurrent).find(function(p){return mMatchesInput(mCurrent,p,input)})
  if(current&&current.attachments&&current.attachments.length&&!mMatchesDraft(current,snapshot||{})){mNotice('输入框里还有新的材料，原补充仍保留在记录中。');return}
  if(input.attachments&&input.attachments.length&&!snapshot){mNotice('原图文保留在这条记录中，请到桌面查看或重新选择材料。');return}
  ta.value=input.text;mWrite(mCurrent+':say',snapshot||{requestId:input.id,runId:input.runId,text:input.text});mDisposeMaterials();mMountMaterials(mCurrent);mNotice(M_INPUT_STATUS[input.status]||'原文和材料已取回，发送会继续核对同一条补充。')
})
document.getElementById("m-list").addEventListener("click",function(ev){var c=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('[data-mid]'));if(c)openMatter(c.dataset.mid)})
document.getElementById("m-back").addEventListener("click",function(){mHandoffViewEpoch++;mDisposeMaterials();mSeq++;mCurrent=null;mDetail=null;clearTimeout(mPoll);mClearPreview();document.getElementById("m-detail").hidden=true;document.getElementById("m-list").hidden=false;loadMatters()})
document.querySelectorAll('nav button[data-p]').forEach(function(/** @type {HTMLButtonElement} */ b){b.addEventListener('click',function(){mHandoffViewEpoch++;mActive=b.dataset.p==='matters';clearTimeout(mPoll);if(mActive){if(mCurrent)mRefresh();else loadMatters()}})})
document.addEventListener('cc:pane',function(){mHandoffViewEpoch++})
// 回前台按当前页分路:在详情页刷详情,在列表页刷列表。此前只调 mRefresh(),而它要
// mCurrent —— 停在列表上回来时什么都不刷,人看到的还是切走之前那份。
document.addEventListener('visibilitychange',function(){mHandoffViewEpoch++;clearTimeout(mPoll);mSeq++;mConnectionEpoch++;mDetailFresh=false;mSetButtons();if(!document.hidden&&mActive){if(mCurrent)mRefresh();else loadMatters()}})
window.addEventListener('offline',function(){mHandoffViewEpoch++;clearTimeout(mPoll);mOffline=true;mSeq++;mConnectionEpoch++;mDetailFresh=false;mMisses=M_STALE_MISSES;mConn();mSetButtons()})
window.addEventListener('online',function(){mOffline=false;if(mActive){if(mCurrent)mRefresh();else loadMatters()}})
window.addEventListener('pagehide',function(){mHandoffViewEpoch++;clearTimeout(mPoll);mSeq++;mConnectionEpoch++;mDetailFresh=false;mSetButtons()})
window.addEventListener('pageshow',function(){if(mActive){if(mCurrent)mRefresh();else loadMatters()}})
// Markdown results retain an exact source preview alongside the reading view.
function mRenderTextArtifact(preview,mime,text,truncated) {
  var pre=document.createElement('pre');pre.className='m-description';pre.textContent=text
  if(mime==='text/markdown'||mime==='text/x-markdown'){
    var reading=document.createElement('div');reading.className='m-markdown';reading.innerHTML=CCM.renderMarkdown(text);preview.appendChild(reading)
    var original=document.createElement('details');original.className='m-artifact-source'
    var label=document.createElement('summary');label.textContent='查看原文';original.appendChild(label);original.appendChild(pre);preview.appendChild(original)
  }else preview.appendChild(pre)
  if(truncated){var notice=document.createElement('p');notice.textContent='预览已截断，下载可查看完整文件。';preview.appendChild(notice)}
}
// Web Crypto is unavailable on a LAN HTTP origin. The fallback verifies the same
// SHA-256 bytes there, without loading third-party code or weakening verification.
async function mSha256(bytes) {
  if(crypto.subtle){var digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),function(b){return b.toString(16).padStart(2,'0')}).join('')}
  var k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  var h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],data=new Uint8Array(Math.ceil((bytes.length+9)/64)*64),w=new Int32Array(64)
  data.set(bytes);data[bytes.length]=128;new DataView(data.buffer).setUint32(data.length-4,bytes.length*8)
  function ro(x,n){return(x>>>n)|(x<<(32-n))}
  for(var off=0;off<data.length;off+=64){
    if(off&&off%(128*1024)===0)await new Promise(function(resolve){setTimeout(resolve,0)})
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
    if(mCurrent!==id||!mDetail||(mDetail.artifacts||[]).every(function(a){return a.id!==artifact.id||a.sha256!==artifact.sha256}))return
    mClearPreview();var preview=document.getElementById('m-artifact-preview'),title=document.createElement('p');title.textContent=artifact.name;preview.appendChild(title)
    var imageMime=['image/png','image/jpeg','image/webp'].indexOf(artifact.mime)>=0
    if(imageMime){var imageUrl=URL.createObjectURL(new Blob([bytes],{type:artifact.mime}));mObjectUrls.push(imageUrl);var img=document.createElement('img');img.src=imageUrl;img.alt=artifact.name;img.style.maxWidth='100%';preview.appendChild(img)}
    else if(/^text\//.test(artifact.mime)||artifact.mime==='application/json')mRenderTextArtifact(preview,artifact.mime,new TextDecoder().decode(bytes.subarray(0,200000)),bytes.length>200000)
    var download=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));mObjectUrls.push(download);var link=document.createElement('a');link.href=download;link.download=artifact.name;link.textContent='下载 '+artifact.name;preview.appendChild(link);mNotice("文件已完整校验")
  }catch(e){if(mCurrent===id)mNotice(mError(e.message))}finally{delete mBusy[key]}
}
document.getElementById('m-artifacts').addEventListener('click',function(ev){var b=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('[data-artifact]'));if(!b||!mDetail)return;var a=(mDetail.artifacts||[]).find(function(a){return a.id===b.dataset.artifact&&a.taskId===mCurrent});if(a)mArtifact(a)})
