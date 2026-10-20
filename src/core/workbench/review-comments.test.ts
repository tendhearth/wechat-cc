import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from './store'

const S = 'a'.repeat(64), H = 'h'.repeat(64)
function setup() {
  const db = openTestDb(), store = makeWorkbenchStore(db)
  const t = store.create({ title: 't', path: '/p', providerId: 'codex', ownerChatId: 'o' })
  const base = { taskId: t.id, artifactId: 'art', artifactSha256: S, path: 'src/a.ts', hunkIndex: 1, hunkSha256: H, rowStart: 2, rowEnd: 3, side: 'new' as const, lineStart: 41, lineEnd: 42, quote: '+x\n+y' }
  return { db, store, t, base }
}

describe('review comments (v83)', () => {
  it('create is idempotent on the client id; different content is a conflict; writes bump the task', () => {
    const { store, t, base } = setup()
    const v = store.version(t.id)
    const c = store.reviewComments.create({ ...base, id: 'c1', body: 'a 可能是 null' })
    expect(c).toMatchObject({ id: 'c1', state: 'draft', rowStart: 2, side: 'new', lineStart: 41, sentAt: null })
    expect(store.version(t.id)).toBe(v + 1)
    expect(store.reviewComments.create({ ...base, id: 'c1', body: 'a 可能是 null' })).toEqual(c)
    expect(store.version(t.id)).toBe(v + 1)
    expect(() => store.reviewComments.create({ ...base, id: 'c1', body: '别的话' })).toThrow('review_comment_conflict')
    expect(() => store.reviewComments.create({ ...base, id: 'c1', rowStart: 0, body: 'a 可能是 null' })).toThrow('review_comment_conflict')
    // 整块评论:行留空
    const whole = store.reviewComments.create({ ...base, id: 'c2', rowStart: undefined, rowEnd: undefined, body: '整块' })
    expect(whole).toMatchObject({ rowStart: null, rowEnd: null })
    expect(store.reviewComments.create({ ...base, id: 'c2', rowStart: undefined, rowEnd: undefined, body: '整块' }).id).toBe('c2')
    expect(store.reviewComments.countDrafts(t.id)).toBe(2)
  })

  it('a client id used by another task is a conflict, and other tasks cannot touch it', () => {
    const { store, base } = setup()
    const u = store.create({ title: 'u', path: '/q', providerId: 'codex', ownerChatId: 'o' })
    store.reviewComments.create({ ...base, id: 'c1', body: 'x' })
    expect(() => store.reviewComments.create({ ...base, taskId: u.id, id: 'c1', body: 'x' })).toThrow('review_comment_conflict')
    expect(() => store.reviewComments.edit(u.id, 'c1', 'y')).toThrow('review_comment_not_found')
    expect(() => store.reviewComments.remove(u.id, 'c1')).toThrow('review_comment_not_found')
    expect(store.reviewComments.markSent(u.id, ['c1'], 'r')).toBe(0)
    expect(store.reviewComments.list(u.id)).toEqual([])
  })

  it('only drafts can be edited or removed; markSent touches only drafts', () => {
    const { store, t, base } = setup()
    store.reviewComments.create({ ...base, id: 'c1', body: 'one', createdAt: 1 })
    store.reviewComments.create({ ...base, id: 'c2', body: 'two', createdAt: 2 })
    store.reviewComments.create({ ...base, id: 'c3', body: 'three', createdAt: 3 })
    expect(store.reviewComments.edit(t.id, 'c1', 'ONE').body).toBe('ONE')
    const v = store.version(t.id)
    expect(store.reviewComments.markSent(t.id, ['c1', 'c2'], 'req-1', 100)).toBe(2)
    expect(store.version(t.id)).toBe(v + 1)
    expect(store.reviewComments.markSent(t.id, ['c1', 'c3'], 'req-2', 200)).toBe(1)
    const [c1, c2, c3] = store.reviewComments.list(t.id)
    expect(c1).toMatchObject({ state: 'sent', sentRequestId: 'req-1', sentAt: 100, body: 'ONE' })
    expect(c2).toMatchObject({ state: 'sent', sentRequestId: 'req-1' })
    expect(c3).toMatchObject({ state: 'sent', sentRequestId: 'req-2', sentAt: 200 })
    expect(() => store.reviewComments.edit(t.id, 'c1', 'x')).toThrow('review_comment_sent')
    expect(() => store.reviewComments.remove(t.id, 'c2')).toThrow('review_comment_sent')
    expect(() => store.reviewComments.edit(t.id, 'nope', 'x')).toThrow('review_comment_not_found')
    expect(store.reviewComments.countDrafts(t.id)).toBe(0)
    // 已发出的重试同一条照样回原行
    expect(store.reviewComments.create({ ...base, id: 'c1', body: 'ONE' }).state).toBe('sent')
    expect(store.reviewComments.markSent(t.id, [], 'r')).toBe(0)
  })

  it('remove deletes a draft', () => {
    const { store, t, base } = setup()
    store.reviewComments.create({ ...base, id: 'c1', body: 'x' })
    store.reviewComments.remove(t.id, 'c1')
    expect(store.reviewComments.list(t.id)).toEqual([])
    expect(() => store.reviewComments.remove(t.id, 'c1')).toThrow('review_comment_not_found')
  })

  it('hunk log: set overwrites per hunk and resets notified; markNotified once', () => {
    const { store, t } = setup()
    const key = { artifactSha256: S, path: 'src/a.ts', hunkIndex: 0 }
    const v = store.version(t.id)
    store.reviewHunks.set({ taskId: t.id, ...key, hunkSha256: H, state: 'reverted', createdAt: 10 })
    expect(store.version(t.id)).toBe(v + 1)
    expect(store.reviewHunks.markNotified(t.id, [key], 20)).toBe(1)
    expect(store.reviewHunks.markNotified(t.id, [key], 30)).toBe(0)
    expect(store.reviewHunks.list(t.id)).toEqual([{ taskId: t.id, ...key, hunkSha256: H, state: 'reverted', notifiedAt: 20, createdAt: 10 }])
    store.reviewHunks.set({ taskId: t.id, ...key, hunkSha256: H, state: 'restored', createdAt: 40 })
    expect(store.reviewHunks.list(t.id)).toEqual([{ taskId: t.id, ...key, hunkSha256: H, state: 'restored', notifiedAt: null, createdAt: 40 }])
  })

  it('deleting the task cascades both tables', () => {
    const { db, store, t, base } = setup()
    store.reviewComments.create({ ...base, id: 'c1', body: 'x' })
    store.reviewHunks.set({ taskId: t.id, artifactSha256: S, path: 'src/a.ts', hunkIndex: 0, hunkSha256: H, state: 'reverted' })
    db.query('DELETE FROM workbench_tasks WHERE id=?').run(t.id)
    expect(db.query('SELECT * FROM workbench_review_comments').all()).toEqual([])
    expect(db.query('SELECT * FROM workbench_review_hunks').all()).toEqual([])
  })
})
