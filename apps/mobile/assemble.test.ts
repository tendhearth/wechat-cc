import { describe, it, expect } from 'vitest'
import { assembleMobilePage, serializeMobilePage } from './assemble'

const BASE: Record<string, string> = {
  'phone.html': '<script>{{>a.js}}</script>', 'a.js': 'var x = {{TOKEN_JSON}}',
  'sw.js': 'sw', 'bootstrap.html': 'b', 'transport.js': 't', 'workbench.js': 'w', 'presence.js': 'p',
}
function files(over: Record<string, string> = {}) {
  const all = { ...BASE, ...over }
  return (name: string) => {
    const text = all[name]
    if (text === undefined) throw new Error(`no file ${name}`)
    return text
  }
}

describe('assembleMobilePage', () => {
  it('inlines includes verbatim and leaves runtime markers for the daemon', () => {
    const page = assembleMobilePage(files())
    expect(page.phone).toBe('<script>var x = {{TOKEN_JSON}}</script>')
    expect(page).toMatchObject({ sw: 'sw', bootstrap: 'b', transport: 't', scripts: { workbench: 'w', presence: 'p' } })
  })
  it('expands nested includes', () => {
    expect(assembleMobilePage(files({ 'phone.html': '{{>a.html}}', 'a.html': '[{{>b.css}}]', 'b.css': 'c' })).phone).toBe('[c]')
  })
  it('keeps $-replacement patterns literal', () => {
    const js = "s.replace(/x/, '$&$1$$$`')"
    expect(assembleMobilePage(files({ 'a.js': js })).phone).toBe(`<script>${js}</script>`)
  })
  it('accepts digits in runtime marker names', () => {
    expect(assembleMobilePage(files({ 'a.js': 'src="{{ART_LIT_B64}}"' })).phone).toContain('{{ART_LIT_B64}}')
  })
  it('refuses include cycles', () => {
    expect(() => assembleMobilePage(files({ 'a.js': '{{>phone.html}}' }))).toThrow(/include cycle phone\.html → a\.js → phone\.html/)
  })
  it('refuses unknown runtime markers', () => {
    expect(() => assembleMobilePage(files({ 'a.js': '{{TOKNE_JSON}}' }))).toThrow('unknown runtime marker {{TOKNE_JSON}}')
  })
  it.each(['{{token_json}}', '{{Token_JSON}}', '{{> boot.js}}', '{{>boot.ts}}', '{{ TOKEN_JSON }}'])(
    'refuses a malformed marker %s instead of shipping it literally', (marker) => {
      expect(() => assembleMobilePage(files({ 'a.js': `x ${marker} y` }))).toThrow(/malformed or unknown marker/)
    })
  it('fails loudly on a missing include', () => {
    expect(() => assembleMobilePage(files({ 'a.js': '{{>nope.js}}' }))).toThrow('no file nope.js')
  })
  it('serializes as stable pretty JSON with a trailing newline', () => {
    const page = assembleMobilePage(files())
    const text = serializeMobilePage(page)
    expect(text.endsWith('}\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(page)
    expect(serializeMobilePage(assembleMobilePage(files()))).toBe(text)
  })
})
