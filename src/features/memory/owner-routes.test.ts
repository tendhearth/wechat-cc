import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTestDb, type Db } from '../../lib/db'
import { ROUTES } from '@wechat-cc/protocol/routes'
import { listAllMemory } from '../../lib/memory'
import type { RouteTable } from '../../daemon/internal-api/types'
import { memoryOwnerRoutes } from './owner-routes'

describe('memory owner routes(桌面记忆页,形状照 `wechat-cc memory …`)', () => {
  let stateDir: string, db: Db, routes: RouteTable
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'memory-owner-'))
    mkdirSync(join(stateDir, 'memory', 'friend@im.wechat'), { recursive: true })
    db = openTestDb()
    routes = memoryOwnerRoutes({ stateDir, db, resolveAdminChatId: () => 'owner@im.wechat', projectsRoot: join(stateDir, 'no-projects') })
  })
  afterEach(() => { db.close(); rmSync(stateDir, { recursive: true, force: true }) })
  const get = (key: string, q: Record<string, string> = {}) => routes[key]!(new URLSearchParams(q), null)
  const post = (key: string, body: unknown) => routes[key]!(new URLSearchParams(), body)

  it('每条都登记在路由表里:module memory、admin + operator、经宿主', () => {
    for (const key of Object.keys(routes)) {
      const row = (ROUTES as Record<string, { module?: string; desktop?: unknown }>)[key]
      expect(row?.module, key).toBe('memory')
      expect(row?.desktop, key).toEqual({ tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true })
    }
  })

  it('files = listAllMemory(带大小、时间,按用户分组);file 读原样文件;读不到 ⇒ 200 + ok:false', async () => {
    writeFileSync(join(stateDir, 'memory', 'friend@im.wechat', 'profile.md'), '喜欢猫')
    const files = await get('GET /v1/memory/files')
    expect(files.status).toBe(200)
    expect(files.body).toEqual(listAllMemory(stateDir))
    expect((files.body as Array<{ fileCount: number }>)[0]!.fileCount).toBe(1)
    expect((await get('GET /v1/memory/file', { user_id: 'friend@im.wechat', path: 'profile.md' })).body)
      .toEqual({ ok: true, userId: 'friend@im.wechat', path: 'profile.md', content: '喜欢猫' })
    const missing = await get('GET /v1/memory/file', { user_id: 'friend@im.wechat', path: 'nope.md' })
    expect(missing.status).toBe(200)
    expect(missing.body).toEqual({ ok: false, error: 'file not found: friend@im.wechat/nope.md' })
  })

  it('file/write 写别人对话里的笔记;生成物整份写和 owner.md 被拒(和 CLI 同一道检查)', async () => {
    const ok = await post('POST /v1/memory/file/write', { userId: 'friend@im.wechat', path: 'notes/a.md', content: '新笔记' })
    expect(ok.body).toEqual({ ok: true, userId: 'friend@im.wechat', path: 'notes/a.md', bytesWritten: Buffer.byteLength('新笔记'), created: true })
    expect(readFileSync(join(stateDir, 'memory', 'friend@im.wechat', 'notes', 'a.md'), 'utf8')).toBe('新笔记')
    const derived = await post('POST /v1/memory/file/write', { userId: 'friend@im.wechat', path: '_overview.md', content: 'x' })
    expect(derived.body).toMatchObject({ ok: false, error: expect.stringContaining('逐行改') })
    const owner = await post('POST /v1/memory/file/write', { userId: 'friend@im.wechat', path: 'owner.md', content: 'x' })
    expect(owner.body).toMatchObject({ ok: false })
    expect((await post('POST /v1/memory/file/write', { userId: 'friend@im.wechat', path: 'b.md' })).body).toEqual({ ok: false, error: 'content must be a string' })
  })

  it('profile = `memory profile-read`;profile/status = `memory profile status`;projects = `memory projects`', async () => {
    expect((await get('GET /v1/memory/profile', { chat_id: 'friend@im.wechat' })).body).toEqual({ ok: false, error: 'file not found: friend@im.wechat/_profile.json' })
    writeFileSync(join(stateDir, 'memory', 'friend@im.wechat', '_profile.json'), '{"version":1}')
    expect((await get('GET /v1/memory/profile', { chat_id: 'friend@im.wechat' })).body).toMatchObject({ ok: true, path: '_profile.json' })
    const status = await get('GET /v1/memory/profile/status', { chat_id: 'friend@im.wechat' })
    expect(status.status).toBe(200)
    expect(status.body).toMatchObject({ ok: true, chatId: 'friend@im.wechat' })
    const projects = await get('GET /v1/memory/projects')
    expect(projects.body).toEqual({ ok: true, projects: [] })
  })
})
