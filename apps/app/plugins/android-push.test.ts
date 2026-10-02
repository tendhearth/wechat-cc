import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const p = require('./with-android-push.js') as {
  firebaseMessagingVersion(t: string): string
  patchManifest(m: any): any
  patchAppGradle(t: string, v: string): string
  copySources(androidRoot: string): void
  SERVICE: string
  EXPO_SERVICE: string
}
const manifest = () => ({ manifest: { $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' }, application: [{ $: { 'android:name': '.MainApplication' }, activity: [] }] } })
const notifDir = () => dirname(require.resolve('expo-notifications/package.json'))

describe('with-android-push', () => {
  it('从 expo-notifications 的 build.gradle 读出 firebase-messaging 版本(与它用同一个)', () => {
    const gradle = readFileSync(join(notifDir(), 'android', 'build.gradle'), 'utf8')
    expect(p.firebaseMessagingVersion(gradle)).toMatch(/^\d+\.\d+\.\d+$/)
    expect(() => p.firebaseMessagingVersion('nothing here')).toThrow(/firebase-messaging/)
  })
  it('manifest:登记我们的服务(MESSAGING_EVENT、不导出),移除 expo 自带的那个;POST_NOTIFICATIONS;重复打补丁不重复加', () => {
    const m = p.patchManifest(p.patchManifest(manifest()))
    const app = m.manifest.application[0]
    expect(m.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools')
    const ours = app.service.filter((s: any) => s.$['android:name'] === p.SERVICE)
    expect(ours).toHaveLength(1)
    expect(ours[0].$['android:exported']).toBe('false')
    expect(ours[0]['intent-filter'][0].action[0].$['android:name']).toBe('com.google.firebase.MESSAGING_EVENT')
    expect(app.service.filter((s: any) => s.$['android:name'] === p.EXPO_SERVICE && s.$['tools:node'] === 'remove')).toHaveLength(1)
    expect(m.manifest['uses-permission'].filter((u: any) => u.$['android:name'] === 'android.permission.POST_NOTIFICATIONS')).toHaveLength(1)
  })
  it('manifest:别的服务与权限原样保留', () => {
    const m = manifest() as any
    m.manifest['uses-permission'] = [{ $: { 'android:name': 'android.permission.CAMERA' } }]
    m.manifest.application[0].service = [{ $: { 'android:name': '.Other' } }]
    const out = p.patchManifest(m)
    expect(out.manifest['uses-permission'].map((u: any) => u.$['android:name'])).toEqual(['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS'])
    expect(out.manifest.application[0].service[0].$['android:name']).toBe('.Other')
  })
  it('app/build.gradle:加一次 firebase-messaging 依赖', () => {
    const base = 'dependencies {\n    implementation("com.facebook.react:react-android")\n}\n'
    const once = p.patchAppGradle(base, '24.1.0')
    expect(p.patchAppGradle(once, '24.1.0')).toBe(once)
    expect(once).toContain('implementation "com.google.firebase:firebase-messaging:24.1.0"')
    expect(() => p.patchAppGradle('android {}\n', '24.1.0')).toThrow(/dependencies/)
  })
  it('EXPO_SERVICE 就是 expo-notifications manifest 里登记的那个类(相对名 + 库的 namespace)', () => {
    const xml = readFileSync(join(notifDir(), 'android', 'src', 'main', 'AndroidManifest.xml'), 'utf8')
    const gradle = readFileSync(join(notifDir(), 'android', 'build.gradle'), 'utf8')
    const ns = /namespace\s*=?\s*["']([^"']+)["']/.exec(gradle)?.[1]
    expect(ns).toBeTruthy()
    expect(p.EXPO_SERVICE.startsWith(`${ns}.`)).toBe(true)
    expect(xml).toContain(`android:name="${p.EXPO_SERVICE.slice(ns!.length)}"`)
  })
})

describe('with-android-push 拷源码', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  it('核心 + 安卓专属 + 生成的 PushStrings.kt 进 app/src/main/java/com/tendhearth/app/push;不拷测试;重复拷幂等、覆盖旧文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'th-android-'))
    dirs.push(root)
    const dest = join(root, 'app', 'src', 'main', 'java', 'com', 'tendhearth', 'app', 'push')
    p.copySources(root)
    const first = readdirSync(dest).sort()
    writeFileSync(join(dest, 'PushCrypto.kt'), 'stale')
    p.copySources(root)
    expect(readdirSync(dest).sort()).toEqual(first)
    const core = readdirSync(join(here, '..', 'native', 'android-push', 'src', 'main', 'kotlin', 'com', 'tendhearth', 'app', 'push'))
    const android = readdirSync(join(here, '..', 'native', 'android-push', 'android'))
    expect(first).toEqual([...core, ...android, 'PushStrings.kt'].filter(f => f.endsWith('.kt')).sort())
    expect(first).toContain('TendhearthMessagingService.kt')
    expect(first).toContain('SecureStoreReader.kt')
    expect(first.some(f => f.endsWith('Test.kt'))).toBe(false)
    expect(readFileSync(join(dest, 'PushCrypto.kt'), 'utf8')).not.toBe('stale')
    expect(readFileSync(join(dest, 'PushStrings.kt'), 'utf8')).toContain('"channel.decide" to')
  })
})

describe('通知小图标与单色图', () => {
  // PNG 的 IHDR:宽、高(大端 32 位)在第 16 / 20 字节,颜色类型在第 25 字节(6 = RGBA)
  const ihdr = (f: string) => { const b = readFileSync(join(here, '..', 'assets', 'images', f)); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: b[25] } }
  it('notification-icon.png:96×96 RGBA(expo-notifications 要白色透明底),单色图 432×432 RGBA', () => {
    expect(ihdr('notification-icon.png')).toEqual({ w: 96, h: 96, type: 6 })
    expect(ihdr('android-icon-monochrome.png')).toEqual({ w: 432, h: 432, type: 6 })
  })
})

describe('安卓原生源码不打日志、不回退到原始数据', () => {
  const src = (f: string) => readFileSync(join(here, '..', 'native', 'android-push', 'android', f), 'utf8')
  it.each(['TendhearthMessagingService.kt', 'SecureStoreReader.kt'])('%s 里没有 Log / println / printStackTrace', f => {
    expect(src(f)).not.toMatch(/\bLog\.|println\(|printStackTrace/)
  })
  it('消息服务的决定走 PushResolver(解不开一律占位),不自己拼标题正文', () => {
    const s = src('TendhearthMessagingService.kt')
    expect(s).toContain('PushResolver.resolve(')
    expect(s).not.toMatch(/data\["(title|body)"\]/)
    expect(s).toContain('"decide"')
    expect(s).toContain('"updates"')
  })
  it('post() 整段兜住任何异常(构造 / 资源 / notify 失败 ⇒ 这条不显示,不让后台进程崩)', () => {
    const s = src('TendhearthMessagingService.kt')
    const post = s.slice(s.indexOf('private fun post('), s.indexOf('private companion object'))
    expect(post).toMatch(/catch \(e: Exception\)/)
    expect(post).not.toMatch(/catch \(e: SecurityException\)/)
    // try 包住整个函数体:try 出现在取 NotificationManager 之前
    expect(post.indexOf('try {')).toBeGreaterThan(-1)
    expect(post.indexOf('try {')).toBeLessThan(post.indexOf('getSystemService('))
  })
})
