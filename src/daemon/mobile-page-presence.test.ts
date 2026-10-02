import {describe,it,expect} from 'vitest'
import {phoneHtml} from './settings-panel-html'
import {MOBILE_PRESENCE_JS} from './mobile-page'
import art from './mobile-presence-art.json'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

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
    expect(html).toContain('id="memory-open"')
    const nav=html.match(/<nav>[\s\S]*?<\/nav>/)?.[0]??''
    expect(nav.match(/data-p=/g)).toHaveLength(2)
    expect(nav).toContain('data-p="today"');expect(nav).toContain('data-p="matters"')
    expect(nav).not.toContain('data-p="memory"')
    expect(html).toContain('id="home-focus"')
    expect(html).toContain('id="home-result"')
    for(const id of ['todos','portrait','stickers'])expect(html).toContain(`id="${id}"`)
    expect(html).not.toContain('<span class="i">🌤</span>')
  })
  it('leaves room for the relay envelope inside a 512KB frame',()=>{
    const html=phoneHtml('d'.repeat(128),{relay:'wss://relay.example',id:'test-device'})
    expect(Math.ceil(Buffer.byteLength(html)*4/3)+4096).toBeLessThan(512*1024)
  })
  // 手机协议包 v2 Task 4 fix round 1(2026-09-29):relay 的 512KB 帧预算不能碰
  // (relay/ 不在这个子项目范围内,生产部署是人工的)。page 涨的那 44KB 是内联
  // 的 v1 协议 IIFE,真正的大头(125KB+132KB)是内联的「此刻」形象画,已经搬
  // 到 /m/api/art/presence 按需拉取(不再进页面);这里留出明显的余量
  // (<400KB,而不是刚好卡在 512KB 线上)防止将来再有人往页面里塞大字节的东西
  // 而没人注意到跟中继帧预算的关系。
  it('has real presence art comfortably under the relay frame budget with headroom to spare (<400KB framed)',()=>{
    const html=phoneHtml('d'.repeat(128),{relay:'wss://relay.example',id:'test-device'})
    const framed=Math.ceil(Buffer.byteLength(html)*4/3)+4096
    expect(html).not.toContain(art.unlit.base64)
    expect(html).not.toContain(art.lit.base64)
    expect(framed).toBeLessThan(400*1024)
  })
  it('embeds syntax-valid scripts and escapes a hostile token',()=>{
    const html=phoneHtml('</script><script>evil()</script>',null)
    expect(html).not.toContain('</script><script>evil()')
    expect(()=>new Function(MOBILE_PRESENCE_JS)).not.toThrow()
    for(const [,script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g))expect(()=>new Function(script!)).not.toThrow()
  })
})
