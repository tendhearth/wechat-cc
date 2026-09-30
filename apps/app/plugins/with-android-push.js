// 安卓消息服务(spec §7):prebuild 时把 native/android-push 的核心与服务拷进 android/app,登记服务、移除 expo 自带的消息服务、
// 加 firebase-messaging 依赖(版本取 expo-notifications 自己用的那个)与 POST_NOTIFICATIONS。android/ 不进 git;重复 prebuild 幂等。
// google-services.json 不归这里管:app.config.js 有文件才设 android.googleServicesFile,expo 自带的插件负责拷文件与 gradle 插件。
const fs = require('fs')
const path = require('path')
const { withAndroidManifest, withAppBuildGradle, withDangerousMod } = require('expo/config-plugins')
const { loadStrings, kotlinSource } = require('./push-strings')

const SERVICE = '.push.TendhearthMessagingService'
// expo-notifications 的 manifest 写的是相对名 .service.ExpoFirebaseMessagingService,库 namespace 是 expo.modules.notifications;
// 合并 manifest 时相对名按库的 namespace 展开,tools:node="remove" 要写全名才对得上(android-push.test.ts 核对)。
const EXPO_SERVICE = 'expo.modules.notifications.service.ExpoFirebaseMessagingService'
const NATIVE = path.join(__dirname, '..', 'native', 'android-push')
const CORE = path.join(NATIVE, 'src', 'main', 'kotlin', 'com', 'tendhearth', 'app', 'push')
const ANDROID_ONLY = path.join(NATIVE, 'android')
const MARK = '// tendhearth: firebase-messaging for TendhearthMessagingService'

function firebaseMessagingVersion(gradleText) {
  const m = /firebase-messaging:([0-9][0-9.]*)/.exec(gradleText)
  if (!m) throw new Error('with-android-push: 在 expo-notifications 的 android/build.gradle 里找不到 firebase-messaging 版本')
  return m[1]
}

function expoNotificationsGradle() {
  const dir = path.dirname(require.resolve('expo-notifications/package.json', { paths: [path.join(__dirname, '..')] }))
  return fs.readFileSync(path.join(dir, 'android', 'build.gradle'), 'utf8')
}

function patchManifest(m) {
  const root = m.manifest
  root.$ = root.$ || {}
  root.$['xmlns:tools'] = 'http://schemas.android.com/tools'
  root['uses-permission'] = root['uses-permission'] || []
  if (!root['uses-permission'].some(u => u.$['android:name'] === 'android.permission.POST_NOTIFICATIONS')) {
    root['uses-permission'].push({ $: { 'android:name': 'android.permission.POST_NOTIFICATIONS' } })
  }
  const app = root.application[0]
  app.service = (app.service || []).filter(s => s.$['android:name'] !== SERVICE && s.$['android:name'] !== EXPO_SERVICE)
  app.service.push({
    $: { 'android:name': SERVICE, 'android:exported': 'false' },
    'intent-filter': [{ $: { 'android:priority': '10' }, action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }] }],
  })
  app.service.push({ $: { 'android:name': EXPO_SERVICE, 'tools:node': 'remove' } })
  return m
}

function patchAppGradle(text, version) {
  if (text.includes(MARK)) return text
  if (!/dependencies\s*\{/.test(text)) throw new Error('with-android-push: app/build.gradle 里没有 dependencies { } 块')
  return text.replace(/dependencies\s*\{/, `dependencies {\n    ${MARK}\n    implementation "com.google.firebase:firebase-messaging:${version}"`)
}

/** 目标目录整个重建(只放我们的文件):源码删了、改名了,旧的不会留在 android/ 里。 */
function copySources(androidRoot) {
  const dest = path.join(androidRoot, 'app', 'src', 'main', 'java', 'com', 'tendhearth', 'app', 'push')
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  for (const dir of [CORE, ANDROID_ONLY]) {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.kt'))) fs.copyFileSync(path.join(dir, f), path.join(dest, f))
  }
  fs.writeFileSync(path.join(dest, 'PushStrings.kt'), kotlinSource(loadStrings()))
}

function withAndroidPush(config) {
  config = withDangerousMod(config, ['android', c => { copySources(c.modRequest.platformProjectRoot); return c }])
  config = withAndroidManifest(config, c => { c.modResults = patchManifest(c.modResults); return c })
  config = withAppBuildGradle(config, c => {
    c.modResults.contents = patchAppGradle(c.modResults.contents, firebaseMessagingVersion(expoNotificationsGradle()))
    return c
  })
  return config
}

module.exports = withAndroidPush
module.exports.SERVICE = SERVICE
module.exports.EXPO_SERVICE = EXPO_SERVICE
module.exports.firebaseMessagingVersion = firebaseMessagingVersion
module.exports.patchManifest = patchManifest
module.exports.patchAppGradle = patchAppGradle
module.exports.copySources = copySources
