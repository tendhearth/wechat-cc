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
  const MATTER = { id: 'deadbeef', kind: 'task', title: '整理周报', projectPath: '/work/report', status: 'replied', ownerChatId: OWNER, createdAt: 1, updatedAt: 2 }
  const matters = { list: vi.fn(() => [MATTER]), detail: vi.fn(() => ({ matter: MATTER, bindings: [], sessions: [], task: null, events: [{ kind: 'text', text: '做好了', createdAt: 3 }] })), say: vi.fn(async () => ({ kind: 'task', task: { id: 'deadbeef' } })), seenOnPhone: vi.fn() }

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
      matters,
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
    expect(s.config['provider']).toBe('claude')    // 默认大脑现在是面板键(2026-09-09)
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
    // provider IS panel-writable now (默认大脑);a non-surface key is the refused example
    expect((await panel.apply({ op: 'set_config', key: 'dangerouslySkipPermissions', value: 'true' })).ok).toBe(false)
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

  it('sticker image serving guards path traversal', async () => {
    const { port } = await panel.start(0)
    const base = `http://127.0.0.1:${port}`
    const t = panel.issueToken()
    expect((await fetch(`${base}/m/api/sticker/bear.png?t=${t}`)).status).toBe(200)
    expect((await fetch(`${base}/m/api/sticker/..%2F..%2Fagent-config.json?t=${t}`)).status).toBe(404)
  })

  it('serves the CC brand PNG without a token and declares its actual PWA dimensions', async () => {
    const { port } = await panel.start(0)
    const base = `http://127.0.0.1:${port}`
    const icon = await fetch(`${base}/m/icon.png`)
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).toBe('image/png')
    const bytes = Buffer.from(await icon.arrayBuffer())
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(bytes.equals(readFileSync(new URL('../../apps/desktop/src/wechat-cc-logo.png', import.meta.url)))).toBe(true)
    const manifest = await (await fetch(`${base}/m/manifest.json`)).json() as { icons: Array<{ src: string; sizes: string; type: string }> }
    expect(manifest.icons).toEqual([{
      src: '/m/icon.png', sizes: `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, type: 'image/png',
    }])
  })

  it('/m 首屏是「此刻」,回忆里仍能访问口袋三块', async () => {
    const { port } = await panel.start(0)
    const t = panel.issueToken()
    const html = await (await fetch(`http://127.0.0.1:${port}/m?t=${t}`)).text()
    expect(html).toContain('id="p-today"')
    expect(html).toContain('id="p-pocket"')
    expect(html).toContain('/m/api/home')
    expect(html).toContain('cc.home.v2:')
    expect(html).toContain('id="p-memory"')
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
      turnsRecent: () => [{ chatId: OWNER2, endedAt: Date.parse('2026-09-05T01:00:00.000Z'), outcome: 'completed', mode: 'solo', startedAt: Date.parse('2026-09-05T01:00:00.000Z') }],
      timezone: () => 'Asia/Shanghai',
    },
    presence: () => presenceImpl(),
    seen: { read: () => seenUntil, write: (iso) => { seenUntil = iso } },
    log: () => {},
    now: () => NOW,
    ...over,
  })
  // derivePresence 从不给 kind:'idle' 配非空 label(桌宠靠 kind 本身表达闲着)——
  // 之前这里造的 { kind:'idle', label:'在家' } 是 derivePresence 永远不会产出的
  // 组合,掩盖了手机页把空 label 拼成裸「现在:」的 C1 bug。
  const okPresence = async () => ({ presence: 'ok' as const, activity: { kind: 'idle' as const, label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } })

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
      expect((r.events as Array<{ id: string }>).map(e => e.id)).toEqual([`thought:${OWNER2}:2026-09-06T03:03:55.347Z`, 'journal:j1', 'chat_day:2026-09-05'])
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
  it('home returns an authenticated decision shortcut, not an approval payload', async()=>{
    const task={id:'deadbeef',kind:'task',title:'首页调整',status:'open',updatedAt:NOW}
    await withPanel(mk({matters:{list:()=>[task],detail:()=>({matter:task,task:{id:task.id,status:'running'},runId:'r1',permissions:[{id:'request1',taskId:task.id,description:'private command'}]}),say:async()=>({}),seenOnPhone:()=>{}}}),async(base,t)=>{
      expect((await fetch(`${base}/m/api/home`)).status).toBe(401)
      const response=await (await fetch(`${base}/m/api/home?t=${t}`)).json() as {work:unknown}
      expect(response.work).toEqual({focus:{id:'deadbeef',title:'首页调整',kind:'decision'},partial:false})
      expect(JSON.stringify(response.work)).not.toContain('private command')
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
  it('home:turnsRecent 没接线时抛 → chat_day 读成 degraded,不是「接了但没聊天」(M4)', async () => {
    // 镜像 wiring/pipeline-deps.ts 里 feed.turnsRecent 在 opts.turns 缺失时的
    // 真实实现(抛,而不是回退成 [])—— rule 4 要求的「一个源该说读不到,不能
    // 悄悄说成健康的空」,这里锁的就是 collectSources 接住这个抛之后的行为。
    const feedTurnsThrows = {
      journal: { list: () => rows() },
      planLogDays: () => plans(),
      turnsRecent: () => { throw new Error('turns 未接线') },
      timezone: () => 'Asia/Shanghai',
    }
    await withPanel(mk({ feed: feedTurnsThrows }), async (base, t) => {
      const r = await (await fetch(`${base}/m/api/home?t=${t}`)).json() as Record<string, unknown>
      expect(r.ok).toBe(true)
      expect(r.sources_degraded).toEqual(['chat_day'])
      expect((r.events as unknown[]).length).toBe(2)
    })
  })
  it('feed:分页接得上;坏游标 400', async () => {
    await withPanel(mk(), async (base, t) => {
      const p1 = await (await fetch(`${base}/m/api/feed?limit=2&t=${t}`)).json() as { events: Array<{ id: string }>; next_cursor: string | null; sources_degraded: string[] }
      expect(p1.events).toHaveLength(2)
      expect(p1.next_cursor).not.toBeNull()
      expect(p1.sources_degraded).toEqual([])
      const p2 = await (await fetch(`${base}/m/api/feed?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}&t=${t}`)).json() as { events: Array<{ id: string }>; next_cursor: string | null }
      expect(p2.events.map(e => e.id)).toEqual(['chat_day:2026-09-05'])
      expect(p2.next_cursor).toBeNull()
      const bad = await fetch(`${base}/m/api/feed?cursor=%25%25&t=${t}`)
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ ok: false, error: 'invalid_cursor' })
    })
  })
  it('feed:单源挂 → sources_degraded 也在这个响应里 (I2)', async () => {
    planThrows = true
    await withPanel(mk(), async (base, t) => {
      const r = await (await fetch(`${base}/m/api/feed?t=${t}`)).json() as { sources_degraded: string[] }
      expect(r.sources_degraded).toEqual(['thought'])
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

// ── 模型与后端(2026-09-08):一处看全、一处改全 ────────────────────────
describe('settings panel — 模型与后端', () => {
  function build(extra: { registered?: string[]; cached?: unknown; hasKey?: boolean; config?: Record<string, unknown> } = {}) {
    const stateDir = mkdtempSync(join(tmpdir(), 'settings-models-'))
    mkdirSync(join(stateDir, 'memory', OWNER), { recursive: true })
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude', model: 'claude-opus-5', openaiBaseUrl: 'https://llm.example/v1', openaiModel: 'DeepSeek', openaiAliases: { ds: 'DeepSeek' }, agyModel: 'gemini-3.7-flash-high', ...(extra.config ?? {}) }))
    const audit = vi.fn()
    const panel = makeSettingsPanel({
      stateDir,
      ownerChatId: () => OWNER,
      chatPrefs: { get: () => ({}), set: (_c, p) => p },
      getUserName: () => '大人',
      setUserName: async () => {},
      audit,
      llm: {
        registered: () => extra.registered ?? ['claude', 'agy', 'openai'],
        cached: () => (extra.cached ?? { checked_at: 't', default_provider: 'claude', results: [
          { provider: 'claude', ok: true, latency_ms: 120 },
          { provider: 'agy', ok: false, latency_ms: 0, error: 'Not logged in' },
        ] }) as never,
        hasKey: () => extra.hasKey ?? true,
      },
      log: () => {},
    })
    return { panel, stateDir, audit, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) }
  }

  it('state().models: six providers with registered/status/model, openai block (no key value), aliases, cheap', () => {
    const { panel, cleanup } = build()
    try {
      const m = (panel.state() as { models: any }).models
      expect(m.default_provider).toBe('claude')
      const byId = Object.fromEntries(m.providers.map((p: any) => [p.id, p]))
      expect(Object.keys(byId)).toEqual(['claude', 'codex', 'cursor', 'openai', 'gemini', 'agy'])   // lib/provider-ids order
      expect(byId.claude).toMatchObject({ registered: true, status: 'ok', model: 'claude-opus-5', latency_ms: 120 })
      expect(byId.agy).toMatchObject({ registered: true, status: 'broken', error: 'Not logged in', model: 'gemini-3.7-flash-high' })
      expect(byId.openai).toMatchObject({ registered: true, status: 'unknown', model: 'DeepSeek' })   // registered, never probed
      expect(byId.cursor).toMatchObject({ registered: false, status: 'unconfigured' })
      expect(byId.cursor.hint).toContain('cursor-agent')
      expect(m.openai).toEqual({ base_url: 'https://llm.example/v1', model: 'DeepSeek', has_key: true, aliases: { ds: 'DeepSeek' } })
      expect(JSON.stringify(m)).not.toContain('sk-')
      expect(m.cheap).toBe('auto')
    } finally { cleanup() }
  })

  it('state().models degrades without the llm dep: everything unconfigured/unknown, has_key false', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'settings-models-'))
    mkdirSync(join(stateDir, 'memory', OWNER), { recursive: true })
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
    try {
      const panel = makeSettingsPanel({ stateDir, ownerChatId: () => OWNER, chatPrefs: { get: () => ({}), set: (_c, p) => p }, getUserName: () => null, setUserName: async () => {}, log: () => {} })
      const m = (panel.state() as { models: any }).models
      expect(m.providers.every((p: any) => p.status === 'unconfigured')).toBe(true)
      expect(m.openai.has_key).toBe(false)
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('apply set_llm_key: lands in daemon.env, key never reaches the audit line', async () => {
    const { panel, stateDir, audit, cleanup } = build()
    try {
      const r = await panel.apply({ op: 'set_llm_key', provider: 'openai', key: 'sk-secret-123', base_url: 'https://llm.example/v1', model: 'DeepSeek' })
      expect(r).toEqual({ ok: true })
      expect(readFileSync(join(stateDir, 'daemon.env'), 'utf8')).toContain('WECHAT_OPENAI_API_KEY=sk-secret-123')
      expect(audit).toHaveBeenCalled()
      expect(JSON.stringify(audit.mock.calls)).not.toContain('sk-secret')
      expect((await panel.apply({ op: 'set_llm_key', provider: 'claude', key: 'x' })).ok).toBe(false)
    } finally { cleanup() }
  })

  it('apply set_alias / del_alias round-trip through agent-config; subcommand names and bad model ids are refused', async () => {
    const { panel, stateDir, cleanup } = build()
    try {
      expect((await panel.apply({ op: 'set_alias', alias: 'kimi', model: 'kimi-k2.7-code' })).ok).toBe(true)
      expect(JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8')).openaiAliases).toEqual({ ds: 'DeepSeek', kimi: 'kimi-k2.7-code' })
      expect((await panel.apply({ op: 'set_alias', alias: 'list', model: 'DeepSeek' })).ok).toBe(false)
      expect((await panel.apply({ op: 'set_alias', alias: 'x', model: 'has space' })).ok).toBe(false)
      expect((await panel.apply({ op: 'del_alias', alias: 'ds' })).ok).toBe(true)
      expect((await panel.apply({ op: 'del_alias', alias: 'ds' })).ok).toBe(false)
      expect(JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8')).openaiAliases).toEqual({ kimi: 'kimi-k2.7-code' })
      expect((await panel.apply({ op: 'del_alias', alias: 'kimi' })).ok).toBe(true)
      expect(JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))).not.toHaveProperty('openaiAliases')
    } finally { cleanup() }
  })

  it('state().models exposes trusted_providers (null = all) and which providers share one key', () => {
    const { panel, cleanup } = build({ config: { trusted_providers: ['claude', 'openai'] } })
    try {
      const m = (panel.state() as { models: any }).models
      expect(m.trusted_providers).toEqual(['claude', 'openai'])
      // cursor moved to ACP (2026-09-18, acp-cursor-chat.ts) — its MCP child
      // is injected per session/new with the real tier now, so it's no
      // longer a shared-token provider like agy: no 🔑 badge.
      expect([...m.shared_token].sort()).toEqual(['agy'])
      // …but a guest still can't use it: ACP Cursor edits the workspace without
      // a permission card (guestSafe:false), so it joins the "访客不可用" list.
      expect([...m.guest_blocked].sort()).toEqual(['agy', 'cursor'])
    } finally { cleanup() }
  })

  it('geminiModel and trusted_providers are panel-writable too (owner: 不能我不用就不做)', async () => {
    const { panel, stateDir, cleanup } = build()
    try {
      expect((await panel.apply({ op: 'set_config', key: 'geminiModel', value: 'gemini-3.7-flash' })).ok).toBe(true)
      expect((await panel.apply({ op: 'set_config', key: 'trusted_providers', value: 'claude,agy' })).ok).toBe(true)
      const cfg = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
      expect(cfg.geminiModel).toBe('gemini-3.7-flash')
      expect(cfg.trusted_providers).toEqual(['claude', 'agy'])
    } finally { cleanup() }
  })

  it('the new config keys are panel-writable (openaiModel/openaiBaseUrl/agyModel/cursorModel/cheap_eval_provider)', async () => {
    const { panel, stateDir, cleanup } = build()
    try {
      for (const [k, v] of [['openaiModel', 'Qwen3.8'], ['openaiBaseUrl', 'http://10.84.91.33:8088/v1'], ['agyModel', 'gemini-3.7-pro'], ['cursorModel', 'auto'], ['cheap_eval_provider', 'agy']] as const) {
        expect((await panel.apply({ op: 'set_config', key: k, value: v })).ok).toBe(true)
      }
      const cfg = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
      expect(cfg).toMatchObject({ openaiModel: 'Qwen3.8', openaiBaseUrl: 'http://10.84.91.33:8088/v1', agyModel: 'gemini-3.7-pro', cursorModel: 'auto', cheapEvalProvider: 'agy' })
      expect((await panel.apply({ op: 'set_config', key: 'cheap_eval_provider', value: 'auto' })).ok).toBe(true)
      expect(JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))).not.toHaveProperty('cheapEvalProvider')
    } finally { cleanup() }
  })
})

describe('settings panel — 默认大脑', () => {
  it('set_config provider writes agent-config and asks the daemon to restart; unchanged value does not restart', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'settings-provider-'))
    mkdirSync(join(stateDir, 'memory', OWNER), { recursive: true })
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
    const requestRestart = vi.fn()
    try {
      const panel = makeSettingsPanel({ stateDir, ownerChatId: () => OWNER, chatPrefs: { get: () => ({}), set: (_c, p) => p }, getUserName: () => null, setUserName: async () => {}, requestRestart, log: () => {} })
      expect(await panel.apply({ op: 'set_config', key: 'provider', value: 'agy' })).toEqual({ ok: true, restart: 'requested' })
      expect(requestRestart).toHaveBeenCalledWith('provider-change')
      expect(JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8')).provider).toBe('agy')
      expect(await panel.apply({ op: 'set_config', key: 'provider', value: 'agy' })).toEqual({ ok: true })
      expect(requestRestart).toHaveBeenCalledTimes(1)
      const noRestart = makeSettingsPanel({ stateDir, ownerChatId: () => OWNER, chatPrefs: { get: () => ({}), set: (_c, p) => p }, getUserName: () => null, setUserName: async () => {}, log: () => {} })
      expect(await noRestart.apply({ op: 'set_config', key: 'provider', value: 'claude' })).toEqual({ ok: true, restart: 'required' })
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })
})

describe('「一件事」手机路由(2026-09-16)', () => {
  let stateDir: string, panel: SettingsPanel
  const MATTER = { id: 'deadbeef', kind: 'task', title: '整理周报', projectPath: '/work/report', status: 'replied', ownerChatId: OWNER, createdAt: 1, updatedAt: 2 }
  const matters = { list: vi.fn(() => [MATTER]), detail: vi.fn(() => ({ matter: MATTER, bindings: [], sessions: [], task: null, events: [{ kind: 'text', text: '做好了', createdAt: 3 }] })), say: vi.fn(async () => ({ kind: 'task', task: { id: 'deadbeef' } })), seenOnPhone: vi.fn() }
  const make = (withMatters: boolean) => makeSettingsPanel({
    stateDir, ownerChatId: () => OWNER, ...(withMatters ? { matters } : {}),
    chatPrefs: { get: () => ({}), set: (_c: string, patch: Record<string, unknown>) => patch }, getUserName: () => '大人', setUserName: async () => {}, log: () => {},
  } as never)
  beforeEach(() => { stateDir = seedStateDir(); vi.clearAllMocks() })
  afterEach(async () => { await panel.stop(); rmSync(stateDir, { recursive: true, force: true }) })

  it('lists, details and says — same data as the desktop, and every look marks the phone surface', async () => {
    panel = make(true)
    const { port } = await panel.start(0), base = `http://127.0.0.1:${port}`, t = panel.issueToken()
    const list = await (await fetch(`${base}/m/api/matters?status=open,replied&t=${t}`)).json() as { ok: boolean; matters: unknown[] }
    expect(list).toEqual({ ok: true, matters: [MATTER] })
    expect(matters.list).toHaveBeenCalledWith({ statuses: ['open', 'replied'], limit: 50 })
    expect(matters.seenOnPhone).toHaveBeenCalledWith('deadbeef')
    const detail = await (await fetch(`${base}/m/api/matter?id=deadbeef&t=${t}`)).json() as { ok: boolean; matter: { id: string }; events: unknown[] }
    expect(detail.ok).toBe(true); expect(detail.matter.id).toBe('deadbeef'); expect(detail.events).toHaveLength(1)
    const said = await (await fetch(`${base}/m/api/matter/say?t=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'deadbeef', text: '再改一版' }) })).json() as { ok: boolean }
    expect(said.ok).toBe(true); expect(matters.say).toHaveBeenCalledWith('deadbeef', '再改一版')
    expect((await fetch(`${base}/m/api/matters?status=weird&t=${t}`)).status).toBe(400)
    expect((await fetch(`${base}/m/api/matter?id=nope&t=${t}`)).status).toBe(400)
    expect((await fetch(`${base}/m/api/matter/say?t=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'deadbeef', text: ' ' }) })).status).toBe(400)
    expect((await fetch(`${base}/m/api/matters`)).status).toBe(401)
  })
  it('is 503 when the matter registry is not wired, and maps not-found / busy', async () => {
    panel = make(false)
    const { port } = await panel.start(0), base = `http://127.0.0.1:${port}`, t = panel.issueToken()
    expect((await fetch(`${base}/m/api/matters?t=${t}`)).status).toBe(503)
    await panel.stop()
    panel = make(true)
    const again = await panel.start(0), b2 = `http://127.0.0.1:${again.port}`, t2 = panel.issueToken()
    matters.detail.mockImplementationOnce(() => { throw new Error('matter_not_found') })
    expect((await fetch(`${b2}/m/api/matter?id=00000000&t=${t2}`)).status).toBe(404)
    matters.say.mockImplementationOnce(async () => { throw new Error('workbench_busy') })
    expect((await fetch(`${b2}/m/api/matter/say?t=${t2}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'deadbeef', text: 'x' }) })).status).toBe(409)
  })
})
