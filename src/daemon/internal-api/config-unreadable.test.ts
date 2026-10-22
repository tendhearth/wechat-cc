/**
 * 配置文件写不进去(第三批 3e,lib/json-file 拒写)⇒ 任何路由都回 409 + 码,不是 500,daemon 照常服务。
 * 起因:以前读不出来的 agent-config.json 会被当成 {} 写回,主人整份配置只剩一两个键。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInternalApi, type InternalApi } from '../internal-api'

describe('internal API × unreadable config file', () => {
  let stateDir: string
  let api: InternalApi | null = null
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'config-unreadable-')) })
  afterEach(async () => { if (api) await api.stop(); api = null; rmSync(stateDir, { recursive: true, force: true }) })

  it('POST /v1/social/enable on a torn agent-config.json ⇒ 409 config_unreadable, file untouched, server keeps serving', async () => {
    const p = join(stateDir, 'agent-config.json'), torn = '{"provider":"codex","a2a_agents":[{"id":"x"'
    writeFileSync(p, torn)
    api = createInternalApi({ stateDir, daemonPid: 1 })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    const call = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const r = await call('POST', '/v1/social/enable', { enabled: true })
    expect(r.status).toBe(409)
    const body = await r.json() as { error: string; detail: string }
    expect(body.error).toBe('config_unreadable')
    expect(body.detail).toContain('agent-config.json')
    expect(readFileSync(p, 'utf8')).toBe(torn)
    expect((await call('GET', '/v1/health')).status).toBe(200)
  })
})
