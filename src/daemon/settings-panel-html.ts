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
import { MOBILE_BRAND_ICON_VERSION } from './mobile-brand-icon'
import {MOBILE_WORKBENCH_JS} from './mobile-workbench-client'
import {MOBILE_PRESENCE_HTML,MOBILE_PRESENCE_CSS,MOBILE_PRESENCE_JS} from './mobile-presence-view'

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
<h1><img src="/m/icon.png" alt="" width="32" height="32" style="vertical-align:middle;margin-right:6px">CC 的设置</h1>
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
  <label class="row"><span><b>让 CC 自己画画</b><small>CC 有感觉时用你的电脑画画,只存在本机。首次需下载约 5GB</small></span><input type="checkbox" class="switch" id="f-atelier"></label>
  <div class="say" id="atelier-status" hidden></div>
  <div class="say">💬 也可以直接说:「别拆分回复了」「关心档位调低点」</div>
</section>

<section id="sec-remote" hidden>
  <h2>随身 CC</h2>
  <p class="hint">开启后,手机加到主屏,出门也能看待办和 CC 画的你</p>
  <label class="row"><span><b>出门也能用</b><small>经加密中继回家,数据只在你自己电脑上,中间人看不到</small></span><input type="checkbox" class="switch" id="f-remote"></label>
  <div class="say" id="remote-hint">开启需要重启一下 CC(约十几秒),之后在同一 Wi-Fi 下打开随身 CC,点「把 CC 带在身上」即可</div>
  <label class="row" id="row-devices" hidden><span><b>已配对设备</b><small id="devices-count"></small></span><button type="button" id="forget-devices" style="font:inherit;font-size:12.5px;padding:5px 12px;border:1.5px solid var(--line);border-radius:999px;background:var(--card);color:var(--accent);cursor:pointer">全部忘掉</button></label>
</section>

<section id="sec-models">
  <h2>模型与后端</h2>
  <p class="hint">CC 有哪些大脑、各自通不通。这里改的是全局默认;单个对话换脑子在微信里发 /api /agy /cc</p>
  <div id="models-table"></div>
  <label class="row"><span><b>默认大脑</b><small>没在微信里单独切过的对话、还有 CC 主动找你时,用这家。改完 CC 会自己重启(十几秒)</small></span><select id="f-default-provider"></select></label>
  <div class="row" style="display:block;border-top:1px dashed var(--line);padding-top:10px">
    <b>自配 API(/api)</b><small style="color:var(--soft)">OpenAI 兼容网关 —— DeepSeek / Kimi / Qwen 这类都从这扇门进</small>
    <label class="row"><span><b>地址</b><small>以 /v1 结尾</small></span><input type="text" id="f-api-base" style="width:190px" placeholder="https://…/v1"></label>
    <label class="row"><span><b>默认模型</b><small>没按对话钉时用它</small></span><input type="text" id="f-api-model" style="width:150px" placeholder="DeepSeek"></label>
    <label class="row"><span><b>API Key</b><small id="api-key-hint"></small></span><input type="password" id="f-api-key" style="width:150px" placeholder="sk-…" autocomplete="off"></label>
    <button class="save" id="save-api-key">保存 Key(之后重启一下 CC)</button>
    <div style="border-top:1px dashed var(--line);padding-top:10px;margin-top:10px">
      <b>短名</b><small style="color:var(--soft);display:block">起了短名,微信里 /api ds 就切;网关上的原名照样能用</small>
      <div id="alias-list" style="margin:6px 0"></div>
      <div style="display:flex;gap:6px;align-items:center"><input type="text" id="f-alias-name" style="width:70px" placeholder="ds"><span>→</span><input type="text" id="f-alias-model" style="width:120px" placeholder="DeepSeek"><button type="button" class="seg-btn" id="add-alias" style="font:inherit;font-size:13px;padding:6px 12px;border:1.5px solid var(--line);border-radius:8px;background:#fff;color:var(--accent)">加</button></div>
    </div>
  </div>
  <label class="row"><span><b>后台评估用</b><small>记忆整理 / 辩论主持 / introspect 这些幕后活儿走哪家;auto = 偏好序</small></span><select id="f-cheap"></select></label>
  <div class="row" style="display:block;border-top:1px dashed var(--line);padding-top:10px">
    <b>非管理员能用哪些</b><small style="color:var(--soft);display:block">信任/访客对话只能切到勾选的;🔑共享钥匙的(agy)对访客永远不开放</small>
    <div id="tp-list" style="margin-top:6px"></div>
  </div>
  <div class="say">💬 也可以直接跟 CC 说:「换成 DeepSeek」「用 opus 5」「你现在是哪个模型」</div>
</section>

<section>
  <details><summary>⚙️ 技术详情(好奇再点)</summary>
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
// 画笔下载状态 → 人话(与 daemon 的 formatAtelierModelStatus 保持一致)。下载在
// 电脑上跑,这里只是把电脑写下的进度显示出来。
var atelierStatus = null, atelierPoll = null;
function atelierLabel(st) {
  if (!st) return { label: "", done: false, failed: false }
  if (st.state === "checking") return { label: "正在检查画笔…", done: false, failed: false }
  if (st.state === "downloading") { if (!(st.total > 0)) return { label: "正在下载画笔…", done: false, failed: false }; var pct = Math.min(100, Math.round(st.received / st.total * 100)); return { label: "正在下载画笔… " + pct + "%", done: false, failed: false } }
  if (st.state === "ready") return { label: "画笔就绪 ✓", done: true, failed: false }
  if (st.state === "failed") return { label: "准备失败,点此重试", done: false, failed: true }
  return { label: "", done: false, failed: false }
}
function showAtelier(st) {
  atelierStatus = st || null
  var el = $("atelier-status"), r = atelierLabel(st)
  if (!r.label) { el.hidden = true; return }
  el.hidden = false; el.textContent = r.label; el.style.cursor = r.failed ? "pointer" : ""
}
async function pollAtelier() {
  var s = await sapi("/set/api/state"); if (!s.ok) return
  var st = s.atelier && s.atelier.model_status; showAtelier(st)
  var r = atelierLabel(st); if ((r.done || r.failed) && atelierPoll) { clearInterval(atelierPoll); atelierPoll = null }
}
function startAtelierPoll() { if (atelierPoll) clearInterval(atelierPoll); atelierPoll = setInterval(pollAtelier, 2000) }
// ── 模型与后端 ─────────────────────────────────────────────────────────
var MODEL_KEY = { claude: "model", agy: "agyModel", cursor: "cursorModel", openai: "openaiModel", gemini: "geminiModel" };
var PROVIDER_NAME = { claude: "Claude", agy: "Gemini(订阅 agy)", cursor: "Cursor(订阅)", codex: "Codex", openai: "自配 API(/api)", gemini: "Gemini(API key)" };
function esc(t) { return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] }) }
function statusText(p) {
  if (p.status === "ok") return "✓ 通" + (p.latency_ms != null ? "(" + p.latency_ms + "ms)" : "")
  if (p.status === "broken") return "✗ 不通" + (p.error ? ":" + p.error : "")
  if (p.status === "unknown") return "已接入,还没测过(桌面「大脑」卡可测)"
  return "未接入" + (p.hint ? " · " + p.hint : "")
}
function renderModels(m) {
  if (!m) return
  var html = ""
  for (var i = 0; i < m.providers.length; i++) {
    var p = m.providers[i], key = MODEL_KEY[p.id]
    var isDefault = p.id === m.default_provider
    var input = key
      ? '<input type="text" data-model-key="' + key + '" value="' + esc(p.model || "") + '" style="width:150px" placeholder="默认">'
      : '<small style="color:var(--soft)">' + esc(p.model || (p.id === "codex" ? "同 Claude 那格" : "—")) + '</small>'
    var shared = (m.shared_token || []).indexOf(p.id) >= 0
    html += '<label class="row"><span><b>' + esc(PROVIDER_NAME[p.id] || p.id) + (isDefault ? ' <small style="display:inline;color:var(--accent)">默认</small>' : "") + (shared ? ' <small style="display:inline" title="所有对话共用一把 trusted 钥匙,不能按对话分权限">🔑共享钥匙</small>' : "") + '</b><small>' + esc(statusText(p)) + '</small></span>' + input + '</label>'
  }
  $("models-table").innerHTML = html
  // 非管理员能用哪些(勾选 = 允许;全勾 = 不限制)
  var tp = m.trusted_providers, tpHtml = ""
  for (var q = 0; q < m.providers.length; q++) {
    var pp = m.providers[q]; if (!pp.registered) continue
    var on = tp == null || tp.indexOf(pp.id) >= 0
    tpHtml += '<label style="display:inline-flex;align-items:center;gap:4px;margin:2px 10px 2px 0"><input type="checkbox" data-tp="' + esc(pp.id) + '"' + (on ? " checked" : "") + '> ' + esc(PROVIDER_NAME[pp.id] || pp.id) + '</label>'
  }
  $("tp-list").innerHTML = tpHtml || '<small style="color:var(--soft)">没有已注册的 provider</small>'
  var tps = $("tp-list").querySelectorAll("input[data-tp]")
  for (var w = 0; w < tps.length; w++) tps[w].addEventListener("change", function () {
    var picked = [], all = $("tp-list").querySelectorAll("input[data-tp]")
    for (var x = 0; x < all.length; x++) if (all[x].checked) picked.push(all[x].dataset.tp)
    apply("set_config", { key: "trusted_providers", value: picked.length === all.length ? "all" : (picked.join(",") || "none") }, "已更新非管理员可用范围 ✓")
  })
  var inputs = $("models-table").querySelectorAll("input[data-model-key]")
  for (var j = 0; j < inputs.length; j++) (function (el) {
    el.addEventListener("change", function () { var v = el.value.trim(); if (v) apply("set_config", { key: el.dataset.modelKey, value: v }) })
  })(inputs[j])
  $("f-api-base").value = m.openai.base_url || ""
  $("f-api-model").value = m.openai.model || ""
  $("api-key-hint").textContent = m.openai.has_key ? "已配好(只能覆盖,不显示)" : "还没配 —— 配好才会接入"
  var al = "", names = Object.keys(m.openai.aliases || {}).sort()
  for (var k = 0; k < names.length; k++) al += '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0"><span><b>' + esc(names[k]) + '</b> → ' + esc(m.openai.aliases[names[k]]) + '</span><button type="button" data-del-alias="' + esc(names[k]) + '" style="font:inherit;font-size:12px;padding:3px 10px;border:1.5px solid var(--line);border-radius:999px;background:var(--card);color:var(--soft)">删</button></div>'
  $("alias-list").innerHTML = al || '<small style="color:var(--soft)">还没有短名</small>'
  var dels = $("alias-list").querySelectorAll("button[data-del-alias]")
  for (var d = 0; d < dels.length; d++) (function (b) {
    b.addEventListener("click", async function () { if (await apply("del_alias", { alias: b.dataset.delAlias }, "短名已删 ✓")) reloadModels() })
  })(dels[d])
  var dsel = $("f-default-provider"), dopts = ""
  for (var y = 0; y < m.providers.length; y++) {
    var dp = m.providers[y]; if (!dp.registered && dp.id !== m.default_provider) continue
    // 访客不可用 = 共享钥匙的 + 约束不住自己工具面的(ACP 的 cursor);🔑 徽章只跟前者。
    var dshared = (m.shared_token || []).indexOf(dp.id) >= 0
    var dblocked = (m.guest_blocked || []).indexOf(dp.id) >= 0
    dopts += '<option value="' + esc(dp.id) + '"' + (dp.id === m.default_provider ? " selected" : "") + '>' + esc(PROVIDER_NAME[dp.id] || dp.id) + (dshared ? "(共享钥匙,访客不可用)" : dblocked ? "(访客不可用)" : "") + (dp.registered ? "" : "(未接入)") + '</option>'
  }
  dsel.innerHTML = dopts
  var sel = $("f-cheap"), opts = ["auto"]
  for (var r = 0; r < m.providers.length; r++) if (m.providers[r].registered) opts.push(m.providers[r].id)
  if (opts.indexOf(m.cheap) < 0) opts.push(m.cheap)
  sel.innerHTML = opts.map(function (o) { return '<option value="' + esc(o) + '"' + (o === m.cheap ? " selected" : "") + '>' + esc(o === "auto" ? "auto(偏好序)" : (PROVIDER_NAME[o] || o)) + '</option>' }).join("")
}
async function reloadModels() { var s = await sapi("/set/api/state"); if (s.ok) renderModels(s.models) }
wireText("f-api-base", v => apply("set_config", { key: "openaiBaseUrl", value: v }))
wireText("f-api-model", v => apply("set_config", { key: "openaiModel", value: v }))
$("save-api-key").addEventListener("click", async function () {
  var key = $("f-api-key").value.trim(); if (!key) { toast("先填 Key"); return }
  var ok = await apply("set_llm_key", { provider: "openai", key: key, base_url: $("f-api-base").value.trim(), model: $("f-api-model").value.trim() }, "Key 已存好,重启 CC 后接入 ✓")
  if (ok) { $("f-api-key").value = ""; reloadModels() }
})
$("add-alias").addEventListener("click", async function () {
  var a = $("f-alias-name").value.trim(), mm = $("f-alias-model").value.trim()
  if (!a || !mm) { toast("短名和模型名都要填"); return }
  if (await apply("set_alias", { alias: a, model: mm }, "短名已加 ✓")) { $("f-alias-name").value = ""; $("f-alias-model").value = ""; reloadModels() }
})
$("f-cheap").addEventListener("change", function (e) { apply("set_config", { key: "cheap_eval_provider", value: e.target.value }, "后台评估改走 " + e.target.value + " ✓") })
$("f-default-provider").addEventListener("change", async function (e) {
  var v = e.target.value
  var ok = await apply("set_config", { key: "provider", value: v }, "默认大脑改为 " + (PROVIDER_NAME[v] || v) + ",CC 重启中(十几秒)…")
  if (!ok) reloadModels()
})

async function load() {
  const s = await sapi("/set/api/state")
  if (!s.ok) { toast("读取失败"); return }
  renderModels(s.models)
  $("f-name").value = s.name || ""
  $("f-botname").value = s.config.bot_name || ""
  $("f-persona").value = s.persona || ""
  $("f-split").checked = s.prefs.split !== false
  $("f-stickers").checked = s.prefs.stickers !== false
  $("f-hunt").checked = s.prefs.hunt !== false
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
  const am = s.config["companion.atelier_mode"]
  $("f-atelier").checked = am === "private" || am === "share"
  const ast = s.atelier && s.atelier.model_status; showAtelier(ast)
  const ar = atelierLabel(ast); if ($("f-atelier").checked && !ar.done && !ar.failed) startAtelierPoll()
}
$("f-atelier").addEventListener("change", async e => {
  const on = e.target.checked
  const ok = await apply("set_config", { key: "companion.atelier_mode", value: on ? "private" : "off" }, on ? "开了,正在准备画笔… ✓" : "已关闭")
  if (!ok) { e.target.checked = !on; return }
  if (on) { showAtelier({ state: "checking" }); startAtelierPoll() }
  else { if (atelierPoll) { clearInterval(atelierPoll); atelierPoll = null } showAtelier(null) }
})
$("atelier-status").addEventListener("click", async () => {
  if (!atelierLabel(atelierStatus).failed) return
  await apply("set_config", { key: "companion.atelier_mode", value: "off" })
  if (await apply("set_config", { key: "companion.atelier_mode", value: "private" }, "重新开始准备画笔… ✓")) { showAtelier({ state: "checking" }); startAtelierPoll() }
})
$("f-care").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return
  if (await apply("set_pref", { key: "care", value: b.dataset.v })) {
    for (const o of $("f-care").querySelectorAll("button")) o.classList.toggle("on", o === b)
  }
})
wireText("f-name", v => apply("set_name", { name: v }, "以后就这么称呼你 ✓"))
wireText("f-botname", v => apply("set_config", { key: "bot_name", value: v }))
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
// Rotate static brand assets with the PNG; preserve the paired offline shell.
const BRAND_CACHE = 'cc-brand-${MOBILE_BRAND_ICON_VERSION}'
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
    e.respondWith(caches.open(BRAND_CACHE).then(function(c){ return c.match(e.request).then(function(m){ return m || fetch(e.request).then(function(r){ c.put(e.request, r.clone()); return r }) }) }))
    return
  }
  // /m/api/* and everything else — let the page decide (LAN → tunnel).
})
`

export const M_BOOTSTRAP_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="manifest" href="/m/manifest.json"><title>CC</title>
<body style="font-family:system-ui;background:#f5ead8;color:#5a3f2d;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><img src="/m/icon.png" alt="CC" width="64" height="64"><p id="msg">正在找你的钥匙…</p></div>
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

/** 随身 CC 手机页 — 此刻 / 一起做 / 回忆,自包含无 CDN,PWA 可加主屏。 */
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
  .pres { display:flex; align-items:center; gap:8px; padding:0 16px 6px; color:var(--soft); font-size:13px }
  .pres b { color:var(--ink); font-weight:600 }
  .pres button { margin-left:auto; font:inherit; font-size:12px; padding:3px 10px; border:1.5px solid var(--line); border-radius:999px; background:var(--card); color:var(--soft) }
  #banner { margin:6px 14px; padding:8px 12px; background:rgba(176,86,58,.10); border-radius:10px; font-size:12.5px; color:var(--accent) }
  .ev { display:flex; gap:10px } .ev .k { font-size:18px; width:26px; text-align:center; flex:none }
  .ev .tx { flex:1; min-width:0 } .ev .tx b { display:block; font-size:14px; font-weight:600 }
  .ev .tx p { margin:3px 0 0; font-size:13px; color:var(--soft); white-space:pre-wrap; word-break:break-word }
  .ev .tx small { color:var(--soft); font-size:11.5px }
  .ev .tx a { color:var(--accent) }
  .ev .pc { margin-top:6px } .ev .pc svg { width:100%; height:auto; border:1.5px solid var(--line); border-radius:10px }
  .more { display:block; margin:6px auto 0; font:inherit; font-size:13px; padding:7px 18px; border:1.5px solid var(--line); border-radius:999px; background:var(--card); color:var(--soft) }
  .sec { margin-top:18px }
</style></head><body>
<header><h1>CC</h1><div class="sub" id="sub">随身小窗 · 数据都在你自己电脑上</div><button id="nav-set" type="button">设置</button></header>
<div id="pairbar" hidden>这个链接 10 分钟就过期<button id="pairbtn">把 CC 带在身上</button></div>
<div class="pane on" id="p-today">
  <div class="home-toolbar"><button id="refresh" type="button">刷新</button></div>
  <div id="banner" hidden></div>
  ${MOBILE_PRESENCE_HTML}
</div>
<div class="pane" id="p-memory">
  <div class="grp">回忆</div>
  <div id="feed"></div>
  <details class="memory-pocket"><summary>待办、画像与表情</summary>
<div id="p-pocket">
  <div class="grp">待办</div><div id="todos"></div>
  <div class="sec"><div class="grp">CC 画的你</div><div class="portrait" id="portrait"></div></div>
  <div class="sec"><div class="grp">表情</div><div class="stgrid" id="stickers"></div></div>
</div>
  </details>
</div>
<style>
#m-controls fieldset{border:1px solid var(--line);border-radius:8px;margin:12px 0;padding:10px} .m-option{display:block;margin:10px 0} .m-option small{display:block;margin-left:22px} .m-option textarea{display:block;box-sizing:border-box;width:100%;font:inherit;padding:8px} .m-description{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit} #m-notice{padding:8px 0;white-space:pre-wrap} #m-conn{padding:8px 10px;margin:8px 0;border:1px solid var(--line);border-radius:8px;font-size:.92em;opacity:.85} #m-controls button{min-height:40px} #m-controls button:disabled,#m-send:disabled{opacity:.5} #m-artifacts small{display:block} #m-list button.card{width:100%;text-align:left;font:inherit;color:inherit} #m-artifact-preview{overflow-wrap:anywhere}
#m-controls .done-btn,#m-send{font:inherit;min-height:44px;padding:9px 16px;border:1px solid var(--accent);border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
#m-controls .more{display:inline-block;min-height:44px;margin:8px 0 0 8px;padding:9px 16px;border-radius:10px;color:var(--ink)}
.m-option textarea{border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
#m-controls :focus-visible,#m-send:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
</style>
<div class="pane" id="p-matters">
  <!-- 连接提示:平时不在,连续两次联系不上 daemon 才浮出来,恢复后自己消失。
       放在列表与详情之外,两边共用同一行。 -->
  <div id="m-conn" role="status" aria-live="polite" hidden></div>
  <div id="m-list"><div class="empty">正在读…</div></div>
  <div id="m-detail" hidden>
    <button id="m-back" class="more" type="button">← 全部</button>
    <div class="grp" id="m-title"></div>
    <div id="m-notice" role="status" aria-live="polite"></div>
    <div id="m-controls"><div id="m-permissions"></div><div id="m-questions"></div></div>
    <div id="m-artifacts"></div><div id="m-artifact-preview"></div><div id="m-inputs"></div>
    <details><summary>对话与执行记录</summary><div id="m-events"></div></details>
    <div class="card" id="m-say-box"><textarea id="m-say" rows="2" placeholder="接着说…" style="width:100%;font:inherit;border:1px solid var(--line);border-radius:8px;padding:8px;box-sizing:border-box"></textarea>
      <button id="m-send" class="done-btn" type="button" style="margin-top:6px">发送</button></div>
  </div>
</div>
<nav>
  <button data-p="today" class="on">此刻</button>
  <button data-p="matters">一起做</button>
  <button data-p="memory">回忆</button>
</nav>
<style>${MOBILE_PRESENCE_CSS}</style>
<div id="toast"></div>
<script>
var T = ${JSON.stringify(token).replace(/</g,'\\u003c')}
var REMOTE = ${JSON.stringify(remote).replace(/</g,'\\u003c')}
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
${MOBILE_WORKBENCH_JS}
${MOBILE_PRESENCE_JS}
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
var HOME_KEY = "cc.home.v2:" + (REMOTE ? REMOTE.id : location.host) + ":" + T.slice(-12)
var KIND_ICON = { hunt: "🎯", visit: "🏡", postcard: "💌", thought: "💭", chat_day: "💬" }
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
  var b = ev.target.closest("button.more")
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
</script></body></html>`
}
