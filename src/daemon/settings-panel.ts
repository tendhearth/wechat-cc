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
import { basename, join } from 'node:path'
import { normalizeUserName } from '../lib/user-name'
import { safeSvg } from '../lib/svg-sanitize'
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
  /** 随身 CC 数据面(待办) — 注入 facts + 联系人显示名。缺省 ⇒ 手机页无待办区。 */
  todos?: {
    facts: {
      findFacts(kind: string | null, predicate: string | null, query: string | null, status: string | null, limit: number | null): object
      setFactStatus(id: number, status: string, now: number): object
    }
    names: () => Array<{ username: string; display: string }>
  }
  /** 表情库(只读展示 + 图片文件服务)。 */
  stickers?: { list(): Array<{ file: string; tags: string[]; desc?: string }>; dir: string }
  /** 远程隧道信息(启用时):relay wss + 本机 daemon id。手机页出门时用它
   *  经中继访问。缺省 ⇒ 手机页只能在同一 Wi-Fi 直连。 */
  remoteInfo?: () => { relay: string; id: string } | null
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
  /** Route one request — shared by the LAN Bun.serve and the remote tunnel
   *  client, so /m/* and /set/* behave identically over both transports. */
  handleRequest(req: Request): Promise<Response>
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

const DEVICES_FILE = 'settings-devices.json'
const MAX_DEVICES = 20

export function makeSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const now = deps.now ?? (() => Date.now())
  let active: { token: string; expiresAt: number } | null = null
  let server: ReturnType<typeof Bun.serve> | null = null

  // 长期设备令牌(随身 CC 配对):在家扫码用短令牌换一枚,加进主屏后
  // 一直有效。落盘 JSON(0600 state dir),上限 MAX_DEVICES 防无限膨胀。
  const devicesPath = () => join(deps.stateDir, DEVICES_FILE)
  const readDevices = (): Record<string, { created_at: string }> => {
    try { return JSON.parse(readFileSync(devicesPath(), 'utf8')) as Record<string, { created_at: string }> } catch { return {} }
  }
  const issueDeviceToken = (): string | null => {
    const devices = readDevices()
    if (Object.keys(devices).length >= MAX_DEVICES) return null
    const token = 'd' + randomBytes(24).toString('hex')
    devices[token] = { created_at: new Date().toISOString() }
    writeFileSync(devicesPath(), JSON.stringify(devices, null, 2), { mode: 0o600 })
    return token
  }
  const validDeviceToken = (t: string | null | undefined): boolean =>
    !!t && t.startsWith('d') && t in readDevices()

  const personaPath = (): string | null => {
    const owner = deps.ownerChatId()
    if (!owner || owner.includes('..') || owner.includes('/') || owner.includes('\\')) return null
    return join(deps.stateDir, 'memory', owner, 'persona.md')
  }

  // 随身 CC 首页数据:待办(活跃+最近了结,带显示名)、小像、表情库。
  const phoneState = (): object => {
    const owner = deps.ownerChatId()
    const names = new Map((deps.todos?.names() ?? []).map(c => [c.username, c.display]))
    const deco = (rows: Array<{ contact: string } & Record<string, unknown>>) =>
      rows.map(r => ({ ...r, display: names.get(r.contact) ?? r.contact }))
    const active = deps.todos
      ? deco(((deps.todos.facts.findFacts('obligation', null, null, 'active', 200) as { results?: never[] }).results ?? []))
      : []
    const settledAll = deps.todos
      ? deco(((deps.todos.facts.findFacts('obligation', null, null, 'resolved', 100) as { results?: never[] }).results ?? []))
      : []
    const cutoff = Math.floor(now() / 1000) - 7 * 86400
    const settled = settledAll.filter(r => {
      const u = (r as unknown as { updated_at?: number }).updated_at
      return typeof u === 'number' && u > cutoff
    }).slice(0, 20)
    let portrait: string | null = null
    if (owner) {
      const pp = join(deps.stateDir, 'memory', owner, 'portrait.svg')
      if (existsSync(pp)) portrait = safeSvgFile(pp)
    }
    return {
      ok: true,
      name: owner ? deps.getUserName(owner) ?? '' : '',
      todos: { active, settled },
      portrait,
      stickers: deps.stickers?.list() ?? [],
    }
  }

  const json = (body: object, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

  // Shared router — the LAN Bun.serve and the remote tunnel client both call
  // this, so /m/* and /set/* behave identically over both transports.
  const handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const t = url.searchParams.get('d') ?? url.searchParams.get('t')
    return await routeRequest(url, t, req)
  }

  const panel: SettingsPanel = {
    issueToken() {
      const token = randomBytes(16).toString('hex')
      active = { token, expiresAt: now() + SETTINGS_LINK_TTL_MS }
      return token
    },

    validToken(t) {
      if (validDeviceToken(t)) return true
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

    handleRequest,
    async start(port = 0) {
      if (server) return { port: server.port! }
      server = Bun.serve({
        hostname: '0.0.0.0',
        port,
        fetch: handleRequest,
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

  async function routeRequest(url: URL, t: string | null, req: Request): Promise<Response> {
          // ── tokenless surfaces (non-sensitive) ─────────────────────────
          if (url.pathname === '/m/icon.png') {
            const { starterStickersDir } = await import('./stickers')
            const dir = starterStickersDir()
            const icon = dir ? join(dir, 'bear-complete.png') : null
            if (icon && existsSync(icon)) {
              return new Response(readFileSync(icon), { headers: { 'content-type': 'image/png' } })
            }
            return json({ error: 'not_found' }, 404)
          }
          if (url.pathname === '/m/manifest.json') {
            return json({
              name: 'CC', short_name: 'CC', start_url: '/m', display: 'standalone',
              background_color: '#f5ead8', theme_color: '#f5ead8',
              icons: [{ src: '/m/icon.png', sizes: '360x360', type: 'image/png' }],
            })
          }
          if (url.pathname === '/m' && !panel.validToken(t)) {
            // localStorage bootstrap:加进主屏后 start_url 无参 —— 从本机
            // 存的 deviceToken 续命;没有则提示回微信要新链接。
            return new Response(M_BOOTSTRAP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
          }

          if (!panel.validToken(t)) {
            if (url.pathname === '/set') {
              return new Response(EXPIRED_HTML, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } })
            }
            return json({ error: 'unauthorized' }, 401)
          }

          // ── token-gated ────────────────────────────────────────────────
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
          if (url.pathname === '/set/api/pair' && req.method === 'POST') {
            const token = issueDeviceToken()
            if (!token) return json({ ok: false, error: 'device_limit' })
            deps.log('SETTINGS', 'phone device paired (token issued)')
            return json({ ok: true, device_token: token })
          }
          if (url.pathname === '/m') {
            return new Response(phoneHtml(t!, deps.remoteInfo?.() ?? null), { headers: { 'content-type': 'text/html; charset=utf-8' } })
          }
          if (url.pathname === '/m/api/state' && req.method === 'GET') {
            return json(phoneState())
          }
          if (url.pathname === '/m/api/todo' && req.method === 'POST') {
            let body: unknown
            try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
            const b = (body ?? {}) as { id?: unknown; status?: unknown }
            if (typeof b.id !== 'number' || (b.status !== 'resolved' && b.status !== 'active' && b.status !== 'rejected')) {
              return json({ ok: false, error: 'invalid' }, 400)
            }
            if (!deps.todos) return json({ ok: false, error: 'todos_not_wired' }, 503)
            deps.todos.facts.setFactStatus(b.id, b.status, Math.floor(now() / 1000))
            return json({ ok: true })
          }
          if (url.pathname.startsWith('/m/api/sticker/') && req.method === 'GET') {
            if (!deps.stickers) return json({ error: 'not_found' }, 404)
            const raw = decodeURIComponent(url.pathname.slice('/m/api/sticker/'.length))
            const name = basename(raw)
            // basename + known-in-library double guard — never a free file read.
            if (name !== raw || !deps.stickers.list().some(e => e.file === name)) return json({ error: 'not_found' }, 404)
            const fp = join(deps.stickers.dir, name)
            if (!existsSync(fp)) return json({ error: 'not_found' }, 404)
            const ext = name.split('.').pop()?.toLowerCase() ?? 'png'
            const type = ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png'
            return new Response(readFileSync(fp), { headers: { 'content-type': type } })
          }
          return json({ error: 'not_found' }, 404)
  }

  return panel
}

function safeSvgFile(path: string): string | null {
  try { return safeSvg(readFileSync(path, 'utf8')) } catch { return null }
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
<div class="sub">改完立即生效 · 链接 10 分钟内有效 · <a href="/m?t=${token}" style="color:var(--accent)">随身 CC →</a></div>

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


const M_BOOTSTRAP_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
function toast(m) { var t = document.getElementById("toast"); t.textContent = m; t.classList.add("show"); setTimeout(function(){ t.classList.remove("show") }, 1800) }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;") }
function q(p) { return p + (p.indexOf("?") < 0 ? "?" : "&") + (isDevice ? "d=" : "t=") + encodeURIComponent(T) }
// 传输层:先直连(同 Wi-Fi),失败且配了 remote 就走中继隧道(端到端加密)。
var b64u = { enc: function(b){ return btoa(String.fromCharCode.apply(null, new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"") },
  dec: function(s){ s = s.replace(/-/g,"+").replace(/_/g,"/"); var bin = atob(s); var a = new Uint8Array(bin.length); for (var i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i); return a } }
var tun = null
function tunnel() {
  if (tun) return tun
  tun = new Promise(function(resolve, reject) {
    if (!REMOTE) { reject(new Error("no_remote")); return }
    var ws = new WebSocket(REMOTE.relay + "?id=" + encodeURIComponent(REMOTE.id))
    var key = null, kp = null, pending = {}, sid = "s"
    var ready = false
    ws.onopen = async function() {
      kp = await crypto.subtle.generateKey({ name:"X25519" }, true, ["deriveKey","deriveBits"])
      var raw = await crypto.subtle.exportKey("raw", kp.publicKey)
      ws.send(JSON.stringify({ stream: sid, frame: { hs: b64u.enc(raw) } }))
    }
    ws.onmessage = async function(ev) {
      var m = JSON.parse(ev.data)
      if (m.stream !== sid) return
      if (m.frame && m.frame.hs) {
        var pub = await crypto.subtle.importKey("raw", b64u.dec(m.frame.hs), { name:"X25519" }, true, [])
        var bits = await crypto.subtle.deriveBits({ name:"X25519", public: pub }, kp.privateKey, 256)
        var hk = await crypto.subtle.importKey("raw", new Uint8Array(bits), "HKDF", false, ["deriveKey"])
        key = await crypto.subtle.deriveKey({ name:"HKDF", hash:"SHA-256", salt:new Uint8Array(0), info:new TextEncoder().encode("wechat-cc/tunnel/v1") }, hk, { name:"AES-GCM", length:256 }, false, ["encrypt","decrypt"])
        ready = true; resolve(send)
        return
      }
      if (!key) return
      var iv = b64u.dec(m.frame.iv), ct = b64u.dec(m.frame.ct)
      var pt = await crypto.subtle.decrypt({ name:"AES-GCM", iv: iv }, key, ct)
      var r = JSON.parse(new TextDecoder().decode(pt))
      var cb = pending[r.rid]; delete pending[r.rid]
      if (cb) cb(r)
    }
    ws.onerror = function(){ reject(new Error("ws_error")) }
    ws.onclose = function(){ tun = null; if (!ready) reject(new Error("ws_closed")) }
    var ridSeq = 0
    async function send(path, opts) {
      var rid = "r" + (ridSeq++)
      var body = JSON.stringify({ path: q(path), method: (opts && opts.method) || "GET", body: opts && opts.body, rid: rid })
      var iv = crypto.getRandomValues(new Uint8Array(12))
      var ct = await crypto.subtle.encrypt({ name:"AES-GCM", iv: iv }, key, new TextEncoder().encode(body))
      return new Promise(function(res) {
        pending[rid] = function(r){ res({ status: r.status, text: function(){ return Promise.resolve(r.body) }, json: function(){ return Promise.resolve(JSON.parse(r.body)) } }) }
        ws.send(JSON.stringify({ stream: sid, frame: { iv: b64u.enc(iv), ct: b64u.enc(ct) } }))
      })
    }
  })
  return tun
}
// api():直连优先(2.5s 超时),失败落隧道。返回 {status, json(), text()}。
function api(path, opts) {
  var ctrl = new AbortController()
  var to = setTimeout(function(){ ctrl.abort() }, 2500)
  return fetch(q(path), Object.assign({ signal: ctrl.signal }, opts || {})).then(function(r){
    clearTimeout(to); return r
  }).catch(function() {
    clearTimeout(to)
    return tunnel().then(function(send){ return send(path, opts) })
  })
}
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
document.getElementById("nav-set").addEventListener("click", function(){ location.href = q("/set") })
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
    : '<div class="empty">CC 还没画你 — 在电脑记忆页点「更新画像」</div>'
  var sg = document.getElementById("stickers")
  sg.innerHTML = s.stickers.length ? s.stickers.map(function(e) {
    return '<figure><img src="' + q("/m/api/sticker/" + encodeURIComponent(e.file)) + '" loading="lazy"><figcaption>' + esc(e.tags.join(" · ")) + '</figcaption></figure>'
  }).join("") : '<div class="empty">表情库还空着</div>'
}
document.getElementById("todos").addEventListener("click", function(ev) {
  var b = ev.target.closest("button[data-id]")
  if (!b) return
  fetch(q("/m/api/todo"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: Number(b.dataset.id), status: b.dataset.st }) })
    .then(function(r){ return r.json() }).then(function(r) { if (r.ok) { toast(b.dataset.st === "active" ? "捞回来了" : "划掉了 ✓"); load() } else toast("没改成") })
    .catch(function(){ toast("网络不通") })
})
function load() {
  fetch(q("/m/api/state")).then(function(r) {
    if (r.status === 401) { try { localStorage.removeItem("deviceToken") } catch (e) {}; location.replace("/m"); return null }
    return r.json()
  }).then(function(s){ if (s && s.ok) render(s) }).catch(function(){ toast("连不上家里的电脑 — 要在同一个 Wi-Fi") })
}
load()
</script></body></html>`
}
