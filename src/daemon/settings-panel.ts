/**
 * settings-panel.ts — the WeChat-openable graphical settings page
 * (2026-08-25, owner: 微信用户不会背命令,前期一个设置面板能非常好地帮助他们).
 *
 * Shape: a tiny LAN-bound HTTP server inside the daemon. The owner asks for
 * 设置 in WeChat → the daemon mints a ONE-ACTIVE, 10-minute token and replies
 * with `http://<mac-lan-ip>:<port>/set?t=…`; tapping it opens a warm-paper
 * settings page in WeChat's built-in browser.
 *
 * Security posture:
 *  - the server starts LAZILY on first link request; before that, nothing
 *    listens. Once up, EVERY endpoint requires the current token — an idle
 *    panel is a wall of 401s.
 *  - one active token at a time (reissue revokes), TTL 10 min.
 *  - writes go through the same guarded primitives as everything else:
 *    normalizeUserName, chat-prefs store, config-surface's writable
 *    whitelist (further narrowed to PANEL_CONFIG_KEYS) with the standard
 *    config_changed audit.
 *  - dangerous / flow-shaped operations (provider switch, guest approval,
 *    pairing, restore, restart) are deliberately NOT here — they stay
 *    conversational where CC can confirm context.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { normalizeUserName } from '../lib/user-name'
import { writeConfigKey, readConfigSurface } from '../lib/config-surface'

export const SETTINGS_LINK_TTL_MS = 10 * 60_000

/** Config-surface keys the panel may show/write (surface whitelist ∩ panel). */
export const PANEL_CONFIG_KEYS: readonly string[] = [
  'bot_name', 'model', 'knowledge_enabled', 'social_enabled', 'autoStart',
]

const PREF_KEYS = new Set(['split', 'care', 'stickers', 'hunt'])
const PERSONA_MAX_CHARS = 8000

export interface SettingsPanelDeps {
  stateDir: string
  ownerChatId: () => string | null
  chatPrefs: {
    get(chatId: string): Record<string, unknown>
    set(chatId: string, patch: Record<string, unknown>): Record<string, unknown>
  }
  getUserName: (chatId: string) => string | null
  setUserName: (chatId: string, name: string) => Promise<void>
  /** config_changed audit sink (events store append) — best-effort. */
  audit?: (reasoning: string) => void
  log: (tag: string, line: string) => void
  now?: () => number
}

export interface SettingsPanel {
  issueToken(): string
  validToken(t: string | null | undefined): boolean
  state(): object
  apply(op: unknown): Promise<{ ok: boolean; error?: string }>
  /** Start the HTTP server (idempotent). port 0 = ephemeral. */
  start(port?: number): Promise<{ port: number }>
  stop(): Promise<void>
  /** Mint a fresh token and return the tappable URL (starts the server on
   *  first use). Null when no LAN address / no owner is resolvable. */
  linkUrl(): Promise<string | null>
}

/** First non-internal IPv4 address (en0 preferred). Exported for tests. */
export function lanIp(): string | null {
  const ifs = networkInterfaces()
  const names = Object.keys(ifs).sort((a, b) => (a === 'en0' ? -1 : b === 'en0' ? 1 : 0))
  for (const name of names) {
    for (const addr of ifs[name] ?? []) {
      if (!addr.internal && addr.family === 'IPv4') return addr.address
    }
  }
  return null
}

export function makeSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const now = deps.now ?? (() => Date.now())
  let active: { token: string; expiresAt: number } | null = null
  let server: ReturnType<typeof Bun.serve> | null = null

  const personaPath = (): string | null => {
    const owner = deps.ownerChatId()
    if (!owner || owner.includes('..') || owner.includes('/') || owner.includes('\\')) return null
    return join(deps.stateDir, 'memory', owner, 'persona.md')
  }

  const panel: SettingsPanel = {
    issueToken() {
      const token = randomBytes(16).toString('hex')
      active = { token, expiresAt: now() + SETTINGS_LINK_TTL_MS }
      return token
    },

    validToken(t) {
      return !!t && !!active && t === active.token && now() < active.expiresAt
    },

    state() {
      const owner = deps.ownerChatId()
      if (!owner) return { ok: false, error: 'no_owner' }
      const pp = personaPath()
      const persona = pp && existsSync(pp) ? readFileSync(pp, 'utf8') : ''
      const config: Record<string, string | boolean | null> = {}
      for (const row of readConfigSurface(deps.stateDir)) {
        if (PANEL_CONFIG_KEYS.includes(row.key)) config[row.key] = row.value
      }
      return {
        ok: true,
        name: deps.getUserName(owner) ?? '',
        persona,
        prefs: deps.chatPrefs.get(owner),
        config,
      }
    },

    async apply(raw) {
      const owner = deps.ownerChatId()
      if (!owner) return { ok: false, error: 'no_owner' }
      const b = (raw ?? {}) as Record<string, unknown>
      try {
        if (b.op === 'set_name') {
          const name = typeof b.name === 'string' ? normalizeUserName(b.name).trim() : ''
          if (!name || name.length > 32) return { ok: false, error: 'invalid_name' }
          await deps.setUserName(owner, name)
          return { ok: true }
        }
        if (b.op === 'set_persona') {
          const content = typeof b.content === 'string' ? b.content : null
          if (content === null || content.length > PERSONA_MAX_CHARS) return { ok: false, error: 'invalid_persona' }
          const pp = personaPath()
          if (!pp) return { ok: false, error: 'no_owner' }
          mkdirSync(join(pp, '..'), { recursive: true })
          writeFileSync(pp, content)
          return { ok: true }
        }
        if (b.op === 'set_pref') {
          const key = typeof b.key === 'string' ? b.key : ''
          if (!PREF_KEYS.has(key)) return { ok: false, error: 'unknown_pref' }
          if (key === 'care') {
            if (b.value !== 'off' && b.value !== 'low' && b.value !== 'high') return { ok: false, error: 'invalid_value' }
          } else if (typeof b.value !== 'boolean') {
            return { ok: false, error: 'invalid_value' }
          }
          deps.chatPrefs.set(owner, { [key]: b.value })
          return { ok: true }
        }
        if (b.op === 'set_config') {
          const key = typeof b.key === 'string' ? b.key : ''
          if (!PANEL_CONFIG_KEYS.includes(key)) return { ok: false, error: 'unknown_key' }
          const r = await writeConfigKey(deps.stateDir, key, b.value)
          if (!r.ok) return { ok: false, error: r.error }
          deps.audit?.(`${key}: ${JSON.stringify(r.previous)} → ${JSON.stringify(b.value)} — 设置面板`)
          return { ok: true }
        }
        return { ok: false, error: 'unknown_op' }
      } catch (e) {
        deps.log('SETTINGS', `apply failed: ${String(e)}`)
        return { ok: false, error: 'internal' }
      }
    },

    async start(port = 0) {
      if (server) return { port: server.port! }
      const json = (body: object, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
      server = Bun.serve({
        hostname: '0.0.0.0',
        port,
        fetch: async (req) => {
          const url = new URL(req.url)
          const t = url.searchParams.get('t')
          if (!panel.validToken(t)) {
            if (url.pathname === '/set') {
              return new Response(EXPIRED_HTML, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } })
            }
            return json({ error: 'unauthorized' }, 401)
          }
          if (url.pathname === '/set') {
            return new Response(pageHtml(t!), { headers: { 'content-type': 'text/html; charset=utf-8' } })
          }
          if (url.pathname === '/set/api/state' && req.method === 'GET') {
            return json(panel.state())
          }
          if (url.pathname === '/set/api/apply' && req.method === 'POST') {
            let body: unknown
            try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
            return json(await panel.apply(body))
          }
          return json({ error: 'not_found' }, 404)
        },
      })
      deps.log('SETTINGS', `panel listening on 0.0.0.0:${server.port} (token-gated)`)
      return { port: server.port! }
    },

    async stop() {
      if (server) { server.stop(true); server = null }
    },

    async linkUrl() {
      const ip = lanIp()
      if (!ip || !deps.ownerChatId()) return null
      const { port } = await panel.start()
      return `http://${ip}:${port}/set?t=${panel.issueToken()}`
    },
  }
  return panel
}

const EXPIRED_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
<div class="sub">改完立即生效 · 链接 10 分钟内有效</div>

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
const T = ${JSON.stringify(token)};
const $ = id => document.getElementById(id);
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 1400) }
async function api(path, body) {
  const r = await fetch(path + "?t=" + T, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)
  if (r.status === 401) { document.body.innerHTML = '<div style="text-align:center;padding-top:40vh">⏳ 链接过期啦,回微信跟 CC 再要一个~</div>'; throw new Error("expired") }
  return r.json()
}
async function apply(op, extra, okMsg) {
  const r = await api("/set/api/apply", Object.assign({ op }, extra))
  toast(r.ok ? (okMsg || "已保存 ✓") : ("没改成: " + (r.error || "unknown")))
  return r.ok
}
function wireSwitch(id, kind, key) {
  $(id).addEventListener("change", e => {
    const v = e.target.checked
    if (kind === "pref") apply("set_pref", { key, value: v })
    else apply("set_config", { key, value: v })
  })
}
function wireText(id, fn) {
  $(id).addEventListener("change", e => { const v = e.target.value.trim(); if (v) fn(v) })
}
async function load() {
  const s = await api("/set/api/state")
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
load().catch(() => {})
</script></body></html>`
}
