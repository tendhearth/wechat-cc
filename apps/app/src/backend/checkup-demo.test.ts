import { afterEach, describe, expect, it, vi } from 'vitest'
import { CheckupViewSchema, CheckupEstimateSchema } from '@wechat-cc/protocol'
import { makeDemoBackend } from './demo'
afterEach(() => vi.useRealTimers())
describe('synthetic checkup demo', () => {
  it('has real protocol shapes, is read-only while estimating, and defaults periodic checks off', async () => {
    const b = makeDemoBackend({ now: () => Date.parse('2026-11-12T00:00:00Z') })
    const before = CheckupViewSchema.parse(await b.checkup())
    const quote = CheckupEstimateSchema.parse(await b.checkupEstimate())
    expect(quote).toMatchObject({outputTokens:81200,maxOutputTokens:350000,maxRequests:120})
    expect(quote.summary).toContain('预计用 8 万左右、最多不超过 35 万输出 token，大约 3–6 分钟')
    expect(quote.targetKey).toBeTruthy(); expect(before.periodicProbe).toBe(false)
    expect(await b.checkup()).toEqual(before)
    expect((await b.checkupSettings(true)).periodicProbe).toBe(true)
    b.reset(); expect((await b.checkup()).periodicProbe).toBe(false)
  })
  it('can run, cancel without overwriting a previous result, and then finish a new run', async () => {
    vi.useFakeTimers()
    const b = makeDemoBackend(), before = await b.checkup(), quote = await b.checkupEstimate()
    expect((await b.checkupRun(quote.targetKey)).attempt?.status).toBe('running')
    expect((await b.checkupCancel()).attempt?.status).toBe('cancelled')
    await vi.advanceTimersByTimeAsync(6000)
    expect((await b.checkup()).profile).toEqual(before.profile)
    expect((await b.checkup()).attempt?.status).toBe('cancelled')
    await b.checkupRun(quote.targetKey)
    await vi.advanceTimersByTimeAsync(6000)
    expect(CheckupViewSchema.parse(await b.checkup())).toMatchObject({ profile: { memory: 'good', tools: 'stable' }, attempt: { status: 'completed' } })
  })
  it('does not run a newly pinned model with an old estimate', async () => {
    const b = makeDemoBackend(), quote = await b.checkupEstimate()
    await b.setChatModel('codex', 'synthetic-new-model')
    expect((await b.checkup()).profile).toBeNull()
    await expect(b.checkupRun(quote.targetKey)).rejects.toThrow('stale')
    expect((await b.checkup()).attempt).toBeNull()
  })
})

it('provides all interview rows and concrete care in the offline screenshot fixture',async()=>{
  const view=CheckupViewSchema.parse(await makeDemoBackend().checkup())
  expect(view.profile?.interview?.version).toBe('interview-v3')
  expect(view.review?.rows.map(r=>r.label)).toEqual(['记性','跟得上','诚实','分寸','立场','口风','办事','本色','快慢'])
  expect(view.review?.title).toContain(view.target.model)
  expect(view.review?.care).toContain('更勤换新对话')
  expect(JSON.stringify(view.review)).not.toContain('管家')
})
