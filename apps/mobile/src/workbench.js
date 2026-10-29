// 执行者头像(2026-10-19,同手机 app):跟桌面共用 apps/desktop/src/shared/agent-avatars.js,构建期在这上面内联并调一次。
/** @type {ReturnType<typeof import('../../desktop/src/shared/agent-avatars.js').createAgentAvatars>} */
var mAgents
// 「一起做」在网页上只看状态(收敛 5b,2026-10-21 主人定):列表 + 每件事的标题 / 执行者 / 到哪了 / 额度用完这类状态 +「停下」。
// 对话记录、成果、接着说、批准 / 回答、额度交接都在手机 App 和电脑上。状态词照 docs/reference/phone-wording.md。
var M_STATUS = { open: "在做", replied: "这一轮做完了", done: "完成", archived: "已归档" }
var M_KIND = { task: "任务", chat: "对话", companion: "陪伴" }
var M_PHASE = { queued: "在做", working: "在做", replied: "这一轮做完了", failed: "没做成", cancelled: "停下了", interrupted: "停下了" }
var mCurrent = null, mDetail = null, mPoll = null, mSeq = 0, mActive = false, mBusy = {}
var mDetailFresh = false, mConnectionEpoch = 0, mOffline = false
/** 最后一次真正联系上 daemon 的时刻。断网时它会停住变旧 —— 这正是"你看到的是几点的样子"要报的那个数。 */
var mLastOkAt = null
/** 连续几次没联系上才浮提示:一次抖动不打扰人。按"次数"而不是"过了多久"判 ——
 * 重算只发生在有请求的时候,按时长判会出现"门槛到了却没人算"的空窗。 */
var M_STALE_MISSES = 2, mMisses = 0
function mNotice(message) { document.getElementById("m-notice").textContent = message }
function mClock(ts) { var d = new Date(ts); return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0") }
/** 平时不在;超过门槛没联系上才浮出来,恢复后自己消失(列表页与详情页共用这一行)。 */
function mConn() {
  var el = document.getElementById("m-conn"), stale = mMisses >= M_STALE_MISSES
  el.hidden = !stale
  el.textContent = stale ? (mLastOkAt===null?"家里的电脑暂时连不上，看看它开着没。":"家里的电脑暂时连不上 —— 你看到的是 " + mClock(mLastOkAt) + " 的样子") : ""
}
// 码 → 一句话。读列表 / 详情(GET /m/api/matters、/m/api/matter)用 M_ERRORS,停下这一轮用 M_STOP_ERRORS;
// 没列的码走后面那句通用的。守卫 scripts/mobile-web-errors.guard.test.ts:每个码都得是那几条路由真会回的,
// 路由会回的码要么在这里、要么在守卫的 GENERIC 里明列(以前这里认的 not_found 详情路由从来不回 —— 它回 matter_not_found)。
var M_ERRORS = {
  detail_too_large: "这件事的内容太多，网页上读不全，请到手机 App 或电脑上看。",
  unauthorized: "这台手机已经不能连了，在电脑上重新配对。",
  matter_not_found: "找不到这件事了，可能已经删掉。"
}
var M_STOP_ERRORS = { input_stale: "这一轮已经结束或换了一轮，刷新看看现在的样子。" }
function mText(map, code, fallback) { return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : fallback }
function mError(code) { return mText(M_ERRORS, code, "暂时没读到，请检查连接后再看。") }
function mApi(path,opts,sender) {
  var timer, epoch=mConnectionEpoch, pageId=mCurrent
  return Promise.race([(sender||api)(path,opts).then(function(r){return r.json().then(function(b){if (!r.status || r.status < 400) { if (b.ok) return b }; throw Object.assign(new Error(b.error || "unavailable"),{status:r.status})})}),new Promise(function(_r,reject){timer=setTimeout(function(){reject(new Error("timeout"))},15000)})])
    .then(function(b){
      // 只在"从断线里回来"这一下清提示:断线期间那条错误不清就会赖到下一次操作;平时成功不动它(「已经请电脑停下」要留着)。
      if(epoch!==mConnectionEpoch||mOffline)return b
      var recovered = mMisses > 0
      mLastOkAt=Date.now();mMisses=0;mConn();if(recovered&&mCurrent===pageId)mNotice("")
      return b
    },function(e){if(epoch===mConnectionEpoch){if(e.status>=400){mLastOkAt=Date.now();mMisses=0}else mMisses++;if(mCurrent===pageId)mDetailFresh=false;mConn();mSetButtons()}throw e})
    .finally(function(){clearTimeout(timer)})
}
function mSetButtons() {
  document.querySelectorAll('#m-status [data-stop]').forEach(function(/** @type {HTMLButtonElement} */ b){b.disabled=!mDetailFresh||mOffline||!!mBusy[mCurrent+':stop']})
}
function loadMatters() {
  mApi("/m/api/matters?status=open,replied,done").then(function(r){
    document.getElementById("m-list").innerHTML=r.matters.filter(function(m){return m.kind!=="companion"}).map(function(m){return '<button type="button" class="card todo" data-mid="'+esc(m.id)+'"><span class="tx"><b>'+esc(ccPlain(m.title))+'</b><small>'+esc(M_KIND[m.kind]||m.kind)+' · '+esc(m.networkSuspended?"已暂停(网络未受保护)":(M_STATUS[m.status]||m.status))+(m.projectPath?' · '+esc(m.projectPath.split(/[\\/]/).filter(Boolean).pop()||m.projectPath):'')+'</small></span>'+mAgents.originMarkHtml(m.origin)+mAgents.agentAvatarsHtml(m.agents,{nameOf:mNameOf(m.agentNames)})+'</button>'}).join("") || '<div class="empty">还没有事，微信或桌面上交代一件就会出现在这里</div>'
  }).catch(function(e){document.getElementById("m-list").textContent=mError(e.message)})
}
/** 执行者叫什么只读 daemon 给的 matter.agentNames(收敛清单 ⑥),网页不存名字表;老 daemon 不带 ⇒ id。 */
function mNameOf(names) { return function(id) { return names&&typeof names[id]==='string'&&names[id]?names[id]:id } }
var M_ID = /^[a-z][a-z0-9._-]{0,63}$/
/** 额度用完那一块只当状态读:认不出的形状一律当没有,不猜。 */
function mQuotaView(value) {
  if(!value||typeof value.from!=='string'||!M_ID.test(value.from))return null
  if(value.state==='handed')return typeof value.to==='string'&&M_ID.test(value.to)?value:null
  if((value.state!=='offer'&&value.state!=='none')||['quota','rate_limit'].indexOf(value.kind)<0||!Number.isFinite(value.resetAt))return null
  return value.state==='none'||typeof value.to==='string'&&M_ID.test(value.to)?value:null
}
function mQuotaText(view, names) {
  var mProviderName=mNameOf(names)
  if(view.state==='handed')return '已经交给 '+mProviderName(view.to)+' 接着做了。'
  var wait=Math.max(1,Math.ceil((view.resetAt-Date.now())/60000))
  var head=mProviderName(view.from)+(view.kind==='rate_limit'?' 暂时受限，请求太频繁了。':' 的额度已用完。')+'预计约 '+wait+' 分钟后可再试。'
  return head+(view.state==='none'?'目前没有可用的接手者。':'可以在手机 App 或电脑上交给 '+mProviderName(view.to)+' 接着做。')
}
/** 现在到哪了:一个状态词(用词表),外加等你的几项、正在跑的那一步、额度这类状态。 */
function mStateWord(d) {
  var id=d.matter.id,task=d.task
  var waiting=(d.permissions||[]).concat(d.questions||[]).filter(function(r){return r.taskId===id}).length
  var quota=mQuotaView(d.quotaHandoff)
  if(d.matter.status==='archived')return {word:'已归档',waiting:waiting}
  if(d.matter.status==='done')return {word:'完成',waiting:waiting}
  if(waiting||quota&&quota.state!=='handed')return {word:'等你决定',waiting:waiting}
  if(task&&task.phase&&M_PHASE[task.phase])return {word:M_PHASE[task.phase],waiting:0}
  return {word:M_STATUS[d.matter.status]||d.matter.status,waiting:0}
}
function mRenderStatus(d) {
  var root=document.getElementById('m-status'),state=mStateWord(d),quota=mQuotaView(d.quotaHandoff),html='<p class="m-state">'+esc(state.word)+'</p>'
  if(state.waiting)html+='<p class="m-task-note">有 '+state.waiting+' 项等你决定，到手机 App 或电脑上处理。</p>'
  var events=d.events||[],last=events[events.length-1]
  if(last&&last.kind==='tool_call'&&last.activity&&last.activity.status==='running')html+='<p class="m-now"><span>正在</span> '+esc(last.activity.label||last.text)+'</p>'
  if(d.matter.kind==='task'&&quota)html+='<p class="m-task-note">'+esc(mQuotaText(quota,d.matter.agentNames))+'</p>'
  if(d.task&&d.task.error==='execution_model_unsupported')html+='<p class="m-task-note">请在电脑上为这件事选一个账号可用的模型后再继续。</p>'
  if(d.task&&d.task.rewind&&d.task.rewind.blocked)html+='<p class="m-task-note">撤回这一轮时停住了，请到电脑上处理。</p>'
  // 停下这一轮(2026-10-06,网页留着:停是安全方向):只在有一轮排队 / 在干活时出现;点一下先变「再点一次」,3 秒内再点才停,只停这一轮(runId)。
  if(d.matter.kind==='task'&&d.runId&&d.task&&(d.task.phase==='queued'||d.task.phase==='working')){
    var armed=mStopArmed&&mStopArmed.task===d.matter.id&&mStopArmed.run===d.runId
    html+='<button type="button" class="more" data-stop="1" data-task="'+esc(d.matter.id)+'" data-run="'+esc(d.runId)+'">'+(armed?'再点一次，确认停止':'停止这一轮')+'</button>'
  }
  if(root.innerHTML!==html){
    // 确认文字 / 轮询状态变化不能把键盘用户从「停下」上丢掉。
    var focused=document.activeElement
    var restore=focused&&root.contains(focused)&&focused.hasAttribute('data-stop')
    var task=restore?focused.getAttribute('data-task'):null,run=restore?focused.getAttribute('data-run'):null
    root.innerHTML=html
    var next=restore?root.querySelector('button[data-stop]'):null
    if(next&&next.getAttribute('data-task')===task&&next.getAttribute('data-run')===run)/** @type {HTMLButtonElement} */ (next).focus({preventScroll:true})
  }
}
var mStopArmed=null,mStopTimer=null
async function mStop(task,run) {
  var key=task+':stop'
  if(task!==mCurrent||!mDetail||mDetail.runId!==run||!mDetailFresh||mOffline||mBusy[key])return
  if(!mStopArmed||mStopArmed.task!==task||mStopArmed.run!==run){
    mStopArmed={task:task,run:run};clearTimeout(mStopTimer)
    mStopTimer=setTimeout(function(){mStopArmed=null;if(mDetail){mRenderStatus(mDetail);mSetButtons()}},3000)
    mRenderStatus(mDetail);mSetButtons();return
  }
  mStopArmed=null;clearTimeout(mStopTimer);mBusy[key]=true;mSetButtons();mNotice('正在停下这一轮…')
  try{
    // 一次只走一条通道,不自动重发
    var r=await mPostOnce('/m/api/matter/stop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:task,runId:run})})
    var b=await r.json().catch(function(){return null})
    mNotice(b&&b.ok?'已经请电脑停下这一轮。':mText(M_STOP_ERRORS,b&&b.error,'没停成，稍后再试。'))
  }catch(e){mNotice('没停成，稍后再试。')}
  finally{delete mBusy[key];mSetButtons();clearTimeout(mPoll);mSchedule()}
}
/** A POST selects one transport once. A lost LAN reply must never send it again through the tunnel. */
function mPostOnce(path,opts) {
  if(preferTunnel&&REMOTE)return tunnel().then(function(send){return send(path,opts)})
  var ctrl=new AbortController(),timer=setTimeout(function(){ctrl.abort()},2500)
  return fetch(q(path),Object.assign({signal:ctrl.signal},opts)).catch(function(e){if(REMOTE)preferTunnel=true;throw e}).finally(function(){clearTimeout(timer)})
}
document.getElementById('m-status').addEventListener('click',function(ev){var s=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('[data-stop]'));if(s&&s.dataset.task===mCurrent)mStop(s.dataset.task,s.dataset.run)})
function renderMatter(d) {
  mDetail=d;mDetailFresh=true
  document.getElementById("m-title").textContent=ccPlain(d.matter.title)
  // 标题下一组头像 + 名字:任务那一家在前,老 daemon 不带 agents 也有
  // 出生地(2026-10-19):字形在头像组前面,名字后面写一句「从哪来的」;不知道 ⇒ 不画
  var agents=mAgents.matterAgents(d.task&&d.task.providerId,d.matter.agents),who=document.getElementById("m-agents"),from=mAgents.originLabel(d.matter.origin)
  who.hidden=!agents.length&&!from;who.innerHTML=agents.length||from?mAgents.originMarkHtml(d.matter.origin)+mAgents.agentAvatarsHtml(agents,{nameOf:mNameOf(d.matter.agentNames)})+'<span>'+esc([mAgents.agentsLabel(agents,mNameOf(d.matter.agentNames)),from].filter(Boolean).join(" · "))+'</span>':''
  mRenderStatus(d)
  mSetButtons()
}
function mSchedule() { clearTimeout(mPoll);if(mActive&&mCurrent&&!document.hidden)mPoll=setTimeout(mRefresh,3000) }
function mRefresh() {
  clearTimeout(mPoll);if(!mActive||!mCurrent||document.hidden||mOffline)return Promise.resolve()
  var id=mCurrent,seq=++mSeq
  return mApi('/m/api/matter?id='+encodeURIComponent(id)).then(function(d){if(mCurrent===id&&seq===mSeq&&d.matter.id===id)renderMatter(d)}).catch(function(e){if(mCurrent===id&&seq===mSeq)mNotice(mError(e.message))}).finally(function(){if(mCurrent===id&&seq===mSeq)mSchedule()})
}
function openMatter(id) {
  mDetailFresh=false
  if(mCurrent!==id){mSeq++;mDetail=null;mStopArmed=null;document.getElementById('m-status').replaceChildren();document.getElementById('m-agents').hidden=true;mNotice("");document.getElementById("m-title").textContent="正在读…"}
  mCurrent=id;mActive=true
  document.getElementById("m-list").hidden=true;document.getElementById("m-detail").hidden=false
  return mRefresh()
}
/** 此刻页那张「等你」的卡点进来:切到「一起做」,直接看这件事的状态。 */
function ccShowMatter(id) {
  ccSelectMobilePane('matters')
  openMatter(id)
}
document.getElementById("m-list").addEventListener("click",function(ev){var c=/** @type {HTMLElement} */ (/** @type {Element} */ (ev.target).closest('[data-mid]'));if(c)openMatter(c.dataset.mid)})
document.getElementById("m-back").addEventListener("click",function(){mSeq++;mCurrent=null;mDetail=null;mStopArmed=null;clearTimeout(mPoll);document.getElementById("m-detail").hidden=true;document.getElementById("m-list").hidden=false;loadMatters()})
document.querySelectorAll('nav button[data-p]').forEach(function(/** @type {HTMLButtonElement} */ b){b.addEventListener('click',function(){mActive=b.dataset.p==='matters';clearTimeout(mPoll);if(mActive){if(mCurrent)mRefresh();else loadMatters()}})})
// 回前台按当前页分路:在详情页刷详情,在列表页刷列表。
document.addEventListener('visibilitychange',function(){clearTimeout(mPoll);mSeq++;mConnectionEpoch++;mDetailFresh=false;mSetButtons();if(!document.hidden&&mActive){if(mCurrent)mRefresh();else loadMatters()}})
window.addEventListener('offline',function(){clearTimeout(mPoll);mOffline=true;mSeq++;mConnectionEpoch++;mDetailFresh=false;mMisses=M_STALE_MISSES;mConn();mSetButtons()})
window.addEventListener('online',function(){mOffline=false;if(mActive){if(mCurrent)mRefresh();else loadMatters()}})
window.addEventListener('pagehide',function(){clearTimeout(mPoll);mSeq++;mConnectionEpoch++;mDetailFresh=false;mSetButtons()})
window.addEventListener('pageshow',function(){if(mActive){if(mCurrent)mRefresh();else loadMatters()}})
