// 真机验收的 XCUITest target(scripts/device-e2e.ts)。只在 TENDHEARTH_UITESTS=1 时由 app.config.js 接上 —— 平常的 prebuild / EAS 构建里没有它。
// prebuild 时:拷 native/ios-e2e/*.swift 到 ios/TendhearthUITests/,建 UI 测试 target(依赖主 app),写一个共享 scheme `TendhearthUITests`
// (build-for-testing 要 scheme)。源码只在 native/ios-e2e/,ios/ 不进 git。重复 prebuild(不带 --clean)也幂等:target 已在就不再加。
//
// 为什么是 XCUITest 而不是 Maestro(2026-10-01 真机实测):Maestro 2.11 对这台 iOS 27 真机报「Device … is not connected」(它只认模拟器);
// 构建用 Release 配置(JS 打进包里、不连 Metro;为什么不用 Debug 见 src/e2e-build.ts)。
// 而 XCUITest 能接管已在跑的 app(XCUIApplication(bundleIdentifier:))、能点 SpringBoard 的通知横幅 / 通知中心 / 权限框。
const fs = require('fs')
const path = require('path')
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins')

const UI_TARGET = 'TendhearthUITests'
const NATIVE = path.join(__dirname, '..', 'native', 'ios-e2e')
const swiftSources = () => fs.readdirSync(NATIVE).filter(f => f.endsWith('.swift')).sort()
const unquote = s => String(s).replace(/^"(.*)"$/, '$1')

function findTarget(project, name) {
  const targets = project.pbxNativeTargetSection()
  const key = Object.keys(targets).find(k => !k.endsWith('_comment') && targets[k] && unquote(targets[k].name) === name)
  return key ? { uuid: key, target: targets[key] } : null
}

/** 主 app target:产品类型是 application 的那一个(Expo 模板里就一个)。 */
function appTarget(project) {
  const targets = project.pbxNativeTargetSection()
  const key = Object.keys(targets).find(k => !k.endsWith('_comment') && targets[k] && unquote(targets[k].productType) === 'com.apple.product-type.application')
  if (!key) throw new Error('with-ios-uitests: no application target in the Xcode project')
  return { uuid: key, name: unquote(targets[key].name) }
}

/** 删掉 from 对 to 的显式依赖(PBXTargetDependency + 它的 PBXContainerItemProxy)。 */
function dropDependency(project, fromUuid, toUuid) {
  const objects = project.hash.project.objects
  const from = project.pbxNativeTargetSection()[fromUuid]
  const deps = objects.PBXTargetDependency || {}
  const proxies = objects.PBXContainerItemProxy || {}
  if (!from || !Array.isArray(from.dependencies)) return
  from.dependencies = from.dependencies.filter(d => {
    const dep = deps[d.value]
    if (!dep || dep.target !== toUuid) return true
    delete proxies[dep.targetProxy]; delete proxies[`${dep.targetProxy}_comment`]
    delete deps[d.value]; delete deps[`${d.value}_comment`]
    return false
  })
}

function addUiTestTarget(project, { bundleId, teamId }) {
  const app = appTarget(project)
  const existing = findTarget(project, UI_TARGET)
  if (existing) return { app, testUuid: existing.uuid }
  const objects = project.hash.project.objects
  objects.PBXTargetDependency = objects.PBXTargetDependency || {}
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {}

  const configs = project.pbxXCBuildConfigurationSection()
  let deployment = '16.4'
  for (const k of Object.keys(configs)) {
    const s = configs[k] && configs[k].buildSettings
    if (s && s.IPHONEOS_DEPLOYMENT_TARGET && s.PRODUCT_BUNDLE_IDENTIFIER && unquote(s.PRODUCT_BUNDLE_IDENTIFIER) === bundleId) deployment = s.IPHONEOS_DEPLOYMENT_TARGET
  }

  // xcode 库没有 ui-testing 类型:按 unit_test_bundle 建,再把产品类型与产物名改成 UI 测试的
  const target = project.addTarget(UI_TARGET, 'unit_test_bundle', UI_TARGET, `${bundleId}.uitests`)
  target.pbxNativeTarget.productType = '"com.apple.product-type.bundle.ui-testing"'
  const fileRefs = project.pbxFileReferenceSection()
  const refKey = target.pbxNativeTarget.productReference
  const ref = fileRefs[refKey]
  if (ref) {
    Object.assign(ref, { name: `"${UI_TARGET}.xctest"`, path: `"${UI_TARGET}.xctest"`, explicitFileType: 'wrapper.cfbundle', includeInIndex: 0 })
    delete ref.fileEncoding
    delete ref.lastKnownFileType
    fileRefs[`${refKey}_comment`] = `${UI_TARGET}.xctest`
  }
  target.pbxNativeTarget.productReference_comment = `${UI_TARGET}.xctest`
  // xcode 库的 addTarget 顺手让第一个 target(主 app)依赖新 target —— UI 测试反过来依赖 app,留着就成环(Xcode 报 Cycle in dependencies)。
  dropDependency(project, app.uuid, target.uuid)

  const sources = swiftSources()
  const group = project.addPbxGroup(sources, UI_TARGET, UI_TARGET)
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup)
  project.addBuildPhase(sources, 'PBXSourcesBuildPhase', 'Sources', target.uuid)
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid)
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid)
  project.addTargetDependency(target.uuid, [app.uuid])

  for (const k of Object.keys(configs)) {
    const c = configs[k]
    if (!c || !c.buildSettings || unquote(c.buildSettings.PRODUCT_NAME) !== UI_TARGET) continue
    delete c.buildSettings.INFOPLIST_FILE
    Object.assign(c.buildSettings, {
      GENERATE_INFOPLIST_FILE: 'YES',
      TEST_TARGET_NAME: `"${app.name}"`,
      CODE_SIGN_STYLE: 'Automatic',
      DEVELOPMENT_TEAM: teamId,
      IPHONEOS_DEPLOYMENT_TARGET: deployment,
      TARGETED_DEVICE_FAMILY: '"1,2"',
      SWIFT_VERSION: '5.0',
      PRODUCT_BUNDLE_IDENTIFIER: `${bundleId}.uitests`,
      SDKROOT: 'iphoneos',
    })
  }
  return { app, testUuid: target.uuid }
}

function schemeXml({ projectFile, app, testUuid }) {
  const ref = (uuid, buildable, name) =>
    `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${uuid}" BuildableName="${buildable}" BlueprintName="${name}" ReferencedContainer="container:${projectFile}"></BuildableReference>`
  const appRef = ref(app.uuid, `${app.name}.app`, app.name)
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
    <BuildActionEntries>
      <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">
        ${appRef}
      </BuildActionEntry>
    </BuildActionEntries>
  </BuildAction>
  <TestAction buildConfiguration="Release" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES">
    <Testables>
      <TestableReference skipped="NO">
        ${ref(testUuid, `${UI_TARGET}.xctest`, UI_TARGET)}
      </TestableReference>
    </Testables>
  </TestAction>
  <LaunchAction buildConfiguration="Release" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES">
    <BuildableProductRunnable runnableDebuggingMode="0">
      ${appRef}
    </BuildableProductRunnable>
  </LaunchAction>
</Scheme>
`
}

function withIosUiTests(config, { teamId }) {
  const bundleId = config.ios.bundleIdentifier
  config = withDangerousMod(config, ['ios', c => {
    const dir = path.join(c.modRequest.platformProjectRoot, UI_TARGET)
    fs.mkdirSync(dir, { recursive: true })
    for (const f of swiftSources()) fs.copyFileSync(path.join(NATIVE, f), path.join(dir, f))
    return c
  }])
  config = withXcodeProject(config, c => {
    const { app, testUuid } = addUiTestTarget(c.modResults, { bundleId, teamId })
    const projectFile = `${c.modRequest.projectName}.xcodeproj`
    const dir = path.join(c.modRequest.platformProjectRoot, projectFile, 'xcshareddata', 'xcschemes')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${UI_TARGET}.xcscheme`), schemeXml({ projectFile, app, testUuid }))
    return c
  })
  return config
}

module.exports = withIosUiTests
module.exports.UI_TARGET = UI_TARGET
module.exports.schemeXml = schemeXml
module.exports.addUiTestTarget = addUiTestTarget
