import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'

const require = createRequire(import.meta.url)
const links = require('./with-app-links.js') as ((c: object, o?: { dev?: boolean }) => any) & {
  PROD_HOST: string; STAGING_HOST: string
  linkHosts(dev: boolean): string[]; associatedDomains(dev: boolean): string[]
  applyAssociatedDomains(plist: Record<string, unknown>, dev: boolean): Record<string, unknown>
  androidIntentFilters(dev: boolean): unknown[]
}
const notify = require('./with-ios-notify.js') as ((c: object, o: { teamId: string }) => any) & { mainKeychainGroups(b: string): string[] }

describe('with-app-links(spec §6.2)', () => {
  it('发布构建只认生产中继;开发构建再加 staging', () => {
    expect(links.associatedDomains(false)).toEqual(['applinks:relay.tendhearth.com'])
    expect(links.associatedDomains(true)).toEqual(['applinks:relay.tendhearth.com', 'applinks:relay-staging.tendhearth.com'])
  })
  it('entitlements:写 associated-domains,别的键原样留着(钥匙串组归 with-ios-notify)', () => {
    const out = links.applyAssociatedDomains({ 'keychain-access-groups': ['x'] }, false)
    expect(out).toEqual({ 'keychain-access-groups': ['x'], 'com.apple.developer.associated-domains': ['applinks:relay.tendhearth.com'] })
  })
  it('安卓:autoVerify 的 https VIEW,只覆盖 /pset', () => {
    expect(links.androidIntentFilters(false)).toEqual([{
      action: 'VIEW', autoVerify: true, category: ['BROWSABLE', 'DEFAULT'],
      data: [{ scheme: 'https', host: 'relay.tendhearth.com', path: '/pset' }, { scheme: 'https', host: 'relay.tendhearth.com', pathPrefix: '/pset/' }],
    }])
    const dev = links.androidIntentFilters(true) as Array<{ data: Array<{ host: string }> }>
    expect(dev[0]!.data.map(d => d.host)).toEqual(['relay.tendhearth.com', 'relay.tendhearth.com', 'relay-staging.tendhearth.com', 'relay-staging.tendhearth.com'])
  })
})

describe('with-app-links 插件包装本身(R-T8:跑 entitlements mod,不靠 export:check)', () => {
  const run = (cfg: any, plist: Record<string, unknown>) =>
    cfg.mods.ios.entitlements({ modResults: plist, modRequest: { platform: 'ios', introspect: true } })

  it('mod 挂在 ios.entitlements 上,写入 associated-domains 并保留已有键', async () => {
    const out = await run(links({ name: 'x', slug: 'x' }, { dev: true }), { 'aps-environment': 'development' })
    expect(out.modResults['aps-environment']).toBe('development')
    expect(out.modResults['com.apple.developer.associated-domains']).toEqual(links.associatedDomains(true))
  })
  it('不传选项 = 发布口径', async () => {
    const out = await run(links({ name: 'x', slug: 'x' }), {})
    expect(out.modResults['com.apple.developer.associated-domains']).toEqual(['applinks:relay.tendhearth.com'])
  })
  it('与 with-ios-notify 共存:钥匙串组与关联域名都在,顺序无关', async () => {
    const base = { name: 'x', slug: 'x', ios: { bundleIdentifier: 'com.tendhearth.app' } }
    const a = await run(links(notify(base, { teamId: '9Y6JAPDP7A' }), { dev: false }), {})
    const b = await run(notify(links(base, { dev: false }), { teamId: '9Y6JAPDP7A' }), {})
    for (const out of [a, b]) {
      expect(out.modResults['keychain-access-groups']).toEqual(notify.mainKeychainGroups('com.tendhearth.app'))
      expect(out.modResults['com.apple.developer.associated-domains']).toEqual(['applinks:relay.tendhearth.com'])
    }
  })
  it('安卓:插件不碰 manifest(intentFilters 走 app.config.js 的 android 配置)', () => {
    const cfg = links({ name: 'x', slug: 'x' }, { dev: false })
    expect(cfg.mods.android).toBeUndefined()
  })
})
