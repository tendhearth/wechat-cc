import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTestDb, type Db } from '../../lib/db'
import { ROUTES } from '@wechat-cc/protocol/routes'
import { makeConversationStore } from '../../adapters/store/conversation-store'
import { makeSessionStore } from '../../adapters/store/session-store'
import { makeObservationsStore } from '../../daemon/observations/store'
import type { RouteTable } from '../../daemon/internal-api/types'
import { consoleRoutes } from './routes'

// 1×1 PNG(只要魔数对)
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('console routes(桌面以前起 CLI 读写的那些,形状照 CLI)', () => {
  let stateDir: string, db: Db, routes: RouteTable
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'console-routes-'))
    db = openTestDb()
    routes = consoleRoutes({ stateDir, db, conversationStore: makeConversationStore(db) })
  })
  afterEach(() => { db.close(); rmSync(stateDir, { recursive: true, force: true }) })
  const get = (key: string, q: Record<string, string> = {}) => routes[key]!(new URLSearchParams(q), null)
  const post = (key: string, body: unknown) => routes[key]!(new URLSearchParams(), body)

  it('每条都登记在路由表里:module console、admin + operator、经宿主(tauri + devProxy)', () => {
    for (const key of Object.keys(routes)) {
      const row = (ROUTES as Record<string, { module?: string; desktop?: { tier: string; tokens?: readonly string[]; tauri?: true; devProxy?: true } }>)[key]
      expect(row, key).toBeDefined()
      expect(row!.module, key).toBe('console')
      expect(row!.desktop, key).toEqual({ tier: 'admin', tokens: ['operator'], tauri: true, devProxy: true })
    }
  })

  it('conversations list = `conversations list --json`', async () => {
    makeConversationStore(db).set('c1@im.wechat', { kind: 'solo', provider: 'codex' })
    const r = await get('GET /v1/conversations/list')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, conversations: [{ chat_id: 'c1@im.wechat', user_id: null, account_id: null, user_name: null, mode: { kind: 'solo', provider: 'codex' } }] })
  })

  it('observations list / archive = `observations list|archive`', async () => {
    const store = makeObservationsStore(db, 'c1')
    const id = await store.append({ body: '想早点睡', tone: 'concern' })
    const listed = await get('GET /v1/observations/list', { chat_id: 'c1' })
    expect(listed.body).toMatchObject({ ok: true, observations: [{ id, body: '想早点睡', tone: 'concern', archived: false }] })
    expect((await post('POST /v1/observations/archive', { chat_id: 'c1', id })).body).toEqual({ ok: true, archived: id })
    expect((await get('GET /v1/observations/list', { chat_id: 'c1' })).body).toEqual({ ok: true, observations: [] })
    expect((await get('GET /v1/milestones/list', { chat_id: 'c1' })).body).toEqual({ ok: true, milestones: [] })
    expect((await get('GET /v1/events/list', { chat_id: 'c1', limit: '30' })).body).toEqual({ ok: true, events: [] })
  })

  it('sessions projects / chats / delete = `sessions list-projects|list-chats|delete`', async () => {
    const sessions = makeSessionStore(db)
    sessions.set({ alias: 'proj', provider: 'claude', chatId: 'c1', sessionId: 's1' })
    await sessions.flush()
    const projects = await get('GET /v1/sessions/projects')
    expect(projects.body).toMatchObject({ ok: true, projects: [{ alias: 'proj', session_id: 's1', summary: null, summary_updated_at: null }] })
    const chats = await get('GET /v1/sessions/chats')
    expect(chats.body).toMatchObject({ ok: true, chats: [{ chat_id: 'c1', session_count: 1 }] })
    expect((await post('POST /v1/sessions/delete', { alias: 'proj' })).body).toEqual({ ok: true, deleted: 'proj' })
    expect((await get('GET /v1/sessions/projects')).body).toEqual({ ok: true, projects: [] })
  })

  it('avatar info / set / remove = `avatar info|set|remove`;设置失败回 4xx(CLI 是非 0 退出)', async () => {
    expect((await get('GET /v1/avatar/info', { key: 'claude' })).body).toMatchObject({ ok: true, exists: false })
    const set = await post('POST /v1/avatar/set', { key: 'claude', base64: PNG })
    expect(set.status).toBe(200)
    expect(set.body).toMatchObject({ ok: true })
    const info = await get('GET /v1/avatar/info', { key: 'claude' })
    expect(info.body).toMatchObject({ ok: true, exists: true })
    expect(existsSync((info.body as { path: string }).path)).toBe(true)
    expect((await post('POST /v1/avatar/remove', { key: 'claude' })).body).toMatchObject({ ok: true })
    expect((await get('GET /v1/avatar/info', { key: 'claude' })).body).toMatchObject({ exists: false })
    const bad = await post('POST /v1/avatar/set', { key: 'claude', base64: 'bm90IGFuIGltYWdl' })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ ok: false, error: expect.stringContaining('not a supported image') })
  })

  it('dialogue:时间线 / 线索 / 搜索照 lib/dialogue;线索不存在回 404(CLI 是非 0 退出)', async () => {
    expect((await get('GET /v1/dialogue/timeline', { chat_id: 'c1', limit: '100' })).body).toMatchObject({ messages: [], hasMore: false })
    expect((await get('GET /v1/dialogue/threads', { chat_id: 'c1', facet: 'task' })).body).toMatchObject({ threads: [] })
    expect((await get('GET /v1/dialogue/search', { chat_id: 'c1', q: '睡觉' })).body).toMatchObject({ hits: [] })
    const missing = await get('GET /v1/dialogue/thread', { id: 'thr_nope' })
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ ok: false, error: 'thread not found: thr_nope' })
    expect((await post('POST /v1/dialogue/unlock', { passphrase: 'x' })).body).toMatchObject({ ok: false })
  })
})
