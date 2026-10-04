// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { act, createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeCredentialStore, PAIRING_KEY, type SecureStoreLike } from '../net/credentials'
import type { PairingRecord } from '../net/pairing'
import { INPUT_JOURNAL_KEY, makeInputJournal } from './input-journal'
import { matterInputState } from './matter-inputs'
import { SessionProvider, useSession } from './session'
vi.mock('../i18n/useLang', async () => ({ LangOverrideCtx: (await import('react')).createContext(null) }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot as (el: Element) => { render(node: ReactNode): void; unmount(): void }
const A: PairingRecord = { v: 1, daemonId: 'r' + 'a'.repeat(26), relayHost: 'relay.test', relayUrl: 'wss://relay.test/v2/phone?id=r'+'a'.repeat(26), deviceToken: 'd'+'1'.repeat(48), deviceId: 'aabb0011', pairedAt: 1 }
const B: PairingRecord = { ...A, deviceToken: 'd'+'2'.repeat(48), deviceId: 'aabb0022' }
const hash = async (s: string) => createHash('sha256').update(s).digest('hex')
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
function fixture() {
  const disk = new Map<string,string>([[PAIRING_KEY, JSON.stringify(A)]]), writes: string[] = [], deleted: string[] = []
  let failLoad = false, failSave = false
  let afterWrite: ((key: string, value: string) => Promise<void>) | undefined
  const ss: SecureStoreLike = {
    async getItemAsync(k) { if (k === PAIRING_KEY && failLoad) throw new Error('keychain_unavailable'); return disk.get(k) ?? null },
    async setItemAsync(k,v) { if (k === PAIRING_KEY && failSave) throw new Error('keychain_unavailable'); disk.set(k,v); writes.push(k); await afterWrite?.(k,v) },
    async deleteItemAsync(k) { disk.delete(k); deleted.push(k) },
  }
  return { disk, writes, deleted, ss, store: makeCredentialStore(ss), journal: () => makeInputJournal(ss, hash), failLoad: (v: boolean) => { failLoad = v }, failSave: (v: boolean) => { failSave = v }, afterWrite: (f?: typeof afterWrite) => { afterWrite = f } }
}
let session!: ReturnType<typeof useSession>
const roots: Array<ReturnType<typeof createRoot>> = []
const push = { clear: vi.fn(async () => {}) }
async function mount(f: ReturnType<typeof fixture>) {
  const el = document.createElement('div'); document.body.appendChild(el)
  const root = createRoot(el); roots.push(root)
  const Probe = () => { session = useSession(); return createElement('span', null, `${session.ready}:${session.loadError}`) }
  await act(async () => { root.render(createElement(SessionProvider, { store: f.store, push, inputs: f.journal(), children: createElement(Probe) })); await new Promise(r => setTimeout(r,0)) })
  await act(async () => { await new Promise(r => setTimeout(r,0)) })
  return root
}
afterEach(async () => { await act(() => { for (const root of roots.splice(0)) root.unmount() }); matterInputState.configure(undefined); await matterInputState.clear(); document.body.innerHTML = ''; push.clear.mockClear() })
async function seed(f: ReturnType<typeof fixture>) {
  matterInputState.configure(f.journal()); await matterInputState.activate(A)
  const row = await matterInputState.prepare('task', '\r\n**保留原文**\r\n', 'first-run', undefined, true); await matterInputState.update(row, { status: 'uncertain' })
  matterInputState.configure(undefined); await matterInputState.activate(null)
  return row
}

describe('real Session + credential store + durable journal transitions', () => {
  it('temporary credential read failure does NOT mean unpaired and cannot erase saved originals; retry restores them', async () => {
    const f = fixture(), row = await seed(f), pointer = f.disk.get(INPUT_JOURNAL_KEY)
    f.failLoad(true); await mount(f)
    expect(session.ready).toBe(false); expect(session.loadError).toBe(true); expect(f.disk.get(INPUT_JOURNAL_KEY)).toBe(pointer)
    expect(f.deleted).not.toContain(PAIRING_KEY)
    await expect(matterInputState.prepare('task','must not send','run',undefined,true)).rejects.toThrow()
    f.failLoad(false); await act(async () => { session.retryLoad(); await new Promise(r => setTimeout(r,0)) }); await act(async () => { await new Promise(r => setTimeout(r,0)) })
    expect(session.ready).toBe(true); expect(session.pairing).toEqual(A); expect(matterInputState.all()[0]).toMatchObject({ requestId: row.requestId, rawText: row.rawText, status: 'uncertain' })
  })
  it('old A revocation after B credential bytes were written cannot delete B; B survives a cold reopen', async () => {
    const f = fixture(); await seed(f); const root = await mount(f)
    const capturedA = session.pairing, epochA = session.pairingEpoch, reached = gate(), release = gate()
    f.afterWrite(async(k,v) => { if (k === PAIRING_KEY && JSON.parse(v).deviceId === B.deviceId) { reached.resolve(); await release.promise } })
    let paired!: Promise<void>
    await act(async () => { paired = session.setPaired(B); await reached.promise })
    await act(() => session.dropStoredPairing(capturedA, epochA))
    expect(JSON.parse(f.disk.get(PAIRING_KEY)!)).toEqual(B); expect(f.deleted).not.toContain(PAIRING_KEY)
    await act(async () => { release.resolve(); await paired })
    expect(session.pairing).toEqual(B); expect(session.inputScope).toMatch(/^[a-f0-9]{64}$/)
    const saved = await act(async () => matterInputState.prepare('B-task', 'B original', 'B-run', undefined, true))
    await act(async () => matterInputState.update(saved, { status: 'uncertain' }))
    await act(() => root.unmount()); roots.splice(roots.indexOf(root),1)
    matterInputState.configure(undefined); await matterInputState.activate(null)
    f.afterWrite(undefined); await mount(f)
    expect(session.pairing).toEqual(B); expect(matterInputState.all()[0]?.rawText).toBe('B original')
  })
  it('old revoke during B tombstone write cannot cancel its journal activation or produce live scope-null send', async () => {
    const f = fixture(); await mount(f)
    const capturedA = session.pairing, epochA = session.pairingEpoch, reached = gate(), release = gate()
    f.afterWrite(async(k,v) => { if (k === INPUT_JOURNAL_KEY && JSON.parse(v).state === 'empty') { reached.resolve(); await release.promise } })
    let paired!: Promise<void>; await act(async () => { paired = session.setPaired(B); await reached.promise })
    const gen = matterInputState.generation(); await act(() => session.dropStoredPairing(capturedA, epochA)); expect(matterInputState.generation()).toBe(gen)
    await act(async () => { release.resolve(); await paired })
    const before = f.writes.length; await act(async () => matterInputState.prepare('B-task','B saved','run',undefined,true))
    expect(f.writes.length).toBeGreaterThan(before); expect(matterInputState.recovery().scope).toBe(session.inputScope)
  })
  it('explicit unpair supersedes a pending save; cancelled setPaired cannot claim success or enable a zero-write POST', async () => {
    const f = fixture(); await mount(f); const reached = gate(), release = gate()
    f.afterWrite(async(k,v) => { if (k === PAIRING_KEY && JSON.parse(v).deviceId === B.deviceId) { reached.resolve(); await release.promise } })
    let error: unknown, paired!: Promise<void>, unpaired!: Promise<void>
    await act(async () => { paired = session.setPaired(B).catch(e => { error = e }); await reached.promise })
    await act(() => { unpaired = session.forgetPairing() })
    await act(async () => { release.resolve(); await paired; await unpaired })
    expect(error).toBeInstanceOf(Error); expect(session.pairing).toBeNull(); expect(f.disk.has(PAIRING_KEY)).toBe(false)
    await expect(matterInputState.prepare('B','must not POST','run',undefined,true)).rejects.toMatchObject({ code: 'input_scope' })
  })
  it('failed B save preserves A and its journal; callbacks bound to A rebuild with a fresh epoch', async () => {
    const f = fixture(), row = await seed(f); await mount(f); const epoch = session.pairingEpoch
    f.failSave(true); await act(async () => { await expect(session.setPaired(B)).rejects.toThrow() })
    expect(session.pairing).toEqual(A); expect(session.pairingTransition).toBe(false); expect(session.pairingEpoch).toBeGreaterThan(epoch)
    expect(matterInputState.all()[0]?.requestId).toBe(row.requestId); expect(JSON.parse(f.disk.get(PAIRING_KEY)!)).toEqual(A)
  })
})
