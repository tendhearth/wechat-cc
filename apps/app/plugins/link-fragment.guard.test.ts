import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import base from '../app.json'

// 锚点探针(spec 2026-10-01-tendhearth-pairing-ux §6.3):配对码的令牌在 # 锚点里,中继看不到。
// 系统相机扫码 → 通用链接 / App Link → app 时,锚点能不能活到 JS 的 redirectSystemPath,取决于下面这些别人的实现。
// 升级依赖时这里先红;红了先去真机 / 模拟器验(Task 9 的 Maestro、Task 12 的真机),再改这里。
const require = createRequire(import.meta.url)
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`))
const read = (...p: string[]) => readFileSync(join(...p), 'utf8')

describe('expo-router 把系统交来的原样 URL 交给 +native-intent 的 redirectSystemPath', () => {
  const router = pkgDir('expo-router')
  it('冷启动:getInitialURL 的结果(不改写)进 redirectSystemPath', () => {
    const src = read(router, 'build', 'getLinkingConfig.js')
    expect(src).toContain('nativeLinking.redirectSystemPath({ path: initialUrl, initial: true })')
    expect(src).toContain('return nativeLinking.redirectSystemPath({ path: url, initial: true })')
  })
  it('热启动:url 事件的原样字符串(只过 applyRedirects)进 redirectSystemPath', () => {
    const src = read(router, 'build', 'link', 'linking.js')
    expect(src).toContain('let href = (0, getRoutesRedirects_1.applyRedirects)(url, redirects);')
    expect(src).toContain('href = await nativeLinking.redirectSystemPath({ path: href, initial: false });')
  })
  it('没有重定向表时 applyRedirects 原样返回;我们的 app.json 没配 redirects', () => {
    expect(read(router, 'build', 'getRoutesRedirects.js')).toMatch(/if \(typeof url !== 'string' \|\| !redirects\) \{\s*return url;/)
    expect(base.expo.plugins).toContain('expo-router')   // 字符串形式 = 无选项 = 无 redirects
  })
})

describe('iOS:通用链接的 webpageURL 以 absoluteString(含锚点)交给 JS', () => {
  it('场景委托把冷启动的 userActivities 与热启动的 continue 转给 AppDelegate 订阅者', () => {
    const src = read(pkgDir('expo'), 'ios', 'AppDelegates', 'ExpoAppSceneDelegate.swift')
    expect(src).toContain('connectionOptions.userActivities.forEach { forwarder.continue($0) }')
    expect(src).toContain('open func scene(_ scene: UIScene, continue userActivity: NSUserActivity)')
  })
  it('expo-linking 记下 webpageURL,给 JS 的是 absoluteString', () => {
    const dir = join(pkgDir('expo-linking'), 'ios')
    expect(read(dir, 'LinkingAppDelegateSubscriber.swift')).toContain('userActivity.webpageURL')
    const mod = read(dir, 'ExpoLinkingModule.swift')
    expect(mod).toContain('ExpoLinkingRegistry.shared.initialURL?.absoluteString')
    expect(mod).toContain('["url": url.absoluteString]')
  })
})

describe('安卓:App Link 的 intent data 以 uri.toString()(含锚点)交给 JS', () => {
  const rn = join(pkgDir('react-native'), 'ReactAndroid', 'src', 'main', 'java', 'com', 'facebook', 'react', 'modules')
  it('冷启动 getInitialURL', () => {
    expect(read(rn, 'intent', 'IntentModule.kt')).toContain('uri.toString()')
  })
  it('热启动 url 事件', () => {
    expect(read(rn, 'core', 'DeviceEventManagerModule.kt')).toContain('put("url", uri.toString())')
  })
})
