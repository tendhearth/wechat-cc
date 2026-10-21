
try {
  // 壳页模式(中继域,所有电脑共用)同时记下令牌属于哪台电脑,见 relay/pset.src.html
  if (T.charAt(0) === "d") { localStorage.setItem("deviceToken", T); if (window.__CC_SHELL__) localStorage.setItem("deviceTokenId", window.__CC_SHELL__.id) }
  if (REMOTE) localStorage.setItem("ccRemote", JSON.stringify(REMOTE))
  else { var rr = localStorage.getItem("ccRemote"); if (rr) REMOTE = JSON.parse(rr) }
} catch (e) {}
var isDevice = T.charAt(0) === "d"
function ccLinkSession() { return !isDevice }
document.body.classList.toggle("link-session", !isDevice)
if (!isDevice) document.getElementById("pairbar").hidden = false
if ("serviceWorker" in navigator) { navigator.serviceWorker.register("/m/sw.js", { scope: "/m" }).catch(function(){}) }
function toast(m) { var t = document.getElementById("toast"); t.textContent = m; t.classList.add("show"); setTimeout(function(){ t.classList.remove("show") }, 1800) }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;") }
function q(p) { return p + (p.indexOf("?") < 0 ? "?" : "&") + (isDevice ? "d=" : "t=") + encodeURIComponent(T) }
// 标题里的排版记号去掉(收敛 5b 删了整套 Markdown 渲染,标题只要读得顺):链接留字、去反引号 / 标题井号 / 列表头 / 粗斜体记号,压成一行。
function ccPlain(s) {
  return String(s == null ? "" : s)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ").trim()
}
