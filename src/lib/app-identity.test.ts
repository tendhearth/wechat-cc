import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_BUNDLE_ID, APP_BUNDLE_NAME, APP_MAIN_BINARY_NAMES, LEGACY_APP_BUNDLE_NAMES,
  SIDECAR_NAMES, appBundleRootOf, isSidecarBasename, sidecarNameFor,
} from './app-identity'

const HERE = dirname(fileURLToPath(import.meta.url))
const TAURI = join(HERE, '..', '..', 'apps', 'desktop', 'src-tauri')
const conf = JSON.parse(readFileSync(join(TAURI, 'tauri.conf.json'), 'utf8'))
const macConf = JSON.parse(readFileSync(join(TAURI, 'tauri.macos.conf.json'), 'utf8'))

describe('app-identity —— 新旧两代名字都要认', () => {
  it('sidecar:新旧两代 + .exe + 大小写都认,别的不认', () => {
    for (const n of ['tendhearth-cc-cli', 'wechat-cc-cli', 'wechat-cc-cli.exe', 'WECHAT-CC-CLI.EXE']) expect(isSidecarBasename(n)).toBe(true)
    for (const n of ['bun', 'wechat-cc', 'Tendhearth CC', 'tendhearth-cc-cli-aarch64-apple-darwin', '']) expect(isSidecarBasename(n)).toBe(false)
  })

  it('只有 macOS 换 sidecar 名;Windows / Linux 照旧(计划任务 / systemd unit 里写死的是旧名)', () => {
    expect(sidecarNameFor('darwin')).toBe('tendhearth-cc-cli')
    expect(sidecarNameFor('win32')).toBe('wechat-cc-cli')
    expect(sidecarNameFor('linux')).toBe('wechat-cc-cli')
  })

  it('appBundleRootOf:主二进制 / sidecar / MacOS 目录 → .app 根;不是 bundle ⇒ null', () => {
    expect(appBundleRootOf('/Applications/Tendhearth CC.app/Contents/MacOS/Tendhearth CC')).toBe('/Applications/Tendhearth CC.app')
    expect(appBundleRootOf('/Applications/wechat-cc.app/Contents/MacOS/wechat-cc-cli')).toBe('/Applications/wechat-cc.app')
    expect(appBundleRootOf('/Applications/wechat-cc.app/Contents/MacOS/')).toBe('/Applications/wechat-cc.app')
    expect(appBundleRootOf('/opt/homebrew/bin/bun')).toBeNull()
    expect(appBundleRootOf('/repo/target/MacOS/x')).toBeNull()
  })
})

describe('app-identity ↔ tauri 配置 —— 常量和真正打出来的包对得上', () => {
  it('bundle id 永不改(TCC 授权按它 + 签名记)', () => {
    expect(conf.identifier).toBe(APP_BUNDLE_ID)
    expect(macConf.identifier).toBeUndefined()
  })

  it('macOS:productName → .app 名,mainBinaryName → 主二进制,externalBin → sidecar 名', () => {
    expect(`${macConf.productName}.app`).toBe(APP_BUNDLE_NAME)
    expect(macConf.mainBinaryName).toBe(APP_MAIN_BINARY_NAMES[0])
    expect(macConf.bundle.externalBin).toContain(`binaries/${SIDECAR_NAMES[0]}`)
    expect(macConf.bundle.externalBin).not.toContain('binaries/wechat-cc-cli')
  })

  it('跨平台基础配置不动:Windows NSIS 安装目录 / 注册表键挂在 productName 上,改了会装成并排两份', () => {
    expect(conf.productName).toBe('wechat-cc')
    expect(conf.mainBinaryName).toBeUndefined()
    expect(conf.bundle.externalBin).toContain('binaries/wechat-cc-cli')
  })

  it('老 .app 名在迁移表里,新名不在', () => {
    expect(LEGACY_APP_BUNDLE_NAMES).toContain(`${conf.productName}.app`)
    expect(LEGACY_APP_BUNDLE_NAMES).not.toContain(APP_BUNDLE_NAME)
  })

  it('Rust 侧(bundle_migrate.rs / daemon_mode.rs / lib.rs)用的是同一组名字', () => {
    const rs = readFileSync(join(TAURI, 'src', 'bundle_migrate.rs'), 'utf8')
    expect(rs).toContain(`"${APP_BUNDLE_NAME}"`)
    for (const n of LEGACY_APP_BUNDLE_NAMES) expect(rs).toContain(`"${n}"`)
    for (const n of SIDECAR_NAMES) expect(rs).toContain(`"${n}"`)
  })
})
