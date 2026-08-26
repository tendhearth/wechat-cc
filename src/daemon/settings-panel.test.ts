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
})
