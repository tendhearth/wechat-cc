import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const plugin = require('./with-ios-scene.js') as {
  SCENE_DELEGATE_CLASS: string
  applySceneManifest: (plist: Record<string, unknown>) => Record<string, unknown>
  adoptSceneAppDelegate: (src: string) => string
} & ((c: object) => { mods: { ios: { infoPlist: (c: object) => Promise<{ modResults: Record<string, unknown> }>; appDelegate: (c: object) => Promise<{ modResults: { contents: string; language: string } }> } } })
const sdk57 = readFileSync(join(here, 'fixtures', 'AppDelegate.sdk57.swift'), 'utf8')

const expoPkg = dirname(require.resolve('expo/package.json'))

describe('with-ios-scene:Info.plist(iOS 27 不认场景生命周期就在启动时断言崩溃)', () => {
  it('加 UIApplicationSceneManifest:单场景、Default Configuration、委托类 = Expo 自带的 EXExpoAppSceneDelegate;不带 storyboard', () => {
    const out = plugin.applySceneManifest({ CFBundleDisplayName: 'Tendhearth', UILaunchStoryboardName: 'SplashScreen' })
    expect(out.CFBundleDisplayName).toBe('Tendhearth')
    expect(out.UILaunchStoryboardName).toBe('SplashScreen')
    expect(out.UIApplicationSceneManifest).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: 'EXExpoAppSceneDelegate' },
        ],
      },
    })
  })

  it('幂等:跑两次结果一样', () => {
    const once = plugin.applySceneManifest({})
    expect(plugin.applySceneManifest(structuredClone(once))).toEqual(once)
  })

  it('委托类名就是 expo 包里 @objc 导出的那个(Expo 改名这里就红)', () => {
    const swift = readFileSync(join(expoPkg, 'ios', 'AppDelegates', 'ExpoAppSceneDelegate.swift'), 'utf8')
    expect(swift).toContain(`@objc(${plugin.SCENE_DELEGATE_CLASS})`)
    expect(swift).toContain('UIWindowSceneDelegate')
  })
})

describe('with-ios-scene:AppDelegate.swift', () => {
  it('SDK 57 模板:声明 ExpoReactNativeFactoryProvider、不再自己建窗口启动 RN(交给场景委托)', () => {
    const out = plugin.adoptSceneAppDelegate(sdk57)
    expect(out).toMatch(/class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider \{/)
    expect(out).not.toContain('UIWindow(frame: UIScreen.main.bounds)')
    expect(out).not.toContain('startReactNative')
    // 工厂照样在 didFinishLaunching 里建好(场景委托从这里取)
    expect(out).toContain('reactNativeFactory = factory')
    expect(out).toContain('var window: UIWindow?')
    expect(out).toContain('var reactNativeFactory: RCTReactNativeFactory?')
    // 深链 / 通用链接的覆写保留(SceneEventForwarder 会转给它们)
    expect(out).toContain('RCTLinkingManager.application(app, open: url, options: options)')
    expect(out).toContain('continue userActivity: NSUserActivity')
    expect(out).toContain('return super.application(application, didFinishLaunchingWithOptions: launchOptions)')
  })

  it('幂等:已经改过的不再动', () => {
    const once = plugin.adoptSceneAppDelegate(sdk57)
    expect(plugin.adoptSceneAppDelegate(once)).toBe(once)
  })

  it('模板变了、锚点找不到 ⇒ 报错(别悄悄生成一个 iOS 27 上启动就崩的 app)', () => {
    expect(() => plugin.adoptSceneAppDelegate(sdk57.replace('UIWindow(frame: UIScreen.main.bounds)', 'UIWindow()'))).toThrow(/with-ios-scene/)
    expect(() => plugin.adoptSceneAppDelegate(sdk57.replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: Foo {'))).toThrow(/with-ios-scene/)
  })

  it('插件的 mods:infoPlist 与 appDelegate 都挂上(Swift 才改,ObjC 报错)', async () => {
    const cfg = plugin({ name: 'x', slug: 'x' }) as any
    const plist = await cfg.mods.ios.infoPlist({ modResults: { A: 1 }, modRequest: { platform: 'ios', introspect: true } })
    expect(plist.modResults.A).toBe(1)
    expect(plist.modResults.UIApplicationSceneManifest).toBeDefined()
    const ad = await cfg.mods.ios.appDelegate({ modResults: { contents: sdk57, language: 'swift' }, modRequest: { platform: 'ios', introspect: true } })
    expect(ad.modResults.contents).toContain('ExpoReactNativeFactoryProvider')
    await expect(cfg.mods.ios.appDelegate({ modResults: { contents: '', language: 'objcpp' }, modRequest: { platform: 'ios', introspect: true } })).rejects.toThrow(/with-ios-scene/)
  })
})
