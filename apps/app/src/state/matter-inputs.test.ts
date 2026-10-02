import { beforeEach, describe, expect, it } from 'vitest'
import { clearDrafts, getDraft, pairingGen, setDraft } from './drafts'
import { beginMatterInput, consumeMatterInputDraft, matchesMatterInput, matterInputs, observeMatterInputs, updateMatterInput } from './matter-inputs'
import type { MatterInputT } from '../backend/types'

beforeEach(() => { clearDrafts() })
const remote = (input: ReturnType<typeof beginMatterInput>, status: MatterInputT['status'] = 'delivered'): MatterInputT => ({ id: input.requestId, taskId: input.taskId, runId: input.runId ?? 'new-run', text: input.text, status })

describe('workbench input snapshots', () => {
  it('pins the first request, run and original text across uncertain retries and later run changes', () => {
    const raw = '\r\n**补充**\r\n'
    const input = beginMatterInput('task', raw, 'first-run', () => 'req')
    updateMatterInput(input, { status: 'uncertain' })
    const retry = beginMatterInput('task', ' **补充** ', 'later-run', () => 'wrong')
    expect(retry).toMatchObject({ requestId: 'req', runId: 'first-run', text: '**补充**', rawText: raw })
    expect(matterInputs('task')).toHaveLength(1)
  })
  it('keeps the no-run continuation route fixed when a lost first request may have started a run', () => {
    const input = beginMatterInput('task', 'go', undefined, () => 'req')
    updateMatterInput(input, { status: 'uncertain' })
    const retry = beginMatterInput('task', 'go', 'now-running', () => 'wrong')
    expect(retry.runId).toBeUndefined()
    observeMatterInputs('task', [remote(input)])
    expect(matterInputs('task')[0]!.status).toBe('delivered')
  })
  it('reconciles only an exact request, task, run and sent body; a collision is not confirmation', () => {
    const input = beginMatterInput('task', 'go', 'run', () => 'req')
    expect(matchesMatterInput(input, { ...remote(input), runId: 'other' })).toBe(false)
    expect(matchesMatterInput(input, { ...remote(input), text: 'different' })).toBe(false)
    expect(matchesMatterInput(input, { ...remote(input), taskId: 'other' })).toBe(false)
    observeMatterInputs('task', [{ ...remote(input), text: 'different' }])
    expect(matterInputs('task')[0]).toMatchObject({ status: 'refused', error: 'input_conflict', rawText: 'go' })
    observeMatterInputs('task', [remote(input, 'pending')])
    expect(matterInputs('task')[0]).toMatchObject({ status: 'pending', error: undefined })
  })
  it('clears only the unchanged accepted draft once and lets a later restore keep its exact source', () => {
    const raw = '\r\n**go**\r\n'
    setDraft('task', raw)
    const input = beginMatterInput('task', raw, 'run', () => 'req')
    observeMatterInputs('task', [remote(input, 'sending')])
    expect(consumeMatterInputDraft('task')).toBe(true)
    expect(getDraft('task')).toBe('')
    setDraft('task', raw)
    observeMatterInputs('task', [remote(input)])
    expect(consumeMatterInputDraft('task')).toBe(false)
    expect(getDraft('task')).toBe(raw)
  })
  it('preserves a draft edited during delivery, and held/withdrawn/refused/uncertain never clear it', () => {
    const input = beginMatterInput('task', 'first', 'run', () => 'req')
    setDraft('task', 'newer')
    observeMatterInputs('task', [remote(input)])
    expect(consumeMatterInputDraft('task')).toBe(false)
    expect(getDraft('task')).toBe('newer')
    for (const status of ['held', 'withdrawn', 'refused', 'uncertain'] as const) {
      const another = beginMatterInput('task', status, 'run', () => status)
      setDraft('task', status)
      updateMatterInput(another, { status })
      expect(consumeMatterInputDraft('task')).toBe(false)
      expect(getDraft('task')).toBe(status)
    }
  })
  it('lets a deliberate repeat after confirmed acceptance have a fresh request id', () => {
    const first = beginMatterInput('task', 'same', 'run', () => 'first')
    updateMatterInput(first, { status: 'delivered' })
    expect(beginMatterInput('task', 'same', 'run', () => 'second').requestId).toBe('second')
  })
  it('does not carry snapshots or old responses across a pairing change', () => {
    const gen = pairingGen()
    const input = beginMatterInput('task', 'secret', 'run', () => 'old')
    clearDrafts()
    const next = beginMatterInput('task', 'new', 'run', () => 'new')
    updateMatterInput(input, { status: 'delivered' }, gen)
    expect(matterInputs('task')).toEqual([next])
  })
})
