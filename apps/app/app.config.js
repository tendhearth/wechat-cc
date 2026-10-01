// app.json 是底;这里只加随构建环境变化的部分(spec §4、§7):
// - TENDHEARTH_APNS_ENV:development(开发构建,沙盒 APNs)/ production(TestFlight、商店、内部分发)——决定 aps-environment 与登记的平台
// - APPLE_TEAM_ID:默认 Nate Gu & Co LLC 的 9Y6JAPDP7A;共享钥匙串组 = <团队>.com.tendhearth.app.shared(src/push/native.ts 读 extra.keychainGroup)
// - GOOGLE_SERVICES_JSON:EAS 的文件型环境变量,或本地 apps/app/google-services.json(都不进 git);没有 ⇒ 安卓拿不到 FCM token(显示「不可用」)
// keychain-access-groups 只在 plugins/with-ios-notify.js 声明(裁决 C7),这里不写 ios.entitlements。
const fs = require('fs')
const path = require('path')
const { TARGET, SHARED_GROUP, extensionKeychainGroups } = require('./plugins/with-ios-notify')

module.exports = ({ config }) => {
  const team = process.env.APPLE_TEAM_ID || '9Y6JAPDP7A'
  const apnsEnv = process.env.TENDHEARTH_APNS_ENV === 'production' ? 'production' : 'development'
  const localGs = path.join(__dirname, 'google-services.json')
  const gs = process.env.GOOGLE_SERVICES_JSON || (fs.existsSync(localGs) ? './google-services.json' : undefined)
  const bundleId = config.ios.bundleIdentifier
  return {
    ...config,
    ios: { ...config.ios, appleTeamId: team },
    android: { ...config.android, ...(gs ? { googleServicesFile: gs } : {}) },
    plugins: [
      ...config.plugins,
      ['expo-notifications', { mode: apnsEnv, icon: './assets/images/notification-icon.png', color: '#4f6b4f' }],
      ['./plugins/with-ios-notify', { teamId: team }],
      './plugins/with-android-push',
      // iOS 27 要求 UIScene 生命周期(否则启动即崩);接上 expo 自带的场景委托
      './plugins/with-ios-scene',
    ],
    extra: {
      ...(config.extra || {}),
      apnsEnv,
      keychainGroup: `${team}.${SHARED_GROUP}`,
      eas: {
        ...((config.extra && config.extra.eas) || {}),
        build: { experimental: { ios: { appExtensions: [{
          targetName: TARGET,
          bundleIdentifier: `${bundleId}.notify`,
          entitlements: { 'keychain-access-groups': extensionKeychainGroups() },
        }] } } },
      },
    },
  }
}
