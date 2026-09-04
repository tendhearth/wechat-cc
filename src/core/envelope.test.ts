import { describe, it, expect } from 'vitest'
import { sealEnvelope, openEnvelope, isEnvelopeText } from './envelope'

describe('envelope', () => {
  it('seal ↔ open 往返', () => {
    const e = { kind: 'visit', payload: { id: 'v', round: 1, max: 6, text: '嗨' } }
    expect(openEnvelope(sealEnvelope(e))).toEqual(e)
  })
  it('**普通信不是信封**(主人写的一封真信在旧对端上必须仍然是一封真信)', () => {
    expect(openEnvelope('你好,见字如面')).toEqual({ kind: 'letter', payload: { text: '你好,见字如面' } })
    expect(isEnvelopeText('你好')).toBe(false)
  })
  it('坏 JSON 当成信而不是抛 —— 抛会断掉整条接收路径', () => {
    expect(openEnvelope('⟪env⟫{not json')).toEqual({ kind: 'letter', payload: { text: '⟪env⟫{not json' } })
    expect(openEnvelope('⟪env⟫{"nokind":1}').kind).toBe('letter')
  })
  it('payload 可以是任意 JSON,含 null', () => {
    expect(openEnvelope(sealEnvelope({ kind: 'ping', payload: null }))).toEqual({ kind: 'ping', payload: null })
  })
})
