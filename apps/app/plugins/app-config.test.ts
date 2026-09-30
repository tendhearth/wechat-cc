import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import base from '../app.json'

const require = createRequire(import.meta.url)
const load = () => { delete require.cache[require.resolve('../app.config.js')]; return require('../app.config.js') as (a: { config: typeof base.expo }) => any }
const plugin = require('./with-ios-notify.js') as {
  TARGET: string; SHARED_GROUP: string
  mainKeychainGroups(bundleId: string): string[]; extensionKeychainGroups(): string[]
  entitlementsPlist(): string; infoPlist(v: { version: string; build: string }): string
}
const envKeys = ['TENDHEARTH_APNS_ENV', 'APPLE_TEAM_ID', 'GOOGLE_SERVICES_JSON'] as const
const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]))

// 裁决 C8:本机有 apps/app/google-services.json(不进 git)时测试也得过 ⇒ 桩掉它的存在性检查。
const fs = require('fs') as typeof import('fs')
const realExists = fs.existsSync
beforeEach(() => { vi.spyOn(fs, 'existsSync').mockImplementation(p => (String(p).endsWith('google-services.json') ? false : realExists(p))) })
afterEach(() => {
  vi.restoreAllMocks()
  for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
})

describe('app.config.js', () => {
  it('默认:开发 APNs、团队 9Y6JAPDP7A 的共享钥匙串组;钥匙串组只由 with-ios-notify 声明(裁决 C7)', () => {
    for (const k of envKeys) delete process.env[k]
    const c = load()({ config: base.expo })
    expect(c.extra.apnsEnv).toBe('development')
    expect(c.extra.keychainGroup).toBe('9Y6JAPDP7A.com.tendhearth.app.shared')
    expect(c.ios.appleTeamId).toBe('9Y6JAPDP7A')
    expect(c.ios.entitlements?.['keychain-access-groups']).toBeUndefined()
    expect(c.plugins).toContainEqual(['expo-notifications', expect.objectContaining({ mode: 'development' })])
    expect(c.plugins).toContainEqual(['./plugins/with-ios-notify', { teamId: '9Y6JAPDP7A' }])
    expect(c.plugins).toContain('./plugins/with-android-push')
    expect(c.android.googleServicesFile).toBeUndefined()
    expect(c.extra.eas.build.experimental.ios.appExtensions).toEqual([{
      targetName: 'TendhearthNotify', bundleIdentifier: 'com.tendhearth.app.notify',
      entitlements: { 'keychain-access-groups': ['$(AppIdentifierPrefix)com.tendhearth.app.shared'] },
    }])
  })
  it('TENDHEARTH_APNS_ENV=production(TestFlight / 商店);GOOGLE_SERVICES_JSON 指到文件', () => {
    process.env.TENDHEARTH_APNS_ENV = 'production'
    process.env.GOOGLE_SERVICES_JSON = '/tmp/gs.json'
    const c = load()({ config: base.expo })
    expect(c.extra.apnsEnv).toBe('production')
    expect(c.plugins).toContainEqual(['expo-notifications', expect.objectContaining({ mode: 'production' })])
    expect(c.android.googleServicesFile).toBe('/tmp/gs.json')
  })
  it('本地有 apps/app/google-services.json(主人放的,不进 git)⇒ 用它;环境变量优先', () => {
    for (const k of envKeys) delete process.env[k]
    vi.mocked(fs.existsSync).mockImplementation(p => (String(p).endsWith('google-services.json') ? true : realExists(p)))
    expect(load()({ config: base.expo }).android.googleServicesFile).toBe('./google-services.json')
    process.env.GOOGLE_SERVICES_JSON = '/tmp/gs.json'
    expect(load()({ config: base.expo }).android.googleServicesFile).toBe('/tmp/gs.json')
  })
  it('APPLE_TEAM_ID 换团队 ⇒ 共享组与插件参数跟着换', () => {
    process.env.APPLE_TEAM_ID = 'ABCDE12345'
    const c = load()({ config: base.expo })
    expect(c.extra.keychainGroup).toBe('ABCDE12345.com.tendhearth.app.shared')
    expect(c.plugins).toContainEqual(['./plugins/with-ios-notify', { teamId: 'ABCDE12345' }])
  })
  it('app.json 里原有的插件都还在', () => {
    const c = load()({ config: base.expo })
    for (const p of base.expo.plugins) expect(c.plugins).toContainEqual(p)
  })
  it('iOS 权限说明 en 与 zh-Hans 同时存在、键一致(计划 3 裁决:只有 zh 会把 en-GB 用户翻成中文)', () => {
    const c = load()({ config: base.expo })
    expect(Object.keys(c.locales).sort()).toEqual(['en', 'zh-Hans'])
    const en = require('../locales/en.json'), zh = require('../locales/zh-Hans.json')
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    const cam = base.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-camera') as [string, { cameraPermission: string }]
    expect(en.NSCameraUsageDescription).toBe(cam[1].cameraPermission)
  })
})

describe('with-ios-notify(钥匙串组的唯一来源)', () => {
  it('主 app:自己的组排第一,再是共享组;扩展只有共享组', () => {
    expect(plugin.TARGET).toBe('TendhearthNotify')
    expect(plugin.SHARED_GROUP).toBe('com.tendhearth.app.shared')
    expect(plugin.mainKeychainGroups('com.tendhearth.app')).toEqual(['$(AppIdentifierPrefix)com.tendhearth.app', '$(AppIdentifierPrefix)com.tendhearth.app.shared'])
    expect(plugin.extensionKeychainGroups()).toEqual(['$(AppIdentifierPrefix)com.tendhearth.app.shared'])
  })
  it('扩展的 entitlements 只有共享组;Info.plist 是通知服务扩展点、版本号跟 app', () => {
    const ent = plugin.entitlementsPlist()
    expect(ent).toContain('<key>keychain-access-groups</key>')
    expect(ent.match(/<string>/g)).toHaveLength(1)
    expect(ent).toContain('<string>$(AppIdentifierPrefix)com.tendhearth.app.shared</string>')
    const info = plugin.infoPlist({ version: '1.2.3', build: '45' })
    expect(info).toContain('<string>com.apple.usernotifications.service</string>')
    expect(info).toContain('<string>$(PRODUCT_MODULE_NAME).NotificationService</string>')
    expect(info).toContain('<key>CFBundleShortVersionString</key><string>1.2.3</string>')
    expect(info).toContain('<key>CFBundleVersion</key><string>45</string>')
  })
  it('插件的 entitlements mod 给主 app 写两个组(保留已有键)', async () => {
    const withIosNotify = require('./with-ios-notify.js') as (c: object, o: { teamId: string }) => { mods: { ios: { entitlements: (c: object) => Promise<{ modResults: Record<string, unknown> }> } } }
    const c = withIosNotify({ name: 'T', slug: 't', ios: { bundleIdentifier: 'com.tendhearth.app' } }, { teamId: '9Y6JAPDP7A' })
    const out = await c.mods.ios.entitlements({ modResults: { 'aps-environment': 'development' }, modRequest: { platform: 'ios', modName: 'entitlements', introspect: true } })
    expect(out.modResults).toEqual({
      'aps-environment': 'development',
      'keychain-access-groups': ['$(AppIdentifierPrefix)com.tendhearth.app', '$(AppIdentifierPrefix)com.tendhearth.app.shared'],
    })
  })
})
