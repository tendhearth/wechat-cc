/*@@CCP@@*/
// 传输层:先直连(同 Wi-Fi),失败且配了 remote 就走中继(端到端加密)。
// 2026-10-25(架构终态 F4):中继那一路跟原生 App 用同一个协议客户端 —— 本文件顶部那行占位注释挂的
// CCP.makeProtocolClient(packages/protocol 的 client.ts,apps/mobile/sources.ts 的 readMobileSource 在读这个
// 文件时原地替换成 apps/mobile/src/protocol-generated.js 的内容),说协议 v2(双向密钥、计数器 nonce、
// 防重放)。握手自报 client:"web",daemon 据此把这里建的事记成网页出生。v1 与老 VPS 中继(t… id)已退休:
// 还拿着老中继 id、或 daemon 回 upgrade_required 的页面,提示主人在电脑上重新扫码配对(ccNeedsRepair)。
// 沙箱可以没有 crypto.subtle(只要有 crypto.getRandomValues / TextEncoder / TextDecoder / WebSocket)。
// 注:占位注释写成合法的空 JS 注释而不是 apps/mobile 的构建期包含语法(见
// assemble.ts 的 INCLUDE 正则)—— 那套标记不是合法 JS,这个文件若以它开头,`tsc -p apps/mobile`
// 把 src/*.js 当真 JS 解析(checkJs)会在替换之前就报语法错误。这份注释故意
// 不重复打印顶部那行占位注释的确切写法 —— sources.ts 用字符串替换,写第二
// 遍会被当成第二处替换点,把生成物插进注释中间炸成语法错误(relay/pset.src.html
// 踩过一次同款坑,原因相同:占位标记只能在真正要展开的地方出现一次)。
var CC_REPAIR_TEXT = "连接方式升级了，请在电脑上重新扫码配对"
var CC_REPAIR_HINT = "在电脑上点「连接手机」，用这台手机扫出现的码。"
/** 老 VPS 中继的 id(t…):随 v1 退休,连不上了。 */
function ccLegacyRemote(/** @type {any} */ r) { return !!r && typeof r.id === "string" && r.id.charAt(0) === "t" }
/** 页面顶上的一块说明(同一个 id 只放一块,再来就换字)。 */
function ccNotice(/** @type {string} */ id, /** @type {string} */ text, /** @type {string} */ hint) {
  if (typeof document === "undefined" || !document.body) return
  var box = document.getElementById(id)
  if (!box) {
    box = document.createElement("div")
    box.id = id
    box.setAttribute("role", "alert")
    box.style.cssText = "margin:8px 14px;padding:12px 14px;background:var(--wash);border-radius:var(--r-s);color:var(--ink);font-size:14px;line-height:1.6"
    document.body.insertBefore(box, document.body.firstChild)
  }
  box.textContent = ""
  var t = document.createElement("div"); t.textContent = text; box.appendChild(t)
  if (hint) { var h = document.createElement("div"); h.textContent = hint; h.style.cssText = "color:var(--soft);font-size:12.5px;margin-top:2px"; box.appendChild(h) }
}
function ccClearNotice(/** @type {string} */ id) {
  if (typeof document === "undefined") return
  var box = document.getElementById(id)
  if (box && box.parentNode) box.parentNode.removeChild(box)
}
// 连接方式升级了:在页面顶上说清楚怎么重新配对。只有手里真是老中继的配对(t… id)才丢掉它 ——
// 一句明文 upgrade_required 谁都能伪造(中继也能),不能凭它删掉一份好好的 v2 配对。
function ccNeedsRepair() {
  if (ccLegacyRemote(REMOTE)) {
    try {
      localStorage.removeItem("ccRemote")
      var dtId = localStorage.getItem("deviceTokenId")
      if (dtId && dtId.charAt(0) === "t") { localStorage.removeItem("deviceToken"); localStorage.removeItem("deviceTokenId") }
    } catch (e) {}
  }
  ccNotice("cc-repair", CC_REPAIR_TEXT, CC_REPAIR_HINT)
}
// v2 配对的握手回来不是 v2(中继把 v 抹掉了):拒绝连接,配对原样留着,协议客户端按退避自己再试。
var CC_TAMPER_TEXT = "家里的电脑暂时连不上（连接在半路被改过），过一会儿会自己再试"
function ccTampered() {
  if (ccLegacyRemote(REMOTE)) { ccNeedsRepair(); return }
  ccNotice("cc-tamper", CC_TAMPER_TEXT, "")
}
/** 浏览器 WebSocket → 协议客户端要的 ProtocolSocket。 */
function ccSocket(/** @type {string} */ url) {
  var ws = new WebSocket(url)
  /** @type {null | (() => void)} */ var onOpen = null
  /** @type {null | ((s: string) => void)} */ var onMsg = null
  /** @type {null | (() => void)} */ var onClose = null
  ws.onopen = function() { if (onOpen) onOpen() }
  ws.onmessage = function(ev) { if (onMsg) onMsg(typeof ev.data === "string" ? ev.data : String(ev.data)) }
  ws.onclose = function() { if (onClose) onClose() }
  ws.onerror = function() { try { ws.close() } catch (e) {} }
  return {
    send: function(/** @type {string} */ s) { ws.send(s) },
    close: function() { try { ws.close() } catch (e) {} },
    onOpen: function(/** @type {() => void} */ cb) { onOpen = cb },
    onMessage: function(/** @type {(s: string) => void} */ cb) { onMsg = cb },
    onClose: function(/** @type {() => void} */ cb) { onClose = cb },
  }
}
// 一个令牌一个客户端:配对换了令牌之后 resetTunnel() 关掉旧的,下一次 api() 用新令牌重新握手。
var tun = null
function tunnel() {
  if (!tun) {
    var remote = REMOTE
    tun = CCP.makeProtocolClient({
      open: function() { return ccSocket(remote.relay + "?id=" + encodeURIComponent(remote.id)) },
      token: T,
      client: "web",
      // 页面会发慢请求(说一句、转写一段话):单次等 30 秒;握手 15 秒没回就重连。
      requestTimeoutMs: 30000,
      handshakeTimeoutMs: 15000,
      // 中继把握手里的 v 抹掉:客户端拒绝降级、按退避重连(不会刷屏);这里只说一声,不动配对。
      onProtocolError: function(/** @type {string} */ reason) { if (reason === "downgrade_refused") ccTampered() },
    })
  }
  return tun
}
/** 经中继发一个请求;回 {status, json(), text()}(跟 fetch 的 Response 用法一样,json/text 是 Promise)。 */
function viaTunnel(/** @type {string} */ path, /** @type {any} */ opts) {
  if (ccLegacyRemote(REMOTE)) { ccNeedsRepair(); return Promise.reject(new Error("upgrade_required")) }
  var o = opts || {}
  /** @type {any} */
  var req = { method: o.method || "GET", path: path }
  if (o.headers) { /** @type {Record<string, string>} */ var hs = {}; for (var k in o.headers) if (typeof o.headers[k] === "string") hs[k] = o.headers[k]; req.headers = hs }
  if (typeof o.body === "string") req.body = o.body
  return tunnel().request(req).then(function(/** @type {any} */ r) {
    ccClearNotice("cc-tamper")
    return { status: r.status, text: function() { return Promise.resolve(r.text()) }, json: function() { return Promise.resolve(r.json()) } }
  }, function(/** @type {Error} */ err) {
    if (err && err.message === "upgrade_required") ccNeedsRepair()
    throw err
  })
}
// 配对换了令牌(nav.js)之后,绑着旧短令牌的隧道作废:关掉,下一次 api() 用新令牌重新握手(plan 7a)。
function resetTunnel() {
  var c = tun
  tun = null
  if (c) { try { c.close() } catch (e) {} }
}
// 401:只有「发请求时用的令牌」就是现在这枚,才说明本机令牌失效;刚配对换令牌时在飞的旧请求回 401 不算(plan 7a)。
/** @param {string} sentAs */
function onUnauthorized(sentAs) {
  if (sentAs !== T) return
  try { localStorage.removeItem("deviceToken"); localStorage.removeItem("deviceTokenId") } catch (e) {}
  location.replace("/m")
}
// api():在家直连,出门走隧道。一旦直连失败一次就记住"在外面",后续
// 直接走隧道,不再每次白等 2.5s。返回 {status, json(), text()}。
var preferTunnel = false
function api(path, opts) {
  if (preferTunnel && REMOTE) return viaTunnel(path, opts)
  var ctrl = new AbortController()
  var to = setTimeout(function(){ ctrl.abort() }, 2500)
  return fetch(q(path), Object.assign({ signal: ctrl.signal }, opts || {})).then(function(r){
    clearTimeout(to); return r
  }).catch(function() {
    clearTimeout(to)
    if (!REMOTE) throw new Error("no_lan_no_remote")
    preferTunnel = true
    return viaTunnel(path, opts)
  })
}
// 壳模式(公网 pset 引导页注入):没有可用的直连域,强制走隧道。
if (window.__CC_SHELL__) { REMOTE = window.__CC_SHELL__; preferTunnel = true }
// 页面间跳转:壳模式下相对路径指向壳域(404),必须经壳流程重进。
function ccNav(path) {
  if (window.__CC_SHELL__) {
    location.href = "/pset/#id=" + encodeURIComponent(window.__CC_SHELL__.id) + "&t=" + encodeURIComponent(T) + "&p=" + encodeURIComponent(path)
    location.reload()
    return
  }
  location.href = q(path)
}
