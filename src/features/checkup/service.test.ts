import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeCheckupService } from './service'
import { makeCheckupStore } from '../../adapters/store/checkup-store'
import type { CheckupSample, CheckupTurn } from '../../domain/butler-checkup'

const dirs: string[] = []
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'cc-checkup-test-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const target = { provider: 'fake', address: 'https://example.invalid/v1', model: 'fabricated', windowTokens: 8192, windowKnown: false }
const correct = async (sample: CheckupSample): Promise<CheckupTurn> => ({ text: sample.kind === 'memory' ? JSON.stringify(sample.answers) : '', toolCalls: sample.kind === 'tool' ? [{ name: sample.tool, input: sample.input }] : [], firstTextMs: 10, durationMs: 20 })
function setup(run = correct, now = () => new Date('2026-11-12T12:00:00Z')) {
  const stateDir = temp(), store = makeCheckupStore(stateDir)
  return { stateDir, store, service: makeCheckupService({ store, resolveTarget: o => ({...target,...(o?.model ? {model:o.model} : {})}), run, version: 'test', now }) }
}
describe('local checkup lifecycle', () => {
  it('keeps an accepted run queryable and cancellable after a pin and endpoint change',async()=>{
    let current={...target}
    const {store}=setup()
    const service=makeCheckupService({store,resolveTarget:()=>current,run:()=>new Promise<CheckupTurn>(()=>{}),version:'test'})
    const key=service.estimate().targetKey,run=service.start({expectedTargetKey:key})
    current={...target,model:'new-pin',address:'https://other.invalid'}
    expect(service.view().profile).toBeNull()
    expect(service.view().attempt?.status).toBe('running')
    expect(service.view({runKey:key}).target.model).toBe('fabricated')
    service.cancel();await run.done
    expect(service.view({runKey:key}).attempt?.status).toBe('cancelled')
  })
  it('does not leave a phantom running state when the initial atomic attempt write is refused', () => {
    const {service,store}=setup()
    const original=store.saveAttempt
    store.saveAttempt=()=>{throw new Error('disk unavailable')}
    expect(()=>service.start({})).toThrow('disk unavailable')
    expect(service.view().attempt).toBeNull()
    store.saveAttempt=original
  })
  it('uses measured budget only for the exact endpoint/model; a pin change does not run', async () => {
    const { service, store } = setup()
    expect(store.contextBudgetFor(target, target.model).source).toBe('default')
    await service.start({}).done
    expect(service.view().profile?.memory).toBe('good')
    expect(store.contextBudgetFor(target, target.model)).toEqual({ windowTokens: 8192, reliableFillRatio: .8, source: 'measured' })
    expect(store.contextBudgetFor({ ...target, address: 'https://other.invalid' }, target.model).source).toBe('default')
    expect(service.view({ model: 'new-pin' }).profile).toBeNull()
  })
  it('measures the threshold of a model that starts forgetting at 60%', async () => {
    const { service } = setup(async sample => sample.kind === 'memory' && sample.fillRatio >= .6 ? { ...await correct(sample), text: '["?","?","?"]' } : correct(sample))
    await service.start({}).done
    expect(service.view().profile).toMatchObject({ memory: 'fair', reliableFillRatio: .4 })
  })
  it('finishes the profile with flaky tools when only the model fake-tool loop exceeds its bound', async () => {
    const { service } = setup(async sample => ({ ...await correct(sample), ...(sample.kind === 'tool' ? { toolError: true } : {}) }))
    await service.start({}).done
    expect(service.view().attempt?.status).toBe('completed')
    expect(service.view().profile).toMatchObject({ memory: 'good', tools: 'flaky', toolAccuracy: 0 })
  })
  it('records an all-wrong model as weak, including real tool argument mistakes', async () => {
    const { service } = setup(async () => ({ text: '[]', toolCalls: [], firstTextMs: null, durationMs: 5 }))
    await service.start({}).done
    expect(service.view().profile).toMatchObject({ memory: 'weak', tools: 'flaky', reliableFillRatio: 0 })
  })
  for (const code of ['rate_limited', 'auth_failed']) it(`does not replace a complete profile after ${code}`, async () => {
    let fail = false, n = 0
    const { service } = setup(async sample => { if (fail && ++n === 3) throw Object.assign(new Error('private detail must not persist'), { code }); return correct(sample) })
    await service.start({}).done
    const before = service.view().profile
    fail = true
    await service.start({}).done
    expect(service.view().attempt).toMatchObject({ status: 'failed', errorCode: code })
    expect(service.view().profile).toEqual(before)
  })
  it('cancels a stalled request promptly and preserves the previous archive', async () => {
    let stall = false
    const { service } = setup(async sample => stall ? new Promise<CheckupTurn>(() => {}) : correct(sample))
    await service.start({}).done
    const before = service.view().profile
    stall = true
    const next = service.start({})
    service.cancel()
    await next.done
    expect(service.view().attempt?.status).toBe('cancelled')
    expect(service.view().profile).toEqual(before)
  })
  it('defaults periodic spending off; a three-question probe can flag a changed model', async () => {
    let wrong = false, calls = 0, clock = new Date('2026-11-12T12:00:00Z')
    const { service } = setup(async sample => { calls++; return wrong ? { text: '[]', toolCalls: [], firstTextMs: null, durationMs: 5 } : correct(sample) }, () => clock)
    await service.probeIfDue()
    expect(calls).toBe(0)
    await service.start({}).done
    service.settings(true)
    wrong = true
    clock = new Date(clock.getTime() + 7*86400_000)
    await service.probeIfDue()
    expect(calls).toBe(11)
    expect(service.view().suspectedChanged).toBe(true)
    expect(service.view().profile?.memory).toBe('good')
  })
  it('does not immediately reprobe a full checkup or repeatedly spend after probe failure', async () => {
    let calls = 0, fail = false, clock = new Date('2026-11-12T12:00:00Z')
    const run = async (sample: CheckupSample) => { calls++; if (fail) throw Object.assign(Error('offline fixture'), { code: 'network' }); return correct(sample) }
    const { service, store } = setup(run, () => clock)
    await service.start({}).done
    service.settings(true)
    await service.probeIfDue()
    expect(calls).toBe(8)
    clock = new Date(clock.getTime() + 7*86400_000)
    fail = true
    await service.probeIfDue()
    expect(calls).toBe(9)
    expect(service.view().suspectedChanged).toBe(false)
    // A fresh service reads the durable attempt timestamp after daemon restart.
    const restarted = makeCheckupService({ store, resolveTarget: () => target, run, version: 'test', now: () => clock })
    await restarted.probeIfDue()
    clock = new Date(clock.getTime() + 6*86400_000)
    await restarted.probeIfDue()
    expect(calls).toBe(9)
    clock = new Date(clock.getTime() + 86400_000)
    await restarted.probeIfDue()
    expect(calls).toBe(10)
  })
  it('keeps real state canaries out of every outgoing synthetic question', async () => {
    const sent: CheckupSample[] = []
    const { service, stateDir } = setup(async sample => { sent.push(sample); return correct(sample) })
    const canary = 'PRIVATE_STATE_CANARY_never_send_894032'
    writeFileSync(join(stateDir, 'private-secret.txt'), canary)
    await service.start({ full: true }).done
    expect(sent).toHaveLength(21)
    for (const sample of sent) {
      expect(sample.prompt).not.toContain(canary)
      expect(sample.prompt).not.toContain(stateDir)
    }
  })
  it('never reads synthetic questions from real state and never persists prompt, key or raw error', async () => {
    const { service, stateDir } = setup()
    writeFileSync(join(stateDir, 'private-secret.txt'), 'PRIVATE_CANARY_894032_API_KEY')
    await service.start({}).done
    const json = readFileSync(join(stateDir, 'checkup', 'profiles.json'), 'utf8')
    expect(json).not.toContain('PRIVATE_CANARY')
    expect(json).not.toContain('prompt')
    expect(json).not.toContain('answers')
  })
})
