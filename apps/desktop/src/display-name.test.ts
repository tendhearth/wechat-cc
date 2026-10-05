// 仓库守卫:桌面 app 的「显示名」与「底层标识」分开管(docs/reference/product-naming.md)。
// 2026-10-04 主人拍板:1.7.4 起用户看到的名字是 Tendhearth CC(程序坞、菜单栏、关于、窗口标题、
// 通知、权限弹框),但 productName / bundle id 不动 —— productName 决定 .app 文件名(wechat-cc.app)、
// 更新器产物名、LaunchAgent 路径;bundle id 决定 TCC 授权、钥匙串、更新身份。
// 改 .app 文件名是另一项迁移(见 docs/roadmap.md),到那时有意改本文件里的 productName 断言。
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const TAURI_DIR = join(__dirname, '..', 'src-tauri')
const conf = JSON.parse(readFileSync(join(TAURI_DIR, 'tauri.conf.json'), 'utf8'))
const infoPlist = readFileSync(join(TAURI_DIR, 'Info.plist'), 'utf8')
const DISPLAY_NAME = 'Tendhearth CC'
const LOCALES = ['en', 'zh-Hans']

/** InfoPlist.strings 里 `"KEY" = "value";` 的值;没有就 undefined。 */
function stringsValue(src: string, key: string): string | undefined {
  return new RegExp(`^"${key}"\\s*=\\s*"([^"]*)";`, 'm').exec(src)?.[1]
}

describe('桌面显示名 = Tendhearth CC,底层标识不变', () => {
  it('底层标识不变:productName / bundle id / 主二进制名 / 更新地址', () => {
    expect(conf.productName).toBe('wechat-cc')
    expect(conf.identifier).toBe('com.tendhearth.wechat-cc')
    expect(conf.mainBinaryName).toBeUndefined()
    expect(conf.plugins.updater.endpoints).toEqual(['https://dl.tendhearth.com/wechat-cc/latest.json'])
  })

  it('主窗口标题是显示名', () => {
    expect(conf.app.windows[0].title).toBe(DISPLAY_NAME)
  })

  it('Info.plist 不覆盖基础名与 bundle id(基础名须与 .app 文件名一致,Finder 才用本地化名)', () => {
    for (const key of ['CFBundleDisplayName', 'CFBundleName', 'CFBundleIdentifier', 'CFBundleExecutable']) {
      expect(infoPlist).not.toContain(`<key>${key}</key>`)
    }
    expect(infoPlist).toMatch(/<key>LSHasLocalizedDisplayName<\/key>\s*<true\/>/)
  })

  it.each(LOCALES)('%s.lproj/InfoPlist.strings 打进包,且显示名 = Tendhearth CC', (locale) => {
    const rel = `lproj/${locale}.lproj/InfoPlist.strings`
    expect(conf.bundle.macOS.files[`Resources/${locale}.lproj/InfoPlist.strings`]).toBe(rel)
    expect(existsSync(join(TAURI_DIR, rel))).toBe(true)
    const src = readFileSync(join(TAURI_DIR, rel), 'utf8')
    expect(stringsValue(src, 'CFBundleDisplayName')).toBe(DISPLAY_NAME)
    expect(stringsValue(src, 'CFBundleName')).toBe(DISPLAY_NAME)
  })

  it('权限弹框文案用显示名,不再说 wechat-cc', () => {
    const usage = [...infoPlist.matchAll(/<key>(NS\w+UsageDescription)<\/key>\s*<string>([^<]*)<\/string>/g)]
    expect(usage.length).toBeGreaterThan(0)
    for (const [, key, text] of usage) {
      expect(text, key).toContain(DISPLAY_NAME)
      expect(text, key).not.toContain('wechat-cc')
    }
    for (const locale of LOCALES) {
      const src = readFileSync(join(TAURI_DIR, `lproj/${locale}.lproj/InfoPlist.strings`), 'utf8')
      for (const m of src.matchAll(/^"(NS\w+UsageDescription)"\s*=\s*"([^"]*)";/gm)) {
        expect(m[2], `${locale} ${m[1]}`).toContain(DISPLAY_NAME)
      }
    }
  })

  it('网页标题用显示名', () => {
    const index = readFileSync(join(__dirname, 'index.html'), 'utf8')
    expect(index).toContain(`<title>${DISPLAY_NAME}</title>`)
  })
})
