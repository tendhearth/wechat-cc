import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import { APPLE_APP_ID, androidCertFingerprints, appleAppSiteAssociation, assetLinks, wellKnown } from '../src/well-known'

const fp = (seed: number) => Array.from({ length: 32 }, (_, i) => ((i + seed) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':')
const FP1 = fp(0), FP2 = fp(7)

describe('.well-known(spec 2026-10-01-tendhearth-pairing-ux §6.1)', () => {
  it('AASA:只认 /pset 与 /pset/*;appID = 团队 + bundle id', () => {
    expect(APPLE_APP_ID).toBe('9Y6JAPDP7A.com.tendhearth.app')
    expect(appleAppSiteAssociation()).toEqual({
      applinks: { details: [{ appIDs: ['9Y6JAPDP7A.com.tendhearth.app'], components: [{ '/': '/pset' }, { '/': '/pset/*' }] }] },
    })
  })
  it('指纹:逗号分隔、去空格、小写规范成大写、畸形丢掉、去重', () => {
    expect(androidCertFingerprints(undefined)).toEqual([])
    expect(androidCertFingerprints('')).toEqual([])
    expect(androidCertFingerprints(` ${FP1.toLowerCase()} , nope, ${FP2},${FP1}`)).toEqual([FP1, FP2])
  })
  it('指纹:长度不对 / 非十六进制 / 缺冒号都丢掉', () => {
    const short = FP1.split(':').slice(1).join(':')
    const long = FP1 + ':AA'
    const nonHex = FP1.replace(/^../, 'ZZ')
    const noColon = FP1.replace(/:/g, '')
    expect(androidCertFingerprints([short, long, nonHex, noColon].join(','))).toEqual([])
  })
  it('assetlinks:有指纹 ⇒ 一条 handle_all_urls;没有 ⇒ [](合法 JSON,验证失败、浏览器兜底)', () => {
    expect(assetLinks(undefined)).toEqual([])
    expect(assetLinks('garbage')).toEqual([])
    expect(assetLinks(FP1)).toEqual([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: 'com.tendhearth.app', sha256_cert_fingerprints: [FP1] },
    }])
  })
  it('wellKnown():设了 secret ⇒ 响应带指纹;未知路径 ⇒ null', async () => {
    const r = wellKnown('/.well-known/assetlinks.json', { ANDROID_CERT_SHA256: `${FP1},bad,${FP2}` })!
    expect(r.headers.get('content-type')).toBe('application/json')
    expect(await r.json()).toEqual(assetLinks(`${FP1},${FP2}`))
    expect(wellKnown('/.well-known/other', {})).toBeNull()
  })
  it('入口:两个文件都是 200 JSON、不重定向、可缓存;测试环境没设 secret ⇒ assetlinks 是 []', async () => {
    const a = await SELF.fetch('https://relay.test/.well-known/apple-app-site-association', { redirect: 'manual' })
    expect(a.status).toBe(200)
    expect(a.headers.get('content-type')).toContain('application/json')
    expect(a.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await a.json()).toEqual(appleAppSiteAssociation())
    const b = await SELF.fetch('https://relay.test/.well-known/assetlinks.json', { redirect: 'manual' })
    expect(b.status).toBe(200)
    expect(b.headers.get('content-type')).toContain('application/json')
    expect(await b.json()).toEqual([])
    expect((await SELF.fetch('https://relay.test/.well-known/other')).status).toBe(404)
  })
  it('既有路由不变:/healthz、/pset、/v2/*', async () => {
    expect((await SELF.fetch('https://relay.test/healthz')).status).toBe(200)
    const p = await SELF.fetch('https://relay.test/pset')
    expect(p.status).toBe(200)
    expect(p.headers.get('content-type')).toContain('text/html')
    expect((await SELF.fetch('https://relay.test/v2/daemon')).status).toBe(426)
    expect((await SELF.fetch('https://relay.test/v2/phone', { headers: { Upgrade: 'websocket' } })).status).toBe(400)
  })
})
