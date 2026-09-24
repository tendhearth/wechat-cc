
// 传输层:先直连(同 Wi-Fi),失败且配了 remote 就走中继隧道(端到端加密)。
var b64u = { enc: function(b){ return btoa(String.fromCharCode.apply(null, new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"") },
  dec: function(s){ s = s.replace(/-/g,"+").replace(/_/g,"/"); var bin = atob(s); var a = new Uint8Array(bin.length); for (var i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i); return a } }
var tun = null
function tunnel() {
  if (tun) return tun
  tun = new Promise(function(resolve, reject) {
    if (!REMOTE) { reject(new Error("no_remote")); return }
    var ws = new WebSocket(REMOTE.relay + "?id=" + encodeURIComponent(REMOTE.id))
    // relay tags streams itself — the phone sends/receives BARE frames.
    var key = null, kp = null, pending = {}
    var ready = false
    function failAllPending(err) { for (var k in pending) { try { pending[k](null, err) } catch (e) {} } pending = {} }
    ws.onopen = async function() {
      kp = await crypto.subtle.generateKey({ name:"X25519" }, true, ["deriveKey","deriveBits"])
      var raw = await crypto.subtle.exportKey("raw", kp.publicKey)
      ws.send(JSON.stringify({ hs: b64u.enc(raw) }))
    }
    ws.onmessage = async function(ev) {
      var f = JSON.parse(ev.data)
      if (f.error) { reject(new Error(f.error)); return }
      if (f.hs) {
        var pub = await crypto.subtle.importKey("raw", b64u.dec(f.hs), { name:"X25519" }, true, [])
        var bits = await crypto.subtle.deriveBits({ name:"X25519", public: pub }, kp.privateKey, 256)
        var hk = await crypto.subtle.importKey("raw", new Uint8Array(bits), "HKDF", false, ["deriveKey"])
        // Key BOUND to the device token — proves to the daemon we hold it,
        // without ever putting it on the wire; defeats a MITM relay.
        key = await crypto.subtle.deriveKey({ name:"HKDF", hash:"SHA-256", salt:new TextEncoder().encode(T), info:new TextEncoder().encode("wechat-cc/tunnel/v1") }, hk, { name:"AES-GCM", length:256 }, false, ["encrypt","decrypt"])
        ready = true; resolve(send)
        return
      }
      if (!key || !f.iv) return
      var iv = b64u.dec(f.iv), ct = b64u.dec(f.ct)
      var pt = await crypto.subtle.decrypt({ name:"AES-GCM", iv: iv }, key, ct)
      var r = JSON.parse(new TextDecoder().decode(pt))
      var cb = pending[r.rid]; delete pending[r.rid]
      if (cb) cb(r)
    }
    ws.onerror = function(){ reject(new Error("ws_error")) }
    ws.onclose = function(){ tun = null; failAllPending(new Error("closed")); if (!ready) reject(new Error("ws_closed")) }
    var ridSeq = 0
    async function send(path, opts) {
      var rid = "r" + (ridSeq++)
      // token NEVER travels — the bound key already authenticated us; the
      // daemon injects the device token server-side. Send the BARE path.
      var body = JSON.stringify({ path: path, method: (opts && opts.method) || "GET", body: opts && opts.body, rid: rid })
      var iv = crypto.getRandomValues(new Uint8Array(12))
      var ct = await crypto.subtle.encrypt({ name:"AES-GCM", iv: iv }, key, new TextEncoder().encode(body))
      return new Promise(function(res, rej) {
        pending[rid] = function(r, err){ if (err) { rej(err); return } res({ status: r.status, text: function(){ return Promise.resolve(r.body) }, json: function(){ return Promise.resolve(JSON.parse(r.body)) } }) }
        ws.send(JSON.stringify({ iv: b64u.enc(iv), ct: b64u.enc(ct) }))
      })
    }
  })
  return tun
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
