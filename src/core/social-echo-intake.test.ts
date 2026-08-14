import { describe, it, expect, vi } from 'vitest'
import { makeEchoIntake } from './social-echo-intake'

const direct = { agent_id: 'ccb', intent_id: 'i1', echo: { blurb: '我认识一位  修相机的\n师傅'.repeat(1), degree: 1 } }
const relayed = { agent_id: 'w', intent_id: 'i1', echo: { blurb: '二度回音', degree: 2, relay_token: 'tok1' } }

function make(status: string | null = 'foraging') {
  const recordEcho = vi.fn(); const markEchoed = vi.fn()
  const intake = makeEchoIntake({ seekStatus: vi.fn(() => status), recordEcho, markEchoed })
  return { intake, recordEcho, markEchoed }
}

describe('makeEchoIntake', () => {
  it('直连回音:peerAgentId=sender、degree 透传、blurb 消毒(空白折叠)、foraging→markEchoed', () => {
    const { intake, recordEcho, markEchoed } = make('foraging')
    expect(intake('ccb', direct as any)).toBe('recorded')
    expect(recordEcho).toHaveBeenCalledWith(expect.objectContaining({
      intentId: 'i1', peerAgentId: 'ccb', degree: 1, peerMasked: '第 1 度的某人',
    }))
    expect(recordEcho.mock.calls[0]![0].content).not.toContain('\n')
    expect(markEchoed).toHaveBeenCalledWith('i1')
  })

  it('relay 回音(带 relay_token):peerAgentId=null、relayVia=sender、relayToken 透传', () => {
    const { intake, recordEcho } = make('foraging')
    expect(intake('w', relayed as any)).toBe('recorded')
    expect(recordEcho).toHaveBeenCalledWith(expect.objectContaining({
      peerAgentId: null, relayVia: 'w', relayToken: 'tok1', degree: 2, peerMasked: '第 2 度的某人',
    }))
  })

  it('echoed 状态仍收(后续回音),但不再 markEchoed', () => {
    const { intake, recordEcho, markEchoed } = make('echoed')
    expect(intake('ccb', direct as any)).toBe('recorded')
    expect(recordEcho).toHaveBeenCalled()
    expect(markEchoed).not.toHaveBeenCalled()
  })

  it('迟到回音:closed/cancelled/proposed → stale 丢弃;未知 seek → unknown', () => {
    for (const st of ['closed', 'cancelled', 'proposed', 'connected']) {
      const { intake, recordEcho } = make(st)
      // connected 例外:仍属活跃关系,收 —— 见实现注释;其余丢
      if (st === 'connected') { expect(intake('ccb', direct as any)).toBe('recorded') }
      else { expect(intake('ccb', direct as any)).toBe('stale'); expect(recordEcho).not.toHaveBeenCalled() }
    }
    const { intake } = make(null)
    expect(intake('ccb', direct as any)).toBe('unknown')
  })
})
