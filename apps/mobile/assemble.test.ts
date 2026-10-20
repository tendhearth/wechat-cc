import { describe, it, expect } from 'vitest'
import { assembleMobilePage, serializeMobilePage } from './assemble'

const BASE: Record<string, string> = {
  'phone.html': '<script>{{>a.js}}</script>', 'a.js': 'var x = {{TOKEN_JSON}}',
  'sw.js': 'sw', 'bootstrap.html': 'b', 'tokens.css': 'k', 'transport.js': 't', 'workbench.js': 'w', 'presence.js': 'p',
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
  it('leaves a registered runtime marker untouched for the daemon to fill later', () => {
    expect(assembleMobilePage(files({ 'a.js': 'id="{{BRAND_ICON_VERSION}}"' })).phone).toContain('{{BRAND_ICON_VERSION}}')
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

describe('inlined scripts drop whole-line // comments (page budget, 10-20)', () => {
  it('strips full-line // comments from included .js, keeps code, trailing comments, strings with //, and files with template literals', async () => {
    const { assembleMobilePage } = await import('./assemble')
    const files: Record<string, string> = {
      'phone.html': '<script>{{>a.js}}{{>markdown-generated.js}}</script>', 'sw.js': '', 'bootstrap.html': '', 'tokens.css': '', 'transport.js': '', 'workbench.js': '', 'presence.js': '',
      'a.js': '// 中文注释\n  // 缩进的注释\nvar u="https://x"//行尾\nvar k=1\n',
      'markdown-generated.js': 'var t=`\n// 这是字符串里的一行\n`\n',
    }
    const p = assembleMobilePage(n => files[n]!).phone
    expect(p).not.toContain('中文注释')
    expect(p).not.toContain('缩进的注释')
    expect(p).toContain('var u="https://x"//行尾')
    expect(p).toContain('var k=1')
    expect(p).toContain('// 这是字符串里的一行')
  })
})
