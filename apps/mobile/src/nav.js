
document.getElementById("pairbtn").addEventListener("click", function() {
  // 走 api():壳模式(微信里点 /set 链接,人在外面)下裸 fetch 打到中继域,必 404。
  api("/set/api/pair", { method: "POST" }).then(function(r){ return r.json() }).then(function(r) {
    if (r.ok && r.device_token) {
      try { localStorage.setItem("deviceToken", r.device_token) } catch (e) {}
      T = r.device_token; isDevice = true
      resetTunnel()
      document.getElementById("pairbar").hidden = true
      toast("配好了,这台手机以后点链接不会再过期")
      // 壳页优先读本域的 deviceToken:重开一次,隧道就用长期令牌重新握手(这条流还绑着 10 分钟短令牌)。
      if (window.__CC_SHELL__) setTimeout(function(){ location.reload() }, 1200)
    } else toast("没配上:" + (r.error || ""))
  }).catch(function(){ toast("没配上,网络不通") })
})
function ccSelectMobilePane(name) {
  var main=name==='memory'?'today':name==='sessions'?'matters':name
  document.querySelectorAll('nav button[data-p]').forEach(function(/** @type {HTMLButtonElement} */ button){button.classList.toggle('on',button.dataset.p===main)})
  document.querySelectorAll('.pane').forEach(function(pane){pane.classList.toggle('on',pane.id==='p-'+name)})
  document.dispatchEvent(new CustomEvent('cc:pane',{detail:{pane:name}}))
}
function ccMobilePane(name) {
  var button=/** @type {HTMLButtonElement} */ (document.querySelector('nav button[data-p="'+name+'"]'))
  // Preserve the existing workbench/entry navigation hooks for the two main destinations.
  if(button){button.click();return}
  if(typeof mActive!=='undefined'){mActive=false;clearTimeout(mPoll);mSeq++;mDetailFresh=false;mSetButtons()}
  if(typeof eViewEpoch!=='undefined')eViewEpoch++
  ccSelectMobilePane(name)
}
document.querySelectorAll("nav button[data-p]").forEach(function(/** @type {HTMLButtonElement} */ b) {
  b.addEventListener("click", function() {
    ccSelectMobilePane(b.dataset.p)
  })
})
document.getElementById('memory-open').addEventListener('click',function(){ccMobilePane('memory')})
document.getElementById('memory-back').addEventListener('click',function(){ccMobilePane('today')})
document.getElementById("nav-set").addEventListener("click", function(){ ccNav("/set") })
