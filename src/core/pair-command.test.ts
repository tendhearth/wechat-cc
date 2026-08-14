import { describe, it, expect } from 'vitest'
import { parsePairCommand } from './pair-command'

describe('parsePairCommand', () => {
  it('bare 配对 → start', () => { expect(parsePairCommand('配对')).toEqual({ kind: 'start' }) })
  it('配对 with trailing space → start', () => { expect(parsePairCommand('配对  ')).toEqual({ kind: 'start' }) })
  it('配对 <6 digits> → accept', () => { expect(parsePairCommand('配对 483921')).toEqual({ kind: 'accept', code: '483921' }) })
  it('trims + tolerates inner spacing', () => { expect(parsePairCommand('  配对   483921 ')).toEqual({ kind: 'accept', code: '483921' }) })
  it('non-command → null', () => {
    expect(parsePairCommand('配对一下吧')).toBeNull()
    expect(parsePairCommand('配对 12345')).toBeNull()   // 5 digits
    expect(parsePairCommand('配对 4839210')).toBeNull() // 7 digits
    expect(parsePairCommand('揭晓 x')).toBeNull()
    expect(parsePairCommand('')).toBeNull()
  })
})
