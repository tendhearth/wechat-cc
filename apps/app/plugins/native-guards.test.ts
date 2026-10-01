import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { PUSH_KEY_ITEM, PUSH_KEY_SERVICE } from '../src/push/key-store'
import { RELAY_PLACEHOLDER_BODY } from '../src/push/banner'

// 原生端直接读 expo-secure-store 的存储、按中继的占位文字判断:这些是别人的实现细节,升级依赖时这里先红。
const require = createRequire(import.meta.url)
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`))
const read = (...p: string[]) => readFileSync(join(...p), 'utf8')
const here = dirname(fileURLToPath(import.meta.url))

describe('expo-secure-store 的 iOS 钥匙串属性(扩展按它查推送密钥)', () => {
  const swift = read(pkgDir('expo-secure-store'), 'ios', 'SecureStoreModule.swift')
  it('service = keychainService + ":no-auth";account = 键名的 UTF-8', () => {
    expect(swift).toContain('var service = options.keychainService ?? "app"')
    expect(swift).toContain('service.append(":\\(requireAuthentication ? "auth" : "no-auth")")')
    expect(swift).toContain('let encodedKey = Data(key.utf8)')
    expect(swift).toContain('kSecAttrAccount as String: encodedKey')
  })
  it('扩展源码里的 service / account 与 key-store.ts 一致', () => {
    const ext = read(here, '..', 'native', 'ios-notify', 'Extension', 'ExtensionStores.swift')
    expect(ext).toContain(`"${PUSH_KEY_SERVICE}:no-auth"`)
    expect(ext).toContain(`"${PUSH_KEY_ITEM}"`)
  })
  it('扩展的去重读-改-写在一把静态 NSLock 里(并发的扩展实例不会都漏掉重复)', () => {
    const ext = read(here, '..', 'native', 'ios-notify', 'Extension', 'ExtensionStores.swift')
    const dedupe = ext.slice(ext.indexOf('enum DedupeStore'))
    expect(dedupe).toMatch(/static let lock = NSLock\(\)/)
    expect(dedupe).toMatch(/lock\.lock\(\)\s*\n\s*defer \{ lock\.unlock\(\) \}/)
    expect(dedupe.indexOf('lock.lock()')).toBeLessThan(dedupe.indexOf('d.dictionary(forKey:'))
  })
})

describe('中继的 APNs 占位', () => {
  it('apps/relay/src/push-apns.ts 的占位正文就是 RELAY_PLACEHOLDER_BODY', () => {
    expect(read(here, '..', '..', 'relay', 'src', 'push-apns.ts')).toContain(`body: '${RELAY_PLACEHOLDER_BODY}'`)
  })
})

describe('expo-secure-store 的安卓存储格式(TendhearthMessagingService 按它读推送密钥)', () => {
  const dir = join(pkgDir('expo-secure-store'), 'android', 'src', 'main', 'java', 'expo', 'modules', 'securestore')
  const mod = read(dir, 'SecureStoreModule.kt')
  const aes = read(dir, 'encryptors', 'AESEncryptor.kt')
  const auth = read(dir, 'AuthenticationHelper.kt')
  it('SharedPreferences「SecureStore」,键 = "<service>-<key>",记录里有 scheme', () => {
    expect(mod).toContain('SHARED_PREFERENCES_NAME = "SecureStore"')
    expect(mod).toContain('return "$keychainService-$key"')
    expect(mod).toContain('encryptedItem.put(SCHEME_PROPERTY, AESEncryptor.NAME)')
    expect(mod).toContain('SCHEME_PROPERTY = "scheme"')
  })
  it('AES/GCM,Keystore 别名 = "AES/GCM/NoPadding:<service>:keystoreUnauthenticated",字段 ct / iv / tlen', () => {
    expect(aes).toContain('AES_CIPHER = "AES/GCM/NoPadding"')
    expect(aes).toContain('return "$AES_CIPHER:$baseAlias"')
    expect(aes).toContain('return "${getKeyStoreAlias(options)}:$suffix"')
    expect(mod).toContain('UNAUTHENTICATED_KEYSTORE_SUFFIX = "keystoreUnauthenticated"')
    expect(aes).toContain('CIPHERTEXT_PROPERTY = "ct"')
    expect(aes).toContain('IV_PROPERTY = "iv"')
    expect(aes).toContain('GCM_AUTHENTICATION_TAG_LENGTH_PROPERTY = "tlen"')
    expect(aes).toContain('NAME = "aes"')
    expect(aes).toContain('Base64.encodeToString(ciphertextBytes, Base64.NO_WRAP)')
    expect(aes).toContain('MIN_GCM_AUTHENTICATION_TAG_LENGTH = 96')
  })
  it('带后缀的别名由 usesKeystoreSuffix 标记;要求认证的记录另有标记(我们只读不要认证的)', () => {
    expect(mod).toContain('USES_KEYSTORE_SUFFIX_PROPERTY = "usesKeystoreSuffix"')
    expect(mod).toContain('encryptedItem.put(USES_KEYSTORE_SUFFIX_PROPERTY, true)')
    expect(auth).toContain('REQUIRE_AUTHENTICATION_PROPERTY = "requireAuthentication"')
    const item = read(here, '..', 'native', 'android-push', 'src', 'main', 'kotlin', 'com', 'tendhearth', 'app', 'push', 'SecureStoreItem.kt')
    for (const s of ['"scheme"', '"aes"', '"usesKeystoreSuffix"', '"requireAuthentication"', '"ct"', '"iv"', '"tlen"', 'MIN_TAG_BITS = 96']) expect(item).toContain(s)
  })
  it('Kotlin 读取端用的常量与 key-store.ts 一致', () => {
    const reader = read(here, '..', 'native', 'android-push', 'android', 'SecureStoreReader.kt')
    expect(reader).toContain(`SERVICE = "${PUSH_KEY_SERVICE}"`)
    expect(reader).toContain(`ITEM = "${PUSH_KEY_ITEM}"`)
    expect(reader).toContain('"AES/GCM/NoPadding:$SERVICE:keystoreUnauthenticated"')
    expect(reader).toContain('PREFS = "SecureStore"')
    expect(reader).toContain('"$SERVICE-$ITEM"')
  })
})
