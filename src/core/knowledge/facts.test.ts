import { test, expect } from 'vitest'
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
  const id = found.results[0].id
  const setRes = api.setFactStatus(id, 'resolved', 2) as any
  expect(setRes).toEqual({ ok: true })
  expect((api.findFacts('obligation', null, null, 'active', 50) as any).results.length).toBe(0)
  expect((api.findFacts('obligation', null, null, 'resolved', 50) as any).results.length).toBe(1)
  s.close()
})

test('record reports same-predicate conflicts without auto-superseding', () => {
  const s = seed(); const api = makeFactsApi(s)
  const b1 = api.nextBatch('wxid_a', 1) as any
  api.record(b1.batch_id, [{ kind: 'attribute', predicate: '住在', value: '北京', source_msg_keys: [] }], 1000)
  const b2 = api.nextBatch('wxid_a', 40) as any
  const res = api.record(b2.batch_id, [{ kind: 'attribute', predicate: '住在', value: '上海', source_msg_keys: [] }], 2000) as any
  expect(res.conflicts).toHaveLength(1)
  expect(res.conflicts[0].predicate).toBe('住在')
  expect(res.conflicts[0].value).toBe('上海')
  expect(res.conflicts[0].against.map((a: any) => a.value)).toEqual(['北京'])
  // both still active — resolution is the judge's job, not record's
  expect(s.factsForContact('wxid_a', 'active')).toHaveLength(2)
  s.close()
})

test('record with no same-predicate clash reports empty conflicts', () => {
  const s = seed(); const api = makeFactsApi(s)
  const b = api.nextBatch('wxid_a', 40) as any
  const res = api.record(b.batch_id, [
    { kind: 'attribute', predicate: '喜欢', value: '茶', source_msg_keys: [] },
    { kind: 'attribute', predicate: '住在', value: '北京', source_msg_keys: [] },
  ], 1000) as any
  expect(res.conflicts).toEqual([])
  s.close()
})

test('supersede applies valid pairs and skips invalid ones', () => {
  const s = seed(); const api = makeFactsApi(s)
  const beijing = s.upsertFact({ contact: 'wxid_a', kind: 'attribute', predicate: '住在', value: '北京' }, 1000)
  const shanghai = s.upsertFact({ contact: 'wxid_a', kind: 'attribute', predicate: '住在', value: '上海' }, 2000)
  const tea = s.upsertFact({ contact: 'wxid_a', kind: 'attribute', predicate: '喜欢', value: '茶' }, 1000)
  const res = api.supersede([
    { supersede: beijing.id, by: shanghai.id },     // valid
    { supersede: 99999, by: shanghai.id },          // unknown id — skipped
    { supersede: tea.id, by: shanghai.id },         // predicate mismatch — skipped
    { supersede: shanghai.id, by: shanghai.id },    // self-pair — skipped
    null as never,                                  // garbage element — skipped
  ], 3000) as any
  expect(res).toEqual({ superseded: 1 })
  expect(s.factsForContact('wxid_a', 'active').map((f) => f.value).sort()).toEqual(['上海', '茶'])
  expect(s.factById(beijing.id)!.superseded_by).toBe(shanghai.id)
  s.close()
})

test('settleObligations resolves only this contact\'s active obligations', () => {
  const s = seed(); const api = makeFactsApi(s)
  const mine = s.upsertFact({ contact: 'wxid_a', kind: 'obligation', predicate: 'lend_book', value: '还书' }, 1000)
  const theirs = s.upsertFact({ contact: 'wxid_b', kind: 'obligation', predicate: 'x', value: 'y' }, 1000)
  const attr = s.upsertFact({ contact: 'wxid_a', kind: 'attribute', predicate: 'city', value: '上海' }, 1000)
  const done = s.upsertFact({ contact: 'wxid_a', kind: 'obligation', predicate: 'z', value: 'w' }, 1000)
  s.setFactStatusById(done.id, 'resolved', 1500)
  const res = api.settleObligations('wxid_a', [
    mine.id,      // valid
    theirs.id,    // other contact — skipped
    attr.id,      // not an obligation — skipped
    done.id,      // already resolved — skipped
    99999,        // unknown id — skipped
  ], 3000) as { settled: number }
  expect(res).toEqual({ settled: 1 })
  expect(s.factById(mine.id)!.status).toBe('resolved')
  expect(s.factById(theirs.id)!.status).toBe('active')
  expect(s.factById(attr.id)!.status).toBe('active')
  s.close()
})

test('mergeObligations applies same-contact obligation pairs, skips everything else', () => {
  const s = seed(); const api = makeFactsApi(s)
  const a = s.upsertFact({ contact: 'wxid_a', kind: 'obligation', predicate: 'help_vps', value: '帮忙配 VPS' }, 1000)
  const b = s.upsertFact({ contact: 'wxid_a', kind: 'obligation', predicate: 'setup_tailscale', value: '帮忙配 Tailscale 和 VPS' }, 2000)
  const other = s.upsertFact({ contact: 'wxid_b', kind: 'obligation', predicate: 'x', value: 'y' }, 1000)
  const attr = s.upsertFact({ contact: 'wxid_a', kind: 'attribute', predicate: 'city', value: '上海' }, 1000)
  const res = api.mergeObligations([
    { supersede: a.id, by: b.id },        // valid cross-predicate obligation pair
    { supersede: other.id, by: b.id },    // different contact — skipped
    { supersede: attr.id, by: b.id },     // not an obligation — skipped
    { supersede: b.id, by: b.id },        // self — skipped
  ], 3000) as { merged: number }
  expect(res).toEqual({ merged: 1 })
  expect(s.factById(a.id)!.status).toBe('superseded')
  expect(s.factById(a.id)!.superseded_by).toBe(b.id)
  expect(s.factById(other.id)!.status).toBe('active')
  expect(s.factById(attr.id)!.status).toBe('active')
})
