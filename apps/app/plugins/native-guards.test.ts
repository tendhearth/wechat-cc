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
})

describe('中继的 APNs 占位', () => {
  it('apps/relay/src/push-apns.ts 的占位正文就是 RELAY_PLACEHOLDER_BODY', () => {
    expect(read(here, '..', '..', 'relay', 'src', 'push-apns.ts')).toContain(`body: '${RELAY_PLACEHOLDER_BODY}'`)
  })
})
