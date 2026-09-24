
document.getElementById("pairbtn").addEventListener("click", function() {
  // 走 api():壳模式(微信里点 /set 链接,人在外面)下裸 fetch 打到中继域,必 404。
  api("/set/api/pair", { method: "POST" }).then(function(r){ return r.json() }).then(function(r) {
    if (r.ok && r.device_token) {
      try { localStorage.setItem("deviceToken", r.device_token) } catch (e) {}
      T = r.device_token; isDevice = true
      document.getElementById("pairbar").hidden = true
      toast("配好了,这台手机以后点链接不会再过期")
      // 壳页优先读本域的 deviceToken:重开一次,隧道就用长期令牌重新握手(这条流还绑着 10 分钟短令牌)。
      if (window.__CC_SHELL__) setTimeout(function(){ location.reload() }, 1200)
    } else toast("没配上:" + (r.error || ""))
  }).catch(function(){ toast("没配上,网络不通") })
})
document.querySelectorAll("nav button[data-p]").forEach(function(/** @type {HTMLButtonElement} */ b) {
  b.addEventListener("click", function() {
    document.querySelectorAll("nav button").forEach(function(o){ o.classList.toggle("on", o === b) })
    document.querySelectorAll(".pane").forEach(function(p){ p.classList.toggle("on", p.id === "p-" + b.dataset.p) })
  })
})
document.getElementById("nav-set").addEventListener("click", function(){ ccNav("/set") })
