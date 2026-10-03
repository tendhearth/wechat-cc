import { describe, expect, it } from 'vitest'
import { inputAccepted, inputCanRetry, inputFailure, inputRows, inputStatusText, matterInputHint } from './matter-input'
import type { MatterDetailT, MatterInputT } from '../backend/types'
import type { InputSnapshot } from '../state/matter-inputs'
import { DETAIL } from '../backend/fixtures'

const local: InputSnapshot = { taskId: 't', requestId: 'r', runId: 'run', text: '**hi**', rawText: '\r\n**hi**\r\n', status: 'uncertain' }
const receipt: MatterInputT = { id: 'r', taskId: 't', runId: 'run', text: '**hi**', status: 'delivered' }
describe('input reading', () => {
  it('reads daemon newest-first receipts oldest→newest and keeps every unconfirmed local request', () => {
    const old = { ...receipt, id: 'old', text: 'old' }, newest = { ...receipt, id: 'new', text: 'new' }
    const retained = Array.from({ length: 8 }, (_, i) => ({ ...local, requestId: `kept-${i}`, text: `kept-${i}`, rawText: `kept-${i}` }))
    expect(inputRows([newest, old], retained).map(r => r.requestId)).toEqual(['old', 'new', ...retained.map(r => r.requestId)])
  })
  it('uses actual receipts and preserves the original source; mismatches never appear delivered', () => {
    expect(inputRows([receipt], [local])).toEqual([expect.objectContaining({ rawText: local.rawText, status: 'delivered' })])
    expect(inputRows([{ ...receipt, runId: 'other' }], [local])[0]).toMatchObject({ status: 'refused', error: 'input_conflict', rawText: local.rawText })
  })
  it('reports held as retained and delivery as receipt, without claiming work is done or rejected', () => {
    expect(inputStatusText('held', 'zh-Hans')).toBe('保留了这条补充，查看进展再决定。')
    expect(inputStatusText('delivered', 'zh-Hans')).toBe('执行者已收到这条补充。')
    expect(inputStatusText('refused', 'zh-Hans', 'input_stale')).toContain('进展已变')
    expect(inputStatusText('refused', 'en', 'input_conflict')).toContain('checking')
    expect(inputAccepted('held')).toBe(false)
    expect(inputCanRetry({ ...local, status: 'refused' })).toBe(false)
    expect(inputCanRetry(local)).toBe(true)
  })
  it('keeps ambiguous results uncertain and known rejections separate from a queue receipt', () => {
    expect(inputFailure('unknown').status).toBe('uncertain')
    expect(inputFailure('uncertain').status).toBe('uncertain')
    expect(inputFailure('offline').status).toBe('failed')
    expect(inputFailure('input_stale').status).toBe('refused')
    expect(inputFailure('busy').status).toBe('refused')
  })
  it('uses the advertised steer/queue capability only for context, not an invented wire mode', () => {
    const detail = DETAIL as MatterDetailT
    expect(matterInputHint(detail, 'zh-Hans')).toContain('补充这一轮')
    expect(matterInputHint({ ...detail, inputMode: 'queue' }, 'zh-Hans')).toContain('排队')
    expect(matterInputHint({ ...detail, inputMode: 'send' }, 'en')).toBeNull()
  })
})
