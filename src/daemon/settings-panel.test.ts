import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSettingsPanel, SETTINGS_LINK_TTL_MS, type SettingsPanel } from './settings-panel'
import { writeFileSync as wf } from 'node:fs'

const OWNER = 'owner_chat@im.wechat'

function seedStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'settings-panel-'))
  mkdirSync(join(dir, 'memory', OWNER), { recursive: true })
  writeFileSync(join(dir, 'memory', OWNER, 'persona.md'), '# 性格\n温柔一点')
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'claude', bot_name: 'CC', knowledge_enabled: true }))
  return dir
}

describe('settings panel', () => {
  let stateDir: string
  let panel: SettingsPanel
  let nowMs: number
  const prefs: Record<string, Record<string, unknown>> = {}
  const setUserName = vi.fn(async () => {})
  const audit = vi.fn()

  beforeEach(() => {
    stateDir = seedStateDir()
    nowMs = 1_000_000
    prefs[OWNER] = { split: false }
    panel = makeSettingsPanel({
      stateDir,
      ownerChatId: () => OWNER,
      todos: {
        facts: {
          findFacts: (_k, _p, _q, status) => ({ results: status === 'active'
            ? [{ id: 7, contact: 'wx_f', predicate: '还书', value: '答应还《三体》', time_ref: null, updated_at: 100 }]
            : [{ id: 9, contact: 'wx_f', predicate: 'x', value: '已还的书', time_ref: null, updated_at: 90 }] }),
          setFactStatus: (id, status) => { prefs['_lastSet'] = { id, status } as never; return { ok: true } },
        },
        names: () => [{ username: 'wx_f', display: '小飞' }],
      },
      stickers: { list: () => [{ file: 'bear.png', tags: ['开心'] }], dir: join(stateDir, 'stickers') },
      chatPrefs: {
        get: (c) => prefs[c] ?? {},
        set: (c, patch) => { prefs[c] = { ...(prefs[c] ?? {}), ...patch }; return prefs[c]! },
      },
      getUserName: () => '大人',
      setUserName,
      audit,
      remote: {
        isEnabled: () => { try { return JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8')).remote_tunnel === true } catch { return false } },
        setEnabled: (on) => {
          const cfg = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
          cfg.remote_tunnel = on
          writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify(cfg))
        },
        requestRestart: () => { prefs['_restarted'] = { yes: true } as never },
      },
      log: () => {},
      now: () => nowMs,
    })
  })
  afterEach(async () => {
    await panel.stop()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('apply: forget_devices wipes all paired device tokens (they stop validating)', async () => {
    const { port } = await panel.start(0)
    const base = `http://127.0.0.1:${port}`
    const t = panel.issueToken()
    const r = await (await fetch(`${base}/set/api/pair?t=${t}`, { method: 'POST' })).json() as { device_token: string }
    expect(panel.validToken(r.device_token)).toBe(true)
    expect((await panel.apply({ op: 'forget_devices' })).ok).toBe(true)
    expect(panel.validToken(r.device_token)).toBe(false)   // revoked immediately
    const st = panel.state() as { remote?: { devices: number } }
    expect(st.remote?.devices).toBe(0)
  })

  it('apply: set_remote toggles remote_tunnel in config and requests a restart', async () => {
    expect((await panel.apply({ op: 'set_remote', enabled: true })).ok).toBe(true)
    expect(JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8')).remote_tunnel).toBe(true)
    expect(prefs['_restarted']).toEqual({ yes: true })
    expect((await panel.apply({ op: 'set_remote', enabled: 'nope' })).ok).toBe(false)
  })

  it('issueToken: fresh token validates; expires after TTL; reissue revokes the old one', () => {
    const t1 = panel.issueToken()
    expect(panel.validToken(t1)).toBe(true)
    nowMs += SETTINGS_LINK_TTL_MS + 1
    expect(panel.validToken(t1)).toBe(false)
    nowMs = 1_000_000
    const t2 = panel.issueToken()
    const t3 = panel.issueToken()
    expect(panel.validToken(t2)).toBe(false)   // replaced
    expect(panel.validToken(t3)).toBe(true)
  })

  it('state() assembles name/persona/prefs/config for the owner', () => {
    const s = panel.state() as { ok: true; name: string; persona: string; prefs: Record<string, unknown>; config: Record<string, unknown> }
    expect(s.ok).toBe(true)
    expect(s.name).toBe('大人')
    expect(s.persona).toContain('温柔一点')
    expect(s.prefs).toEqual({ split: false })
    expect(s.config['bot_name']).toBe('CC')
    expect(s.config['knowledge_enabled']).toBe(true)
    expect(s.config['provider']).toBeUndefined()   // not a panel key
  })

  it('apply: set_name normalizes 叫我-phrases; set_persona writes the file', async () => {
    expect((await panel.apply({ op: 'set_name', name: '叫我老板' })).ok).toBe(true)
    expect(setUserName).toHaveBeenCalledWith(OWNER, '老板')
    expect((await panel.apply({ op: 'set_persona', content: '# 性格\n毒舌一点' })).ok).toBe(true)
    expect(readFileSync(join(stateDir, 'memory', OWNER, 'persona.md'), 'utf8')).toBe('# 性格\n毒舌一点')
  })

  it('apply: set_pref validates keys and values', async () => {
    expect((await panel.apply({ op: 'set_pref', key: 'care', value: 'high' })).ok).toBe(true)
    expect(prefs[OWNER]!['care']).toBe('high')
    expect((await panel.apply({ op: 'set_pref', key: 'care', value: 'max' })).ok).toBe(false)
    expect((await panel.apply({ op: 'set_pref', key: 'split', value: true })).ok).toBe(true)
    expect((await panel.apply({ op: 'set_pref', key: 'nope', value: true })).ok).toBe(false)
  })

  it('apply: set_config only touches panel-whitelisted keys and audits', async () => {
    expect((await panel.apply({ op: 'set_config', key: 'bot_name', value: '小柴' })).ok).toBe(true)
    expect(audit).toHaveBeenCalled()
    const cfg = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
    expect(cfg.bot_name).toBe('小柴')
    // provider is config-surface-readable but NOT panel-writable
    expect((await panel.apply({ op: 'set_config', key: 'provider', value: 'codex' })).ok).toBe(false)
    expect((await panel.apply({ op: 'nonsense' })).ok).toBe(false)
  })

  it('HTTP: everything without a valid token is 401; with token the API round-trips', async () => {
    const { port } = await panel.start(0)
    const base = `http://127.0.0.1:${port}`
    expect((await fetch(`${base}/set`)).status).toBe(401)
    expect((await fetch(`${base}/set/api/state?t=wrong`)).status).toBe(401)
    const t = panel.issueToken()
    const page = await fetch(`${base}/set?t=${t}`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('陪伴方式')
    const st = await (await fetch(`${base}/set/api/state?t=${t}`)).json() as { name: string }
    expect(st.name).toBe('大人')
    const ap = await fetch(`${base}/set/api/apply?t=${t}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'set_pref', key: 'stickers', value: false }),
    })
    expect((await ap.json() as { ok: boolean }).ok).toBe(true)
    expect(prefs[OWNER]!['stickers']).toBe(false)
    nowMs += SETTINGS_LINK_TTL_MS + 1
    expect((await fetch(`${base}/set/api/state?t=${t}`)).status).toBe(401)
  })
})


describe('随身 CC (phone PWA + device pairing)', () => {
  let stateDir: string
  let panel: SettingsPanel
  let nowMs: number
  const prefs: Record<string, Record<string, unknown>> = {}

  beforeEach(() => {
    stateDir = seedStateDir()
    mkdirSync(join(stateDir, 'stickers'), { recursive: true })
    wf(join(stateDir, 'stickers', 'bear.png'), 'png-bytes')
    wf(join(stateDir, 'memory', OWNER, 'portrait.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><circle cx="1" cy="1" r="1" fill="none" stroke="#5a3f2d"/></svg>')
    nowMs = 1_000_000
    prefs[OWNER] = {}
    panel = makeSettingsPanel({
      stateDir,
      ownerChatId: () => OWNER,
      chatPrefs: { get: (c) => prefs[c] ?? {}, set: (c, patch) => { prefs[c] = { ...(prefs[c] ?? {}), ...patch }; return prefs[c]! } },
      getUserName: () => '大人',
      setUserName: async () => {},
      todos: {
        facts: {
          findFacts: (_k, _p, _q, status) => ({ results: status === 'active'
            ? [{ id: 7, contact: 'wx_f', predicate: '还书', value: '答应还《三体》', time_ref: null, updated_at: 100 }] : [] }),
          setFactStatus: () => ({ ok: true }),
        },
        names: () => [{ username: 'wx_f', display: '小飞' }],
      },
      stickers: { list: () => [{ file: 'bear.png', tags: ['开心'] }], dir: join(stateDir, 'stickers') },
      log: () => {},
      now: () => nowMs,
    })
  })
  afterEach(async () => { await panel.stop(); rmSync(stateDir, { recursive: true, force: true }) })

  it('pairing: short token mints a durable device token that survives short-token expiry', async () => {
    const { port } = await panel.start(0)
    const base = `http://127.0.0.1:${port}`
    const t = panel.issueToken()
    const r = await (await fetch(`${base}/set/api/pair?t=${t}`, { method: 'POST' })).json() as { ok: boolean; device_token: string }
    expect(r.ok).toBe(true)
    expect(r.device_token.length).toBeGreaterThanOrEqual(32)
    nowMs += SETTINGS_LINK_TTL_MS + 1
    expect((await fetch(`${base}/m/api/state?d=${r.device_token}`)).status).toBe(200)   // device token still valid
    expect((await fetch(`${base}/m/api/state?t=${t}`)).status).toBe(401)                // short token dead
  })

  it('/m without token serves the localStorage bootstrap (200), API stays 401', async () => {
    const { port } = await panel.start(0)
    const base = `http://127.0.0.1:${port}`
    const page = await fetch(`${base}/m`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('deviceToken')
    expect((await fetch(`${base}/m/api/state`)).status).toBe(401)
  })

  it('phone state: todos with display names, portrait svg, sticker tags', async () => {
    const { port } = await panel.start(0)
    const base = `http://127.0.0.1:${port}`
    const t = panel.issueToken()
    const s2 = await (await fetch(`${base}/m/api/state?t=${t}`)).json() as { todos: { active: Array<{ display: string }> }; portrait: string | null; stickers: Array<{ tags: string[] }> }
    expect(s2.todos.active[0]!.display).toBe('小飞')
    expect(s2.portrait).toContain('<svg')
    expect(s2.stickers[0]!.tags).toEqual(['开心'])
  })

  it('sticker ?b64=1 returns JSON data-URI payload (tunnel/shell mode images)', async () => {
    const { port } = await panel.start(0)
    const base = `http://127.0.0.1:${port}`
    const t = panel.issueToken()
    const r = await (await fetch(`${base}/m/api/sticker/bear.png?b64=1&t=${t}`)).json() as { ok: boolean; mime: string; data: string }
    expect(r.ok).toBe(true)
    expect(r.mime).toBe('image/png')
    expect(Buffer.from(r.data, 'base64').toString()).toBe('png-bytes')
  })

  it('sticker image serving guards path traversal; icon is tokenless', async () => {
    const { port } = await panel.start(0)
    const base = `http://127.0.0.1:${port}`
    const t = panel.issueToken()
    expect((await fetch(`${base}/m/api/sticker/bear.png?t=${t}`)).status).toBe(200)
    expect((await fetch(`${base}/m/api/sticker/..%2F..%2Fagent-config.json?t=${t}`)).status).toBe(404)
    const icon = await fetch(`${base}/m/icon.png`)
    expect([200, 404]).toContain(icon.status)   // bundled art may be absent in test env — must not 401
    expect(icon.status).not.toBe(401)
  })

  it('/m 首屏是「今天」,口袋里还有原来三块', async () => {
    const { port } = await panel.start(0)
    const t = panel.issueToken()
    const html = await (await fetch(`http://127.0.0.1:${port}/m?t=${t}`)).text()
    expect(html).toContain('id="p-today"')
    expect(html).toContain('id="p-pocket"')
    expect(html).toContain('/m/api/home')
    expect(html).toContain('cc.home.v1')
    for (const id of ['id="todos"', 'id="portrait"', 'id="stickers"']) expect(html).toContain(id)
  })
})

describe('随身 CC 首屏:伙伴的一天', () => {
  const OWNER2 = 'owner2@im.wechat'
  const NOW = Date.parse('2026-09-06T08:00:00.000Z')
  let dir: string
  let seenUntil: string | null
  let presenceImpl: () => Promise<import('../core/companion-presence').Presence | null>
  let planThrows: boolean
  const rows = () => [
    { id: 'j1', ts: '2026-09-06T02:43:36.412Z', chat_id: OWNER2, title: '好玩的东西', url: 'https://x', note: '', status: 'new', kind: 'hunt', image_svg: null },
  ] as import('../core/journal-store').CatchRow[]
  const plans = () => [
    { at: '2026-09-06T03:03:55.347Z', chatId: OWNER2, candidates: ['visit'], decision: 'none', why: '没朋友,在家歇着。', source: 'model' },
  ] as import('../core/companion-plan').PlanLogEntry[]
  const mk = (over: Partial<Parameters<typeof makeSettingsPanel>[0]> = {}) => makeSettingsPanel({
    stateDir: dir,
    ownerChatId: () => OWNER2,
    chatPrefs: { get: () => ({}), set: () => ({}) },
    getUserName: () => '大人',
    setUserName: async () => {},
    feed: {
      journal: { list: () => rows() },
      planLogDays: () => { if (planThrows) throw new Error('boom'); return plans() },
      turnsRecent: () => [{ chatId: OWNER2, endedAt: Date.parse('2026-09-05T01:00:00.000Z'), outcome: 'completed' }],
      timezone: () => 'Asia/Shanghai',
    },
    presence: () => presenceImpl(),
    seen: { read: () => seenUntil, write: (iso) => { seenUntil = iso } },
    log: () => {},
    now: () => NOW,
    ...over,
  })
  const okPresence = async () => ({ presence: 'ok' as const, activity: { kind: 'idle' as const, label: '在家', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-feed-'))
    seenUntil = null
    presenceImpl = okPresence
    planThrows = false
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function withPanel(p: ReturnType<typeof makeSettingsPanel>, fn: (base: string, t: string) => Promise<void>) {
    const { port } = await p.start(0)
    try { await fn(`http://127.0.0.1:${port}`, p.issueToken()) } finally { await p.stop() }
  }

  it('home:三源合并、presence、unread、synced_at、today', async () => {
    await withPanel(mk(), async (base, t) => {
      const r = await (await fetch(`${base}/m/api/home?t=${t}`)).json() as Record<string, unknown>
      expect(r.ok).toBe(true)
      expect(r.synced_at).toBe('2026-09-06T08:00:00.000Z')
      expect(r.today).toBe('2026-09-06')
      expect(r.presence).toMatchObject({ presence: 'ok' })
      expect(r.unread).toBe(3)
      expect(r.seen_until).toBeNull()
      expect((r.events as Array<{ id: string }>).map(e => e.id)).toEqual(['thought:2026-09-06T03:03:55.347Z', 'journal:j1', 'chat_day:2026-09-05'])
      expect(r.sources_degraded).toEqual([])
      expect(r.next_cursor).toBeNull()
    })
  })
  it('home:presence 抛 → null + presence_error;单源抛 → degraded 仍 200', async () => {
    presenceImpl = async () => { throw new Error('nope') }
    planThrows = true
    await withPanel(mk(), async (base, t) => {
      const res = await fetch(`${base}/m/api/home?t=${t}`)
      expect(res.status).toBe(200)
      const r = await res.json() as Record<string, unknown>
      expect(r.presence).toBeNull()
      expect(r.presence_error).toBe('unavailable')
      expect(r.sources_degraded).toEqual(['thought'])
      expect((r.events as unknown[]).length).toBe(2)
    })
  })
  it('home:feed dep 缺 → 三项 degraded、空 events,仍 200', async () => {
    await withPanel(mk({ feed: undefined }), async (base, t) => {
      const r = await (await fetch(`${base}/m/api/home?t=${t}`)).json() as Record<string, unknown>
      expect(r.ok).toBe(true)
      expect(r.sources_degraded).toEqual(['journal', 'thought', 'chat_day'])
      expect(r.events).toEqual([])
    })
  })
  it('feed:分页接得上;坏游标 400', async () => {
    await withPanel(mk(), async (base, t) => {
      const p1 = await (await fetch(`${base}/m/api/feed?limit=2&t=${t}`)).json() as { events: Array<{ id: string }>; next_cursor: string | null }
      expect(p1.events).toHaveLength(2)
      expect(p1.next_cursor).not.toBeNull()
      const p2 = await (await fetch(`${base}/m/api/feed?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}&t=${t}`)).json() as { events: Array<{ id: string }>; next_cursor: string | null }
      expect(p2.events.map(e => e.id)).toEqual(['chat_day:2026-09-05'])
      expect(p2.next_cursor).toBeNull()
      const bad = await fetch(`${base}/m/api/feed?cursor=%25%25&t=${t}`)
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ ok: false, error: 'invalid_cursor' })
    })
  })
  it('seen:写入、夹到 now、单调不后退、非法 400、没接 503', async () => {
    await withPanel(mk(), async (base, t) => {
      const post = (until: unknown) => fetch(`${base}/m/api/seen?t=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ until }) })
      expect(await (await post('2026-09-06T07:00:00.000Z')).json()).toEqual({ ok: true, seen_until: '2026-09-06T07:00:00.000Z' })
      expect(await (await post('2099-01-01T00:00:00.000Z')).json()).toEqual({ ok: true, seen_until: '2026-09-06T08:00:00.000Z' })
      expect(await (await post('2026-09-06T06:00:00.000Z')).json()).toEqual({ ok: true, seen_until: '2026-09-06T08:00:00.000Z' })
      const bad = await post('yesterday')
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ ok: false, error: 'invalid_until' })
      const home = await (await fetch(`${base}/m/api/home?t=${t}`)).json() as { unread: number; seen_until: string }
      expect(home.unread).toBe(0)
      expect(home.seen_until).toBe('2026-09-06T08:00:00.000Z')
    })
    await withPanel(mk({ seen: undefined }), async (base, t) => {
      const r = await fetch(`${base}/m/api/seen?t=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ until: '2026-09-06T07:00:00.000Z' }) })
      expect(r.status).toBe(503)
    })
  })
  it('三个路由都要令牌', async () => {
    await withPanel(mk(), async (base) => {
      expect((await fetch(`${base}/m/api/home`)).status).toBe(401)
      expect((await fetch(`${base}/m/api/feed`)).status).toBe(401)
      expect((await fetch(`${base}/m/api/seen`, { method: 'POST' })).status).toBe(401)
    })
  })
})
