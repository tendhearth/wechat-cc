import { describe, expect, it, vi } from 'vitest'
import { wireJobs, type WireJobsDeps } from './wire-jobs'

/** 重构第二批步 6c 第二块:建的时候只给命令和 requestReview,runner 要 start() 才起(规矩:wireX 里不 await 还没就绪的东西)。 */
function deps(over: Partial<WireJobsDeps> = {}) {
  const sup = { start: vi.fn(async () => null) }
  const d = {
    stateDir: '/nonexistent', db: {} as never, ilink: { sendMessage: vi.fn(async () => ({ msgId: 'x' })) } as never,
    boot: { registry: { has: () => true }, holdBusy: () => () => {} } as never,
    sup: sup as never, lc: { register: vi.fn() } as never,
    jobsStore: {} as never, activityLog: {} as never, activity: { sources: () => ({}) },
    calendar: {} as never, overseerToday: (() => ({})) as never, careLedger: {} as never,
    runJobTurn: vi.fn(async () => 'sent' as const), sendProactive: vi.fn(),
    ...over,
  } as WireJobsDeps
  return { d, sup }
}

describe('wireJobs', () => {
  it('building it does not start the runner; start() does', async () => {
    const { d, sup } = deps()
    const jobs = wireJobs(d)
    expect(typeof jobs.command.probe).toBe('function')
    expect(sup.start).not.toHaveBeenCalled()
    await jobs.start()
    expect(sup.start).toHaveBeenCalledWith('scheduled-jobs', expect.any(Function))
  })
  it('requestReview: only claude / codex; with no owner ⇒ false and nothing runs', () => {
    const { d } = deps()
    const jobs = wireJobs(d)
    expect(jobs.requestReview({ taskId: 't1', providerId: 'cursor', material: 'm' })).toBe(false)
    expect(d.runJobTurn).not.toHaveBeenCalled()
  })
})
