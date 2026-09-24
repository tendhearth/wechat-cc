import { describe, it, expect } from 'vitest'
import { fillMobileTemplate, inlineScriptJson } from './mobile-page-template'

describe('fillMobileTemplate', () => {
  it('fills every runtime key', () => {
    expect(fillMobileTemplate('a{{TOKEN_JSON}}b{{ART_LIT_B64}}', { TOKEN_JSON: '"x"', ART_LIT_B64: 'QQ==' })).toBe('a"x"bQQ==')
  })
  it('is single-pass: a value that looks like a marker is not rescanned', () => {
    expect(fillMobileTemplate('{{TOKEN_JSON}}|{{ART_LIT_B64}}', { TOKEN_JSON: '{{ART_LIT_B64}}', ART_LIT_B64: 'IMG' })).toBe('{{ART_LIT_B64}}|IMG')
  })
  it('inserts $-patterns literally', () => {
    expect(fillMobileTemplate('[{{TOKEN_JSON}}]', { TOKEN_JSON: "$&$'$`$$" })).toBe("[$&$'$`$$]")
  })
  it('throws on a key with no value instead of shipping {{…}} to the phone', () => {
    expect(() => fillMobileTemplate('{{REMOTE_JSON}}', {})).toThrow('mobile page template: no value for {{REMOTE_JSON}}')
  })
})

describe('inlineScriptJson', () => {
  it('cannot close the surrounding <script>', () => {
    expect(inlineScriptJson('</script>')).toBe('"\\u003c/script>"')
  })
  it('encodes null and objects like JSON.stringify', () => {
    expect(inlineScriptJson(null)).toBe('null')
    expect(inlineScriptJson({ relay: 'wss://r', id: 'd' })).toBe('{"relay":"wss://r","id":"d"}')
  })
})
