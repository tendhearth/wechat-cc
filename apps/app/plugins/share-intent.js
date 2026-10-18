// 「分享给 CC」(2026-10-18):系统分享面板里出现 Tendhearth CC,接文字 / 链接 / 图片。原生部分用 expo-share-intent(钉死 8.0.1)的插件,
// 这里只放它的参数与 EAS 的扩展登记,app.config.js 与测试共用(和 with-ios-notify 导出钥匙串组同一个做法)。
// - iOS:建 TendhearthCC 分享扩展(bundle id <app>.share),主 app 与扩展共用 App Group(group.<app>);扩展把内容写进 App Group,
//   再开 tendhearth://dataUrl=…(app/+native-intent 改写到 /share)。钥匙串组照旧只由 with-ios-notify 声明,这里不碰。
// - 安卓:主 Activity 加 SEND(text/*、image/*)与 SEND_MULTIPLE(image/*);插件是往已有 intent-filter 后面接,App Links 那条原样留着。
const TARGET = 'TendhearthCC'
// 扩展显示名 = 分享面板里那一格的名字(产品名,见 docs/reference/product-naming.md);插件把它去掉空格当 target 名
const DISPLAY_NAME = 'Tendhearth CC'
const appGroup = bundleId => `group.${bundleId}`
const extensionBundleId = bundleId => `${bundleId}.share`
// iOS 分享面板只在这些内容时列出我们:一段文字、一个网址 / 网页、最多 4 张图(= 协议包 PHONE_CHAT_MAX_IMAGES,share-intent.test.ts 钉住)。
// 别的类型(PDF、视频、文件)iOS 上根本不出现;安卓的 text/* 与 image/* 之外同理。
const MAX_IMAGES = 4
const activationRules = () => ({
  NSExtensionActivationSupportsText: true,
  NSExtensionActivationSupportsWebURLWithMaxCount: 1,
  NSExtensionActivationSupportsWebPageWithMaxCount: 1,
  NSExtensionActivationSupportsImageWithMaxCount: MAX_IMAGES,
})

const shareIntentParams = bundleId => ({
  iosShareExtensionName: DISPLAY_NAME,
  iosShareExtensionBundleIdentifier: extensionBundleId(bundleId),
  iosAppGroupIdentifier: appGroup(bundleId),
  iosActivationRules: activationRules(),
  androidIntentFilters: ['text/*', 'image/*'],
  androidMultiIntentFilters: ['image/*'],
})

/** EAS 的扩展登记(签名时按它给扩展配描述文件):与插件自己补的那条同名,插件找到就只合并 entitlements,不再加第二条。 */
const easAppExtension = bundleId => ({
  targetName: TARGET,
  bundleIdentifier: extensionBundleId(bundleId),
  entitlements: { 'com.apple.security.application-groups': [appGroup(bundleId)] },
})

module.exports = { TARGET, DISPLAY_NAME, MAX_IMAGES, appGroup, extensionBundleId, activationRules, shareIntentParams, easAppExtension }
