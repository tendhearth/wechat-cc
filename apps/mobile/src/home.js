document.getElementById("refresh").addEventListener("click", loadHome)
var HOME_KEY = "cc.home.v2:" + (REMOTE ? REMOTE.id : location.host) + ":" + T.slice(-12)
var homeState = null, homeSeq = 0
// 配对换了令牌(plan 7a):旧令牌那一趟的失败(在飞的 401、resetTunnel 关掉旧隧道的 closed)
// 不是「连不上」,也不是本机令牌失效 —— 标成 HOME_STALE / 走 catch 里的 sent !== T,拿新令牌重拉一次。
var HOME_STALE = { stale: true }
// I5:presence 没有独立的过期机制 —— 页面一直开着,只有 load/visibilitychange/
// 手动刷新才会重拉。这里给它记一个「拉到的时间」,过 TTL 就自己塌成「不知道」,
// 而不是让一条越来越旧的「现在」一直挂在屏幕上。TTL 跟 companion-presence.ts
// 的 ACTIVE_WINDOW_MS 对齐(3 分钟)。
var PRESENCE_TTL_MS = 3 * 60 * 1000
var presenceAt = null
function ago(iso) {
  var d = Math.max(0, Date.now() - Date.parse(iso)) / 1000
  if (d < 60) return "刚刚"
  if (d < 3600) return Math.floor(d / 60) + " 分钟前"
  if (d < 86400) return Math.floor(d / 3600) + " 小时前"
  return Math.floor(d / 86400) + " 天前"
}
function readCache() { try { var s = localStorage.getItem(HOME_KEY); return s ? JSON.parse(s) : null } catch (e) { return null } }
// 只存此刻页用得上的几项(收敛 5b 起不再显示动态,不把整份 events 塞进本机存储)
function writeCache(s) { try { localStorage.setItem(HOME_KEY, JSON.stringify({ ok: true, synced_at: s.synced_at, presence: s.presence, work: s.work })) } catch (e) {} }
function presenceTtlCheck() {
  if (presenceAt !== null && Date.now() - presenceAt > PRESENCE_TTL_MS) {
    presenceAt = null
    document.getElementById("pres-txt").textContent = "不知道"
  }
}
function renderHome(s, stale) {
  renderPresenceHome(s,stale)
  // presence:只有这次真拉到的才显示;缓存里的永远不渲染 —— 它说的是「现在」。
  var pt = document.getElementById("pres-txt")
  if (!stale && s.presence) {
    presenceAt = Date.now()
    // C1:kind === "idle" 时 label 是空串(桌宠那边靠 kind 自己表达闲着);手机页把 label 当作
    // 现成的一句话直接拼,空串会显示成光秃秃的「现在:」,分不清是真没数据还是渲染坏了。
    pt.textContent = (s.presence.activity.label || "在家待着") + (s.presence.presence === "ok" ? "" : "(" + (s.presence.presence === "offline" ? "断线" : "有点不对劲") + ")")
  } else {
    presenceAt = null
    pt.textContent = "不知道"
  }
}
setInterval(presenceTtlCheck, 30000)
function showBanner(txt) { var b = document.getElementById("banner"); b.hidden = !txt; b.textContent = txt || "" }
function loadHome() {
  var seq=++homeSeq
  var cached = readCache()
  if (cached&&!homeState) { homeState = cached; renderHome(cached, true); showBanner("上次同步 " + ago(cached.synced_at)) }
  var sent = T
  api("/m/api/home").then(function(r) {
    if (r.status === 401) { if (sent !== T) return HOME_STALE; onUnauthorized(sent); return null }
    return r.json()
  }).then(function(s) {
    if(seq!==homeSeq)return
    if (s === HOME_STALE) { loadHome(); return }
    if (!s || !s.ok) throw new Error('unavailable')
    homeState = s; renderHome(s, false); showBanner(""); writeCache(s)
  }).catch(function() {
    if(seq!==homeSeq)return
    if (sent !== T) { loadHome(); return }
    var previous=homeState||cached
    if (previous) {renderHome(previous,true);showBanner("家里的电脑暂时连不上 · 你看到的是 " + new Date(previous.synced_at).toLocaleString() + " 的样子")}
    else {renderPresenceHome({work:{focus:null,partial:true}},true);showBanner('家里的电脑暂时连不上，看看它开着没。');document.getElementById("pres-txt").textContent = "暂时不知道 CC 在做什么"}
  })
}
setInterval(function(){if(!document.hidden&&document.getElementById('p-today').classList.contains('on'))loadHome()},15000)
document.addEventListener("visibilitychange", function(){ if (document.visibilityState === "visible") loadHome() })
loadHome()
