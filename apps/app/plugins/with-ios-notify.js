// iOS 通知服务扩展(spec §7):prebuild 时建 TendhearthNotify target、拷源码、写 Info.plist 与 entitlements,
// 主 app 加 keychain-access-groups。钥匙串组只在这里声明(裁决 C7:唯一来源;app.config.js 的 EAS appExtensions 也从这里取)。
// 源码只在 native/ios-notify/,ios/ 不进 git。重复 prebuild(不带 --clean)也幂等:target 已在就不再加。
const fs = require('fs')
const path = require('path')
const { withDangerousMod, withEntitlementsPlist, withXcodeProject } = require('expo/config-plugins')
const { loadStrings, swiftSource } = require('./push-strings')

const TARGET = 'TendhearthNotify'
const SHARED_GROUP = 'com.tendhearth.app.shared'
const NATIVE = path.join(__dirname, '..', 'native', 'ios-notify')
const swiftIn = dir => fs.readdirSync(dir).filter(f => f.endsWith('.swift')).sort().map(f => path.join(dir, f))
const swiftFiles = () => [...swiftIn(path.join(NATIVE, 'Sources', 'PushCore')), ...swiftIn(path.join(NATIVE, 'Extension'))]

/** 主 app:自己的组排第一(不带 accessGroup 的写入 —— 配对记录 —— 仍落在私有组),再是与扩展共享的组。 */
const mainKeychainGroups = bundleId => [`$(AppIdentifierPrefix)${bundleId}`, `$(AppIdentifierPrefix)${SHARED_GROUP}`]
/** 扩展:只有共享组(读得到推送密钥,读不到配对记录)。 */
const extensionKeychainGroups = () => [`$(AppIdentifierPrefix)${SHARED_GROUP}`]

const infoPlist = ({ version, build }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key><string>${TARGET}</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${build}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>
</dict>
</plist>
`

const entitlementsPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>keychain-access-groups</key>
  <array>${extensionKeychainGroups().map(g => `<string>${g}</string>`).join('')}</array>
</dict>
</plist>
`

function writeExtensionFiles(iosRoot, { version, build }) {
  const dir = path.join(iosRoot, TARGET)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of swiftFiles()) fs.copyFileSync(f, path.join(dir, path.basename(f)))
  fs.writeFileSync(path.join(dir, 'PushStrings.swift'), swiftSource(loadStrings()))
  fs.writeFileSync(path.join(dir, 'Info.plist'), infoPlist({ version, build }))
  fs.writeFileSync(path.join(dir, `${TARGET}.entitlements`), entitlementsPlist())
}

const unquote = s => String(s).replace(/^"(.*)"$/, '$1')

function hasTarget(project) {
  const targets = project.pbxNativeTargetSection()
  return Object.keys(targets).some(k => !k.endsWith('_comment') && targets[k] && unquote(targets[k].name) === TARGET)
}

function addExtensionTarget(project, { bundleId, teamId }) {
  if (hasTarget(project)) return
  const objects = project.hash.project.objects
  objects.PBXTargetDependency = objects.PBXTargetDependency || {}
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {}

  // 主 target 的部署版本抄给扩展
  const configs = project.pbxXCBuildConfigurationSection()
  let deployment = '16.4'
  for (const k of Object.keys(configs)) {
    const s = configs[k] && configs[k].buildSettings
    if (s && s.IPHONEOS_DEPLOYMENT_TARGET && s.PRODUCT_BUNDLE_IDENTIFIER && unquote(s.PRODUCT_BUNDLE_IDENTIFIER) === bundleId) deployment = s.IPHONEOS_DEPLOYMENT_TARGET
  }

  const sources = [...swiftFiles().map(f => path.basename(f)), 'PushStrings.swift']
  const target = project.addTarget(TARGET, 'app_extension', TARGET, `${bundleId}.notify`)
  const group = project.addPbxGroup([...sources, 'Info.plist', `${TARGET}.entitlements`], TARGET, TARGET)
  const mainGroup = project.getFirstProject().firstProject.mainGroup
  project.addToPbxGroup(group.uuid, mainGroup)
  project.addBuildPhase(sources, 'PBXSourcesBuildPhase', 'Sources', target.uuid)
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid)
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid)

  for (const k of Object.keys(configs)) {
    const c = configs[k]
    if (!c || !c.buildSettings || unquote(c.buildSettings.PRODUCT_NAME) !== TARGET) continue
    Object.assign(c.buildSettings, {
      INFOPLIST_FILE: `${TARGET}/Info.plist`,
      CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
      CODE_SIGN_STYLE: 'Automatic',
      DEVELOPMENT_TEAM: teamId,
      IPHONEOS_DEPLOYMENT_TARGET: deployment,
      TARGETED_DEVICE_FAMILY: '"1,2"',
      SWIFT_VERSION: '5.0',
      PRODUCT_BUNDLE_IDENTIFIER: `${bundleId}.notify`,
      GENERATE_INFOPLIST_FILE: 'NO',
      SKIP_INSTALL: 'YES',
    })
  }
}

function withIosNotify(config, { teamId }) {
  const bundleId = config.ios.bundleIdentifier
  config = withEntitlementsPlist(config, c => {
    c.modResults['keychain-access-groups'] = mainKeychainGroups(bundleId)
    return c
  })
  config = withDangerousMod(config, ['ios', c => {
    writeExtensionFiles(c.modRequest.platformProjectRoot, { version: c.version || '1.0.0', build: (c.ios && c.ios.buildNumber) || '1' })
    return c
  }])
  config = withXcodeProject(config, c => {
    addExtensionTarget(c.modResults, { bundleId, teamId })
    return c
  })
  return config
}

module.exports = withIosNotify
module.exports.TARGET = TARGET
module.exports.SHARED_GROUP = SHARED_GROUP
module.exports.infoPlist = infoPlist
module.exports.entitlementsPlist = entitlementsPlist
module.exports.mainKeychainGroups = mainKeychainGroups
module.exports.extensionKeychainGroups = extensionKeychainGroups
