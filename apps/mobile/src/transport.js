/*@@CCP@@*/
// 传输层:先直连(同 Wi-Fi),失败且配了 remote 就走中继隧道(端到端加密)。
// v1 密封帧改由本文件顶部那行占位注释挂的 CCP(packages/protocol,noble 实
// 现,apps/mobile/sources.ts 的 readMobileSource 在读这个文件时原地替换成
// apps/mobile/src/protocol-generated.js 的内容)算,跟 daemon(同一个包)字
// 节级兼容;这里不再手写 WebCrypto 的 subtle 那一块,沙箱可以没有它(只要有
// crypto.getRandomValues / TextEncoder / TextDecoder / atob / btoa)。hs 握
// 手交换的裸公钥还是走下面这份手写 base64url(不是 v1 密封帧,CCP 管不着;
// continuation-materials.test.ts 按大文件场景专门测过)。
// 注:占位注释写成合法的空 JS 注释而不是 apps/mobile 的构建期包含语法(见
// assemble.ts 的 INCLUDE 正则)—— 那套标记不是合法 JS,这个文件若以它开头,`tsc -p apps/mobile`
// 把 src/*.js 当真 JS 解析(checkJs)会在替换之前就报语法错误。这份注释故意
// 不重复打印顶部那行占位注释的确切写法 —— sources.ts 用字符串替换,写第二
// 遍会被当成第二处替换点,把生成物插进注释中间炸成语法错误(relay/pset.src.html
// 踩过一次同款坑,原因相同:占位标记只能在真正要展开的地方出现一次)。
var b64u = { enc: function(b){ var bytes=new Uint8Array(b),parts=[];for(var i=0;i<bytes.length;i+=0x8000)parts.push(String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000)));return btoa(parts.join("")).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"") },
  dec: function(s){ s = s.replace(/-/g,"+").replace(/_/g,"/"); var bin = atob(s); var a = new Uint8Array(bin.length); for (var i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i); return a } }
var tun = null
var tunWs = null
function tunnel() {
  if (tun) return tun
  tun = new Promise(function(resolve, reject) {
    if (!REMOTE) { reject(new Error("no_remote")); return }
    var ws = new WebSocket(REMOTE.relay + "?id=" + encodeURIComponent(REMOTE.id))
    tunWs = ws
    // relay tags streams itself — the phone sends/receives BARE frames.
    var key = null, kp = null, pending = {}
    var ready = false
    function failAllPending(err) { for (var k in pending) { try { pending[k](null, err) } catch (e) {} } pending = {} }
    ws.onopen = function() {
      kp = CCP.x25519KeyPair()
      ws.send(JSON.stringify({ hs: b64u.enc(kp.pub) }))
    }
    ws.onmessage = function(ev) {
      var f = JSON.parse(ev.data)
      // 握手前的错误让 tunnel() 失败;握手后的(daemon 认不出这台手机:auth_failed)让挂着的请求全部失败,别永远等。
      if (f.error) { var err = new Error(f.error); reject(err); failAllPending(err); try { ws.close() } catch (e) {}; return }
      if (f.hs) {
        // Key BOUND to the device token — proves to the daemon we hold it,
        // without ever putting it on the wire; defeats a MITM relay.
        var shared = CCP.x25519Shared(kp.priv, b64u.dec(f.hs))
        key = CCP.deriveV1Key(shared, T)
        ready = true; resolve(send)
        return
      }
      if (!key || !f.iv) return
      var pt = CCP.openV1(key, { iv: f.iv, ct: f.ct })
      var r = JSON.parse(new TextDecoder().decode(pt))
      var cb = pending[r.rid]; delete pending[r.rid]
      if (cb) cb(r)
    }
    ws.onerror = function(){ reject(new Error("ws_error")) }
    // 只清自己那条:resetTunnel() 之后旧 socket 的 close 事件是异步晚到的,那时 tun 可能已是新开的隧道(plan 7a)。
    ws.onclose = function(){ if (tunWs === ws) { tun = null; tunWs = null } failAllPending(new Error("closed")); if (!ready) reject(new Error("ws_closed")) }
    var ridSeq = 0
    function send(path, opts) {
      var rid = "r" + (ridSeq++)
      // token NEVER travels — the bound key already authenticated us; the
      // daemon injects the device token server-side. Send the BARE path.
      var body = JSON.stringify({ path: path, method: (opts && opts.method) || "GET", body: opts && opts.body, rid: rid })
      var frame = CCP.sealV1(key, new TextEncoder().encode(body))
      return new Promise(function(res, rej) {
        pending[rid] = function(r, err){ if (err) { rej(err); return } res({ status: r.status, text: function(){ return Promise.resolve(r.body) }, json: function(){ return Promise.resolve(JSON.parse(r.body)) } }) }
        ws.send(JSON.stringify({ iv: frame.iv, ct: frame.ct }))
      })
    }
  })
  return tun
}
// 配对换了令牌(nav.js)之后,绑着旧短令牌的隧道作废:关掉,下一次 api() 用新令牌重新握手(plan 7a)。
function resetTunnel() {
  var w = tunWs
  tunWs = null; tun = null
  if (w) { try { w.close() } catch (e) {} }
}
// 401:只有「发请求时用的令牌」就是现在这枚,才说明本机令牌失效;刚配对换令牌时在飞的旧请求回 401 不算(plan 7a)。
/** @param {string} sentAs */
function onUnauthorized(sentAs) {
  if (sentAs !== T) return
  try { localStorage.removeItem("deviceToken") } catch (e) {}
  location.replace("/m")
}
// api():在家直连,出门走隧道。一旦直连失败一次就记住"在外面",后续
// 直接走隧道,不再每次白等 2.5s。返回 {status, json(), text()}。
var preferTunnel = false
function api(path, opts) {
  if (preferTunnel && REMOTE) return tunnel().then(function(send){ return send(path, opts) })
  var ctrl = new AbortController()
  var to = setTimeout(function(){ ctrl.abort() }, 2500)
  return fetch(q(path), Object.assign({ signal: ctrl.signal }, opts || {})).then(function(r){
    clearTimeout(to); return r
  }).catch(function() {
    clearTimeout(to)
    if (!REMOTE) throw new Error("no_lan_no_remote")
    preferTunnel = true
    return tunnel().then(function(send){ return send(path, opts) })
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
