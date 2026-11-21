import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaceT, PlaceWaitingT } from '@wechat-cc/protocol'
import { approvalOpinion, scheduleOpinionReads } from './approval-opinion'

function place(requestId?: string, notes: Partial<PlaceWaitingT> = {}): PlaceT {
  return {
    key: 'p:1', name: 'portfolio', line: 'test', status: 'waiting',
    waiting: { itemKey: 'matter:1', kind: 'permission', requestId, summary: 'test', count: 1, ...notes },
    moving: false, unseen: false, updatedAt: null, matterIds: [], messageIds: [], sessionIds: [],
  }
}

describe('approvalOpinion', () => {
  const notes = { ccOpinion: 'Opinion', questionReason: 'Reason' }
  const empty = { ccOpinion: undefined, questionReason: undefined }

  it('finds the waiting request by exact ID', () => {
    expect(approvalOpinion([place('other'), place('p1', notes)], 'p1')).toEqual(notes)
    expect(approvalOpinion([place('p1', notes), place(undefined, notes)], undefined)).toEqual(empty)
    expect(approvalOpinion([place('p1', notes)], 'P1')).toEqual(empty)
  })

  it('returns either field on its own', () => {
    expect(approvalOpinion([place('p1', { ccOpinion: 'Opinion' })], 'p1')).toEqual({ ...empty, ccOpinion: 'Opinion' })
    expect(approvalOpinion([place('p1', { questionReason: 'Reason' })], 'p1')).toEqual({ ...empty, questionReason: 'Reason' })
  })

  it('drops the previous opinion when the active request changes', () => {
    const places = [place('p1', notes), place('p2')]
    expect(approvalOpinion(places, 'p1')).toEqual(notes)
    expect(approvalOpinion(places, 'p2')).toEqual(empty)
  })
})

describe('scheduleOpinionReads', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads at 3, 8 and 20 seconds, then stops', () => {
    const read = vi.fn()
    scheduleOpinionReads(() => true, read)
    for (const [interval, count] of [[3_000, 1], [5_000, 2], [12_000, 3]] as const) {
      vi.advanceTimersByTime(interval - 1)
      expect(read).toHaveBeenCalledTimes(count - 1)
      vi.advanceTimersByTime(1)
      expect(read).toHaveBeenCalledTimes(count)
    }
    vi.advanceTimersByTime(60_000)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('cancels outstanding reads when an opinion arrives', () => {
    const read = vi.fn()
    const cancel = scheduleOpinionReads(() => true, read)
    vi.advanceTimersByTime(3_000)
    cancel()
    vi.advanceTimersByTime(30_000)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('cancels the previous request’s timers when the request changes', () => {
    const readPrevious = vi.fn()
    const readNext = vi.fn()
    const cancel = scheduleOpinionReads(() => true, readPrevious)
    vi.advanceTimersByTime(2_000)
    cancel()
    scheduleOpinionReads(() => true, readNext)
    vi.advanceTimersByTime(1_000)
    expect(readPrevious).not.toHaveBeenCalled()
    expect(readNext).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    expect(readNext).toHaveBeenCalledOnce()
  })

  it('skips offline slots without restarting the schedule', () => {
    let online = false
    const read = vi.fn()
    scheduleOpinionReads(() => online, read)
    vi.advanceTimersByTime(3_000)
    expect(read).not.toHaveBeenCalled()
    online = true
    vi.advanceTimersByTime(5_000)
    expect(read).toHaveBeenCalledOnce()
    online = false
    vi.advanceTimersByTime(12_000)
    online = true
    vi.advanceTimersByTime(60_000)
    expect(read).toHaveBeenCalledOnce()
  })
})
