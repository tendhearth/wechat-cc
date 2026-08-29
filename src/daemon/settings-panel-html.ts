/**
 * settings-panel-html.ts — the /set + /m page documents and the shared tunnel
 * client, extracted from settings-panel.ts (2026-08-27 架构审查:845 行揉了
 * 路由+令牌+文件服务+三份内联 HTML/JS,拆开后主文件只剩路由/令牌逻辑).
 *
 * These are pure string builders (pageHtml/phoneHtml take their args, the rest
 * are constants). No dependency on makeSettingsPanel internals — safe to live
 * apart. `TUNNEL_CLIENT_JS` is shared by both pages and stays private here.
 */
import { readFileSync } from 'node:fs'
import { safeSvg } from '../lib/svg-sanitize'

export function safeSvgFile(path: string): string | null {
  try { return safeSvg(readFileSync(path, 'utf8')) } catch { return null }
}

export const EXPIRED_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;background:#f5ead8;color:#5a3f2d;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:52px">⏳</div><h2 style="margin:8px 0">链接过期啦</h2>
<p style="color:#8b5e3c">回微信跟 CC 说「/set」再要一个新链接~</p></div></body>`

/** The settings page — fully self-contained (WeChat's browser, no CDN). */
export function pageHtml(token: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CC 的设置</title>
<style>
  :root { --ink:#5a3f2d; --soft:#8b5e3c; --accent:#b0563a; --paper:#f5ead8; --card:#fffdf8; --line:rgba(89,63,44,.25); }
  * { box-sizing:border-box }
  body { margin:0; font-family:system-ui,-apple-system,"PingFang SC",sans-serif; background:var(--paper); color:var(--ink); padding:20px 16px 48px }
  h1 { font-size:26px; margin:6px 0 2px }
  .sub { color:var(--soft); font-size:13px; margin-bottom:18px }
  section { background:var(--card); border:2px solid var(--line); border-radius:14px 18px 12px 20px; padding:16px; margin-bottom:16px }
  section h2 { font-size:16px; margin:0 0 4px; color:var(--accent) }
  .hint { font-size:12px; color:var(--soft); margin:0 0 12px }
  label.row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 0; border-top:1px dashed var(--line) }
  label.row:first-of-type { border-top:0 }
  .row b { font-size:14px; font-weight:600 }
  .row small { display:block; color:var(--soft); font-weight:400; margin-top:2px }
  input[type=text], textarea, select { font:inherit; color:var(--ink); background:#fff; border:1.5px solid var(--line); border-radius:8px; padding:8px 10px }
  input[type=text] { width:150px }
  textarea { width:100%; min-height:110px; resize:vertical }
  .switch { appearance:none; width:46px; height:26px; border-radius:13px; background:#d8c6ae; position:relative; cursor:pointer; transition:.15s; flex-shrink:0 }
  .switch:checked { background:var(--accent) }
  .switch::after { content:""; position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#fff; transition:.15s }
  .switch:checked::after { left:23px }
  .seg { display:flex; gap:6px }
  .seg button { font:inherit; font-size:13px; padding:6px 12px; border:1.5px solid var(--line); background:#fff; border-radius:8px; color:var(--soft) }
  .seg button.on { background:var(--accent); border-color:var(--accent); color:#fff }
  details { margin-top:4px } summary { color:var(--soft); font-size:14px; cursor:pointer; padding:6px 0 }
  .say { font-size:12px; color:var(--soft); background:rgba(176,86,58,.07); border-radius:8px; padding:8px 10px; margin-top:10px }
  #toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); background:var(--ink); color:#fff; padding:8px 18px; border-radius:20px; font-size:13px; opacity:0; transition:.25s; pointer-events:none }
  #toast.show { opacity:1 }
  .save { font:inherit; padding:8px 16px; border:0; border-radius:10px; background:var(--accent); color:#fff; margin-top:8px }
</style></head><body>
<h1>🐻 CC 的设置</h1>
<div class="sub">改完立即生效 · 链接 10 分钟内有效 · <a href="javascript:void(0)" onclick="ccNav('/m')" style="color:var(--accent)">随身 CC →</a></div>

<section id="sec-persona">
  <h2>人格与称呼</h2>
  <p class="hint">CC 是谁、该怎么叫你</p>
  <label class="row"><span><b>CC 怎么称呼你</b><small>只填称呼本身,比如「大人」</small></span><input type="text" id="f-name"></label>
  <label class="row"><span><b>CC 叫什么名字</b></span><input type="text" id="f-botname"></label>
  <div class="row" style="display:block;border-top:1px dashed var(--line);padding-top:10px">
    <b>CC 的性格</b><small style="color:var(--soft)">写给 CC 的性格说明,每次聊天都会带上</small>
    <textarea id="f-persona" placeholder="比如:说话温柔,偶尔损我一句,别太啰嗦…"></textarea>
    <button class="save" id="save-persona">保存性格</button>
  </div>
  <div class="say">💬 也可以直接跟 CC 说:「以后叫我大人」「说话毒舌一点」</div>
</section>

<section id="sec-companion">
  <h2>陪伴方式</h2>
  <p class="hint">CC 主动来找你的方式</p>
  <label class="row"><span><b>主动关心</b><small>CC 隔段时间主动来看看你</small></span>
    <span class="seg" id="f-care">
      <button data-v="off">关</button><button data-v="low">轻</button><button data-v="high">贴心</button>
    </span></label>
  <label class="row"><span><b>回复拆成小气泡</b><small>像真人一样分几条发</small></span><input type="checkbox" class="switch" id="f-split"></label>
  <label class="row"><span><b>表情包</b></span><input type="checkbox" class="switch" id="f-stickers"></label>
  <label class="row"><span><b>每日打猎</b><small>早上主动分享它发现的东西</small></span><input type="checkbox" class="switch" id="f-hunt"></label>
  <div class="say">💬 也可以直接说:「别拆分回复了」「关心档位调低点」</div>
</section>

<section id="sec-remote" hidden>
  <h2>随身 CC</h2>
  <p class="hint">开启后,手机加到主屏,出门也能看待办和 CC 画的你</p>
  <label class="row"><span><b>出门也能用</b><small>经加密中继回家,数据只在你自己电脑上,中间人看不到</small></span><input type="checkbox" class="switch" id="f-remote"></label>
  <div class="say" id="remote-hint">开启需要重启一下 CC(约十几秒),之后在同一 Wi-Fi 下打开随身 CC,点「把 CC 带在身上」即可</div>
  <label class="row" id="row-devices" hidden><span><b>已配对设备</b><small id="devices-count"></small></span><button type="button" id="forget-devices" style="font:inherit;font-size:12.5px;padding:5px 12px;border:1.5px solid var(--line);border-radius:999px;background:var(--card);color:var(--accent);cursor:pointer">全部忘掉</button></label>
</section>

<section>
  <details><summary>⚙️ 技术详情(好奇再点)</summary>
    <label class="row"><span><b>模型</b><small>CC 用哪个大脑思考</small></span><input type="text" id="f-model" style="width:190px"></label>
    <label class="row"><span><b>知识库</b><small>长期记忆检索</small></span><input type="checkbox" class="switch" id="f-knowledge"></label>
    <label class="row"><span><b>社交能力</b><small>替你和别人的 CC 打交道</small></span><input type="checkbox" class="switch" id="f-social"></label>
    <label class="row"><span><b>开机自启</b></span><input type="checkbox" class="switch" id="f-autostart"></label>
  </details>
</section>

<div id="toast"></div>
<script>
var T = ${JSON.stringify(token)};
var REMOTE = null;
try { var rr = localStorage.getItem("ccRemote"); if (rr) REMOTE = JSON.parse(rr) } catch (e) {}
const $ = id => document.getElementById(id);
function q(p) { return p + (p.indexOf("?") < 0 ? "?" : "&") + "t=" + encodeURIComponent(T) }
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 1400) }
${TUNNEL_CLIENT_JS}
// sapi:设置页的 JSON 封装,底下走共享 api()(在家直连,壳/出门走隧道)。
async function sapi(path, body) {
  const r = await api(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)
  if (r.status === 401) { document.body.innerHTML = '<div style="text-align:center;padding-top:40vh">⏳ 链接过期啦,回微信跟 CC 再要一个~</div>'; throw new Error("expired") }
  return r.json()
}
async function apply(op, extra, okMsg) {
  let r
  try { r = await sapi("/set/api/apply", Object.assign({ op }, extra)) }
  catch (e) { toast("没连上 — 待在家里(和电脑同一网络)再试"); return false }  // 网络/过期:别静默,让调用方回滚
  toast(r.ok ? (okMsg || "已保存 ✓") : (r.error === "lan_only" ? "这个开关要在家里(和电脑同一网络)才能动" : "没改成: " + (r.error || "unknown")))
  return r.ok
}
function wireSwitch(id, kind, key) {
  $(id).addEventListener("change", async e => {
    const v = e.target.checked
    const ok = await apply(kind === "pref" ? "set_pref" : "set_config", { key, value: v })
    if (!ok) e.target.checked = !v   // 保存失败 → 回滚开关,别让 UI 撒谎(下次 load 会打回原形)
  })
}
function wireText(id, fn) {
  $(id).addEventListener("change", e => { const v = e.target.value.trim(); if (v) fn(v) })
}
async function load() {
  const s = await sapi("/set/api/state")
  if (!s.ok) { toast("读取失败"); return }
  $("f-name").value = s.name || ""
  $("f-botname").value = s.config.bot_name || ""
  $("f-persona").value = s.persona || ""
  $("f-split").checked = s.prefs.split !== false
  $("f-stickers").checked = s.prefs.stickers !== false
  $("f-hunt").checked = s.prefs.hunt !== false
  $("f-model").value = s.config.model || ""
  $("f-knowledge").checked = s.config.knowledge_enabled === true
  $("f-social").checked = s.config.social_enabled === true
  $("f-autostart").checked = s.config.autoStart === true
  if (s.remote && s.remote.available) {
    $("sec-remote").hidden = false
    $("f-remote").checked = s.remote.enabled === true
    if (window.__CC_SHELL__ || preferTunnel) {
      $("f-remote").disabled = true
      $("remote-hint").textContent = "出门在外不能动这个开关 — 回家(和电脑同一网络)再改"
    }
    if (s.remote.devices > 0) { $("row-devices").hidden = false; $("devices-count").textContent = s.remote.devices + " 台手机拿着长期钥匙" }
  }
  const care = s.prefs.care || "low"
  for (const b of $("f-care").querySelectorAll("button")) b.classList.toggle("on", b.dataset.v === care)
}
$("f-care").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return
  if (await apply("set_pref", { key: "care", value: b.dataset.v })) {
    for (const o of $("f-care").querySelectorAll("button")) o.classList.toggle("on", o === b)
  }
})
wireText("f-name", v => apply("set_name", { name: v }, "以后就这么称呼你 ✓"))
wireText("f-botname", v => apply("set_config", { key: "bot_name", value: v }))
wireText("f-model", v => apply("set_config", { key: "model", value: v }))
$("save-persona").addEventListener("click", () => apply("set_persona", { content: $("f-persona").value }, "性格已更新 ✓"))
wireSwitch("f-split", "pref", "split")
wireSwitch("f-stickers", "pref", "stickers")
wireSwitch("f-hunt", "pref", "hunt")
wireSwitch("f-knowledge", "config", "knowledge_enabled")
wireSwitch("f-social", "config", "social_enabled")
wireSwitch("f-autostart", "config", "autoStart")
$("forget-devices").addEventListener("click", async () => {
  if (!confirm("忘掉所有已配对设备?手机上的随身 CC 会立即失效,需要重新配对。")) return
  const r = await sapi("/set/api/apply", { op: "forget_devices" })
  if (r.ok) { $("row-devices").hidden = true; toast("都忘掉了,手机要重新配对") }
})
$("f-remote").addEventListener("change", async e => {
  const on = e.target.checked
  const h = $("remote-hint")
  h.textContent = on ? "正在开启并重启 CC…十几秒后回来,在同一 Wi-Fi 下打开随身 CC 点「把 CC 带在身上」" : "已关闭出门访问"
  let r
  try { r = await sapi("/set/api/apply", { op: "set_remote", enabled: on }) }
  catch (err) { h.textContent = "没连上 — 待在家里再试"; e.target.checked = !on; return }
  if (!r.ok) { h.textContent = "没改成:" + (r.error || ""); e.target.checked = !on }
})
load().catch(() => {})
</script></body></html>`
}


export const SW_JS = `
const CACHE = 'cc-shell-v1'
self.addEventListener('install', function(e){ self.skipWaiting() })
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()) })
self.addEventListener('fetch', function(e){
  var url = new URL(e.request.url)
  if (e.request.mode === 'navigate' && url.pathname === '/m') {
    // network-first for the shell; cache the tokened doc; fall back offline.
    e.respondWith(fetch(e.request).then(function(r){
      var copy = r.clone(); caches.open(CACHE).then(function(c){ c.put('shell', copy) }); return r
    }).catch(function(){ return caches.open(CACHE).then(function(c){ return c.match('shell') }).then(function(m){ return m || new Response('离线且没有缓存,请先在家里打开一次', { status: 503 }) }) }))
    return
  }
  if (url.pathname === '/m/icon.png' || url.pathname === '/m/manifest.json') {
    e.respondWith(caches.open(CACHE).then(function(c){ return c.match(e.request).then(function(m){ return m || fetch(e.request).then(function(r){ c.put(e.request, r.clone()); return r }) }) }))
    return
  }
  // /m/api/* and everything else — let the page decide (LAN → tunnel).
})
`

export const M_BOOTSTRAP_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="manifest" href="/m/manifest.json"><title>CC</title>
<body style="font-family:system-ui;background:#f5ead8;color:#5a3f2d;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:52px">🐻</div><p id="msg">正在找你的钥匙…</p></div>
<script>
try {
  var d = localStorage.getItem("deviceToken")
  if (d) { location.replace("/m?d=" + encodeURIComponent(d)) }
  else { document.getElementById("msg").textContent = "还没配对过 — 回微信跟 CC 说「/set」拿个新链接,打开后点「把 CC 带在身上」" }
} catch (e) { document.getElementById("msg").textContent = "浏览器不让存钥匙,回微信重新拿链接吧" }
</script></body>`

const TUNNEL_CLIENT_JS = `
// 传输层:先直连(同 Wi-Fi),失败且配了 remote 就走中继隧道(端到端加密)。
var b64u = { enc: function(b){ return btoa(String.fromCharCode.apply(null, new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"") },
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
`

/** 随身 CC 手机页 — 待办 / 小像 / 表情,自包含无 CDN,PWA 可加主屏。 */
export function phoneHtml(token: string, remote: { relay: string; id: string } | null): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>CC</title>
<link rel="manifest" href="/m/manifest.json">
<link rel="apple-touch-icon" href="/m/icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<style>
  :root { --ink:#5a3f2d; --soft:#8b5e3c; --accent:#b0563a; --paper:#f5ead8; --card:#fffdf8; --line:rgba(89,63,44,.25); }
  * { box-sizing:border-box }
  body { margin:0; font-family:system-ui,-apple-system,"PingFang SC",sans-serif; background:var(--paper); color:var(--ink); padding-bottom:70px }
  header { padding:18px 16px 8px } header h1 { font-size:22px; margin:0 }
  header .sub { color:var(--soft); font-size:12.5px }
  .pane { padding:8px 14px 20px; display:none } .pane.on { display:block }
  .card { background:var(--card); border:1.5px solid var(--line); border-radius:14px 18px 12px 20px; padding:12px 14px; margin-bottom:10px }
  .todo { display:flex; align-items:center; gap:10px }
  .todo .tx { flex:1; min-width:0 } .todo .tx b { font-size:14px; font-weight:600; display:block }
  .todo .tx small { color:var(--soft) }
  .todo button { font:inherit; font-size:12.5px; padding:5px 12px; border:1.5px solid var(--line); border-radius:999px; background:var(--card); color:var(--ink) }
  .todo button.done-btn { background:var(--accent); border-color:var(--accent); color:#fff }
  .grp { color:var(--accent); font-size:13px; font-weight:700; margin:14px 2px 6px }
  .empty { text-align:center; color:var(--soft); padding:40px 10px }
  .portrait { text-align:center; padding:12px }
  .portrait .frame { display:inline-block; background:var(--card); border:2.5px solid var(--line); border-radius:16px 20px 14px 22px; padding:16px; transform:rotate(-1deg); max-width:78vw }
  .portrait svg { width:100%; height:auto } .portrait figcaption { color:var(--soft); font-size:13px; margin-top:8px }
  .stgrid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px }
  .stgrid figure { margin:0; background:var(--card); border:1.5px solid var(--line); border-radius:12px; padding:8px; text-align:center }
  .stgrid img { width:100%; height:84px; object-fit:contain } .stgrid figcaption { font-size:11.5px; color:var(--soft) }
  nav { position:fixed; left:0; right:0; bottom:0; display:flex; background:var(--card); border-top:1.5px solid var(--line); padding-bottom:env(safe-area-inset-bottom) }
  nav button { flex:1; font:inherit; font-size:12px; padding:10px 0 8px; border:0; background:none; color:var(--soft) }
  nav button.on { color:var(--accent); font-weight:700 }
  nav button .i { display:block; font-size:20px }
  #pairbar { margin:8px 14px; padding:9px 12px; background:rgba(176,86,58,.08); border-radius:10px; font-size:12.5px; color:var(--soft) }
  #pairbar button { font:inherit; font-size:12.5px; margin-left:8px; padding:4px 12px; border:1.5px solid var(--accent); border-radius:999px; background:var(--accent); color:#fff }
  #toast { position:fixed; left:50%; bottom:76px; transform:translateX(-50%); background:var(--ink); color:#fff; padding:7px 16px; border-radius:16px; font-size:12.5px; opacity:0; transition:.25s; pointer-events:none }
  #toast.show { opacity:1 }
</style></head><body>
<header><h1>🐻 CC</h1><div class="sub" id="sub">随身小窗 · 数据都在你自己电脑上</div></header>
<div id="pairbar" hidden>这个链接 10 分钟就过期<button id="pairbtn">把 CC 带在身上</button></div>
<div class="pane on" id="p-todos"><div id="todos"></div></div>
<div class="pane" id="p-portrait"><div class="portrait" id="portrait"></div></div>
<div class="pane" id="p-stickers"><div class="stgrid" id="stickers"></div></div>
<nav>
  <button data-p="todos" class="on"><span class="i">📋</span>待办</button>
  <button data-p="portrait"><span class="i">🖼</span>CC画的你</button>
  <button data-p="stickers"><span class="i">🐻</span>表情</button>
  <button id="nav-set"><span class="i">⚙️</span>设置</button>
</nav>
<div id="toast"></div>
<script>
var T = ${JSON.stringify(token)}
var REMOTE = ${JSON.stringify(remote)}
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
${TUNNEL_CLIENT_JS}
document.getElementById("pairbtn").addEventListener("click", function() {
  fetch(q("/set/api/pair"), { method: "POST" }).then(function(r){ return r.json() }).then(function(r) {
    if (r.ok && r.device_token) {
      try { localStorage.setItem("deviceToken", r.device_token) } catch (e) {}
      T = r.device_token; isDevice = true
      document.getElementById("pairbar").hidden = true
      toast("配好了,把这页加到主屏幕就能一直用")
    } else toast("没配上:" + (r.error || ""))
  }).catch(function(){ toast("没配上,网络不通") })
})
document.querySelectorAll("nav button[data-p]").forEach(function(b) {
  b.addEventListener("click", function() {
    document.querySelectorAll("nav button").forEach(function(o){ o.classList.toggle("on", o === b) })
    document.querySelectorAll(".pane").forEach(function(p){ p.classList.toggle("on", p.id === "p-" + b.dataset.p) })
  })
})
document.getElementById("nav-set").addEventListener("click", function(){ ccNav("/set") })
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
        if (r && r.ok) { var img = sg.querySelector('[data-sti="' + i + '"]'); if (img) img.src = "data:" + r.mime + ";base64," + r.data }
      }).catch(function(){})
    })
  }
}
document.getElementById("todos").addEventListener("click", function(ev) {
  var b = ev.target.closest("button[data-id]")
  if (!b) return
  // 走隧道感知的 api()(在家直连,出门/壳模式走隧道)—— 不能用裸 fetch,
  // 否则出门时待办勾选打不到家里的 daemon。
  api("/m/api/todo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: Number(b.dataset.id), status: b.dataset.st }) })
    .then(function(r){ return r.json() }).then(function(r) { if (r.ok) { toast(b.dataset.st === "active" ? "捞回来了" : "划掉了 ✓"); load() } else toast("没改成") })
    .catch(function(){ toast("网络不通") })
})
function load() {
  api("/m/api/state").then(function(r) {
    if (r.status === 401) { try { localStorage.removeItem("deviceToken") } catch (e) {}; location.replace("/m"); return null }
    return r.json()
  }).then(function(s){ if (s && s.ok) render(s) }).catch(function(){ toast("连不上家里的电脑 — 看看它开着没") })
}
load()
</script></body></html>`
}
