// iOS 27 起 UIKit 在启动时断言 app 采用了 UIScene 生命周期(NoSceneLifecycleAdoption),SDK 57 的模板没有 ⇒ 启动即崩。
// expo 57.0.26 已经自带场景委托 ExpoAppSceneDelegate(@objc 名 EXExpoAppSceneDelegate):从连接的 UIWindowScene 建窗口、
// 把 RN 启动进去、把冷启动的 URL 补进 launchOptions(Linking.getInitialURL 照常)、把 URL / user activity / 生命周期事件
// 转回 ExpoAppDelegate(订阅者与 AppDelegate 的覆写照样收到)。只是模板还没接上,这里在 prebuild 时接:
// 1) Info.plist 加 UIApplicationSceneManifest,委托类直接用 Expo 那个类(不另写 Swift、不动 pbxproj);
// 2) AppDelegate 声明 ExpoReactNativeFactoryProvider(场景委托从这里拿工厂、把窗口挂回 delegate.window),
//    删掉自己建 UIWindow + startReactNative 那段(交给场景委托做)。
// 幂等:重复 prebuild 不重复改;模板变了找不到锚点就报错,别悄悄生成一个在 iOS 27 上启动就崩的 app。
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins')

const SCENE_DELEGATE_CLASS = 'EXExpoAppSceneDelegate'
const PROVIDER = 'ExpoReactNativeFactoryProvider'
const fail = msg => { throw new Error(`with-ios-scene: ${msg}`) }

function applySceneManifest(plist) {
  return {
    ...plist,
    UIApplicationSceneManifest: {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: SCENE_DELEGATE_CLASS },
        ],
      },
    },
  }
}

const CLASS_DECL = 'class AppDelegate: ExpoAppDelegate {'
// 模板里那段:#if os(iOS) || os(tvOS) 里建窗口 + startReactNative,到 #endif
const WINDOW_BLOCK = /\n[ \t]*#if os\(iOS\) \|\| os\(tvOS\)\n[ \t]*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n[ \t]*factory\.startReactNative\([\s\S]*?\)\n[ \t]*#endif\n/

function adoptSceneAppDelegate(src) {
  if (src.includes(`class AppDelegate: ExpoAppDelegate, ${PROVIDER} {`) && !src.includes('startReactNative')) return src
  if (!src.includes(CLASS_DECL)) fail(`找不到「${CLASS_DECL}」——Expo 模板变了,核对场景接法后再改插件`)
  if (!WINDOW_BLOCK.test(src)) fail('找不到模板里建 UIWindow + startReactNative 的那段——Expo 模板变了,核对场景接法后再改插件')
  for (const need of ['var window: UIWindow?', 'var reactNativeFactory: RCTReactNativeFactory?', 'reactNativeFactory = factory']) {
    if (!src.includes(need)) fail(`AppDelegate 里缺「${need}」(ExpoAppSceneDelegate 靠它拿工厂与挂窗口)`)
  }
  return src
    .replace(CLASS_DECL, `class AppDelegate: ExpoAppDelegate, ${PROVIDER} {`)
    .replace(WINDOW_BLOCK, '\n    // 窗口与 React Native 由场景委托(Info.plist 里的 EXExpoAppSceneDelegate)建,见 plugins/with-ios-scene.js\n')
}

const withIosScene = config => {
  config = withInfoPlist(config, c => {
    c.modResults = applySceneManifest(c.modResults)
    return c
  })
  return withAppDelegate(config, c => {
    if (c.modResults.language !== 'swift') fail(`只认 Swift 的 AppDelegate,拿到 ${c.modResults.language}`)
    c.modResults.contents = adoptSceneAppDelegate(c.modResults.contents)
    return c
  })
}

module.exports = withIosScene
module.exports.SCENE_DELEGATE_CLASS = SCENE_DELEGATE_CLASS
module.exports.applySceneManifest = applySceneManifest
module.exports.adoptSceneAppDelegate = adoptSceneAppDelegate
