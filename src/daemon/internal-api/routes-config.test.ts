// Mirrors routes-memory.test.ts's injection idiom, but against a REAL temp
// stateDir + in-memory db — config-surface writes real json files and the
// audit path writes a real events row, so stubbing them would test nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configRoutes } from './routes-config'
import type { InternalApiDeps } from './types'
import { openTestDb, type Db } from '../../lib/db'
import { loadAgentConfig } from '../../lib/agent-config'

const q = () => new URLSearchParams()

describe('config routes', () => {
  let stateDir: string
  let db: Db
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cfg-routes-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(stateDir, { recursive: true, force: true })
  })

  const deps = () => ({ stateDir, db } as unknown as InternalApiDeps)

  it('GET /v1/config/surface returns the whitelist with values', async () => {
    const r = await configRoutes(deps())['GET /v1/config/surface']!(q(), undefined)
    expect(r.status).toBe(200)
    const keys = (r.body as any).keys
    expect(Array.isArray(keys)).toBe(true)
    expect(keys.some((k: any) => k.key === 'model')).toBe(true)
    expect(keys.some((k: any) => k.key === 'dangerouslySkipPermissions')).toBe(false)
  })

  it('POST /v1/config/set writes the key and audits with the caller chat', async () => {
    const r = await configRoutes(deps())['POST /v1/config/set']!(
      q(), { key: 'model', value: 'claude-sonnet-5', reason: '主人要求换模型' },
      { tier: 'admin', origin: 'session', chatId: 'chatX' },
    )
    expect(r.status).toBe(200)
    expect((r.body as any).ok).toBe(true)
    expect(loadAgentConfig(stateDir).model).toBe('claude-sonnet-5')
    const row = db.query("SELECT chat_id, kind, trigger, reasoning FROM events WHERE kind='config_changed'").get() as any
    expect(row.chat_id).toBe('chatX')
    expect(row.trigger).toBe('mcp_tool_call')
    expect(row.reasoning).toContain('model')
    expect(row.reasoning).toContain('主人要求换模型')
  })

  it('invalid key/value returns ok:false without an audit row', async () => {
    const r1 = await configRoutes(deps())['POST /v1/config/set']!(q(), { key: 'nope', value: 'x' })
    expect((r1.body as any)).toMatchObject({ ok: false, error: 'unknown_key' })
    const r2 = await configRoutes(deps())['POST /v1/config/set']!(q(), { key: 'knowledge_enabled', value: 'maybe' })
    expect((r2.body as any)).toMatchObject({ ok: false, error: 'invalid_value' })
    expect(db.query("SELECT COUNT(*) n FROM events").get()).toMatchObject({ n: 0 })
  })

  it('missing key/value → 400', async () => {
    const r = await configRoutes(deps())['POST /v1/config/set']!(q(), { value: 'x' })
    expect(r.status).toBe(400)
  })

  it('audit falls back to _operator when the caller has no chat', async () => {
    await configRoutes(deps())['POST /v1/config/set']!(
      q(), { key: 'knowledge_enabled', value: 'on' },
      { tier: 'admin', origin: 'operator' },
    )
    const row = db.query("SELECT chat_id FROM events WHERE kind='config_changed'").get() as any
    expect(row.chat_id).toBe('_operator')
  })
})
