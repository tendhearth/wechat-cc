import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTestDb, type Db } from '../../lib/db'
import { parseMemoryDoc } from '../../features/memory/curated-doc'
import { parseOwnerDoc } from '../../lib/memory-owner'
import { factsFromMemoryDoc, factsFromOwnerDoc, type NewMemoryFact } from '../../domain/memory/facts'
import { renderMemoryForPrompt, renderMemoryMd, renderOwnerForPrompt, renderOwnerMd } from '../../domain/memory/render'
import { makeMemoryFactsStore } from './memory-facts'
import type { MemoryFactsStore } from '../../ports/memory-facts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-support', 'fixtures', 'memory')
const STAMP = '2026-10-25T03:00:00.000Z'
const golden = (rel: string) => readFileSync(join(FIXTURES, 'golden', rel), 'utf8')
const fixture = (rel: string) => readFileSync(join(FIXTURES, 'chats', rel), 'utf8')
const CHAT = 'o9fixture-owner@im.wechat'
const by = { actor: 'import' as const, ts: 1_761_400_000_000 }

let db: Db
let store: MemoryFactsStore
beforeEach(() => { db = openTestDb(); store = makeMemoryFactsStore(db) })
afterEach(() => db.close())

const tombstone = (id: string, text: string): NewMemoryFact => ({ chatId: CHAT, key: `c:${id}`, doc: 'owner', subject: 'owner', text, status: 'retracted', source: 'legacy_correction' })

describe('memory-facts store', () => {
  it('fixture → table → render is still byte-equal to the G0 golden (owner chat)', () => {
    store.insert([tombstone('3fa9c1', '年糕是狸花猫'), tombstone('77aa01', '周二晚上固定打羽毛球')], by)
    store.insert(factsFromMemoryDoc(CHAT, parseMemoryDoc(fixture('owner/memory.md')), 'import'), by)
    store.insert(factsFromOwnerDoc(CHAT, parseOwnerDoc(fixture('owner/owner.md'))), by)
    const rows = store.list(CHAT)
    expect(renderMemoryMd(rows, STAMP)).toBe(golden('owner/memory.md'))
    expect(renderOwnerMd(rows)).toBe(golden('owner/owner.md'))
    expect(renderMemoryForPrompt(rows)).toBe(golden('owner/prompt-curated.txt'))
    expect(renderOwnerForPrompt(rows)).toBe(golden('owner/prompt-owner.txt'))
    const replaced = store.byKey(CHAT, 'o:k7x9q2')!
    expect(replaced.replacesKey).toBe('c:3fa9c1')
    expect(replaced.replaces).toBe(store.byKey(CHAT, 'c:3fa9c1')!.id)
    expect(replaced.scope).toBe('owner_only')
  })

  it('every inserted row gets one added event; the revision is the chat\'s max seq and never goes backwards', () => {
    expect(store.revision(CHAT)).toBe(0)
    const [a, b] = store.insert([
      { chatId: CHAT, key: 'm:aaaa', doc: 'memory', subject: 'owner', section: '偏好', text: '只喝美式', status: 'active', source: 'nightly', seenAt: '2026-10-26' },
      { chatId: CHAT, key: 'm:bbbb', doc: 'memory', subject: 'owner', section: '近况', ord: 1, text: '在发版', status: 'active', source: 'nightly' },
    ], { actor: 'nightly', ts: 5, note: '整理' })
    store.insert([{ chatId: 'other', key: 'm:aaaa', doc: 'memory', subject: 'owner', text: '别的对话', status: 'active', source: 'nightly' }], by)
    const ev = store.events(CHAT)
    expect(ev.map(e => [e.factId, e.action, e.actor, e.ts, e.note])).toEqual([[a!.id, 'added', 'nightly', 5, '整理'], [b!.id, 'added', 'nightly', 5, '整理']])
    expect(store.revision(CHAT)).toBe(ev[1]!.seq)
    expect(store.revision('other')).toBeGreaterThan(store.revision(CHAT))
    expect(store.events(CHAT, ev[0]!.seq).map(e => e.factId)).toEqual([b!.id])
    expect(a).toMatchObject({ chatId: CHAT, key: 'm:aaaa', section: '偏好', ord: 0, scope: 'chat', seenAt: '2026-10-26', createdAt: 5, updatedAt: 5, replacesKey: null })
  })

  it('a batch is all-or-nothing: a duplicate key or a dangling replacesKey inserts nothing', () => {
    const ok: NewMemoryFact = { chatId: CHAT, key: 'm:aaaa', doc: 'memory', subject: 'owner', section: '偏好', text: 'x', status: 'active', source: 'nightly' }
    expect(() => store.insert([ok, { ...ok, text: 'dup' }], by)).toThrow()
    expect(() => store.insert([{ ...ok, key: 'o:zz01', doc: 'owner', replacesKey: 'c:missing' }], by)).toThrow(/not in the table/)
    expect(store.list(CHAT)).toEqual([])
    expect(store.revision(CHAT)).toBe(0)
  })

  it('list filters by doc and status', () => {
    store.insert([tombstone('c1c1', '旧话')], by)
    store.insert(factsFromMemoryDoc(CHAT, parseMemoryDoc(fixture('owner/memory.md')), 'import'), by)
    expect(store.list(CHAT, { doc: 'owner' }).map(r => r.key)).toEqual(['c:c1c1'])
    expect(store.list(CHAT, { statuses: ['retracted'] }).map(r => r.key)).toEqual(['c:c1c1'])
    expect(store.list(CHAT, { doc: 'memory', statuses: ['active'] }).length).toBe(store.list(CHAT).length - 1)
  })

  it('derived cache: put replaces by (chat, kind); stale is input_rev < revision', () => {
    expect(store.getDerived(CHAT, 'overview')).toBeNull()
    store.putDerived({ chatId: CHAT, kind: 'overview', body: 'v1', inputRev: 0, generatedAt: 1 })
    store.insert([{ chatId: CHAT, key: 'm:aaaa', doc: 'memory', subject: 'owner', text: 'x', status: 'active', source: 'nightly' }], by)
    const d = store.getDerived(CHAT, 'overview')!
    expect(d.inputRev < store.revision(CHAT)).toBe(true)
    store.putDerived({ ...d, body: 'v2', inputRev: store.revision(CHAT), generatedAt: 2 })
    expect(store.getDerived(CHAT, 'overview')).toEqual({ chatId: CHAT, kind: 'overview', body: 'v2', inputRev: store.revision(CHAT), generatedAt: 2 })
  })
})

describe('retract / restore / resolve / supersede (G5)', () => {
  const by2 = { actor: 'owner' as const, ts: 9 }
  const row = (key: string, text: string): NewMemoryFact => ({ chatId: CHAT, key, doc: key.startsWith('o:') ? 'owner' : 'memory', subject: 'owner', section: '偏好', text, status: 'active', source: 'nightly' })
  it('retract by text hits every active entry / owner word with that sentence and always leaves a tombstone', () => {
    store.insert([row('m:aa01', '只喝美式不加糖'), row('o:bb01', '只喝美式不加糖'), row('m:aa02', '别的')], by)
    const r = store.retract(CHAT, { text: ' 只喝美式  不加糖' .replace('  ', '') }, { verdict: 'wrong', section: '偏好', day: '2026-10-26', by: by2 })
    expect(r.targets.sort()).toEqual(['m:aa01', 'o:bb01'])
    expect(store.byKey(CHAT, r.key)).toMatchObject({ status: 'retracted', section: '偏好', seenAt: '2026-10-26' })
    const none = store.retract(CHAT, { text: '总览上一句没编号的话' }, { verdict: 'delete', section: '总览', day: '2026-10-26', by: by2 })
    expect(none.targets).toEqual([])
    expect(store.byKey(CHAT, none.key)!.text).toBe('总览上一句没编号的话')
  })
  it('restore brings back exactly what that retraction took, once', () => {
    store.insert([row('m:aa01', '只喝美式不加糖')], by)
    const r = store.retract(CHAT, { key: 'm:aa01' }, { verdict: 'outdated', section: '偏好', day: '2026-10-26', by: by2 })
    expect(store.byKey(CHAT, 'm:aa01')!.status).toBe('outdated')
    expect(store.restore(CHAT, r.key, by2)).toEqual({ restored: ['m:aa01'] })
    expect(store.byKey(CHAT, 'm:aa01')!.status).toBe('active')
    expect(store.restore(CHAT, r.key, by2)).toBeNull()
    expect(store.restore(CHAT, 'm:aa01', by2)).toBeNull()
  })
  it('resolve and supersede are not retractions: no tombstone', () => {
    store.insert([row('k:1', '答应帮小林看简历'), row('k:2', '答应帮小林看简历(重复)'), row('k:3', '保留的那条')], by)
    expect(store.resolve(CHAT, 'k:1', by2)).toBe(true)
    expect(store.supersede(CHAT, 'k:2', 'k:3', by2)).toBe(true)
    expect(store.byKey(CHAT, 'k:1')!.status).toBe('resolved')
    expect(store.byKey(CHAT, 'k:2')).toMatchObject({ status: 'superseded', supersededBy: store.byKey(CHAT, 'k:3')!.id })
    expect(store.tombstones(CHAT)).toEqual([])
    expect(store.resolve(CHAT, 'k:1', by2)).toBe(false)
  })
})

describe('retracting a key that is not in the table (数据安全评审第 3 条)', () => {
  const by2 = { actor: 'owner' as const, ts: 9 }
  it('the tombstone carries the caller\'s sentence, never the key, so it enters the retracted list', () => {
    const r = store.retract(CHAT, { key: 'm:feed99' }, { verdict: 'wrong', section: '偏好', day: '2026-10-26', text: '只喝美式不加糖', by: by2 })
    expect(r.targets).toEqual([])
    expect(store.byKey(CHAT, r.key)!.text).toBe('只喝美式不加糖')
    expect(store.tombstones(CHAT).map(t => t.text)).toEqual(['只喝美式不加糖'])
  })
  it('the caller\'s text wins over the row\'s even when the row exists', () => {
    store.insert([{ chatId: CHAT, key: 'm:aa01', doc: 'memory', subject: 'owner', section: '偏好', text: '表里的写法', status: 'active', source: 'nightly' }], by)
    const r = store.retract(CHAT, { key: 'm:aa01' }, { verdict: 'wrong', section: '偏好', day: '2026-10-26', text: '主人看到的那句', by: by2 })
    expect(store.byKey(CHAT, r.key)!.text).toBe('主人看到的那句')
    expect(store.byKey(CHAT, 'm:aa01')!.status).toBe('retracted')
  })
  it('no sentence at all ⇒ refuses instead of writing the key as the text', () => {
    expect(() => store.retract(CHAT, { key: 'm:nope' }, { verdict: 'wrong', section: '偏好', day: '2026-10-26', by: by2 })).toThrow(/without the sentence/)
    expect(store.tombstones(CHAT)).toEqual([])
  })
})
