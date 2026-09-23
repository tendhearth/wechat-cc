import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTestDb, type Db } from '../../lib/db'
import { isDerivedMemoryStale, readDerivedRevision } from '../../lib/memory-derived-state'
import { makeObservationsStore } from '../observations/store'
import { makeMilestonesStore } from '../milestones/store'
import { makeEventsStore } from '../events/store'
import { memoryReviewRoutes } from './routes-memory-review'
import type { InternalApiDeps, RouteTable } from './types'
import { createInternalApi } from './index'

describe('reviewed memory sources', () => {
  let stateDir: string, root: string, projectsRoot: string, db: Db, routes: RouteTable
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'source-review-'))
    root = join(stateDir, 'memory', 'owner')
    projectsRoot = join(stateDir, 'projects')
    mkdirSync(root, { recursive: true })
    db = openTestDb()
    routes = memoryReviewRoutes({ stateDir, daemonPid: 1, db, resolveAdminChatId: () => 'owner', memoryProjectsRoot: projectsRoot } as InternalApiDeps)
  })
  afterEach(() => { db.close(); rmSync(stateDir, { recursive: true, force: true }) })
  const get = (params: Record<string, string>) => routes['GET /v1/memory/source']!(new URLSearchParams({ chat_id: 'owner', ...params }), null)
  const review = (body: Record<string, unknown>) => routes['POST /v1/memory/source/review']!(new URLSearchParams(), { chat_id: 'owner', ...body })

  it('reads real note content and commits only the exact reviewed revision', async () => {
    writeFileSync(join(root, 'note.md'), 'old belief')
    writeFileSync(join(root, '_overview.md'), 'preserved artifact')
    const read = await get({ kind: 'memory', path: 'note.md' })
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ ok: true, content: 'old belief', editable: true, canMarkOutdated: false, needsRefresh: false })
    const revision = (read.body as any).revision
    expect(revision).toMatch(/^[a-f0-9]{64}$/)
    const response = await review({ kind: 'memory', path: 'note.md', revision, action: 'correct', content: 'corrected fact' })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: true, needsRefresh: true })
    expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('corrected fact')
    expect(readFileSync(join(root, '_overview.md'), 'utf8')).toBe('preserved artifact')
    expect(isDerivedMemoryStale(root, 'overview')).toBe(true)
    expect(isDerivedMemoryStale(root, 'profile')).toBe(true)
    expect((await review({ kind: 'memory', path: 'note.md', revision, action: 'correct', content: 'overwrite' })).status).toBe(409)
    expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('corrected fact')
  })

  it('rejects missing, mismatched and externally modified note revisions without invalidating', async () => {
    const initial = readDerivedRevision(root)
    expect((await review({ kind: 'memory', path: 'missing.md', revision: 'x', action: 'correct', content: 'x' })).status).toBe(404)
    writeFileSync(join(root, 'note.md'), 'before')
    const read = await get({ kind: 'memory', path: 'note.md' })
    writeFileSync(join(root, 'note.md'), 'external edit')
    expect((await review({ kind: 'memory', path: 'note.md', revision: (read.body as any).revision, action: 'correct', content: 'x' })).status).toBe(409)
    expect((await review({ kind: 'memory', path: 'note.md', action: 'correct', content: 'x' })).status).toBe(409)
    expect(readDerivedRevision(root)).toBe(initial)
  })

  it('archives the old observation, appends its correction, and records the audit together', async () => {
    const store = makeObservationsStore(db, 'owner')
    const id = await store.append({ body: 'old observation', tone: 'curious' })
    const read = await get({ kind: 'observation', id })
    const result = await review({ kind: 'observation', id, revision: (read.body as any).revision, action: 'correct', content: 'corrected observation' })
    expect(result.status).toBe(200)
    const active = await store.listActive()
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ body: 'corrected observation', tone: 'curious', archived: false })
    expect(active[0]!.id).not.toBe(id)
    expect(await store.listArchived()).toMatchObject([{ id, body: 'old observation', archived: true }])
    expect(await makeEventsStore(db, 'owner').list()).toMatchObject([{ kind: 'observation_written', observation_id: active[0]!.id }])
    expect((await get({ kind: 'observation', id })).body).toMatchObject({ content: 'old observation', archived: true, editable: false, canMarkOutdated: false })
    expect((await review({ kind: 'observation', id, revision: (read.body as any).revision, action: 'outdated' })).status).toBe(409)
  })

  it('marks only an existing observation in the selected chat outdated', async () => {
    const owner = makeObservationsStore(db, 'owner')
    const id = await owner.append({ body: 'retired observation' })
    const other = await makeObservationsStore(db, 'guest').append({ body: 'private guest observation' })
    expect((await get({ kind: 'observation', id: other })).status).toBe(404)
    expect((await review({ kind: 'observation', id: other, revision: 'x', action: 'outdated' })).status).toBe(404)
    const read = await get({ kind: 'observation', id })
    expect((await review({ kind: 'observation', id, revision: (read.body as any).revision, action: 'outdated' })).status).toBe(200)
    expect(await owner.listActive()).toEqual([])
    expect(await owner.listArchived()).toHaveLength(1)
  })

  it('rolls back the observation replacement if its audit cannot be recorded', async () => {
    const store = makeObservationsStore(db, 'owner')
    const id = await store.append({ body: 'original' })
    const read = await get({ kind: 'observation', id })
    db.exec("CREATE TRIGGER reject_review BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'audit rejected'); END")
    const result = await review({ kind: 'observation', id, revision: (read.body as any).revision, action: 'correct', content: 'replacement' })
    expect(result.status).toBe(500)
    expect(await store.listActive()).toMatchObject([{ id, body: 'original' }])
    expect(await store.listArchived()).toEqual([])
    expect(isDerivedMemoryStale(root, 'overview')).toBe(true)
  })

  it('permits only one of two competing reviews of the same observation', async () => {
    const store = makeObservationsStore(db, 'owner')
    const id = await store.append({ body: 'original' })
    const read = await get({ kind: 'observation', id })
    const body = { kind: 'observation', id, revision: (read.body as any).revision, action: 'correct' }
    const replies = await Promise.all([review({ ...body, content: 'first' }), review({ ...body, content: 'second' })])
    expect(replies.map(r => r.status)).toEqual([200, 409])
    expect(await store.listActive()).toMatchObject([{ body: 'first' }])
    expect(await store.listArchived()).toHaveLength(1)
  })

  it('serves the registered endpoints through the actual local authenticated HTTP dispatcher', async () => {
    writeFileSync(join(root, 'note.md'), 'original')
    const api = createInternalApi({ stateDir, daemonPid: 1, db, resolveAdminChatId: () => 'owner' })
    const { port, tokenFilePath, operatorTokenFilePath } = await api.start()
    try {
      const url = `http://127.0.0.1:${port}/v1/memory/source?chat_id=owner&kind=memory&path=note.md`
      expect((await fetch(url)).status).toBe(401)
      const headers = { Authorization: `Bearer ${readFileSync(tokenFilePath, 'utf8').trim()}` }
      expect((await fetch(url, { headers: { Authorization: `Bearer ${readFileSync(operatorTokenFilePath, 'utf8').trim()}` } })).status).toBe(403)
      const read = await fetch(url, { headers })
      expect(read.status).toBe(200)
      const source = await read.json() as { revision: string }
      const result = await fetch(`http://127.0.0.1:${port}/v1/memory/source/review`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: 'owner', kind: 'memory', path: 'note.md', revision: source.revision, action: 'correct', content: 'reviewed' }),
      })
      expect(result.status).toBe(200)
      expect(await result.json()).toMatchObject({ ok: true, needsRefresh: true })
      expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('reviewed')
    } finally { await api.stop() }
  })

  it('exposes milestones and discovered project notes as read-only original sources', async () => {
    await makeMilestonesStore(db, 'owner').fire({ id: 'ms_one', body: 'milestone original' })
    expect((await get({ kind: 'milestone', id: 'ms_one' })).body).toMatchObject({ content: 'milestone original', editable: false, canMarkOutdated: false })
    const project = '-Users-owner-project'
    mkdirSync(join(projectsRoot, project, 'memory'), { recursive: true })
    writeFileSync(join(projectsRoot, project, 'memory', 'MEMORY.md'), 'project original')
    expect((await get({ kind: 'project', project, path: 'MEMORY.md' })).body).toMatchObject({ content: 'project original', editable: false, canMarkOutdated: false })
    expect((await get({ kind: 'project', project, path: 'MEMORY.md', chat_id: 'guest' })).status).toBe(404)
    expect((await review({ kind: 'project', project, path: 'MEMORY.md', action: 'correct', revision: 'x', content: 'bad' })).status).toBe(403)
    expect((await review({ kind: 'milestone', id: 'ms_one', action: 'correct', revision: 'x', content: 'bad' })).status).toBe(403)
  })

  it.each(['../other.md', 'a/../note.md', '/note.md', 'C:/note.md', 'C:\\note.md', 'a\\..\\note.md', 'note.txt', 'a\0.md'])('rejects unsafe source path %s', async path => {
    expect((await get({ kind: 'memory', path })).status).toBe(400)
  })

  it('rejects chat traversal, source symlink escapes, and cross-chat root aliases', async () => {
    expect((await get({ kind: 'memory', path: 'note.md', chat_id: '..' })).status).toBe(400)
    const other = join(stateDir, 'memory', 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'note.md'), 'other chat secret')
    symlinkSync(join(other, 'note.md'), join(root, 'link.md'))
    expect((await get({ kind: 'memory', path: 'link.md' })).status).toBe(400)
    symlinkSync(other, join(stateDir, 'memory', 'alias'))
    expect((await get({ kind: 'memory', path: 'note.md', chat_id: 'alias' })).status).toBe(400)
  })

  it('scopes session callers and rejects empty or oversized corrections', async () => {
    writeFileSync(join(root, 'note.md'), 'content')
    const read = await get({ kind: 'memory', path: 'note.md' })
    const body = { chat_id: 'owner', kind: 'memory', path: 'note.md', revision: (read.body as any).revision, action: 'correct' }
    const caller = { tier: 'trusted', origin: 'session', chatId: 'other' } as const
    expect((await routes['GET /v1/memory/source']!(new URLSearchParams({ chat_id: 'owner', kind: 'memory', path: 'note.md' }), null, caller)).status).toBe(403)
    expect((await routes['POST /v1/memory/source/review']!(new URLSearchParams(), { ...body, content: 'x' }, caller)).status).toBe(403)
    expect((await review({ ...body, content: ' ' })).status).toBe(400)
    expect((await review({ ...body, kind: ['observation'], id: 'bad', content: 'x' })).status).toBe(400)
    expect((await review({ ...body, content: 'x'.repeat(100 * 1024 + 1) })).status).toBe(400)
    expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('content')
    expect(existsSync(join(root, '.derived-state.json'))).toBe(false)
  })
})
