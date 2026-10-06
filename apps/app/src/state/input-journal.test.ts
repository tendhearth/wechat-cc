import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { SecureStoreLike } from '../net/credentials'
import type { PairingRecord } from '../net/pairing'
import type { MatterInputT } from '../backend/types'
import { INPUT_JOURNAL_CHUNK_BYTES, INPUT_JOURNAL_KEY, INPUT_JOURNAL_MAX_BYTES, INPUT_JOURNAL_MAX_ROWS, InputJournalError, inputPairingScope, makeInputJournal } from './input-journal'
import { makeMatterInputState } from './matter-inputs'
const hash = async (text: string) => createHash('sha256').update(text).digest('hex')
const REC: PairingRecord = { v: 1, daemonId: 'daemon', relayHost: 'relay.example', relayUrl: 'wss://relay.example/phone?id=daemon', deviceToken: 'd-secret-credential', deviceId: 'device', pairedAt: 1 }
function storage(seed = new Map<string, string>()) {
  const disk = new Map(seed), writes: Array<{ key: string; value: string }> = [], reads: string[] = [], deletes: string[] = []
  let rejectWrite: ((key: string, value: string) => boolean) | null = null, rejectDelete: ((key: string) => boolean) | null = null
  let beforeWrite: ((key: string, value: string) => Promise<void>) | null = null
  const ss: SecureStoreLike = {
    async getItemAsync(k) { reads.push(k); return disk.get(k) ?? null },
    async setItemAsync(k, v) {
      if (new TextEncoder().encode(v).length > 2048) throw new Error('native_single_value_limit')
      if (beforeWrite) await beforeWrite(k, v)
      if (rejectWrite?.(k, v)) throw new Error('keychain_rejected')
      writes.push({ key: k, value: v }); disk.set(k, v)
    },
    async deleteItemAsync(k) { deletes.push(k); if (rejectDelete?.(k)) throw new Error('keychain_rejected'); disk.delete(k) },
  }
  return { disk, ss, writes, reads, deletes, rejectWrite: (fn: typeof rejectWrite) => { rejectWrite = fn }, rejectDelete: (fn: typeof rejectDelete) => { rejectDelete = fn }, beforeWrite: (fn: typeof beforeWrite) => { beforeWrite = fn } }
}
function controller(f: ReturnType<typeof storage>) { let id = 0; return makeMatterInputState({ journal: makeInputJournal(f.ss, hash), mk: () => `req-${++id}` }) }
const receipt = (s: { taskId: string; requestId: string; runId?: string; text: string }, status: MatterInputT['status'] = 'delivered'): MatterInputT => ({ taskId: s.taskId, id: s.requestId, runId: s.runId ?? 'new-run', text: s.text, status })
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

describe('native durable input journal', () => {
  it('restores exact 20k Chinese/emoji/CRLF from NEW storage/state instances after process loss', async () => {
    const f = storage(), state = controller(f); await state.activate(REC)
    const raw = '\r\n  **用户原文**\r\n' + '中'.repeat(19_970) + '😀  \r\n'
    const first = await state.prepare('task', raw, undefined)
    const reboot = controller(storage(f.disk)); expect(reboot.recovery().phase).toBe('loading')
    await expect(reboot.prepare('task', 'must wait')).rejects.toMatchObject({ code: 'input_recovery' })
    await reboot.activate(REC); expect(reboot.all()).toEqual([{ ...first, status: 'uncertain' }])
    const retry = await reboot.prepare('task', 'irrelevant', 'later-run', reboot.all()[0])
    expect(retry).toMatchObject({ requestId: first.requestId, rawText: raw, text: raw.trim() }); expect(retry).not.toHaveProperty('runId')
    expect(f.writes.every(w => new TextEncoder().encode(w.value).length <= INPUT_JOURNAL_CHUNK_BYTES)).toBe(true)
    expect([...f.disk].some(([k, v]) => k.includes(REC.deviceToken) || v.includes(REC.deviceToken))).toBe(false)
  })
  it('scopes to relay URL/host, daemon, device AND token, excluding pairedAt', async () => {
    const scope = await inputPairingScope(REC, hash); expect(scope).toMatch(/^[a-f0-9]{64}$/)
    expect(await inputPairingScope({ ...REC, pairedAt: 999 }, hash)).toBe(scope)
    for (const prop of ['relayHost', 'relayUrl', 'daemonId', 'deviceId', 'deviceToken'] as const) {
      const changed = { ...REC, [prop]: `${REC[prop]}-changed` }
      expect(await inputPairingScope(changed, hash)).not.toBe(scope)
      const f = storage(), state = controller(f); await state.activate(REC); await state.prepare('old', 'private original', 'run')
      const reboot = controller(storage(f.disk)); await reboot.activate(changed); expect(reboot.all()).toEqual([])
    }
  })
  it.each(['body', 'index', 'pointer'])('partial %s failure preserves the previous commit and sends ZERO POST', async stage => {
    const f = storage(), state = controller(f), post = vi.fn(); await state.activate(REC)
    const first = await state.prepare('task', 'first', 'run'); await state.update(first, { status: 'uncertain' })
    const committed = f.disk.get(INPUT_JOURNAL_KEY)
    f.rejectWrite(k => stage === 'pointer' ? k === INPUT_JOURNAL_KEY : stage === 'body' ? k.includes('.body.') && k.endsWith('.1') : k.includes('.index.') && !k.endsWith('.count'))
    const raw = '第二条原文'.repeat(500)
    await expect(state.prepare('task', raw, 'run').then(post)).rejects.toThrow(); expect(post).not.toHaveBeenCalled()
    expect(state.all().find(r => r.rawText === raw)?.error).toBe('input_storage'); expect(f.disk.get(INPUT_JOURNAL_KEY)).toBe(committed)
    const reboot = controller(storage(f.disk)); await reboot.activate(REC)
    expect(reboot.all()).toHaveLength(1); expect(reboot.all()[0]?.rawText).toBe('first')
  })
  it('corrupt/missing committed fragments lock sends without deleting/overwriting the committed originals', async () => {
    const f = storage(), state = controller(f); await state.activate(REC); await state.prepare('t', '保留原文'.repeat(1000), 'r')
    const bodyKey = [...f.disk.keys()].find(k => k.includes('.body.') && k.endsWith('.0'))!; f.disk.delete(bodyKey)
    const originalPointer = f.disk.get(INPUT_JOURNAL_KEY), reboot = controller(f)
    await expect(reboot.activate(REC)).rejects.toMatchObject({ code: 'input_recovery' })
    expect(reboot.recovery().phase).toBe('error'); await expect(reboot.prepare('t', 'new')).rejects.toThrow()
    expect(f.disk.get(INPUT_JOURNAL_KEY)).toBe(originalPointer)
  })
  it('pending/sending/held/delivered/withdrawn and draftHandled survive; delivered/withdrawn cannot retry', async () => {
    const f = storage(), state = controller(f); await state.activate(REC)
    for (const status of ['pending', 'sending', 'held', 'delivered', 'withdrawn'] as const) {
      const row = await state.prepare(`t-${status}`, `原文-${status}`, 'first-run'); await state.update(row, { status, draftHandled: status === 'delivered' })
    }
    const reboot = controller(storage(f.disk)); await reboot.activate(REC)
    expect(reboot.all().map(r => r.status)).toEqual(['pending', 'sending', 'held', 'delivered', 'withdrawn']); expect(reboot.all()[3]?.draftHandled).toBe(true)
    for (const i of [3, 4]) await expect(reboot.prepare(reboot.all()[i]!.taskId, '', undefined, reboot.all()[i])).rejects.toMatchObject({ code: 'input_scope' })
  })
  it('64 unconfirmed rows and byte capacity block the next send without silently dropping any original', async () => {
    const f = storage(), state = controller(f); await state.activate(REC)
    for (let i = 0; i < INPUT_JOURNAL_MAX_ROWS; i++) { const row = await state.prepare('t', `original-${i}`, 'r'); await state.update(row, { status: 'uncertain' }) }
    const original = state.all().map(r => r.requestId)
    await expect(state.prepare('t', 'overflow', 'r')).rejects.toMatchObject({ code: 'input_capacity' }); expect(state.all().map(r => r.requestId)).toEqual(original)
    const reboot = controller(storage(f.disk)); await reboot.activate(REC); expect(reboot.all()).toHaveLength(INPUT_JOURNAL_MAX_ROWS)
    const g = storage(), large = controller(g); await large.activate(REC); let blocked = false
    for (let i = 0; i < 10; i++) {
      try { const row = await large.prepare(`t-${i}`, '中'.repeat(20_000), 'r'); await large.update(row, { status: 'uncertain' }) }
      catch (e) { expect(e).toMatchObject({ code: 'input_capacity' }); blocked = true; break }
    }
    expect(blocked).toBe(true); expect(new TextEncoder().encode(JSON.stringify({ v: 1, rows: large.all() })).length).toBeLessThanOrEqual(INPUT_JOURNAL_MAX_BYTES)
  })
  it('only handled confirmed rows may make room; all unconfirmed originals remain recoverable', async () => {
    const f = storage(), state = controller(f); await state.activate(REC)
    for (let i = 0; i < INPUT_JOURNAL_MAX_ROWS; i++) {
      const row = await state.prepare('t', `original-${i}`, 'r'); await state.update(row, i === 0 ? { status: 'delivered', draftHandled: true } : { status: 'uncertain' })
    }
    await state.prepare('t', 'new permitted', 'r'); expect(state.all()).toHaveLength(INPUT_JOURNAL_MAX_ROWS)
    expect(state.all().some(r => r.rawText === 'original-0')).toBe(false); expect(state.all().filter(r => r.status === 'uncertain')).toHaveLength(INPUT_JOURNAL_MAX_ROWS - 1)
    const reboot = controller(storage(f.disk)); await reboot.activate(REC); expect(reboot.all()).toHaveLength(INPUT_JOURNAL_MAX_ROWS)
  })
  it('a 64-row status commit never rewrites a 20k original, takes <=12 Keychain writes and one hash', async () => {
    const f = storage(), hashSpy = vi.fn(hash), state = makeMatterInputState({ journal: makeInputJournal(f.ss, hashSpy), mk: () => `id-${f.writes.length}` }); await state.activate(REC)
    const long = await state.prepare('long', '\r\n' + '中'.repeat(19_996) + '\r\n', 'run')
    for (let i = 1; i < INPUT_JOURNAL_MAX_ROWS; i++) { const row = await state.prepare('t', `original-${i}`, 'r'); await state.update(row, { status: 'uncertain' }) }
    const before = f.writes.length; hashSpy.mockClear(); await state.update(long, { status: 'delivered', draftHandled: true })
    const writes = f.writes.slice(before); expect(writes.filter(w => w.key.includes('.body.'))).toEqual([])
    expect(writes.length).toBeLessThanOrEqual(12); expect(hashSpy).toHaveBeenCalledOnce()
  })
  it('scope change while a body write is suspended cancels the prepare and cannot resurrect rows', async () => {
    const f = storage(), state = controller(f), wait = gate(), reached = gate(); await state.activate(REC)
    f.beforeWrite(async k => { if (k.includes('.body.') && !k.endsWith('.count')) { reached.resolve(); await wait.promise } })
    const sending = state.prepare('old', 'secret', 'run'); await reached.promise
    const changing = state.activate({ ...REC, deviceToken: 'new-token' }, false)
    expect(state.all()).toEqual([]); expect(state.recovery().phase).toBe('loading'); wait.resolve()
    await expect(sending).rejects.toBeInstanceOf(InputJournalError); await changing
    const reboot = controller(storage(f.disk)); await reboot.activate({ ...REC, deviceToken: 'new-token' }); expect(reboot.all()).toEqual([])
  })
  it('a late GET after revoke cannot repopulate records; reconnect performs GET only', async () => {
    const f = storage(), state = controller(f), wait = gate(), reads = vi.fn(); await state.activate(REC)
    const row = await state.prepare('archived-task', 'old original', 'run'); await state.update(row, { status: 'uncertain' })
    const lookup = { matterInputReceipt: vi.fn(async () => { reads(); await wait.promise; return receipt(row) }), say: vi.fn(), create: vi.fn() }
    const checking = state.reconcile(lookup); await vi.waitFor(() => expect(reads).toHaveBeenCalledOnce())
    await state.clear(); wait.resolve(); await checking; expect(state.all()).toEqual([])
    expect(lookup.say).not.toHaveBeenCalled(); expect(lookup.create).not.toHaveBeenCalled()
    const reboot = controller(storage(f.disk)); await reboot.activate(REC); expect(reboot.all()).toEqual([])
  })
  it('a tombstone survives failed deletion; cleanup must succeed before sending becomes enabled', async () => {
    const f = storage(), state = controller(f); await state.activate(REC); await state.prepare('t', 'private', 'r')
    f.rejectDelete(k => k.includes('.body.')); await expect(state.clear()).rejects.toThrow()
    expect(JSON.parse(f.disk.get(INPUT_JOURNAL_KEY)!)).toEqual({ v: 1, state: 'empty' }); expect(state.all()).toEqual([]); expect(state.recovery().phase).toBe('error')
    const reboot = controller(f); await expect(reboot.activate(REC)).rejects.toThrow(); expect(reboot.all()).toEqual([])
    f.rejectDelete(null); await reboot.retryStorage(REC); expect(reboot.recovery().phase).toBe('ready'); expect(reboot.all()).toEqual([])
    expect([...f.disk.values()].some(v => v.includes('private'))).toBe(false)
  })
  it('failed tombstone never claims erasure; current generation stays locked and retry actually cleans storage', async () => {
    const f = storage(), state = controller(f); await state.activate(REC); await state.prepare('t', 'private', 'r')
    f.rejectWrite(k => k === INPUT_JOURNAL_KEY); await expect(state.clear()).rejects.toThrow()
    expect(state.all()).toEqual([]); expect(state.recovery().phase).toBe('error'); await expect(state.prepare('t', 'not allowed')).rejects.toThrow()
    f.rejectWrite(null); await state.retryStorage(REC); expect(JSON.parse(f.disk.get(INPUT_JOURNAL_KEY)!)).toEqual({ v: 1, state: 'empty' })
  })
  it('demo/reset/new pairing clears originals; stale updates cannot cross the previous generation', async () => {
    const f = storage(), state = controller(f); await state.activate(REC)
    const row = await state.prepare('t', 'private', 'r'), old = state.generation(); await state.activate(null)
    await state.update(row, { status: 'delivered' }, old); expect(state.all()).toEqual([])
    await state.activate(REC, false); expect(state.all()).toEqual([])
    const reboot = controller(storage(f.disk)); await reboot.activate(REC); expect(reboot.all()).toEqual([])
  })
  it('single lookup verifies beyond detail 50; missing/unsupported remain uncertain; mismatches are refused', async () => {
    const f = storage(), state = controller(f); await state.activate(REC)
    const originals = []
    for (const text of ['first', 'second', 'third']) { const row = await state.prepare('t', text, 'run'); await state.update(row, { status: 'uncertain' }); originals.push(row) }
    const [first, second, third] = originals
    const lookup = { matterInputReceipt: vi.fn(async (_id: string, requestId: string) => requestId === first!.requestId ? receipt(first!) : requestId === second!.requestId ? null : { ...receipt(third!), runId: 'wrong-run' }) }
    await state.reconcile(lookup); expect(lookup.matterInputReceipt).toHaveBeenCalledTimes(3); expect(state.all().map(r => r.status)).toEqual(['delivered', 'uncertain', 'refused'])
    await state.reconcile({ matterInputReceipt: async () => { throw new Error('unsupported') } }); expect(state.all()[1]?.status).toBe('uncertain')
  })
  it('durable draftHandled prevents clearing a restored original; a newer draft is never overwritten', async () => {
    const f = storage(); let draft = '\r\n**first**\r\n'
    const state = makeMatterInputState({ journal: makeInputJournal(f.ss, hash), mk: () => 'req', getDraft: () => draft, deleteDraft: () => { draft = '' } })
    await state.activate(REC); const first = await state.prepare('t', draft, 'run'); await state.update(first, { status: 'sending' })
    draft = 'new draft'; expect(await state.consume('t')).toBe(false); expect(draft).toBe('new draft')
    const reboot = makeMatterInputState({ journal: makeInputJournal(storage(f.disk).ss, hash), getDraft: () => draft, deleteDraft: () => { draft = '' } })
    await reboot.activate(REC); draft = first.rawText; expect(await reboot.consume('t')).toBe(false); expect(draft).toBe(first.rawText)
  })
  it('does not clear a retyped identical draft while draftHandled persistence is pending', async () => {
    const f = storage(); let draft = 'original', revision = 1
    const state = makeMatterInputState({ journal: makeInputJournal(f.ss, hash), mk: () => 'req', getDraft: () => draft, getDraftStamp: () => ({ owner: 'process-A', revision }), deleteDraft: () => { draft = ''; revision++ } })
    await state.activate(REC); const row = await state.prepare('t', draft, 'run'); await state.update(row, { status: 'pending' })
    const reached = gate(), release = gate()
    f.beforeWrite(async k => { if (k.includes('.index.') && !k.endsWith('.count')) { reached.resolve(); await release.promise } })
    const consuming = state.consume('t'); await reached.promise
    draft = 'different'; revision++; draft = row.rawText; revision++
    release.resolve(); expect(await consuming).toBe(false); expect(draft).toBe('original')
  })
  it.each(['held','withdrawn'] as const)('does not clear a pending draft that became %s during its persistence await', async status => {
    const f = storage(); let draft = 'original', revision = 1
    const state = makeMatterInputState({ journal: makeInputJournal(f.ss, hash), mk: () => 'req', getDraft: () => draft, getDraftStamp: () => ({ owner: 'process-A', revision }), deleteDraft: () => { draft = ''; revision++ } })
    await state.activate(REC); const row = await state.prepare('t', draft, 'run'); await state.update(row, { status: 'pending' })
    const reached = gate(), release = gate()
    f.beforeWrite(async k => { if (k.includes('.index.') && !k.endsWith('.count')) { reached.resolve(); await release.promise } })
    const consuming = state.consume('t'); await reached.promise
    const observing = state.observe('t', [receipt(row, status)])
    expect(state.all()[0]?.status).toBe(status)
    release.resolve(); expect(await consuming).toBe(false); await observing
    expect(draft).toBe('original'); expect(state.all()[0]?.status).toBe(status)
    const reboot = controller(storage(f.disk)); await reboot.activate(REC); expect(reboot.all()[0]?.status).toBe(status)
  })
  it('a late GET cannot clear text retyped after prepare, and a new process owner never owns an old same-text draft', async () => {
    const f = storage(); let draft = 'original', revision = 1
    const state = makeMatterInputState({ journal: makeInputJournal(f.ss, hash), mk: () => 'req', getDraft: () => draft, getDraftStamp: () => ({ owner: 'process-A', revision }), deleteDraft: () => { draft = ''; revision++ } })
    await state.activate(REC); const row = await state.prepare('t', draft, 'run'); await state.update(row, { status: 'uncertain' })
    const reached = gate(), release = gate()
    const checking = state.reconcile({ matterInputReceipt: async () => { reached.resolve(); await release.promise; return receipt(row, 'sending') } }); await reached.promise
    draft = ''; revision++; draft = 'original'; revision++; release.resolve(); await checking
    expect(await state.consume('t')).toBe(false); expect(draft).toBe('original')
    // Force an unhandled accepted row to disk, then model a different OS process's draft nonce.
    const g = storage(); const before = makeMatterInputState({ journal: makeInputJournal(g.ss, hash), mk: () => 'req', getDraft: () => 'original', getDraftStamp: () => ({ owner: 'process-A', revision: 1 }) })
    await before.activate(REC); const old = await before.prepare('t','original','run'); await before.update(old, { status: 'sending' })
    let newDraft = 'original'
    const reboot = makeMatterInputState({ journal: makeInputJournal(storage(g.disk).ss, hash), getDraft: () => newDraft, getDraftStamp: () => ({ owner: 'process-B', revision: 1 }), deleteDraft: () => { newDraft = '' } })
    await reboot.activate(REC); expect(reboot.all()[0]).toMatchObject({ draftOwner: 'process-A', draftRevision: 1 })
    expect(await reboot.consume('t')).toBe(false); expect(newDraft).toBe('original')
  })
  it('clears only the still-owned unchanged draft after its handled marker is durable', async () => {
    const f = storage(); let draft = 'original', revision = 1
    const state = makeMatterInputState({ journal: makeInputJournal(f.ss, hash), mk: () => 'req', getDraft: () => draft, getDraftStamp: () => ({ owner: 'process-A', revision }), deleteDraft: () => { draft = ''; revision++ } })
    await state.activate(REC); const row = await state.prepare('t',draft,'run'); await state.update(row,{status:'pending'})
    expect(await state.consume('t')).toBe(true); expect(draft).toBe('')
    const reboot = controller(storage(f.disk)); await reboot.activate(REC); expect(reboot.all()[0]?.draftHandled).toBe(true)
  })
  it.each(['held', 'withdrawn'] as const)('late pending GET cannot overwrite a newer %s receipt or clear its original', async status => {
    const f = storage(); let draft = 'original', revision = 1
    const state = makeMatterInputState({ journal: makeInputJournal(f.ss, hash), mk: () => 'req', getDraft: () => draft, getDraftStamp: () => ({ owner: 'process-A', revision }), deleteDraft: () => { draft = ''; revision++ } })
    await state.activate(REC); const row = await state.prepare('t', draft, 'run'); await state.update(row, { status: 'uncertain' })
    const reached = gate(), release = gate()
    const checking = state.reconcile({ matterInputReceipt: async () => { reached.resolve(); await release.promise; return receipt(row, 'pending') } })
    await reached.promise; await state.observe('t', [receipt(row, status)]); release.resolve(); await checking
    expect(state.all()[0]?.status).toBe(status); expect(await state.consume('t')).toBe(false); expect(draft).toBe('original')
    const reboot = controller(storage(f.disk)); await reboot.activate(REC); expect(reboot.all()[0]?.status).toBe(status)
    await state.reconcile({ matterInputReceipt: async () => receipt(row, 'pending') })
    if (status === 'held') { expect(state.all()[0]?.status).toBe('pending'); expect(await state.consume('t')).toBe(true); expect(draft).toBe('') }
    else { expect(state.all()[0]?.status).toBe('withdrawn'); expect(draft).toBe('original') }
  })
  it('live sending can never fall back to scope-null memory after cancellation or erasure', async () => {
    const f = storage(), state = controller(f); await state.activate(REC); await state.clear()
    const writes = f.writes.length, post = vi.fn()
    await expect(state.prepare('live', 'must not POST', 'run', undefined, true).then(post)).rejects.toMatchObject({ code: 'input_scope' })
    expect(post).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(writes)
    await expect(makeMatterInputState().prepare('live','must not POST','run',undefined,true)).rejects.toMatchObject({ code: 'input_scope' })
  })
  it('serializes concurrent snapshot/status commits and a fresh instance reads every committed row', async () => {
    const f = storage(), state = controller(f), reached = gate(), release = gate(); await state.activate(REC)
    let active = 0, maximum = 0
    f.beforeWrite(async () => { active++; maximum = Math.max(maximum,active); reached.resolve(); await release.promise; active-- })
    const one = state.prepare('t','one','run'), two = state.prepare('t','two','run')
    await reached.promise; expect(maximum).toBe(1); release.resolve(); const [a,b] = await Promise.all([one,two])
    await Promise.all([state.update(a,{status:'uncertain'}),state.update(b,{status:'held'})])
    expect(maximum).toBe(1)
    const reboot = controller(storage(f.disk)); await reboot.activate(REC); expect(reboot.all().map(r=>[r.rawText,r.status])).toEqual([['one','uncertain'],['two','held']])
  })

})

describe('follow-up with photos (2026-10-06)', () => {
  const D = '11111111-1111-4111-8111-111111111111', A = '22222222-2222-4222-8222-222222222222', B = '33333333-3333-4333-8333-333333333333'
  it('keeps the photo references across a process restart and resends them unchanged', async () => {
    const f = storage(), state = controller(f); await state.activate(REC)
    const first = await state.prepare('task', '看这张', 'run', undefined, false, { draftId: D, attachmentIds: [A] })
    expect(first).toMatchObject({ draftId: D, attachmentIds: [A] })
    const reboot = controller(storage(f.disk)); await reboot.activate(REC)
    const retry = await reboot.prepare('task', 'ignored', 'run', reboot.all()[0])
    expect(retry).toMatchObject({ requestId: first.requestId, draftId: D, attachmentIds: [A] })
  })
  it('the same words with different photos is a new message; the same photos is a retry', async () => {
    const f = storage(), state = controller(f); await state.activate(REC)
    const first = await state.prepare('task', '看这张', 'run', undefined, false, { draftId: D, attachmentIds: [A] }); await state.update(first, { status: 'failed' })
    const other = await state.prepare('task', '看这张', 'run', undefined, false, { draftId: D, attachmentIds: [B] })
    expect(other.requestId).not.toBe(first.requestId)
    await state.update(other, { status: 'failed' })
    expect((await state.prepare('task', '看这张', 'run', undefined, false, { draftId: D, attachmentIds: [A] })).requestId).toBe(first.requestId)
  })
  it('a receipt only matches when its photos are exactly these; older computers that omit them are not held against it', async () => {
    const { matchesMatterInput } = await import('./matter-inputs')
    const f = storage(), state = controller(f); await state.activate(REC)
    const s = await state.prepare('task', '看这张', 'run', undefined, false, { draftId: D, attachmentIds: [A] })
    const r = receipt(s)
    const att = (id: string) => ({ id, name: 'p.jpg', mime: 'image/jpeg', size: 1, sha256: 'a'.repeat(64) })
    expect(matchesMatterInput(s, { ...r, attachments: [att(A)] })).toBe(true)
    expect(matchesMatterInput(s, { ...r, attachments: [att(B)] })).toBe(false)
    expect(matchesMatterInput(s, { ...r, attachments: [] })).toBe(false)
    expect(matchesMatterInput(s, r)).toBe(true)
  })
})
