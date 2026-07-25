import { describe, it, expect } from 'vitest'
import { parseRevealCommand } from './reveal-command'

describe('parseRevealCommand', () => {
  it('parses "揭晓 <id>" and tolerates a leading # + surrounding space', () => {
    expect(parseRevealCommand('揭晓 i1:ccb')).toEqual({ id: 'i1:ccb' })
    expect(parseRevealCommand('揭晓 #i1:ccb')).toEqual({ id: 'i1:ccb' })
    expect(parseRevealCommand('  揭晓   i1:ccb  ')).toEqual({ id: 'i1:ccb' })
  })
  it('returns null for non-reveal text and bare 揭晓 (no id)', () => {
    expect(parseRevealCommand('揭晓')).toBeNull()
    expect(parseRevealCommand('今天天气不错')).toBeNull()
    expect(parseRevealCommand('是')).toBeNull()
  })
})
