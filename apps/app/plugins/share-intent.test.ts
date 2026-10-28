import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { PHONE_CHAT_MAX_IMAGES } from '@wechat-cc/protocol'

// 分享给 CC(2026-10-18):expo-share-intent(钉死 8.0.1)的参数,以及我们依赖的它的实现细节 —— 升级依赖时这里先红。
const require = createRequire(import.meta.url)
const share = require('./share-intent.js') as {
  TARGET: string; DISPLAY_NAME: string; MAX_IMAGES: number
  appGroup(b: string): string; extensionBundleId(b: string): string
  shareIntentParams(b: string): Record<string, any>; easAppExtension(b: string): Record<string, any>
}
const links = require('./with-app-links.js') as { androidIntentFilters(dev: boolean): unknown[] }
const pkgDir = dirname(require.resolve('expo-share-intent/package.json'))
const read = (...p: string[]) => readFileSync(join(pkgDir, ...p), 'utf8')
const plugin = (require('expo-share-intent/app.plugin.js') as { default: (c: object, p: object) => any }).default
const BUNDLE = 'com.tendhearth.app'

describe('plugins/share-intent.js 的参数', () => {
  it('扩展:target TendhearthCC、分享面板显示 Tendhearth CC、bundle id <app>.share(与 .notify 同一种前缀)、App Group group.<app>', () => {
    const p = share.shareIntentParams(BUNDLE)
    expect(p.iosShareExtensionName).toBe('Tendhearth CC')
    expect(p.iosShareExtensionName.replace(/[^a-zA-Z0-9]/g, '')).toBe(share.TARGET)   // 插件按这个规则得 target 名
    expect(share.TARGET).not.toBe('Tendhearth')                                         // 不能和主 app 的 target 同名
    expect(p.iosShareExtensionBundleIdentifier).toBe('com.tendhearth.app.share')
    expect(p.iosAppGroupIdentifier).toBe('group.com.tendhearth.app')
  })
  it(`iOS 只在文字 / 一个网址 / 最多 ${PHONE_CHAT_MAX_IMAGES} 张图时出现(= 协议包 PHONE_CHAT_MAX_IMAGES)`, () => {
    expect(share.MAX_IMAGES).toBe(PHONE_CHAT_MAX_IMAGES)
    expect(share.shareIntentParams(BUNDLE).iosActivationRules).toEqual({
      NSExtensionActivationSupportsText: true,
      NSExtensionActivationSupportsWebURLWithMaxCount: 1,
      NSExtensionActivationSupportsWebPageWithMaxCount: 1,
      NSExtensionActivationSupportsImageWithMaxCount: PHONE_CHAT_MAX_IMAGES,
    })
  })
  it('安卓:SEND 收 text/* 与 image/*,SEND_MULTIPLE 只收 image/*', () => {
    const p = share.shareIntentParams(BUNDLE)
    expect(p.androidIntentFilters).toEqual(['text/*', 'image/*'])
    expect(p.androidMultiIntentFilters).toEqual(['image/*'])
  })
  it('EAS 扩展登记:只带 App Group(扩展拿不到钥匙串组,也不需要)', () => {
    expect(share.easAppExtension(BUNDLE)).toEqual({
      targetName: 'TendhearthCC', bundleIdentifier: 'com.tendhearth.app.share',
      entitlements: { 'com.apple.security.application-groups': ['group.com.tendhearth.app'] },
    })
  })
})

describe('expo-share-intent 插件跑在我们的配置上', () => {
  const base = () => ({ name: 'Tendhearth', slug: 't', scheme: 'tendhearth', sdkVersion: '57.0.0', ios: { bundleIdentifier: BUNDLE }, android: { package: BUNDLE }, _internal: { projectRoot: join(__dirname, '..') } })
  it('主 app entitlements:加 App Group,钥匙串组与关联域名原样留着;Info.plist 写 AppGroupIdentifier(原生模块按它读)', async () => {
    const c = plugin(base(), share.shareIntentParams(BUNDLE))
    const ent = await c.mods.ios.entitlements({ ...c, modResults: { 'keychain-access-groups': ['k'], 'com.apple.developer.associated-domains': ['applinks:x'] }, modRequest: { platform: 'ios', modName: 'entitlements', introspect: true } })
    expect(ent.modResults).toEqual({ 'keychain-access-groups': ['k'], 'com.apple.developer.associated-domains': ['applinks:x'], 'com.apple.security.application-groups': ['group.com.tendhearth.app'] })
    const info = await c.mods.ios.infoPlist({ ...c, modResults: { UIApplicationSceneManifest: { x: 1 } }, modRequest: { platform: 'ios', modName: 'infoPlist', introspect: true } })
    expect(info.modResults).toEqual({ UIApplicationSceneManifest: { x: 1 }, AppGroupIdentifier: 'group.com.tendhearth.app' })
  })
  it('EAS:我们先登记了同名扩展 ⇒ 插件只合并 entitlements,不再加第二条(通知扩展那条不动)', () => {
    const notify = { targetName: 'TendhearthNotify', bundleIdentifier: `${BUNDLE}.notify`, entitlements: { 'keychain-access-groups': ['g'] } }
    const c = plugin({ ...base(), extra: { eas: { build: { experimental: { ios: { appExtensions: [notify, share.easAppExtension(BUNDLE)] } } } } } }, share.shareIntentParams(BUNDLE))
    expect(c.extra.eas.build.experimental.ios.appExtensions).toEqual([notify, share.easAppExtension(BUNDLE)])
  })
  it('安卓 manifest:SEND / SEND_MULTIPLE 接在后面,启动项与 App Links(/pset)那两条原样留着', async () => {
    const launcher = { action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }], category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }] }
    const appLinks = { $: { 'android:autoVerify': 'true' }, action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }], data: [{ $: { 'android:scheme': 'https', 'android:host': 'relay.tendhearth.com', 'android:path': '/pset' } }] }
    const manifest = { manifest: { $: {}, application: [{ $: { 'android:name': '.MainApplication' }, activity: [{ $: { 'android:name': '.MainActivity', 'android:launchMode': 'singleTask' }, 'intent-filter': [launcher, appLinks] }] }] } }
    const c = plugin({ ...base(), android: { package: BUNDLE, intentFilters: links.androidIntentFilters(false) } }, share.shareIntentParams(BUNDLE))
    const out = await c.mods.android.manifest({ ...c, modResults: manifest, modRequest: { platform: 'android', modName: 'manifest', introspect: true } })
    const activity = out.modResults.manifest.application[0].activity[0]
    const filters = activity['intent-filter'] as Array<{ action: Array<{ $: Record<string, string> }>; data?: Array<{ $: Record<string, string> }> }>
    expect(filters.slice(0, 2)).toEqual([launcher, appLinks])
    const by = (a: string) => filters.find(f => f.action[0]!.$['android:name'] === a)!
    expect(by('android.intent.action.SEND').data!.map(d => d.$['android:mimeType'])).toEqual(['text/*', 'image/*'])
    expect(by('android.intent.action.SEND_MULTIPLE').data!.map(d => d.$['android:mimeType'])).toEqual(['image/*'])
    expect(activity.$['android:launchMode']).toBe('singleTask')
  })
})

describe('expo-share-intent 8.0.1 的实现细节(state/ShareGate 与 push/open 靠它)', () => {
  it('版本钉死', () => {
    expect(JSON.parse(read('package.json')).version).toBe('8.0.1')
    const app = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    expect(app.dependencies['expo-share-intent']).toBe('8.0.1')
  })
  it('分享扩展开 <scheme>://dataUrl=<scheme>ShareKey?nonce=…#类型(open.ts 把它改写到 /share;getShareExtensionKey 就是这个键)', () => {
    const swift = read('plugin', 'build', 'ios', 'ShareExtensionViewController.swift')
    expect(swift).toContain('let sharedKey: String = "<SCHEME>ShareKey"')
    expect(swift).toContain('URL(string: "\\(shareProtocol)://dataUrl=\\(sharedKey)?nonce=\\(nonce)#\\(type)")')
    expect(read('build', 'utils.js')).toContain('return `${scheme}ShareKey`;')
  })
  it('iOS 原生模块:按 Info.plist 的 AppGroupIdentifier 找 App Group;onChange 给 JSON 字符串', () => {
    const mod = read('ios', 'ExpoShareIntentModule.swift')
    expect(mod).toContain('Bundle.main.object(forInfoDictionaryKey: "AppGroupIdentifier")')
    expect(mod).toContain('"value": json')
  })
  it('安卓原生模块:文件带 contentUri(view/share.ts 优先用它);文字带 meta.title;getShareIntent 取走即清', () => {
    const kt = read('android', 'src', 'main', 'java', 'expo', 'modules', 'shareintent', 'ExpoShareIntentModule.kt')
    expect(kt).toContain('"contentUri" to uri.toString()')
    expect(kt).toContain('"title" to intent.getCharSequenceExtra(Intent.EXTRA_TITLE)')
    expect(kt).toMatch(/handleShareIntent\(ExpoShareIntentSingleton\.intent!!\);\s*\n\s*ExpoShareIntentSingleton\.intent = null/)
  })
})
