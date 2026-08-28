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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { basename, join } from 'node:path'
import { normalizeUserName } from '../lib/user-name'
import { writeConfigKey, readConfigSurface } from './config-surface'
import { safeSvgFile, EXPIRED_HTML, SW_JS, M_BOOTSTRAP_HTML, pageHtml, phoneHtml } from './settings-panel-html'

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
  /** 远程访问一键开关(2026-08-26):读/写 remote_tunnel + 触发重启。
   *  缺省 ⇒ 设置页不显示远程访问开关。 */
  remote?: {
    isEnabled: () => boolean
    setEnabled: (on: boolean) => void
    requestRestart: () => void
  }
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
      const config: Record<string, string | boolean | number | null> = {}
      for (const row of readConfigSurface(deps.stateDir)) {
        if (PANEL_CONFIG_KEYS.includes(row.key)) config[row.key] = row.value
      }
      return {
        ok: true,
        name: deps.getUserName(owner) ?? '',
        persona,
        prefs: deps.chatPrefs.get(owner),
        config,
        remote: deps.remote
          ? { available: true, enabled: deps.remote.isEnabled(), devices: Object.keys(readDevices()).length }
          : { available: false, enabled: false, devices: 0 },
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
        if (b.op === 'forget_devices') {
          // 安全 review HIGH 收尾 (2026-08-26):设备令牌长期有效是产品决策
          // (加主屏永不过期),但必须可撤销。一键全忘,手机重新配对即可。
          try { rmSync(devicesPath(), { force: true }) } catch { /* already gone */ }
          deps.audit?.('随身 CC:忘掉所有已配对设备 — 设置面板')
          return { ok: true }
        }
        if (b.op === 'set_remote') {
          if (typeof b.enabled !== 'boolean') return { ok: false, error: 'invalid_value' }
          if (!deps.remote) return { ok: false, error: 'remote_not_wired' }
          deps.remote.setEnabled(b.enabled)
          deps.audit?.(`remote_tunnel: → ${b.enabled} — 设置面板`)
          // Restart applies the new tunnel wiring (dials out / stops).
          deps.remote.requestRestart()
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
      const token = panel.issueToken()
      // 远程隧道开着 → 链接指向中继上的公网壳页(owner 2026-08-26:人在
      // 电脑旁但手机走流量是常态,LAN 链接打不开)。令牌放 # 锚点 ——
      // 锚点不上服务器,中继看不到;壳先探 LAN(在家秒开),不通走隧道。
      const remote = deps.remoteInfo?.()
      if (remote) {
        const base = remote.relay.replace(/^wss:/, 'https:').replace(/\/tunnel\/phone$/, '')
        return `${base}/pset/#id=${encodeURIComponent(remote.id)}&t=${token}&p=${encodeURIComponent('/set')}&lan=${ip}:${port}`
      }
      return `http://${ip}:${port}/set?t=${token}`
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
              name: 'CC', short_name: 'CC', id: '/m', start_url: '/m', scope: '/m', display: 'standalone',
              background_color: '#f5ead8', theme_color: '#f5ead8',
              // bear-complete.png 实际是 340x360;声明尺寸必须跟真实一致,否则
              // 浏览器判定不匹配、拒用这个图标,主屏就退化成通用字母图标。
              icons: [{ src: '/m/icon.png', sizes: '340x360', type: 'image/png' }],
            })
          }
          if (url.pathname === '/m/sw.js') {
            // Service worker — WITHOUT it the PWA shell can't load off-LAN
            // (the origin is the daemon's LAN address, unreachable outside).
            // Caches the last tokened /m document + icon so the shell loads
            // from cache offline; the page's own api() then reaches data over
            // the tunnel. Header widens scope to /m (sw sits at /m/sw.js).
            return new Response(SW_JS, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'Service-Worker-Allowed': '/m' } })
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
            // set_remote (toggle remote access + restart the daemon) is a
            // flow-shaped op — refuse it over the tunnel; you only toggle remote
            // access from home anyway, and a leaked device token must not be
            // able to flip config + force restarts remotely.
            if ((body as { op?: unknown })?.op === 'set_remote' && url.searchParams.get('_via') === 'tunnel') {
              return json({ ok: false, error: 'lan_only' })
            }
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
            // 隧道/壳模式的图片通道:隧道 body 是 JSON 文本,二进制走不了 ——
            // ?b64=1 返回 base64 载荷,页面拼 data URI(出门表情不再裂图)。
            if (url.searchParams.get('b64') === '1') {
              return json({ ok: true, mime: type, data: readFileSync(fp).toString('base64') })
            }
            return new Response(readFileSync(fp), { headers: { 'content-type': type } })
          }
          return json({ error: 'not_found' }, 404)
  }

  return panel
}
