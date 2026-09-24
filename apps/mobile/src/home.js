
function render(s) {
  var t = document.getElementById("todos")
  var groups = {}
  s.todos.active.forEach(function(r){ (groups[r.display] = groups[r.display] || []).push(r) })
  var h = ""
  Object.keys(groups).forEach(function(g) {
    h += '<div class="grp">' + esc(g) + '</div>'
    groups[g].forEach(function(r) {
      h += '<div class="card todo"><div class="tx"><b>' + esc(r.value) + '</b><small>' + esc(r.time_ref || "") + '</small></div>' +
           '<button class="done-btn" data-id="' + r.id + '" data-st="resolved">完成</button></div>'
    })
  })
  if (!s.todos.active.length) h = '<div class="empty">都了结了 ✨<br><small>聊天里出现新约定会自己长出来</small></div>'
  if (s.todos.settled.length) {
    h += '<div class="grp">最近了结</div>'
    s.todos.settled.forEach(function(r) {
      h += '<div class="card todo" style="opacity:.65"><div class="tx"><b style="text-decoration:line-through">' + esc(r.value) + '</b><small>' + esc(r.display) + '</small></div>' +
           '<button data-id="' + r.id + '" data-st="active">捞回</button></div>'
    })
  }
  t.innerHTML = h
  document.getElementById("portrait").innerHTML = s.portrait
    ? '<figure class="frame">' + s.portrait + '<figcaption>CC 画的你</figcaption></figure>'
    : '<div class="empty">CC 还在慢慢认识你 🖍<br><small>聊得多了,它会自己给你画一张</small></div>'
  var sg = document.getElementById("stickers")
  if (!s.stickers.length) { sg.innerHTML = '<div class="empty">表情库还空着</div>' }
  else if (!preferTunnel) {
    sg.innerHTML = s.stickers.map(function(e) {
      return '<figure><img src="' + q("/m/api/sticker/" + encodeURIComponent(e.file)) + '" loading="lazy"><figcaption>' + esc(e.tags.join(" · ")) + '</figcaption></figure>'
    }).join("")
  } else {
    // 隧道/壳模式:<img src> 直连必然失败,走 api() 取 base64 拼 data URI。
    sg.innerHTML = s.stickers.map(function(e, i) {
      return '<figure><img data-sti="' + i + '" alt=""><figcaption>' + esc(e.tags.join(" · ")) + '</figcaption></figure>'
    }).join("")
    s.stickers.forEach(function(e, i) {
      api("/m/api/sticker/" + encodeURIComponent(e.file) + "?b64=1").then(function(r){ return r.json() }).then(function(r) {
        if (r && r.ok) { var img = /** @type {HTMLImageElement} */ (sg.querySelector('[data-sti="' + i + '"]')); if (img) img.src = "data:" + r.mime + ";base64," + r.data }
      }).catch(function(){})
    })
  }
}
document.getElementById("todos").addEventListener("click", function(ev) {
  var b = /** @type {HTMLButtonElement} */ (/** @type {Element} */ (ev.target).closest("button[data-id]"))
  if (!b) return
  // 走隧道感知的 api()(在家直连,出门/壳模式走隧道)—— 不能用裸 fetch,
  // 否则出门时待办勾选打不到家里的 daemon。
  api("/m/api/todo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: Number(b.dataset.id), status: b.dataset.st }) })
    .then(function(r){ return r.json() }).then(function(r) { if (r.ok) { toast(b.dataset.st === "active" ? "捞回来了" : "划掉了 ✓"); load() } else toast("没改成") })
    .catch(function(){ toast("网络不通") })
})
var HOME_KEY = "cc.home.v2:" + (REMOTE ? REMOTE.id : location.host) + ":" + T.slice(-12)
var KIND_ICON = { hunt: "🎯", visit: "🏡", postcard: "💌", recollection: "📖", thought: "💭", chat_day: "💬" }
var homeState = null, homeSeq = 0
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
function writeCache(s) { try { localStorage.setItem(HOME_KEY, JSON.stringify(s)) } catch (e) {} }
function evHtml(e) {
  var h = '<div class="card ev"><div class="k">' + (KIND_ICON[e.kind] || "•") + '</div><div class="tx"><b>' + esc(e.title) + '</b>'
  if (e.note) h += '<p>' + esc(e.note) + '</p>'
  // M3:esc() 只挡得住 HTML 特殊字符,挡不住 javascript: 这种协议头 —— href
  // 的安全性只靠三个文件外的 hunt-catch.ts URL_RE(只收 http(s)://)撑着,
  // 这里再本地兜一道,只在确实是 http(s) 链接时才输出 <a>。
  if (e.ref && e.ref.url && (e.ref.url.indexOf("https://") === 0 || e.ref.url.indexOf("http://") === 0)) {
    h += '<p><a href="' + esc(e.ref.url) + '" target="_blank" rel="noopener">打开链接</a></p>'
  }
  if (e.ref && e.ref.image_svg) h += '<div class="pc">' + e.ref.image_svg + '</div>'
  // I3:后端已经用伙伴时区把 hhmm 拼好了 —— 页面不再用 new Date(iso).getHours()
  // 自己按手机时区算一遍(隧道出门时两地隔一个时区,算出来的钟点会串到另一天)。
  h += '<small>' + esc(e.hhmm) + '</small></div></div>'
  return h
}
function presenceTtlCheck() {
  if (presenceAt !== null && Date.now() - presenceAt > PRESENCE_TTL_MS) {
    presenceAt = null
    document.getElementById("pres-txt").textContent = "不知道"
  }
}
function renderFeed(s, stale) {
  renderPresenceHome(s,stale)
  var f = document.getElementById("feed")
  // presence:只有这次真拉到的才显示;缓存里的永远不渲染 —— 它说的是「现在」。
  var pt = document.getElementById("pres-txt")
  if (!stale && s.presence) {
    presenceAt = Date.now()
    // C1:kind === "idle" 时 label 是空串(桌宠那边靠 kind 自己表达闲着,熊
    // 本身就是信号);手机页把 label 当作现成的一句话直接拼,空串会显示成
    // 光秃秃的「现在:」,比「不知道」还糟——分不清是真没数据还是渲染坏了。
    pt.textContent = (s.presence.activity.label || "在家待着") + (s.presence.presence === "ok" ? "" : "(" + (s.presence.presence === "offline" ? "断线" : "有点不对劲") + ")")
  } else {
    presenceAt = null
    pt.textContent = "不知道"
  }
  var h = ""
  var evs = s.events || []
  var degradedAll = s.sources_degraded && s.sources_degraded.length === 3
  // I2:collectSources 本来就是为「一两个源挂了,剩下的照常显示」写的 ——
  // 只在三个全挂时才提示,等于把这套设计的价值扔了。挂一两个也要说一声。
  var degradedSome = !degradedAll && s.sources_degraded && s.sources_degraded.length > 0
  if (degradedSome) h += '<div class="empty" style="padding:8px 4px">有一部分没读到</div>'
  if (degradedAll) h += '<div class="empty">今天读不到它的日记</div>'
  else if (!evs.length) h += '<div class="empty">还什么都没发生——它刚醒</div>'
  else {
    var day = null
    // I4:stale(缓存)渲染时 s.today 是缓存写入那一刻的「今天」,出门一天再
    // 打开会把昨天的分组标成「今天」—— stale 时绝不把日期换成「今天」。
    if (!stale && s.today && evs[0].day !== s.today) { h += '<div class="grp">今天</div><div class="empty" style="padding:14px">它今天还没出门</div>' }
    evs.forEach(function(e) {
      if (e.day !== day) { day = e.day; h += '<div class="grp">' + (!stale && day === s.today ? "今天" : esc(day)) + '</div>' }
      h += evHtml(e)
    })
    if (s.next_cursor) h += '<button class="more" data-cursor="' + esc(s.next_cursor) + '">再往前</button>'
  }
  f.innerHTML = h
}
setInterval(presenceTtlCheck, 30000)
function showBanner(txt) { var b = document.getElementById("banner"); b.hidden = !txt; b.textContent = txt || "" }
function loadHome() {
  var seq=++homeSeq
  var cached = readCache()
  if (cached&&!homeState) { homeState = cached; renderFeed(cached, true); showBanner("上次同步 " + ago(cached.synced_at)) }
  api("/m/api/home").then(function(r) {
    if (r.status === 401) { try { localStorage.removeItem("deviceToken") } catch (e) {}; location.replace("/m"); return null }
    return r.json()
  }).then(function(s) {
    if(seq!==homeSeq)return
    if (!s || !s.ok) throw new Error('unavailable')
    homeState = s; renderFeed(s, false); showBanner(""); writeCache(s)
    markMemoriesSeen()
  }).catch(function() {
    if(seq!==homeSeq)return
    var previous=homeState||cached
    if (previous) {renderFeed(previous,true);showBanner("连不上家里的 CC · 上次更新 " + new Date(previous.synced_at).toLocaleString())}
    else {renderPresenceHome({work:{focus:null,partial:true}},true);showBanner('暂时连不上家里的 CC，请检查电脑连接。');document.getElementById("feed").innerHTML = '<div class="empty">连不上家里的 CC<br><small>看看电脑开着没</small></div>'; document.getElementById("pres-txt").textContent = "暂时不知道 CC 在做什么" }
  })
}
function markMemoriesSeen(){
  if(homeState&&document.visibilityState==='visible'&&document.getElementById('p-memory').classList.contains('on')&&!document.getElementById('banner').textContent)
    api('/m/api/seen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({until:homeState.synced_at})}).catch(function(){})
}
document.querySelector('nav button[data-p="memory"]').addEventListener('click',markMemoriesSeen)
setInterval(function(){if(!document.hidden&&document.getElementById('p-today').classList.contains('on'))loadHome()},15000)
document.getElementById("feed").addEventListener("click", function(ev) {
  var b = /** @type {HTMLButtonElement} */ (/** @type {Element} */ (ev.target).closest("button.more"))
  if (!b || !homeState) return
  b.disabled = true
  api("/m/api/feed?cursor=" + encodeURIComponent(b.dataset.cursor)).then(function(r){ return r.json() }).then(function(r) {
    if (!r || !r.ok) { b.disabled = false; return }
    homeState.events = homeState.events.concat(r.events); homeState.next_cursor = r.next_cursor
    if (r.sources_degraded) homeState.sources_degraded = r.sources_degraded
    renderFeed(homeState, !!document.getElementById("banner").textContent)
  }).catch(function(){ b.disabled = false; toast("网络不通") })
})
document.getElementById("refresh").addEventListener("click", loadHome)
document.addEventListener("visibilitychange", function(){ if (document.visibilityState === "visible") loadHome() })
function load() {
  api("/m/api/state").then(function(r) {
    if (r.status === 401) { try { localStorage.removeItem("deviceToken") } catch (e) {}; location.replace("/m"); return null }
    return r.json()
  }).then(function(s){ if (s && s.ok) render(s) }).catch(function(){ toast("连不上家里的电脑 — 看看它开着没") })
}
loadHome()
load()
