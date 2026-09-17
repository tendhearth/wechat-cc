import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from './store'
describe('review marks', () => {
  it('同一快照同一文件只保留最新标记;写后任务 version 递增', () => {
    const db = openTestDb(), store = makeWorkbenchStore(db)
    const t = store.create({ title: 't', path: '/p', providerId: 'codex', ownerChatId: 'o' })
    const v = store.version(t.id)
    const a = store.reviewMarks.set({ taskId: t.id, artifactSha256: 'a'.repeat(64), path: 'src/x.ts', afterSha256: 'b'.repeat(64), mark: 'accepted', comment: '' })
    expect(a.mark).toBe('accepted'); expect(store.version(t.id)).toBe(v + 1)
    store.reviewMarks.set({ taskId: t.id, artifactSha256: 'a'.repeat(64), path: 'src/x.ts', afterSha256: 'b'.repeat(64), mark: 'returned', comment: '改一下' })
    const list = store.reviewMarks.list(t.id)
    expect(list).toHaveLength(1); expect(list[0]!.mark).toBe('returned'); expect(list[0]!.comment).toBe('改一下')
    expect(store.version(t.id)).toBe(v + 2)
  })
  it('按任务隔离;afterSha256 可为 null', () => {
    const db = openTestDb(), store = makeWorkbenchStore(db)
    const t1 = store.create({ title: 't', path: '/p', providerId: 'codex', ownerChatId: 'o' }), t2 = store.create({ title: 'u', path: '/q', providerId: 'codex', ownerChatId: 'o' })
    store.reviewMarks.set({ taskId: t1.id, artifactSha256: 'a'.repeat(64), path: 'gone.ts', afterSha256: null, mark: 'accepted', comment: '' })
    expect(store.reviewMarks.list(t2.id)).toEqual([]); expect(store.reviewMarks.list(t1.id)[0]!.afterSha256).toBeNull()
  })
})
