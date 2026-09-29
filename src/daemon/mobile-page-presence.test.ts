import {describe,it,expect} from 'vitest'
import {phoneHtml} from './settings-panel-html'
import {MOBILE_PRESENCE_JS} from './mobile-page'
import art from './mobile-presence-art.json'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {DEFAULT_MAX_FRAME} from '../../relay/tunnel'

describe('production phone presence',()=>{
  it('bundles exact frozen character bytes for compiled and tunnel delivery',()=>{
    for(const entry of Object.values(art)){
      const source=readFileSync(new URL('../../'+entry.source,import.meta.url))
      expect(Buffer.from(entry.base64,'base64')).toEqual(source)
      expect(createHash('sha256').update(source).digest('hex')).toBe(entry.sha256)
    }
  })
  it('moves past events into memories and keeps existing pocket functions reachable',()=>{
    const html=phoneHtml('test',null)
    expect(html).toContain('id="p-memory"')
    expect(html.indexOf('id="feed"')).toBeGreaterThan(html.indexOf('id="p-memory"'))
    expect(html).toContain('data-p="memory"')
    expect(html).toContain('id="home-focus"')
    expect(html).toContain('id="home-result"')
    for(const id of ['todos','portrait','stickers'])expect(html).toContain(`id="${id}"`)
    expect(html).not.toContain('<span class="i">🌤</span>')
  })
  it('leaves room for the relay envelope inside a tunnel frame (relay/tunnel.ts DEFAULT_MAX_FRAME — 2026-09-29 手机协议包 v2 Task 4 bumped this to 1MB, the /m page now ships its own v1 crypto inlined, ~44KB minified)',()=>{
    const html=phoneHtml('d'.repeat(128),{relay:'wss://relay.example',id:'test-device'})
    expect(Math.ceil(Buffer.byteLength(html)*4/3)+4096).toBeLessThan(DEFAULT_MAX_FRAME)
  })
  it('embeds syntax-valid scripts and escapes a hostile token',()=>{
    const html=phoneHtml('</script><script>evil()</script>',null)
    expect(html).not.toContain('</script><script>evil()')
    expect(()=>new Function(MOBILE_PRESENCE_JS)).not.toThrow()
    for(const [,script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g))expect(()=>new Function(script!)).not.toThrow()
  })
})
