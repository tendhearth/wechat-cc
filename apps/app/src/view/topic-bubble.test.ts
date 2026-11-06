import { expect, it } from 'vitest'
import { appendTopicPage } from './topic-bubble'
import type { TopicDetailT } from '../backend/types'
const page = (revision = 'r1'): TopicDetailT => ({ topic: { id: 'topic', title: '备份', description: '', summary: '', bubbleState: 'closed', lastRecalledAt: null, lastOpenedByOwnerAt: null, activityRevision: 0, matterSummary: { waiting: 0, running: 0, total: 0 } }, revision, entries: [], matters: [{ id: 'a1', title: '备份', state: 'running', archivedAt: null }], messages: [], pages: { entries: { total: 0, nextCursor: null }, matters: { total: 2, nextCursor: 'next' }, messages: { total: 0, nextCursor: null } } })
it('pagination deduplicates stable ids, preserves other sections, and rejects changed revisions and identities', () => {
  const old = page(), next = page()
  next.matters.push({ id: 'a2', title: '检查', state: 'waiting', archivedAt: null })
  next.pages.matters.nextCursor = null
  const merged = appendTopicPage(old, next, 'matters')!
  expect(merged.matters.map(m => m.id)).toEqual(['a1', 'a2'])
  expect(merged.pages.matters.nextCursor).toBeNull()
  expect(merged.pages.entries).toEqual(old.pages.entries)
  expect(appendTopicPage(old, page('r2'), 'matters')).toBeNull()
  next.topic.id = 'other'; expect(appendTopicPage(old, next, 'matters')).toBeNull()
})
