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
import { basename, join } from 'node:path'
import { normalizeUserName } from '../lib/user-name'
import { writeConfigKey, readConfigSurface } from './config-surface'
import { kickAtelierModelProvision, readModelStatus, shouldProvisionOnConfigChange } from './atelier-provision'
import { safeSvgFile, EXPIRED_HTML, SW_JS, M_BOOTSTRAP_HTML, pageHtml, phoneHtml } from './settings-panel-html'
import { readJsonFile } from '../lib/read-json-file'
import { loadAgentConfig, saveAgentConfig, modelForProvider } from '../lib/agent-config'
import { saveLlmKey } from './llm-keys'
import { PROVIDER_SETUP_HINTS, type LlmHealthReport } from './llm-health'
import { capabilitiesFor } from '../core/capability-matrix'
import { PROVIDER_IDS } from '../lib/provider-ids'
import { buildFeed, decodeCursor, FEED_DEFAULT_LIMIT, dayKey, type FeedSources, type TurnLite } from './mobile-feed'
import type { Presence } from '../core/companion-presence'
import type { CatchRow } from '../core/journal-store'
import type { PlanLogEntry } from '../core/companion-plan'

export const SETTINGS_LINK_TTL_MS = 10 * 60_000

/** Config-surface keys the panel may show/write (surface whitelist ∩ panel). */
export const PANEL_CONFIG_KEYS: readonly string[] = [
  'bot_name', 'model', 'knowledge_enabled', 'social_enabled', 'autoStart',
  'companion.atelier_mode',
  // 「模型与后端」一块(2026-09-08):各家模型、/api 地址、后台评估用哪家。
  'openaiModel', 'openaiBaseUrl', 'agyModel', 'cursorModel', 'geminiModel', 'cheap_eval_provider', 'trusted_providers',
  'provider',
]

/** 面板「模型与后端」表格覆盖的六家,顺序即显示顺序。 */
const PANEL_PROVIDERS = PROVIDER_IDS
const ALIAS_RE = /^[A-Za-z0-9._-]{1,32}$/
const MODEL_NAME_RE = /^[A-Za-z0-9._/:-]{1,100}$/

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
  /**
   * 随身 CC 首屏「伙伴的一天」的三个来源(spec 2026-09-06-mobile-home-feed §5.4)。
   * 缺省 ⇒ /m/api/home 三项 sources_degraded。IO 全在这里,mobile-feed.ts 是纯函数。
   */
  feed?: {
    journal: { list(limit?: number): readonly CatchRow[] }
    planLogDays: (days: number) => readonly PlanLogEntry[]
    turnsRecent: (limit: number) => readonly TurnLite[]
    timezone: () => string
  }
  /** 三轴 presence,经 internal-api lifecycle.getPresence 共用。缺省/抛 ⇒ 手机页显示「不知道」。 */
  presence?: () => Promise<Presence | null>
  /** 主人「看到哪了」的水位,与桌面觅食台同一个文件(一个主人一个水位)。缺省 ⇒ POST /m/api/seen 503。 */
  seen?: { read: () => string | null; write: (iso: string) => void }
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
  /**
   * 「模型与后端」的数据源:哪些 provider 注册了、上次体检结果(只读缓存,
   * 面板绝不主动外呼)、key 配了没(只回 boolean)。缺省 ⇒ 表格只显示模型字段。
   */
  llm?: {
    registered: () => string[]
    cached: () => LlmHealthReport | null
    hasKey: (provider: 'openai' | 'gemini') => boolean
  }
  /** 改了要重启才生效的键(provider)写完后触发 daemon 重启。缺省 ⇒ 只写不重启,回复里说明。 */
  requestRestart?: (reason: string) => void
  /** config_changed audit sink (events store append) — best-effort. */
  audit?: (reasoning: string) => void
  log: (tag: string, line: string) => void
  now?: () => number
}

export interface SettingsPanel {
  issueToken(): string
  validToken(t: string | null | undefined): boolean
  state(): object
  apply(op: unknown): Promise<{ ok: boolean; error?: string; restart?: 'requested' | 'required' }>
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

/** First non-internal IPv4 address (en0 preferred). Re-exported from
 *  lib/local-address —— 「本机对外该报哪个地址」现在只有那一处判定
 *  (配手的 `hand invite` 也要用它)。 */
export { lanIp } from '../lib/local-address'
import { lanIp } from '../lib/local-address'

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
    try { return readJsonFile(devicesPath()) as Record<string, { created_at: string }> } catch { return {} }
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

  /** 「模型与后端」:六家一行(注册/体检/模型),openai 的地址·key·别名,后台评估用谁。 */
  const modelsState = () => {
    const cfg = loadAgentConfig(deps.stateDir)
    const registered = new Set(deps.llm?.registered() ?? [])
    const report = deps.llm?.cached() ?? null
    const probe = new Map((report?.results ?? []).map(r => [r.provider, r]))
    const providers = PANEL_PROVIDERS.map(id => {
      const isReg = registered.has(id)
      const pr = probe.get(id)
      const status = !isReg ? 'unconfigured' : pr == null ? 'unknown' : pr.ok === true ? 'ok' : pr.ok === false ? 'broken' : 'unknown'
      return {
        id,
        registered: isReg,
        model: modelForProvider(cfg, id) ?? null,
        status,
        ...(pr?.error ? { error: pr.error.slice(0, 160) } : {}),
        ...(!isReg && PROVIDER_SETUP_HINTS[id] ? { hint: PROVIDER_SETUP_HINTS[id] } : {}),
        ...(pr?.latency_ms != null ? { latency_ms: pr.latency_ms } : {}),
      }
    })
    return {
      default_provider: cfg.provider,
      checked_at: report?.checked_at ?? null,
      providers,
      openai: {
        base_url: cfg.openaiBaseUrl ?? '',
        model: cfg.openaiModel ?? '',
        has_key: deps.llm?.hasKey('openai') ?? false,
        aliases: cfg.openaiAliases ?? {},
      },
      gemini: { has_key: deps.llm?.hasKey('gemini') ?? false },
      cheap: cfg.cheapEvalProvider ?? 'auto',
      // 非管理员可用哪些(null = 全部);shared_token = 共享钥匙、guest 永不开放
      trusted_providers: cfg.trusted_providers ?? null,
      shared_token: PANEL_PROVIDERS.filter(id => { try { return !capabilitiesFor(id).adminMcpTools } catch { return false } }),
    }
  }

  const FEED_WINDOW_DAYS = 14
  const FEED_JOURNAL_LIMIT = 200
  const FEED_TURNS_LIMIT = 2000

  /** 三源各自 try;哪个抛就记 null(buildFeed 会翻译成 sources_degraded)。 */
  const collectSources = (): FeedSources => {
    const f = deps.feed
    if (!f) return { journal: null, thoughts: null, turns: null }
    const since = now() - FEED_WINDOW_DAYS * 86_400_000
    let journal: FeedSources['journal'] = null
    let thoughts: FeedSources['thoughts'] = null
    let turns: FeedSources['turns'] = null
    try { journal = f.journal.list(FEED_JOURNAL_LIMIT) } catch (e) { deps.log('SETTINGS', `feed journal 读不到: ${e instanceof Error ? e.message : e}`) }
    try { thoughts = f.planLogDays(FEED_WINDOW_DAYS) } catch (e) { deps.log('SETTINGS', `feed plan-log 读不到: ${e instanceof Error ? e.message : e}`) }
    try { turns = f.turnsRecent(FEED_TURNS_LIMIT).filter(t => t.endedAt >= since) } catch (e) { deps.log('SETTINGS', `feed turns 读不到: ${e instanceof Error ? e.message : e}`) }
    return { journal, thoughts, turns }
  }
  const feedTimezone = (): string => { try { return deps.feed?.timezone() || 'UTC' } catch { return 'UTC' } }
  const readSeen = (): string | null => { try { return deps.seen?.read() ?? null } catch { return null } }
  const parseLimit = (url: URL): number => {
    const n = Number(url.searchParams.get('limit'))
    return Number.isFinite(n) && n > 0 ? n : FEED_DEFAULT_LIMIT
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
        // Paint-set download progress so the phone can show "已开始 / 62%" right
        // after the owner flips the switch; the download itself runs on the Mac.
        atelier: { model_status: readModelStatus(deps.stateDir) },
        models: modelsState(),
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
        if (b.op === 'set_llm_key') {
          // key 只进 daemon.env,不进日志、不进 audit 正文、不回显。
          const r = await saveLlmKey(deps.stateDir, b, deps.log)
          if (!r.ok) return { ok: false, error: r.error }
          deps.audit?.(`llm key(${String(b.provider)}) 已保存 — 设置面板(值不记录);重启后生效`)
          return { ok: true }
        }
        if (b.op === 'set_alias' || b.op === 'del_alias') {
          const alias = typeof b.alias === 'string' ? b.alias.trim() : ''
          if (!ALIAS_RE.test(alias) || /^(list|alias|unalias)$/i.test(alias)) return { ok: false, error: 'invalid_alias' }
          const cfg = loadAgentConfig(deps.stateDir)
          const next = { ...(cfg.openaiAliases ?? {}) }
          if (b.op === 'del_alias') {
            if (!(alias in next)) return { ok: false, error: 'unknown_alias' }
            delete next[alias]
          } else {
            const model = typeof b.model === 'string' ? b.model.trim() : ''
            if (!MODEL_NAME_RE.test(model)) return { ok: false, error: 'invalid_model' }
            next[alias] = model
          }
          const { openaiAliases: _drop, ...rest } = cfg
          saveAgentConfig(deps.stateDir, Object.keys(next).length > 0 ? { ...rest, openaiAliases: next } : rest)
          deps.audit?.(`/api 别名 ${b.op === 'del_alias' ? `删除 ${alias}` : `${alias} → ${String(b.model).trim()}`} — 设置面板`)
          return { ok: true }
        }
        if (b.op === 'set_config') {
          const key = typeof b.key === 'string' ? b.key : ''
          if (!PANEL_CONFIG_KEYS.includes(key)) return { ok: false, error: 'unknown_key' }
          const r = await writeConfigKey(deps.stateDir, key, b.value)
          if (!r.ok) return { ok: false, error: r.error }
          // Turning the atelier on here (phone) kicks the same silent, deduped
          // ~5GB paint-set download that /v1/config/set does. Never blocks.
          if (shouldProvisionOnConfigChange(key, r.previous, b.value)) {
            void kickAtelierModelProvision(deps.stateDir, { log: deps.log })
          }
          deps.audit?.(`${key}: ${JSON.stringify(r.previous)} → ${JSON.stringify(b.value)} — 设置面板`)
          // 默认 provider 是开机捕获的,改完自己重启(和 set_remote 同一条路);
          // 没接 requestRestart 时告诉调用方要手动重启。
          if (key === 'provider' && r.previous !== b.value) {
            if (deps.requestRestart) { deps.requestRestart('provider-change'); return { ok: true, restart: 'requested' } }
            return { ok: true, restart: 'required' }
          }
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
          if (url.pathname === '/m/api/home' && req.method === 'GET') {
            let presence: Presence | null = null
            let presenceFailed = false
            try { presence = (await deps.presence?.()) ?? null } catch (e) { presenceFailed = true; deps.log('SETTINGS', `presence 读不到: ${e instanceof Error ? e.message : e}`) }
            const tz = feedTimezone()
            const seenUntil = readSeen()
            const r = buildFeed(collectSources(), { ownerChatId: deps.ownerChatId(), timezone: tz, limit: parseLimit(url), seenUntil })
            return json({
              ok: true,
              synced_at: new Date(now()).toISOString(),
              today: dayKey(now(), tz),
              presence,
              ...(presenceFailed ? { presence_error: 'unavailable' } : {}),
              unread: r.unread,
              seen_until: seenUntil,
              events: r.events,
              next_cursor: r.next_cursor,
              sources_degraded: r.sources_degraded,
            })
          }
          if (url.pathname === '/m/api/feed' && req.method === 'GET') {
            const cursor = url.searchParams.get('cursor')
            if (cursor !== null && !decodeCursor(cursor)) return json({ ok: false, error: 'invalid_cursor' }, 400)
            const r = buildFeed(collectSources(), { ownerChatId: deps.ownerChatId(), timezone: feedTimezone(), limit: parseLimit(url), cursor, seenUntil: readSeen() })
            return json({ ok: true, events: r.events, next_cursor: r.next_cursor, sources_degraded: r.sources_degraded })
          }
          if (url.pathname === '/m/api/seen' && req.method === 'POST') {
            if (!deps.seen) return json({ ok: false, error: 'seen_not_wired' }, 503)
            let body: unknown
            try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
            const until = (body as { until?: unknown } | null)?.until
            const ms = typeof until === 'string' ? Date.parse(until) : NaN
            if (!Number.isFinite(ms)) return json({ ok: false, error: 'invalid_until' }, 400)
            // 夹到 now(不许推到未来);单调(桌面与手机两边推,谁靠后算谁)。
            const clamped = new Date(Math.min(ms, now())).toISOString()
            const cur = readSeen()
            if (cur !== null && clamped <= cur) return json({ ok: true, seen_until: cur })
            deps.seen.write(clamped)
            return json({ ok: true, seen_until: clamped })
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
