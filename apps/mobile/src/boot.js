
try {
  if (T.charAt(0) === "d") localStorage.setItem("deviceToken", T)
  if (REMOTE) localStorage.setItem("ccRemote", JSON.stringify(REMOTE))
  else { var rr = localStorage.getItem("ccRemote"); if (rr) REMOTE = JSON.parse(rr) }
} catch (e) {}
var isDevice = T.charAt(0) === "d"
if (!isDevice) document.getElementById("pairbar").hidden = false
if ("serviceWorker" in navigator) { navigator.serviceWorker.register("/m/sw.js", { scope: "/m" }).catch(function(){}) }
function toast(m) { var t = document.getElementById("toast"); t.textContent = m; t.classList.add("show"); setTimeout(function(){ t.classList.remove("show") }, 1800) }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;") }
function q(p) { return p + (p.indexOf("?") < 0 ? "?" : "&") + (isDevice ? "d=" : "t=") + encodeURIComponent(T) }
