import { test, expect } from 'vitest'
import { openKnowledge } from './store'; import { makePersonApi } from './person'
import { makeFactsApi } from './facts'; import { rebuildGraphFromSource } from './graph-build'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'

test('personBrief assembles graph + facts + recent, resolved by name', () => {
  const s = openKnowledge(mkdtempSync(join(tmpdir(), 'kk-person-')))
  s.putContacts([{ username: 'wxid_a', display: '小A' }])
  s.putSourceMessages([
    { msg_key: 'Msg_a:1', conversation: 'wxid_a', sender: 'wxid_a', time: 10, type: '1', text: 'hi', server_id: '1', local_type: 1, is_group: false, kind: 'text' },
    { msg_key: 'Msg_a:2', conversation: 'wxid_a', sender: 'me', time: 20, type: '1', text: 'yo', server_id: '2', local_type: 1, is_group: false, kind: 'text' },
  ])
  rebuildGraphFromSource({ store: s, now: 100, ownerOverride: 'me' })   // so resolveName('小A') works
  const facts = makeFactsApi(s)
  const b = facts.nextBatch('wxid_a', 40) as any
  facts.record(b.batch_id, [{ kind: 'entity', predicate: 'is', value: 'friend', source_msg_keys: [] }], 1)
  const brief = makePersonApi(s).personBrief('小A', 12) as any
  expect(brief.resolved).toBe(true)
  expect(brief.wxid).toBe('wxid_a')
  expect(brief.recent_messages.map((m: any) => m.text)).toEqual(['yo', 'hi'])  // newest-first
  expect(brief.facts.by_kind.entity.length).toBe(1)
  s.close()
})

test('unresolved name returns resolved:false + candidates; empty sources degrade, no crash', () => {
  const s = openKnowledge(mkdtempSync(join(tmpdir(), 'kk-person2-')))
  const brief = makePersonApi(s).personBrief('不存在的人', 12) as any
  expect(brief.resolved).toBe(false)
  expect(Array.isArray(brief.candidates)).toBe(true)
  s.close()
})
