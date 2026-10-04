import { describe, expect, it } from 'vitest'
import { formatProviderProbes, providerProbesFrom, type ProviderProbeRow } from './daemon-health'

const row = (o: Partial<ProviderProbeRow> = {}): ProviderProbeRow => ({
  id: 'agy', state: 'retrying', attempts: 1, last_error: '超时 — 5012ms 内没退出',
  first_failed_at: '2026-10-04T03:14:38.250Z', next_attempt_at: '2026-10-04T03:14:44.000Z', registered_at: null, ...o,
})

describe('daemon-health —— 开机探测失败的 provider 在 CLI 里看得见(2026-10-04)', () => {
  it('retrying ⇒ 「探测失败,重试中」+ 次数 + 下次时间 + 原因', () => {
    const [line] = formatProviderProbes([row()])
    expect(line).toContain('agy 探测失败,重试中')
    expect(line).toContain('已重探 1 次')
    expect(line).toContain('2026-10-04T03:14:44.000Z')
    expect(line).toContain('5012ms 内没退出')
  })
  it('registered ⇒ 说明是晚注册上的', () => {
    expect(formatProviderProbes([row({ state: 'registered', attempts: 2, registered_at: '2026-10-04T03:14:44.100Z', next_attempt_at: null })])[0]).toContain('第 2 次重探通过,已注册')
  })
  it('空表 ⇒ 都通过;null(daemon 没在跑 / 老 daemon)⇒ 不知道,不说「没有」', () => {
    expect(formatProviderProbes([])[0]).toContain('都通过')
    expect(formatProviderProbes(null)[0]).toContain('不知道')
    expect(providerProbesFrom(null)).toBeNull()
    expect(providerProbesFrom({ ok: true })).toBeNull()
    expect(providerProbesFrom({ provider_probes: [row()] })).toHaveLength(1)
  })
})
