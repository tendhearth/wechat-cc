// 守门:macOS 包里麦克风权限的三件套不能丢(2026-10-04)。
//
// 1.7.1 起桌面 app 是 Developer ID + hardened runtime。缺 entitlement
// `com.apple.security.device.audio-input` 或 Info.plist 的 NSMicrophoneUsageDescription,
// 系统会**静默**拒绝麦克风 —— 「语音输入」点了没反应,没有任何报错。这类东西只在
// 打出来的签名包里才看得出来,所以在源码层面钉死。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TAURI_DIR = join(import.meta.dirname, '..', 'src-tauri')
const read = (rel: string) => readFileSync(join(TAURI_DIR, rel), 'utf8')

/** 取 plist 里某个 key 后面紧跟的值元素(<true/> 或 <string>…</string>)。 */
function plistValue(xml: string, key: string): string | null {
  const m = xml.match(new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*(<true/>|<false/>|<string>([\\s\\S]*?)</string>)`))
  if (!m) return null
  return m[2] ?? m[1]!
}

describe('macOS 麦克风权限(桌面「语音输入」)', () => {
  it('entitlements.plist 带 com.apple.security.device.audio-input = true', () => {
    expect(plistValue(read('entitlements.plist'), 'com.apple.security.device.audio-input')).toBe('<true/>')
  })

  it('Info.plist 有中文的 NSMicrophoneUsageDescription,用产品名 Tendhearth CC', () => {
    const s = plistValue(read('Info.plist'), 'NSMicrophoneUsageDescription')
    expect(s).toBeTruthy()
    expect(s).toContain('Tendhearth CC')
    expect(s).toContain('麦克风')
  })

  it('英文 / 简中 InfoPlist.strings 都有这条,并且真的被打进包里(tauri.conf.json bundle.macOS.files)', () => {
    const conf = JSON.parse(read('tauri.conf.json')) as { bundle: { macOS: { files?: Record<string, string> } } }
    const files = conf.bundle.macOS.files ?? {}
    for (const lang of ['en', 'zh-Hans']) {
      const src = files[`Resources/${lang}.lproj/InfoPlist.strings`]
      expect(src, `${lang} 没登记进 bundle.macOS.files`).toBe(`lproj/${lang}.lproj/InfoPlist.strings`)
      expect(read(src!)).toMatch(/"NSMicrophoneUsageDescription"\s*=\s*"[^"]*Tendhearth CC[^"]*";/)
    }
    expect(read('lproj/en.lproj/InfoPlist.strings')).toContain('microphone')
  })

  it('tauri.conf.json 仍然用这份 entitlements.plist 签名', () => {
    const conf = JSON.parse(read('tauri.conf.json')) as { bundle: { macOS: { entitlements?: string } } }
    expect(conf.bundle.macOS.entitlements).toBe('entitlements.plist')
  })
})
