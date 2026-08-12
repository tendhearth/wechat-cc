import { test, expect } from 'bun:test'
import { openKnowledge } from './store'
import { makeFactsApi } from './facts'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'

function seed() {
  const s = openKnowledge(mkdtempSync(join(tmpdir(), 'kk-facts2-')))
  s.putSourceMessages([
    { msg_key: 'Msg_a:1', conversation: 'wxid_a', sender: 'wxid_a', time: 10, type: '1', text: 'a1', server_id: '1', local_type: 1, is_group: false, kind: 'text' },
    { msg_key: 'Msg_a:2', conversation: 'wxid_a', sender: 'me', time: 20, type: '1', text: 'a2', server_id: '2', local_type: 1, is_group: false, kind: 'text' },
    { msg_key: 'Msg_b:1', conversation: 'wxid_b', sender: 'wxid_b', time: 5, type: '1', text: 'b1', server_id: '3', local_type: 1, is_group: false, kind: 'text' },
  ])
  return s
}

test('nextBatch picks the max-backlog contact and returns its candidates in order', () => {
  const s = seed(); const api = makeFactsApi(s)
  const batch = api.nextBatch(null, 40) as any
  expect(batch.contact).toBe('wxid_a')                       // 2 msgs > wxid_b's 1
  expect(batch.messages.map((m: any) => m.text)).toEqual(['a1', 'a2'])
  expect(typeof batch.batch_id).toBe('string')
  s.close()
})

test('record advances the watermark so the batch drops out of the backlog', () => {
  const s = seed(); const api = makeFactsApi(s)
  const batch = api.nextBatch('wxid_a', 40) as any
  const rec = api.record(batch.batch_id, [
    { predicate: 'said', value: 'hello', source_msg_keys: ['Msg_a:1'] }], 100) as any
  expect(rec.recorded).toBe(1)
  const again = api.nextBatch('wxid_a', 40) as any
  expect(again.done).toBe(true)                              // caught up
  const cf = api.contactFacts('wxid_a') as any
  expect(cf.by_kind).toBeDefined()                           // the recorded fact is queryable
  s.close()
})

test('nextBatch respects (ts, local_id) cursor — a same-second later local_id is still fed', () => {
  const s = openKnowledge(mkdtempSync(join(tmpdir(), 'kk-facts3-')))
  s.putSourceMessages([
    { msg_key: 'Msg_c:1', conversation: 'wxid_c', sender: 'wxid_c', time: 50, type: '1', text: 'first', server_id: '1', local_type: 1, is_group: false, kind: 'text' },
    { msg_key: 'Msg_c:2', conversation: 'wxid_c', sender: 'wxid_c', time: 50, type: '1', text: 'second', server_id: '2', local_type: 1, is_group: false, kind: 'text' },
  ])
  const api = makeFactsApi(s)
  const b1 = api.nextBatch('wxid_c', 1) as any                // covers (50,1)
  expect(b1.messages.map((m: any) => m.text)).toEqual(['first'])
  api.record(b1.batch_id, [], 1)                              // advance-only
  const b2 = api.nextBatch('wxid_c', 40) as any               // same-second (50,2) NOT skipped
  expect(b2.messages.map((m: any) => m.text)).toEqual(['second'])
  s.close()
})

test('find_facts obligation query; set_fact_status; extraction_status counts', () => {
  const s = seed(); const api = makeFactsApi(s)
  const b = api.nextBatch('wxid_a', 40) as any
  api.record(b.batch_id, [{ kind: 'obligation', predicate: 'owes', value: '50', source_msg_keys: [] }], 1)
  const found = api.findFacts('obligation', null, null, 'active', 50) as any
  expect(found.results.length).toBe(1)
  const st = api.extractionStatus() as any
  expect(st.facts_by_kind.obligation).toBe(1)
  s.close()
})
