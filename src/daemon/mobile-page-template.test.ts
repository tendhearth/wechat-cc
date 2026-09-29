import { describe, it, expect } from 'vitest'
import { fillMobileTemplate, inlineScriptJson } from './mobile-page-template'

describe('fillMobileTemplate', () => {
  it('fills every runtime key', () => {
    expect(fillMobileTemplate('a{{TOKEN_JSON}}b{{BRAND_ICON_VERSION}}', { TOKEN_JSON: '"x"', BRAND_ICON_VERSION: 'abc123' })).toBe('a"x"babc123')
  })
  it('is single-pass: a value that looks like a marker is not rescanned', () => {
    expect(fillMobileTemplate('{{TOKEN_JSON}}|{{BRAND_ICON_VERSION}}', { TOKEN_JSON: '{{BRAND_ICON_VERSION}}', BRAND_ICON_VERSION: 'IMG' })).toBe('{{BRAND_ICON_VERSION}}|IMG')
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
