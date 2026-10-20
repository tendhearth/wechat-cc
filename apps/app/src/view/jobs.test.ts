import { describe, expect, it } from 'vitest'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import { jobRow, jobsPage } from './jobs'
import { makeDemoBackend } from '../backend/demo'
import type { PhoneJobT } from '../backend/types'

const job = (over: Partial<PhoneJobT> = {}): PhoneJobT => ({ id: 'j1', label: '每天 08:00(上海)', text: '看看天气', brief: false, paused: false, last: null, ...over })

describe('定时 视图', () => {
  it('标题 = label;正文 = 早报 ⇒「早报」,否则原文', () => {
    expect(jobRow(job(), 'zh-Hans')).toMatchObject({ title: '每天 08:00(上海)', body: '看看天气' })
    expect(jobRow(job({ brief: true, text: '早报正文不显示' }), 'zh-Hans').body).toBe('早报')
    expect(jobRow(job({ brief: true }), 'en').body).toBe('Morning brief')
  })
  it('上次结果:中文用电脑给的那句 + 日期;没跑过 ⇒「还没跑过」', () => {
    expect(jobRow(job(), 'zh-Hans').last).toBe('还没跑过')
    expect(jobRow(job(), 'en').last).toBe("Hasn't run yet")
    const last = { day: '2026-10-20', status: 'skipped:network', label: '跳过(网络不安全)' }
    expect(jobRow(job({ last }), 'zh-Hans').last).toBe('上次 10月20日 · 跳过(网络不安全)')
    expect(jobRow(job({ last }), 'en').last).toBe('Last 10/20 · Skipped')
  })
  it('英文按 status 译;认不出的新状态退回电脑那句', () => {
    const at = (status: string, label = 'x') => jobRow(job({ last: { day: '2026-10-05', status, label } }), 'en').last
    expect(at('sent')).toBe('Last 10/5 · Sent')
    expect(at('silent')).toBe('Last 10/5 · Stayed quiet (nothing new)')
    expect(at('failed:timeout')).toBe("Last 10/5 · Didn't run")
    expect(at('brand-new', '新状态')).toBe('Last 10/5 · 新状态')
  })
  it('停着 ⇒「停着」、按钮是「开」;在跑 ⇒ 不写、按钮是「停」', () => {
    expect(jobRow(job({ paused: true }), 'zh-Hans')).toMatchObject({ paused: '停着', toggle: 'resume' })
    expect(jobRow(job(), 'zh-Hans')).toMatchObject({ paused: null, toggle: 'pause' })
  })
  it('没有执行者 ⇒ 顶上一句;空 ⇒ 去微信加;有 ⇒ 底下提示怎么加', () => {
    const none = jobsPage({ timezone: 'Asia/Shanghai', executor: null, jobs: [] }, 'zh-Hans')
    expect(none.notice).toBe('这台电脑上没有 Claude 或 Codex，定时现在跑不了')
    expect(none.empty).toBe('还没有定时。在微信里说「定时 每天 8:00 …」就能加。')
    expect(none.hint).toBeNull()
    expect(jobsPage({ timezone: 'UTC', executor: null, jobs: [] }, 'en').notice).toBe("This computer has neither Claude nor Codex, so scheduled jobs can't run right now")
    const some = jobsPage({ timezone: 'UTC', executor: 'claude', jobs: [job()] }, 'zh-Hans')
    expect(some).toMatchObject({ notice: null, empty: null })
    expect(some.rows).toHaveLength(1)
    expect(some.hint).not.toBeNull()
  })
})

describe('定时 演示后端', () => {
  it('三条(一条早报、一条停着),过 GET /m/api/jobs schema;中英文各一份', async () => {
    const b = makeDemoBackend({ lang: 'zh-Hans' })
    const v = await b.jobs()
    expect(PHONE_API_SCHEMAS['GET /m/api/jobs']!.safeParse({ ok: true, ...v }).success).toBe(true)
    expect(v.jobs.filter(j => j.brief)).toHaveLength(1)
    expect(v.jobs.filter(j => j.paused)).toHaveLength(1)
    expect(v.jobs[0]!.label).toMatch(/[一-鿿]/)
    expect((await makeDemoBackend({ lang: 'en' }).jobs()).jobs[0]!.label).not.toMatch(/[一-鿿]/)
  })
  it('停 / 开 / 删改本地状态;删了再动 ⇒ not_found;reset 还原', async () => {
    const b = makeDemoBackend({ lang: 'zh-Hans' })
    await b.jobsAction('j1', 'pause')
    expect((await b.jobs()).jobs.find(j => j.id === 'j1')!.paused).toBe(true)
    await b.jobsAction('j1', 'resume')
    expect((await b.jobs()).jobs.find(j => j.id === 'j1')!.paused).toBe(false)
    await b.jobsAction('j2', 'remove')
    expect((await b.jobs()).jobs.map(j => j.id)).not.toContain('j2')
    await expect(b.jobsAction('j2', 'pause')).rejects.toMatchObject({ code: 'not_found' })
    await expect(b.jobsAction('j99', 'remove')).rejects.toMatchObject({ code: 'not_found' })
    b.reset()
    expect((await b.jobs()).jobs.map(j => j.id)).toContain('j2')
  })
})
