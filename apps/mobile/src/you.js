// 「CC 眼中的你」(spec 2026-09-26-memory-view-design):一封信的样子,只读。
// 显示用的派生(期限标签、两列、口语时间、变化标签)都由 daemon 算好;这里只渲染。
var youFrames = null, youBlinkTimer = null, youFramesAsked = false
var YOU_ORDER_NOTE = 3
function youReduced() { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) }
function youLine(v) {
  if (v.mood === "first") return "今晚我会第一次整理。"
  return v.mood === "changed" ? "昨晚又认识了你一点。" : "这是我眼中的你。"
}
function youMeta(v) {
  if (v.failures >= 3) return "最近几次整理都没成功,下面可能是旧的"
  return v.when_label ? "最近整理 · " + v.when_label : ""
}
function youNote(v) {
  if (!v.changes || !v.changes.length) return ""
  var h = '<div class="you-note"><div class="you-eyebrow">昨晚</div>'
  v.changes.slice(0, YOU_ORDER_NOTE).forEach(function(c) {
    h += '<div class="you-ch"><span class="you-k">' + esc(c.label) + '</span><span>' + esc(c.text)
    if (c.kind === "update" && c.before) h += '<br><span class="you-was">原来是:' + esc(c.before) + '</span>'
    if (c.kind === "remove" && c.reason) h += '<br><span class="you-was">' + esc(c.reason) + '</span>'
    h += '</span></div>'
  })
  if (v.changes.length > YOU_ORDER_NOTE) h += '<div class="you-was">还有 ' + (v.changes.length - YOU_ORDER_NOTE) + ' 处</div>'
  return h + '</div>'
}
function youItem(section, it) {
  var dot = it.changed ? '<span class="you-new" role="img" aria-label="昨晚更新"></span>' : ""
  if (it.person) return '<div class="you-who"><b>' + esc(it.person.name) + '</b><span>' + esc(it.person.rel) + dot + '</span></div>'
  var due = it.due_label ? '<span class="you-due">' + esc(it.due_label) + '</span>' : ""
  return '<div class="you-it"><span>' + esc(it.display) + dot + '</span>' + due + '</div>'
}
function youHtml(v) {
  var h = '<p class="you-line">' + esc(youLine(v)) + '</p><p class="you-meta">' + esc(youMeta(v)) + '</p>'
  if (v.mood === "first") return h
  h += youNote(v)
  v.sections.forEach(function(s) {
    h += '<div class="you-sec">' + esc(s.name.split("").join(" ")) + '</div>'
    s.items.forEach(function(it) { h += youItem(s.name, it) })
  })
  return h + '<p class="you-foot">不对的地方,直接跟我说。</p>'
}
function youBlinkOnce() {
  var img = /** @type {HTMLImageElement} */ (document.getElementById("you-img"))
  var front = img.getAttribute("data-front") || img.src
  var seq = [youFrames.half, youFrames.closed, youFrames.half, front], i = 0
  var t = setInterval(function() { img.src = seq[i++]; if (i >= seq.length) clearInterval(t) }, 70)
}
function youBlinkLoop() {
  if (youReduced() || youBlinkTimer) return
  youBlinkTimer = setTimeout(function() {
    youBlinkTimer = null
    var pane = document.getElementById("p-you")
    if (!pane || !pane.classList.contains("on") || document.hidden) return
    if (youFrames) youBlinkOnce()
    youBlinkLoop()
  }, 3000 + Math.random() * 4000)
}
function youLoadFrames() {
  if (youFramesAsked) return Promise.resolve()
  youFramesAsked = true
  return api("/m/api/art/blink").then(function(r) { return r.json() }).then(function(f) {
    if (f && f.ok) youFrames = { half: "data:" + f.mime + ";base64," + f.half, closed: "data:" + f.mime + ";base64," + f.closed }
  }).catch(function() { youFramesAsked = false })
}
// 读到过一封信就留着它刷新,不再每次打开都闪一下「看看我记得什么…」。
var youShown = false
function loadYou() {
  var body = document.getElementById("you-body")
  if (!youShown) body.innerHTML = '<p class="you-meta">看看我记得什么…</p>'
  youLoadFrames()
  return api("/m/api/memory").then(function(r) { return r.json() }).then(function(v) {
    if (!v || !v.ok) throw new Error("unavailable")
    body.innerHTML = youHtml(v)
    youShown = true
  }).catch(function() {
    youShown = false
    body.innerHTML = '<p class="you-line">暂时读不到。</p><p class="you-meta">看看电脑开着没,一会儿再点我。</p>'
  })
}
function openYou() {
  var light = /** @type {HTMLImageElement} */ (document.querySelector(".home-light"))
  var img = /** @type {HTMLImageElement} */ (document.getElementById("you-img"))
  if (light && !img.getAttribute("data-front")) { img.src = light.src; img.setAttribute("data-front", light.src) }
  document.querySelectorAll(".pane").forEach(function(p) { p.classList.toggle("on", p.id === "p-you") })
  document.querySelectorAll("nav button").forEach(function(b) { b.classList.remove("on") })
  loadYou()
  youBlinkLoop()
}
document.getElementById("you-back").addEventListener("click", function() { mobilePane("today") })
document.addEventListener("visibilitychange", function() { if (!document.hidden) youBlinkLoop() })
