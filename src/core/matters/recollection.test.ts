import { describe, it, expect, vi } from 'vitest'
import { maybeRecollect, STORY_SIGNALS, crossedOvernight, buildRecollectionPrompt, RETURNED_SIGNAL_UNAVAILABLE } from './recollection'

describe('maybeRecollect —— 判据是故事性,不是产出', () => {
  it('够不上门槛的事,连便宜模型都不问', async () => {
    const asked = vi.fn()
    await maybeRecollect({ turns: 1, returned: 0, overnight: false, ask: asked, write: vi.fn() })
    expect(asked).not.toHaveBeenCalled() // 闸在问之前 —— 省的是额度,也是噪音
  })

  it('来回过两轮就值得问一次', async () => {
    const asked = vi.fn(async () => '那天你让我改首页,我改错了两次。')
    const write = vi.fn()
    await maybeRecollect({ turns: 2, returned: 0, overnight: false, ask: asked, write })
    expect(asked).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(expect.stringContaining('改首页'))
  })

  it('没有模型时整条跳过,不留半条', async () => {
    const write = vi.fn()
    const log = vi.fn()
    await maybeRecollect({ turns: 5, returned: 2, overnight: true, ask: undefined, write, log })
    expect(write).not.toHaveBeenCalled()
    // 没模型是设计好的降级,不是错误 —— 不该跟"模型真的调用失败"走同一条
    // 留痕路径。如果实现漏掉 `!ask` 的早退,调用 undefined() 会抛错,被
    // 下面的 try/catch 悄悄接住、write 依旧没被调 —— 那种情况下这条测试
    // 光看 write 是分不出来的,所以这里额外钉住 log 没被调用过。
    expect(log).not.toHaveBeenCalled()
  })

  it('被打回 / 报错过 ≥1 次也够格', async () => {
    const asked = vi.fn(async () => '报了个错,我改了半天。')
    const write = vi.fn()
    await maybeRecollect({ turns: 1, returned: 1, overnight: false, ask: asked, write })
    expect(asked).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('报了个错,我改了半天。')
  })

  it('跨了一夜也够格', async () => {
    const asked = vi.fn(async () => '第二天早上才通。')
    const write = vi.fn()
    await maybeRecollect({ turns: 1, returned: 0, overnight: true, ask: asked, write })
    expect(asked).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('第二天早上才通。')
  })

  it('模型真的调用失败(不是没有模型)要留痕,不静默吞掉', async () => {
    const boom = new Error('gateway_timeout')
    const asked = vi.fn(async () => { throw boom })
    const write = vi.fn()
    const log = vi.fn()
    await maybeRecollect({ turns: 2, returned: 0, overnight: false, ask: asked, write, log })
    expect(write).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toContain('gateway_timeout')
  })

  it('STORY_SIGNALS 阈值就是 brief 定的那三个数(起步保守,回头按真实数据调)', () => {
    expect(STORY_SIGNALS).toEqual({ turns: 2, returned: 1, overnight: true })
  })
})

describe('crossedOvernight —— 交办与答复是不是不在同一天(UTC 日历日)', () => {
  it('同一个 UTC 日历日内 —— false', () => {
    expect(crossedOvernight(Date.parse('2026-09-23T08:00:00.000Z'), Date.parse('2026-09-23T23:00:00.000Z'))).toBe(false)
  })
  it('跨了 UTC 日历日 —— true', () => {
    expect(crossedOvernight(Date.parse('2026-09-23T23:50:00.000Z'), Date.parse('2026-09-24T00:10:00.000Z'))).toBe(true)
  })
})

describe('buildRecollectionPrompt —— 给便宜模型的理由 + 标题', () => {
  it('把够格的理由拼进 prompt,不够格的信号不提', () => {
    const prompt = buildRecollectionPrompt({ title: '改首页', turns: 2, returned: 0, overnight: false })
    expect(prompt).toContain('改首页')
    expect(prompt).toContain('来回了 2 轮')
    expect(prompt).not.toContain('打回或报错')
    expect(prompt).not.toContain('跨了一夜')
  })
  it('overnight 单独够格时也要提到', () => {
    const prompt = buildRecollectionPrompt({ title: '半夜排查', turns: 0, returned: 0, overnight: true })
    expect(prompt).toContain('跨了一夜才有回复')
  })
})

describe('RETURNED_SIGNAL_UNAVAILABLE —— returned 目前显式挂账为 0', () => {
  it('就是字面量 0(接上真数据源那天连这条一起删)', () => {
    expect(RETURNED_SIGNAL_UNAVAILABLE).toBe(0)
  })
})
